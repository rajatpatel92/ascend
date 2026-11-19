import { gunzipSync } from 'node:zlib';
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isValidApiKey, isValidCronSecret } from '@/lib/api-auth';
import { invalidateMarketCaches } from '@/lib/cache-invalidation';
import { mergeAndCapHoldings, sanitizeStoredHoldings } from '@/lib/issuers/holdings';
import { MAX_UNDERLYING_HOLDINGS, type UnderlyingHoldingEntry } from '@/lib/issuers/types';
import { normalizeCountryName, normalizeSectorName } from '@/lib/look-through';
import { collectSyncSymbols } from '@/lib/market-sync';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

type AllocationWeightEntry = Record<string, number>;

interface PushAllocationItem {
    symbol?: unknown;
    providerId?: unknown;
    productId?: unknown;
    countryAllocations?: unknown;
    sectorAllocations?: unknown;
    topHoldings?: unknown;
    holdingsCount?: unknown;
    asOfDate?: unknown;
}

const FUND_NAME_HINT_PATTERN =
    /\b(etf|ishares|vanguard|bmo|invesco|spdr|schwab|fidelity|purpose|global x|horizons|td |rbc |index|fund|trust|portfolio)\b/i;

async function isAuthorizedRequest(request: Request): Promise<boolean> {
    const url = new URL(request.url);
    const queryKey = url.searchParams.get('key');
    const authHeader = request.headers.get('authorization');
    const bearerToken = authHeader?.replace(/^Bearer\s+/i, '');
    const headerSecret = request.headers.get('x-cron-secret') || bearerToken;
    const apiKey = request.headers.get('x-api-key');

    if (isValidCronSecret(headerSecret) || isValidCronSecret(queryKey) || isValidApiKey(apiKey)) {
        return true;
    }

    const session = await auth();
    const userRole = (session?.user as { role?: unknown } | undefined)?.role;
    return userRole === 'ADMIN';
}

function normalizeAllocationEntries(
    raw: unknown,
    normalizer: (name: string) => string
): AllocationWeightEntry[] {
    if (!Array.isArray(raw)) return [];

    const summed = new Map<string, number>();
    let total = 0;

    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const [rawKey, rawVal] of Object.entries(item as Record<string, unknown>)) {
            if (typeof rawVal !== 'number' || !Number.isFinite(rawVal) || rawVal <= 0) continue;
            const trimmedKey = rawKey.trim();
            if (!trimmedKey) continue;
            const canonicalKey = normalizer(trimmedKey);
            if (!canonicalKey) continue;
            summed.set(canonicalKey, (summed.get(canonicalKey) ?? 0) + rawVal);
            total += rawVal;
        }
    }

    if (total <= 0 || summed.size === 0) return [];

    return Array.from(summed.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, val]) => ({
            [name]: Math.round((val / total) * 1_000_000) / 1_000_000,
        }));
}

