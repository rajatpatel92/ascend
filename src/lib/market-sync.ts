/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { ACTIVE_QUANTITY_EPSILON, buildBehaviorMap } from '@/lib/activity-helpers';
import { getEffectivePriceTtlMs, getMarketConfig } from '@/lib/market-hours';
import { getCacheVersions, invalidateMarketCaches } from '@/lib/cache-invalidation';
import {
    getSyncState,
    getThrottlerSnapshot,
    isSyncActive,
    type SyncStatsSnapshot,
} from '@/lib/sync-state';

export interface CollectedSyncSymbols {
    activeHoldingSymbols: string[];
    benchmarkSymbols: string[];
    fxSymbols: string[];
    activeSymbols: string[];
    allSymbols: string[];
}

export interface IncrementalSyncOptions {
    force?: boolean;
    respectCooldown?: boolean;
    respectMarketHours?: boolean;
    symbols?: string[];
    reason?: string;
}

export interface IncrementalSyncResult {
    ran: boolean;
    coalesced: boolean;
    skippedReason?: 'cooldown' | 'off_hours_fresh' | 'empty';
    cooldownRemainingMs: number;
    stats: SyncStatsSnapshot;
    syncedAt: string | null;
}

export interface FullSyncOptions {
    force?: boolean;
    onlyStaleMetadata?: boolean;
    symbols?: string[];
}

export interface FullSyncResult {
    coalesced: boolean;
    stats: SyncStatsSnapshot & { skipped: number };
    syncedAt: string | null;
}

export interface MarketSyncStatusResponse {
    marketDataVersion: number;
    portfolioMutationVersion: number;
    isIncrementalRunning: boolean;
    isFullSyncRunning: boolean;
    isRefreshing: boolean;
    lastIncrementalSyncAt: string | null;
    lastFullSyncAt: string | null;
    lastMarketWriteAt: string | null;
    lastSyncError: string | null;
    lastIncrementalStats: SyncStatsSnapshot | null;
    isMarketOpen: boolean;
    sessionLabel: string;
    effectivePriceTtlMs: number;
    config: {
        priceCacheTtlMs: number;
        offHoursPriceCacheTtlMs: number;
        metadataCacheTtlMs: number;
        historyCacheTtlMs: number;
        manualRefreshCooldownMs: number;
        marketHoursAware: boolean;
    };
    throttler: ReturnType<typeof getThrottlerSnapshot>;
    activeSymbolCount: number;
    staleSymbolCount: number;
    oldestSyncAt: string | null;
    newestSyncAt: string | null;
}

interface IncrementalFlightEntry {
    promise: Promise<IncrementalSyncResult>;
    baseKey: string;
    respectMarketHours: boolean;
    symbolsPromise: Promise<string[]>;
}

interface GlobalSyncMaps {
    __ascendIncrementalInFlight?: Map<string, IncrementalFlightEntry>;
    __ascendFullSyncInFlight?: Map<string, Promise<FullSyncResult>>;
}

function getIncrementalInFlightMap(): Map<string, IncrementalFlightEntry> {
    const g = globalThis as unknown as GlobalSyncMaps;
    if (!(g.__ascendIncrementalInFlight instanceof Map)) {
        g.__ascendIncrementalInFlight = new Map();
    }
    return g.__ascendIncrementalInFlight;
}

function getFullSyncInFlightMap(): Map<string, Promise<FullSyncResult>> {
    const g = globalThis as unknown as GlobalSyncMaps;
    if (!(g.__ascendFullSyncInFlight instanceof Map)) {
        g.__ascendFullSyncInFlight = new Map();
    }
    return g.__ascendFullSyncInFlight;
}

function isNonMetadataSymbol(symbol: string): boolean {
    return symbol.endsWith('=X') || symbol.startsWith('^');
}

/**
 * Computes active holdings from ledger activities, handling per-account splits consistently
 * with GET /api/portfolio so exited positions are excluded from frequent 2-minute ticks.
 */
