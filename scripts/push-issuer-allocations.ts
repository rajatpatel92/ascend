import { pathToFileURL } from 'node:url';
import { resolveIssuerAllocations } from '../src/lib/issuers/index.ts';
import type { IssuerAllocationResult } from '../src/lib/issuers/types.ts';

export interface DiscoveredSymbol {
    symbol: string;
    name?: string | null;
    investmentType?: string | null;
    currency?: string | null;
    isFundCandidate?: boolean;
    hasCountryAllocations?: boolean;
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

    const postRes = await fetchImpl(endpointBase, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
            allocations: resolvedPayloads,
            overwriteSectors: Boolean(config.overwriteSectors),
        }),
    });

    if (!postRes.ok) {
        const body = await postRes.text().catch(() => '');
        throw new Error(`Failed to push allocations to Ascend (HTTP ${postRes.status}): ${body}`);
    }

    const postBody = (await postRes.json()) as {
        updated?: number;
        skipped?: number;
        failed?: number;
    };
    const updatedCount = postBody.updated ?? 0;

    log(
        `[IssuerPush] Push complete: updated=${updatedCount}, skipped=${postBody.skipped ?? 0}, failed=${postBody.failed ?? 0}`
    );

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