export async function GET(request: Request) {
    if (!(await isAuthorizedRequest(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const onlyMissingCountries = searchParams.get('onlyMissingCountries') === 'true';
    const onlyMissingTopHoldings = searchParams.get('onlyMissingTopHoldings') === 'true';

    const { allSymbols } = await collectSyncSymbols();
    const candidateSymbols = allSymbols.filter((s) => !s.endsWith('=X') && !s.startsWith('^'));

    const [investments, benchmarks, cachedRows] = await Promise.all([
        candidateSymbols.length > 0
            ? prisma.investment.findMany({
                  where: { symbol: { in: candidateSymbols } },
                  select: { symbol: true, name: true, type: true, currencyCode: true },
              })
            : Promise.resolve([]),
        candidateSymbols.length > 0
            ? prisma.benchmark.findMany({
                  where: { symbol: { in: candidateSymbols } },
                  select: { symbol: true, name: true },
              })
            : Promise.resolve([]),
        candidateSymbols.length > 0
            ? prisma.marketDataCache.findMany({
                  where: { symbol: { in: candidateSymbols } },
                  select: {
                      symbol: true,
                      currency: true,
                      countryAllocations: true,
                      sectorAllocations: true,
                      topHoldings: true,
                      metadataUpdatedAt: true,
                  },
              })
            : Promise.resolve([]),
    ]);

    const invMap = new Map(investments.map((i) => [i.symbol, i]));
    const benchmarkMap = new Map(benchmarks.map((b) => [b.symbol, b]));
    const cacheMap = new Map(cachedRows.map((c) => [c.symbol, c]));

    const items = candidateSymbols
        .map((symbol) => {
            const inv = invMap.get(symbol);
            const benchmark = benchmarkMap.get(symbol);
            const cache = cacheMap.get(symbol);
            const countryCount = Array.isArray(cache?.countryAllocations)
                ? cache.countryAllocations.length
                : 0;
            const sectorCount = Array.isArray(cache?.sectorAllocations)
                ? cache.sectorAllocations.length
                : 0;
            const topHoldingsCount = Array.isArray(cache?.topHoldings)
                ? cache.topHoldings.length
                : 0;
            const hasCountryAllocations = countryCount > 0;
            const hasTopHoldings = topHoldingsCount > 0;
            const investmentType = inv?.type ?? null;
            const name = inv?.name ?? benchmark?.name ?? null;
            const currency = cache?.currency ?? inv?.currencyCode ?? null;
            const isFundCandidate =
                Boolean(investmentType && /\b(etf|fund|mutual)\b/i.test(investmentType)) ||
                Boolean(name && FUND_NAME_HINT_PATTERN.test(name)) ||
                sectorCount >= 2;

            return {
                symbol,
                name,
                investmentType,
                currency,
                isFundCandidate,
                hasCountryAllocations,
                countryCount,
                sectorCount,
                hasTopHoldings,
                topHoldingsCount,
                isCached: Boolean(cache),
                metadataUpdatedAt: cache?.metadataUpdatedAt
                    ? new Date(cache.metadataUpdatedAt).toISOString()
                    : null,
            };
        })
        .filter((item) => {
            if (onlyMissingCountries && item.hasCountryAllocations) return false;
            if (onlyMissingTopHoldings && item.hasTopHoldings) return false;
            return true;
        });

    return NextResponse.json({
        symbols: items,
        total: items.length,
        timestamp: new Date().toISOString(),
    });
}

export async function POST(request: Request) {
    if (!(await isAuthorizedRequest(request))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let rawBody: unknown;
    try {
        const contentEncoding = (request.headers.get('content-encoding') || '').toLowerCase();
        if (contentEncoding.includes('gzip')) {
            const compressed = Buffer.from(await request.arrayBuffer());
            const uncompressed = gunzipSync(compressed).toString('utf8');
            rawBody = JSON.parse(uncompressed);
        } else {
            rawBody = await request.json();
        }
    } catch {
        return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
    }

    const body = rawBody as {
        allocations?: unknown;
        overwriteSectors?: unknown;
    };

    if (!body || !Array.isArray(body.allocations)) {
        return NextResponse.json(
            { error: 'Request body must include an "allocations" array' },
            { status: 400 }
        );
    }

    if (body.allocations.length === 0) {
        return NextResponse.json({
            success: true,
            updated: 0,
            skipped: 0,
            failed: 0,
            results: [],
            timestamp: new Date().toISOString(),
        });
    }

    if (body.allocations.length > 250) {
        return NextResponse.json(
            { error: 'Maximum 250 allocations allowed per request' },
            { status: 400 }
        );
    }

    const overwriteSectors = body.overwriteSectors === true;
    const items = body.allocations as PushAllocationItem[];

    const parsedItems = items.map((entry) => {
        const symbol = typeof entry?.symbol === 'string' ? entry.symbol.trim() : '';
        const providerId =
            typeof entry?.providerId === 'string' && entry.providerId.trim()
                ? entry.providerId.trim()
                : undefined;
        const countryAllocations = normalizeAllocationEntries(
            entry?.countryAllocations,
            normalizeCountryName
        );
        const sectorAllocations = normalizeAllocationEntries(
            entry?.sectorAllocations,
            normalizeSectorName
        );
        const sanitizedHoldings = sanitizeStoredHoldings(entry?.topHoldings, MAX_UNDERLYING_HOLDINGS);
        const topHoldings =
            sanitizedHoldings.length > 0
                ? mergeAndCapHoldings(
                      sanitizedHoldings.map((h) => ({
                          ...h,
                          source: h.source ?? providerId,
                      })),
                      MAX_UNDERLYING_HOLDINGS
                  )
                : [];
        return {
            symbol,
            providerId,
            countryAllocations,
            sectorAllocations,
            topHoldings,
        };
    });

    const uniqueSymbols = Array.from(
        new Set(parsedItems.map((i) => i.symbol).filter(Boolean))
    );

    const existingRows =
        uniqueSymbols.length > 0
            ? await prisma.marketDataCache.findMany({
                  where: { symbol: { in: uniqueSymbols } },
                  select: { symbol: true, sectorAllocations: true },
              })
            : [];

    const existingMap = new Map(existingRows.map((r) => [r.symbol, r]));
    const now = new Date();
    const updatedSymbols: string[] = [];
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    const results: Array<{
        symbol: string;
        status: 'updated' | 'skipped_not_cached' | 'invalid';
        countries?: number;
        topHoldings?: number;
        sectorsUpdated?: boolean;
        providerId?: string;
        reason?: string;
    }> = [];

    for (const item of parsedItems) {
        if (!item.symbol || (item.countryAllocations.length === 0 && item.topHoldings.length === 0)) {
            failed++;
            results.push({
                symbol: item.symbol || '(empty)',
                status: 'invalid',
                reason: !item.symbol
                    ? 'Missing symbol'
                    : 'No valid positive countryAllocations or topHoldings entries provided',
            });
            continue;
        }

        const existing = existingMap.get(item.symbol);
        if (!existing) {
            skipped++;
            results.push({
                symbol: item.symbol,
                status: 'skipped_not_cached',
                providerId: item.providerId,
                reason: 'Symbol has no MarketDataCache row yet (run Ascend market sync first)',
            });
            continue;
        }

        const existingSectorsCount = Array.isArray(existing.sectorAllocations)
            ? existing.sectorAllocations.length
            : 0;
        const shouldUpdateSectors =
            item.sectorAllocations.length > 0 &&
            (overwriteSectors || existingSectorsCount === 0);

        const updateData: {
            countryAllocations?: AllocationWeightEntry[];
            topHoldings?: UnderlyingHoldingEntry[];
            metadataUpdatedAt: Date;
            sectorAllocations?: AllocationWeightEntry[];
        } = {
            metadataUpdatedAt: now,
        };

        if (item.countryAllocations.length > 0) {
            updateData.countryAllocations = item.countryAllocations;
        }

        if (item.topHoldings.length > 0) {
            updateData.topHoldings = item.topHoldings;
        }

        if (shouldUpdateSectors) {
            updateData.sectorAllocations = item.sectorAllocations;
        }

        await prisma.marketDataCache.update({
            where: { symbol: item.symbol },
            data: updateData as Record<string, unknown>,
        });

        updated++;
        updatedSymbols.push(item.symbol);
        results.push({
            symbol: item.symbol,
            status: 'updated',
            countries: item.countryAllocations.length,
            topHoldings: item.topHoldings.length,
            sectorsUpdated: shouldUpdateSectors,
            providerId: item.providerId,
        });
    }

    if (updatedSymbols.length > 0) {
        invalidateMarketCaches({ symbols: updatedSymbols });
    }

    return NextResponse.json({
        success: true,
        updated,
        skipped,
        failed,
        results,
        timestamp: now.toISOString(),
    });
}