function computeActiveSymbolsFromActivities(
    activities: Array<{
        type: string;
        quantity: number;
        date: Date | string;
        accountId?: string | null;
        investment?: { symbol: string } | null;
    }>,
    behaviorMap: Map<string, string>
): string[] {
    const bySymbol = new Map<string, {
        accounts: Map<string, { accountId: string | null; quantity: number }>;
        appliedSplits: Set<string>;
    }>();

    for (const activity of activities) {
        const symbol = activity.investment?.symbol;
        if (!symbol) continue;

        let entry = bySymbol.get(symbol);
        if (!entry) {
            entry = { accounts: new Map(), appliedSplits: new Set() };
            bySymbol.set(symbol, entry);
        }

        const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';
        const absQty = Math.abs(activity.quantity || 0);

        if (behavior === 'SPLIT') {
            if (absQty <= 0) continue;
            const dayKey = new Date(activity.date).toISOString().split('T')[0];

            if (activity.accountId) {
                const accKey = activity.accountId;
                const acc = entry.accounts.get(accKey);
                if (acc && acc.quantity > 0) {
                    const dedupKey = `${dayKey}:${accKey}:${absQty}`;
                    if (!entry.appliedSplits.has(dedupKey)) {
                        entry.appliedSplits.add(dedupKey);
                        acc.quantity *= absQty;
                    }
                }
            } else {
                const hasUnassignedShares = Array.from(entry.accounts.values()).some(
                    (a) => !a.accountId && a.quantity > 0
                );
                for (const [accKey, acc] of entry.accounts.entries()) {
                    if (hasUnassignedShares && acc.accountId) continue;
                    if (acc.quantity > 0) {
                        const dedupKey = `${dayKey}:${accKey}:${absQty}`;
                        if (!entry.appliedSplits.has(dedupKey)) {
                            entry.appliedSplits.add(dedupKey);
                            acc.quantity *= absQty;
                        }
                    }
                }
            }
            continue;
        }

        const accKey = activity.accountId || '__UNASSIGNED__';
        let acc = entry.accounts.get(accKey);
        if (!acc) {
            acc = { accountId: activity.accountId || null, quantity: 0 };
            entry.accounts.set(accKey, acc);
        }

        if (behavior === 'ADD') {
            acc.quantity += absQty;
        } else if (behavior === 'REMOVE') {
            acc.quantity = Math.max(0, acc.quantity - absQty);
            if (acc.quantity < 1e-9) acc.quantity = 0;
        }
    }

    const active: string[] = [];
    for (const [symbol, data] of bySymbol.entries()) {
        let total = 0;
        for (const acc of data.accounts.values()) {
            if (acc.quantity > ACTIVE_QUANTITY_EPSILON) {
                total += acc.quantity;
            }
        }
        if (total > ACTIVE_QUANTITY_EPSILON) {
            active.push(symbol);
        }
    }
    return active;
}

/**
 * Resolves prioritized symbol lists from the database:
 * 1) Active holdings + benchmarks + dynamic USD FX pairs (`activeSymbols`)
 * 2) Full investment catalog including exited positions (`allSymbols`)
 */
