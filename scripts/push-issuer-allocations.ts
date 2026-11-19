import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { resolveIssuerAllocations } from '../src/lib/issuers/index.ts';
import type { IssuerAllocationResult } from '../src/lib/issuers/types.ts';

const MAX_HOLDINGS_PER_BATCH = 2_000;
const MAX_FUNDS_PER_BATCH = 50;
const GZIP_THRESHOLD_BYTES = 512 * 1024;

export interface DiscoveredSymbol {
    symbol: string;
    name?: string | null;
    investmentType?: string | null;
    currency?: string | null;
    isFundCandidate?: boolean;
    hasCountryAllocations?: boolean;
    hasTopHoldings?: boolean;
    topHoldingsCount?: number;
}

export interface PushJobConfig {
    ascendUrl: string;
    cronSecret?: string;
    apiKey?: string;
    onlyMissingCountries?: boolean;
    overwriteSectors?: boolean;
    dryRun?: boolean;
    timeoutMs?: number;
    symbolsOverride?: string[];
}

export interface PushAllocationRecord extends IssuerAllocationResult {
    symbol: string;
}

function buildAuthHeaders(config: PushJobConfig): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
    if (config.cronSecret) {
        headers.Authorization = `Bearer ${config.cronSecret}`;
        headers['x-cron-secret'] = config.cronSecret;
    }
    if (config.apiKey) {
        headers['x-api-key'] = config.apiKey;
    }
    return headers;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PushJobConfig {
    const ascendUrl = (env.ASCEND_URL || '').trim().replace(/\/+$/, '');
    if (!ascendUrl) {
        throw new Error('ASCEND_URL environment variable is required (e.g. https://ascend.example.com)');
    }

    const cronSecret = env.CRON_SECRET?.trim() || undefined;
    const apiKey = env.MCP_API_KEY?.trim() || undefined;
    if (!cronSecret && !apiKey) {
        throw new Error('Either CRON_SECRET or MCP_API_KEY environment variable is required');
    }

    const parsedTimeout = Number.parseInt(env.ISSUER_TIMEOUT_MS || '', 10);
    const symbolsRaw = env.ISSUER_SYMBOLS?.trim();
    const symbolsOverride = symbolsRaw
        ? symbolsRaw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : undefined;

    return {
        ascendUrl,
        cronSecret,
        apiKey,
        onlyMissingCountries: env.ISSUER_ONLY_MISSING === 'true',
        overwriteSectors: env.ISSUER_OVERWRITE_SECTORS === 'true',
        dryRun: env.ISSUER_DRY_RUN === 'true',
        timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 20_000,
        symbolsOverride,
    };
}

function compactPayloadForWire(record: PushAllocationRecord): PushAllocationRecord {
    if (!record.topHoldings || record.topHoldings.length === 0) {
        return record;
    }
    return {
        ...record,
        topHoldings: record.topHoldings.map((h) => {
            if (h.source === record.providerId) {
                const rest = { ...h };
                delete rest.source;
                return rest;
            }
            return h;
        }),
    };
}