export async function collectSyncSymbols(): Promise<CollectedSyncSymbols> {
    const prismaAny = prisma as unknown as Record<string, any>;

    const [investments, benchmarks] = await Promise.all([
        typeof prismaAny.investment?.findMany === 'function'
            ? prismaAny.investment.findMany({ select: { symbol: true, currencyCode: true } })
            : Promise.resolve([]),
        typeof prismaAny.benchmark?.findMany === 'function'
            ? prismaAny.benchmark.findMany({ select: { symbol: true } })
            : Promise.resolve([]),
    ]);

    const allInvestmentSymbols = Array.from(
        new Set<string>(
            (investments as Array<{ symbol?: string; currencyCode?: string }>)
                .map((i) => i.symbol)
                .filter((s): s is string => Boolean(s))
        )
    );

    let activeHoldingSymbols: string[] = [];
    if (typeof prismaAny.activity?.findMany === 'function') {
        const [activities, activityTypes] = await Promise.all([
            prismaAny.activity.findMany({
                select: {
                    type: true,
                    quantity: true,
                    date: true,
                    accountId: true,
                    investment: { select: { symbol: true } },
                },
                orderBy: { date: 'asc' },
            }),
            typeof prismaAny.activityType?.findMany === 'function'
                ? prismaAny.activityType.findMany()
                : Promise.resolve([]),
        ]);

        if (Array.isArray(activities) && activities.length > 0) {
            const behaviorMap = buildBehaviorMap(activityTypes || []);
            activeHoldingSymbols = computeActiveSymbolsFromActivities(activities, behaviorMap);
        } else {
            activeHoldingSymbols = allInvestmentSymbols;
        }
    } else {
        // Fallback for unit-test DB mocks that omit activity queries
        activeHoldingSymbols = allInvestmentSymbols;
    }

    const benchmarkSymbols = Array.from(
        new Set<string>(
            (benchmarks as Array<{ symbol?: string }>)
                .map((b) => b.symbol)
                .filter((s): s is string => Boolean(s))
        )
    );

    // Collect dynamic USD-base FX pairs covering all supported + configured DB currencies
    const currencyCodes = new Set<string>(
        SUPPORTED_CURRENCIES.map((c) => c.code).filter((code) => code !== 'USD')
    );

    for (const inv of investments as Array<{ currencyCode?: string }>) {
        const code = inv.currencyCode?.trim().toUpperCase();
        if (code && code !== 'USD') currencyCodes.add(code);
    }

    if (typeof prismaAny.account?.findMany === 'function') {
        try {
            const accounts = await prismaAny.account.findMany({ select: { currency: true } });
            for (const acc of accounts as Array<{ currency?: string }>) {
                const code = acc.currency?.trim().toUpperCase();
                if (code && code !== 'USD') currencyCodes.add(code);
            }
        } catch {
            // Non-critical if mocked/unavailable
        }
    }

    if (typeof prismaAny.currency?.findMany === 'function') {
        try {
            const dbCurrencies = await prismaAny.currency.findMany({ select: { code: true } });
            for (const cur of dbCurrencies as Array<{ code?: string }>) {
                const code = cur.code?.trim().toUpperCase();
                if (code && code !== 'USD') currencyCodes.add(code);
            }
        } catch {
            // Non-critical if mocked/unavailable
        }
    }

    const fxSymbols = Array.from(currencyCodes).map((code) => `${code}=X`);
    const activeSymbols = Array.from(new Set([...activeHoldingSymbols, ...benchmarkSymbols, ...fxSymbols]));
    const allSymbols = Array.from(new Set([...activeSymbols, ...allInvestmentSymbols]));

    return {
        activeHoldingSymbols,
        benchmarkSymbols,
        fxSymbols,
        activeSymbols,
        allSymbols,
    };
}

async function hasStaleSymbolsInDb(symbols: string[], ttlMs: number): Promise<boolean> {
    if (symbols.length === 0) return false;
    const prismaAny = prisma as unknown as Record<string, any>;
    if (typeof prismaAny.marketDataCache?.findMany !== 'function') {
        return true;
    }

    const rows = await prismaAny.marketDataCache.findMany({
        where: { symbol: { in: symbols } },
        select: { symbol: true, price: true, lastUpdated: true },
    });

    const rowMap = new Map<string, { price: number; lastUpdated: Date | string }>(
        (rows || []).map((r: any) => [r.symbol, r])
    );

    const nowMs = Date.now();
    for (const sym of symbols) {
        const row = rowMap.get(sym);
        if (!row || row.price <= 0) return true;
        const ageMs = nowMs - new Date(row.lastUpdated).getTime();
        if (!Number.isFinite(ageMs) || ageMs > ttlMs) return true;
    }

    return false;
}

/**
 * Runs a singleflight-coalesced, bulk-batched price sync for active symbols or an explicit subset.
 * Supports optional manual cooldown enforcement and market-hours off-peak skipping.
 */
export async function runIncrementalSync(options: IncrementalSyncOptions = {}): Promise<IncrementalSyncResult> {
    const state = getSyncState();
    const config = getMarketConfig();
    const inFlightMap = getIncrementalInFlightMap();

    const customSymbols = options.symbols
        ? Array.from(new Set(options.symbols.map((s) => s.trim()).filter(Boolean)))
        : null;
    const hasCustomSymbols = Boolean(customSymbols && customSymbols.length > 0);
    const baseKey = hasCustomSymbols
        ? `symbols:${customSymbols!.slice().sort().join(',')}`
        : '__PORTFOLIO__';
    const callerRespectsMarketHours = Boolean(options.respectMarketHours) && !options.force;
    const flightKey = `${baseKey}:${callerRespectsMarketHours ? 'mh' : 'unconditional'}`;

    // 1. Exact key match (same symbol scope and compatible market-hours skip semantics)
    const exactMatch = inFlightMap.get(flightKey);
    if (exactMatch) {
        const joined = await exactMatch.promise;
        return {
            ...joined,
            coalesced: true,
        };
    }

    // 2. If a portfolio-wide unconditional sync is in flight, coalesce onto it ONLY when:
    //    - It won't skip due to off_hours_fresh (or caller also respects market hours)
    //    - Every custom requested symbol is actually covered by that portfolio flight AND the flight ran
    const compatiblePortfolioFlight = Array.from(inFlightMap.values()).find(
        (entry) =>
            entry.baseKey === '__PORTFOLIO__' &&
            (callerRespectsMarketHours || !entry.respectMarketHours)
    );

    if (compatiblePortfolioFlight) {
        if (!hasCustomSymbols) {
            const joined = await compatiblePortfolioFlight.promise;
            return {
                ...joined,
                coalesced: true,
            };
        }

        const coveredSymbols = await compatiblePortfolioFlight.symbolsPromise.catch(() => [] as string[]);
        const coveredSet = new Set(coveredSymbols);
        if (customSymbols!.every((sym) => coveredSet.has(sym))) {
            const joined = await compatiblePortfolioFlight.promise;
            if (joined.ran) {
                return {
                    ...joined,
                    coalesced: true,
                };
            }
        }
    }

    if (options.respectCooldown && !options.force) {
        const prevEntry = hasCustomSymbols
            ? state.incrementalScopeCooldowns?.get(baseKey)
            : (state.lastIncrementalSyncAt
                ? {
                    syncedAt: state.lastIncrementalSyncAt,
                    stats: state.lastIncrementalStats || { total: 0, success: 0, failed: 0 },
                }
                : undefined);

        if (prevEntry) {
            const elapsedMs = Date.now() - prevEntry.syncedAt.getTime();
            if (elapsedMs < config.manualRefreshCooldownMs) {
                return {
                    ran: false,
                    coalesced: false,
                    skippedReason: 'cooldown',
                    cooldownRemainingMs: config.manualRefreshCooldownMs - elapsedMs,
                    stats: prevEntry.stats,
                    syncedAt: prevEntry.syncedAt.toISOString(),
                };
            }
        }
    }

    const symbolsPromise: Promise<string[]> = hasCustomSymbols
        ? Promise.resolve(customSymbols!)
        : collectSyncSymbols().then((res) => res.activeSymbols);
    // Attach no-op handler so subset callers awaiting symbolsPromise never cause unhandled rejections
    symbolsPromise.catch(() => {});

    const promise = (async (): Promise<IncrementalSyncResult> => {
        state.isIncrementalRunning = true;
        state.lastSyncError = null;

        try {
            const symbols = await symbolsPromise;

            if (symbols.length === 0) {
                return {
                    ran: false,
                    coalesced: false,
                    skippedReason: 'empty',
                    cooldownRemainingMs: 0,
                    stats: { total: 0, success: 0, failed: 0 },
                    syncedAt: state.lastIncrementalSyncAt?.toISOString() || null,
                };
            }

            if (callerRespectsMarketHours) {
                const ttlInfo = getEffectivePriceTtlMs();
                if (!ttlInfo.isMarketOpen && state.lastIncrementalSyncAt) {
                    const sinceLastSync = Date.now() - state.lastIncrementalSyncAt.getTime();
                    if (sinceLastSync < ttlInfo.ttlMs) {
                        const anyStale = await hasStaleSymbolsInDb(symbols, ttlInfo.ttlMs);
                        if (!anyStale) {
                            return {
                                ran: false,
                                coalesced: false,
                                skippedReason: 'off_hours_fresh',
                                cooldownRemainingMs: 0,
                                stats: state.lastIncrementalStats || { total: symbols.length, success: 0, failed: 0 },
                                syncedAt: state.lastIncrementalSyncAt.toISOString(),
                            };
                        }
                    }
                }
            }

            const batchSize = Math.max(1, config.incrementalBatchSize);
            const stats: SyncStatsSnapshot = { total: symbols.length, success: 0, failed: 0 };

            for (let i = 0; i < symbols.length; i += batchSize) {
                const batch = symbols.slice(i, i + batchSize);
                try {
                    const count = await MarketDataService.refreshPriceOnly(batch);
                    stats.success += count;
                    stats.failed += Math.max(0, batch.length - count);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err || 'Batch refresh failed');
                    state.lastSyncError = msg;
                    stats.failed += batch.length;
                }

                if (i + batchSize < symbols.length) {
                    await new Promise((r) => setTimeout(r, 150));
                }
            }

            const now = new Date();
            if (hasCustomSymbols) {
                if (!(state.incrementalScopeCooldowns instanceof Map)) {
                    state.incrementalScopeCooldowns = new Map();
                }
                state.incrementalScopeCooldowns.set(baseKey, { syncedAt: now, stats });
            } else {
                state.lastIncrementalSyncAt = now;
                state.lastIncrementalStats = stats;
            }

            return {
                ran: true,
                coalesced: false,
                cooldownRemainingMs: 0,
                stats,
                syncedAt: now.toISOString(),
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err || 'Incremental sync failed');
            state.lastSyncError = msg;
            throw err;
        } finally {
            state.isIncrementalRunning = false;
            inFlightMap.delete(flightKey);
        }
    })();

    inFlightMap.set(flightKey, {
        promise,
        baseKey,
        respectMarketHours: callerRespectsMarketHours,
        symbolsPromise,
    });
    return await promise;
}