function buildPushBatches(records: PushAllocationRecord[]): PushAllocationRecord[][] {
    const batches: PushAllocationRecord[][] = [];
    let currentBatch: PushAllocationRecord[] = [];
    let currentHoldings = 0;

    for (const record of records) {
        const count = record.topHoldings?.length ?? 0;
        if (
            currentBatch.length > 0 &&
            (currentBatch.length >= MAX_FUNDS_PER_BATCH ||
                currentHoldings + count > MAX_HOLDINGS_PER_BATCH)
        ) {
            batches.push(currentBatch);
            currentBatch = [];
            currentHoldings = 0;
        }
        currentBatch.push(record);
        currentHoldings += count;
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
}

export async function runPushIssuerAllocations(
    config: PushJobConfig,
    deps: {
        fetchFn?: typeof fetch;
        resolveFn?: typeof resolveIssuerAllocations;
        logFn?: (msg: string) => void;
    } = {}
): Promise<{
    discovered: number;
    resolved: number;
    pushed: number;
}> {
    const fetchImpl = deps.fetchFn ?? globalThis.fetch;
    const resolveImpl = deps.resolveFn ?? resolveIssuerAllocations;
    const log = deps.logFn ?? ((msg: string) => console.log(msg));

    const endpointBase = `${config.ascendUrl}/api/cron/issuer-allocations`;
    const listUrl = config.onlyMissingCountries
        ? `${endpointBase}?onlyMissingCountries=true`
        : endpointBase;

    const authHeaders = buildAuthHeaders(config);

    log(`[IssuerPush] Discovering symbols from ${listUrl}...`);
    const listRes = await fetchImpl(listUrl, {
        method: 'GET',
        headers: authHeaders,
    });

    if (!listRes.ok) {
        const body = await listRes.text().catch(() => '');
        throw new Error(`Failed to fetch symbol list from Ascend (HTTP ${listRes.status}): ${body}`);
    }

    const listData = (await listRes.json()) as { symbols?: DiscoveredSymbol[] };
    const serverSymbols = Array.isArray(listData.symbols) ? listData.symbols : [];

    let targets: DiscoveredSymbol[];
    if (config.symbolsOverride && config.symbolsOverride.length > 0) {
        const serverMap = new Map(serverSymbols.map((s) => [s.symbol, s]));
        targets = config.symbolsOverride.map(
            (sym) => serverMap.get(sym) ?? { symbol: sym, isFundCandidate: true }
        );
    } else {
        targets = serverSymbols.filter((s) => s.isFundCandidate !== false);
    }

    const candidatesOnServer = serverSymbols.filter((s) => s.isFundCandidate !== false);
    if (candidatesOnServer.length > 0 && typeof candidatesOnServer[0]?.hasTopHoldings !== 'boolean') {
        log(
            '[IssuerPush] WARNING: Server GET discovery response omits hasTopHoldings — Ascend web container may be running an older build.'
        );
    }

    log(`[IssuerPush] Processing ${targets.length} candidate fund/ETF symbol(s)...`);

    const resolvedPayloads: PushAllocationRecord[] = [];
    for (const item of targets) {
        const result = await resolveImpl({
            symbol: item.symbol,
            fundName: item.name,
            quoteType: item.isFundCandidate ? 'ETF' : undefined,
            currency: item.currency,
            timeoutMs: config.timeoutMs,
            onDiagnostic: (diag) => log(`[IssuerPush] ${diag}`),
        });

        if (result && (result.countryAllocations.length > 0 || (result.topHoldings?.length ?? 0) > 0)) {
            const sectorSummary = result.sectorAllocations?.length
                ? `, ${result.sectorAllocations.length} sectors`
                : '';
            const holdingsSummary = result.topHoldings?.length
                ? `, ${result.topHoldings.length} holdings`
                : '';
            log(
                `[IssuerPush] Resolved ${item.symbol} via ${result.providerId}: ` +
                    `${result.countryAllocations.length} countries${sectorSummary}${holdingsSummary}`
            );
            resolvedPayloads.push({
                symbol: item.symbol,
                ...result,
            });
        }
    }

    if (resolvedPayloads.length === 0) {
        log('[IssuerPush] No issuer allocations resolved; nothing to push.');
        return { discovered: targets.length, resolved: 0, pushed: 0 };
    }

    if (config.dryRun) {
        log(`[IssuerPush] Dry run enabled; skipping POST for ${resolvedPayloads.length} symbol(s).`);
        return { discovered: targets.length, resolved: resolvedPayloads.length, pushed: 0 };
    }

    const wirePayloads = resolvedPayloads.map(compactPayloadForWire);
    const batches = buildPushBatches(wirePayloads);

    let updatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const serverResults: Array<{
        symbol?: string;
        status?: string;
        countries?: number;
        topHoldings?: number;
        reason?: string;
    }> = [];

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const jsonPayload = JSON.stringify({
            allocations: batch,
            overwriteSectors: Boolean(config.overwriteSectors),
        });
        const rawBytes = Buffer.byteLength(jsonPayload, 'utf8');
        const useGzip = rawBytes > GZIP_THRESHOLD_BYTES;
        const compressed = useGzip ? gzipSync(Buffer.from(jsonPayload, 'utf8')) : null;
        const batchHoldingsCount = batch.reduce(
            (sum, p) => sum + (p.topHoldings?.length ?? 0),
            0
        );

        if (batches.length > 1 || useGzip) {
            const sizeInfo = compressed
                ? `gzip ${(compressed.byteLength / 1024).toFixed(0)}KB (raw ${(rawBytes / 1024).toFixed(0)}KB)`
                : `${(rawBytes / 1024).toFixed(0)}KB`;
            log(
                `[IssuerPush] Pushing batch ${i + 1}/${batches.length} (${batch.length} fund(s), ${batchHoldingsCount} holdings, ${sizeInfo})...`
            );
        }

        const postHeaders = useGzip
            ? { ...authHeaders, 'Content-Encoding': 'gzip' }
            : authHeaders;
        const postBody: BodyInit = compressed ? new Uint8Array(compressed) : jsonPayload;

        const postRes = await fetchImpl(endpointBase, {
            method: 'POST',
            headers: postHeaders,
            body: postBody,
        });

        if (!postRes.ok) {
            const body = await postRes.text().catch(() => '');
            throw new Error(
                `Failed to push allocations batch ${i + 1}/${batches.length} to Ascend (HTTP ${postRes.status}): ${body}`
            );
        }

        const postBodyJson = (await postRes.json()) as {
            updated?: number;
            skipped?: number;
            failed?: number;
            results?: Array<{
                symbol?: string;
                status?: string;
                countries?: number;
                topHoldings?: number;
                reason?: string;
            }>;
        };

        updatedCount += postBodyJson.updated ?? 0;
        skippedCount += postBodyJson.skipped ?? 0;
        failedCount += postBodyJson.failed ?? 0;
        if (Array.isArray(postBodyJson.results)) {
            serverResults.push(...postBodyJson.results);
        }
    }

    const clientFundsWithHoldings = resolvedPayloads.filter(
        (p) => (p.topHoldings?.length ?? 0) > 0
    ).length;
    const clientHoldingsTotal = resolvedPayloads.reduce(
        (sum, p) => sum + (p.topHoldings?.length ?? 0),
        0
    );

    const resultsIncludeTopHoldingsField = serverResults.some(
        (r) => typeof r?.topHoldings === 'number'
    );
    const serverHoldingsSaved = serverResults.reduce(
        (sum, r) => sum + (typeof r?.topHoldings === 'number' ? r.topHoldings : 0),
        0
    );

    log(
        `[IssuerPush] Push complete: updated=${updatedCount}, skipped=${skippedCount}, failed=${failedCount}, serverHoldingsSaved=${serverHoldingsSaved}`
    );

    if (
        clientFundsWithHoldings > 0 &&
        (!resultsIncludeTopHoldingsField || serverHoldingsSaved === 0)
    ) {
        log(
            `[IssuerPush] WARNING: Client resolved ${clientHoldingsTotal} holding(s) across ${clientFundsWithHoldings} fund(s), ` +
                `but server acknowledged ${serverHoldingsSaved} topHoldings. Verify the Ascend web deployment is updated and Prisma migrations are applied.`
        );
    }

    return {
        discovered: targets.length,
        resolved: resolvedPayloads.length,
        pushed: updatedCount,
    };
}

const isDirectEntrypoint =
    typeof process !== 'undefined' &&
    Array.isArray(process.argv) &&
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntrypoint) {
    runPushIssuerAllocations(loadConfigFromEnv()).catch((err: unknown) => {
        console.error('[IssuerPush] Fatal error:', err);
        process.exit(1);
    });
}