/**
 * Runs a coalesced metadata & historical-series hydration pass without locking out
 * fast 2-minute incremental price refreshes. Skips symbols whose metadataUpdatedAt
 * and historyUpdatedAt are still fresh unless `force: true` is passed.
 */
export async function runFullMarketSync(
    options: FullSyncOptions = {},
    onLog?: (msg: string) => void
): Promise<FullSyncResult> {
    const state = getSyncState();
    const config = getMarketConfig();
    const inFlightMap = getFullSyncInFlightMap();
    const log = onLog || ((msg: string) => console.log(msg));

    const customSymbols = options.symbols
        ? Array.from(new Set(options.symbols.map((s) => s.trim()).filter(Boolean)))
        : null;
    const flightKey = customSymbols && customSymbols.length > 0
        ? `symbols:${customSymbols.slice().sort().join(',')}`
        : '__ALL__';

    const existingFlight = inFlightMap.get(flightKey);
    if (existingFlight) {
        log('[Cron] Full Market Data Sync already in progress; coalescing caller.');
        const joined = await existingFlight;
        return {
            ...joined,
            coalesced: true,
        };
    }

    const promise = (async (): Promise<FullSyncResult> => {
        state.isFullSyncRunning = true;
        state.lastSyncError = null;

        try {
            log('[Cron] Starting Market Data Refresh...');
            const symbols = customSymbols && customSymbols.length > 0
                ? customSymbols
                : (await collectSyncSymbols()).allSymbols;

            log(`[Cron] Found ${symbols.length} unique symbols to process.`);

            const stats = { total: symbols.length, success: 0, failed: 0, skipped: 0 };
            let phaseAUpdatedCount = 0;

            // Phase A: Fast price pass so current prices never wait on slow 20Y history fetches
            if (!options.onlyStaleMetadata && symbols.length > 0 && typeof MarketDataService.refreshPriceOnly === 'function') {
                const batchSize = Math.max(1, config.incrementalBatchSize);
                for (let i = 0; i < symbols.length; i += batchSize) {
                    const batch = symbols.slice(i, i + batchSize);
                    try {
                        const updated = await MarketDataService.refreshPriceOnly(batch);
                        phaseAUpdatedCount += updated;
                    } catch {
                        // Individual failures handled per-symbol below if metadata/history requested
                    }
                }
            }

            // Phase B: Selective metadata & history hydration
            const prismaAny = prisma as unknown as Record<string, any>;
            const existingCacheMap = new Map<string, any>();
            if (!options.force && symbols.length > 0 && typeof prismaAny.marketDataCache?.findMany === 'function') {
                try {
                    const rows = await prismaAny.marketDataCache.findMany({
                        where: { symbol: { in: symbols } },
                        select: {
                            symbol: true,
                            metadataUpdatedAt: true,
                            historyUpdatedAt: true,
                            history: true,
                        },
                    });
                    for (const row of rows || []) {
                        existingCacheMap.set(row.symbol, row);
                    }
                } catch {
                    // Fallback to full check if select fields aren't available in partial test mocks
                }
            }

            const nowMs = Date.now();
            const updatedPhaseBSymbols: string[] = [];

            for (const symbol of symbols) {
                const cachedRow = existingCacheMap.get(symbol);
                // FX pairs (=X) and market indices (^) lack Yahoo quoteSummary profile/dividend metadata;
                // skipping metadataDue avoids infinite NULL metadataUpdatedAt retries every cron/startup run.
                const supportsMetadata = !isNonMetadataSymbol(symbol);
                const metaTs = cachedRow?.metadataUpdatedAt ? new Date(cachedRow.metadataUpdatedAt).getTime() : Number.NaN;
                const metadataDue = supportsMetadata && (
                    options.force ||
                    !cachedRow ||
                    !Number.isFinite(metaTs) ||
                    (nowMs - metaTs > config.metadataCacheTtlMs)
                );
                const histTs = cachedRow?.historyUpdatedAt ? new Date(cachedRow.historyUpdatedAt).getTime() : Number.NaN;
                const historyDue = options.force ||
                    !cachedRow ||
                    !Number.isFinite(histTs) ||
                    !cachedRow.history ||
                    (nowMs - histTs > config.historyCacheTtlMs);

                if (!metadataDue && !historyDue) {
                    stats.skipped++;
                    stats.success++;
                    continue;
                }

                let retryCount = 0;
                const maxRetries = 3;
                let completed = false;

                while (!completed && retryCount <= maxRetries) {
                    try {
                        if (metadataDue) {
                            await MarketDataService.getPrice(symbol, true);
                        }
                        if (historyDue) {
                            if (typeof MarketDataService.getDailyHistory === 'function') {
                                await MarketDataService.getDailyHistory(symbol, undefined, true);
                            }
                            if (typeof MarketDataService.getHistoricalPrices === 'function') {
                                await MarketDataService.getHistoricalPrices(symbol, true);
                            }
                        }

                        stats.success++;
                        updatedPhaseBSymbols.push(symbol);
                        completed = true;
                        log(`[Context] ${symbol} updated successfully.`);
                        await new Promise((r) => setTimeout(r, 200));
                    } catch (e: unknown) {
                        const msg = e instanceof Error ? e.message : String(e || '');
                        if (msg.includes('Rate limit') || msg.includes('429')) {
                            log(`[Warn] Rate limit for ${symbol}. Pausing...`);
                            let waitTime = 60;
                            const match = msg.match(/Cooling down for (\d+)s/);
                            if (match && match[1]) waitTime = parseInt(match[1], 10) + 5;

                            log(`[Wait] Sleeping ${waitTime}s...`);
                            await new Promise((r) => setTimeout(r, waitTime * 1000));
                            retryCount++;
                        } else {
                            log(`[Error] Failed ${symbol}: ${msg}`);
                            state.lastSyncError = msg;
                            stats.failed++;
                            break;
                        }
                    }
                }

                if (!completed && retryCount > maxRetries) {
                    stats.failed++;
                }
            }

            const finishedAt = new Date();
            state.lastFullSyncAt = finishedAt;
            state.lastFullSyncStats = {
                total: stats.total,
                success: stats.success,
                failed: stats.failed,
            };

            // # Reason: Only invalidate when prices or metadata/history actually mutated, and do NOT
            // wipe _marketDailyUnadjustedCache because Phase B getDailyHistory(..., true) just populated it.
            if (phaseAUpdatedCount > 0 || updatedPhaseBSymbols.length > 0) {
                invalidateMarketCaches({
                    symbols: updatedPhaseBSymbols.length > 0 ? updatedPhaseBSymbols : symbols,
                    clearIntraday: updatedPhaseBSymbols.length > 0,
                    clearDailyUnadjusted: false,
                });
            }

            log(`[Done] Refresh Complete. Success: ${stats.success}, Failed: ${stats.failed}${stats.skipped ? `, Skipped fresh: ${stats.skipped}` : ''}`);
            return {
                coalesced: false,
                stats,
                syncedAt: finishedAt.toISOString(),
            };
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error || 'Unknown error');
            state.lastSyncError = msg;
            log(`[Critical] Failure: ${msg}`);
            throw error;
        } finally {
            state.isFullSyncRunning = false;
            inFlightMap.delete(flightKey);
        }
    })();

    inFlightMap.set(flightKey, promise);
    return await promise;
}

/**
 * Returns lightweight market sync diagnostics for status polling and admin UI dashboards.
 */
export async function getMarketSyncStatus(): Promise<MarketSyncStatusResponse> {
    const state = getSyncState();
    const config = getMarketConfig();
    const ttlInfo = getEffectivePriceTtlMs();
    const versions = getCacheVersions();
    const throttler = getThrottlerSnapshot();

    const { activeSymbols } = await collectSyncSymbols();
    let staleSymbolCount = 0;
    let oldestSyncAt: string | null = null;
    let newestSyncAt: string | null = null;

    const prismaAny = prisma as unknown as Record<string, any>;
    if (activeSymbols.length > 0 && typeof prismaAny.marketDataCache?.findMany === 'function') {
        try {
            const rows = await prismaAny.marketDataCache.findMany({
                where: { symbol: { in: activeSymbols } },
                select: { symbol: true, price: true, lastUpdated: true },
            });

            const rowMap = new Map<string, { price: number; lastUpdated: Date | string }>(
                (rows || []).map((r: any) => [r.symbol, r])
            );

            const nowMs = Date.now();
            let oldestMs = Number.POSITIVE_INFINITY;
            let newestMs = 0;

            for (const sym of activeSymbols) {
                const row = rowMap.get(sym);
                if (!row || row.price <= 0) {
                    staleSymbolCount++;
                    continue;
                }
                const ts = row.lastUpdated ? new Date(row.lastUpdated).getTime() : Number.NaN;
                if (!Number.isFinite(ts) || nowMs - ts > ttlInfo.ttlMs) {
                    staleSymbolCount++;
                }
                if (Number.isFinite(ts) && ts > 0) {
                    if (ts < oldestMs) oldestMs = ts;
                    if (ts > newestMs) newestMs = ts;
                }
            }

            if (Number.isFinite(oldestMs) && oldestMs > 0) {
                oldestSyncAt = new Date(oldestMs).toISOString();
            }
            if (newestMs > 0) {
                newestSyncAt = new Date(newestMs).toISOString();
            }
        } catch {
            // Leave counts resilient if DB read fails in mocked test
        }
    }

    return {
        marketDataVersion: versions.marketDataVersion,
        portfolioMutationVersion: versions.portfolioMutationVersion,
        isIncrementalRunning: state.isIncrementalRunning,
        isFullSyncRunning: state.isFullSyncRunning,
        isRefreshing: isSyncActive(),
        lastIncrementalSyncAt: state.lastIncrementalSyncAt?.toISOString() || null,
        lastFullSyncAt: state.lastFullSyncAt?.toISOString() || null,
        lastMarketWriteAt: versions.lastMarketWriteAt?.toISOString() || newestSyncAt,
        lastSyncError: state.lastSyncError,
        lastIncrementalStats: state.lastIncrementalStats,
        isMarketOpen: ttlInfo.isMarketOpen,
        sessionLabel: ttlInfo.sessionLabel,
        effectivePriceTtlMs: ttlInfo.ttlMs,
        config: {
            priceCacheTtlMs: config.priceCacheTtlMs,
            offHoursPriceCacheTtlMs: config.offHoursPriceCacheTtlMs,
            metadataCacheTtlMs: config.metadataCacheTtlMs,
            historyCacheTtlMs: config.historyCacheTtlMs,
            manualRefreshCooldownMs: config.manualRefreshCooldownMs,
            marketHoursAware: config.marketHoursAware,
        },
        throttler,
        activeSymbolCount: activeSymbols.length,
        staleSymbolCount,
        oldestSyncAt,
        newestSyncAt,
    };
}
