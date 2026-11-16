export interface CacheVersionState {
    marketDataVersion: number;
    portfolioMutationVersion: number;
    lastMarketWriteAt: Date | null;
    lastMutationAt: Date | null;
}

export interface InvalidateMarketCachesOptions {
    symbols?: string[];
    clearIntraday?: boolean;
    clearDailyUnadjusted?: boolean;
}

interface GlobalCacheStores {
    __ascendCacheVersions?: CacheVersionState;
    _portfolio1DCache?: unknown;
    _ownerSnapshotCache?: Map<string, unknown>;
    _marketIntradayCache?: Map<string, unknown>;
    _marketDailyUnadjustedCache?: Map<string, unknown>;
}

function getCacheStore(): CacheVersionState {
    const g = globalThis as unknown as GlobalCacheStores;
    if (!g.__ascendCacheVersions) {
        g.__ascendCacheVersions = {
            marketDataVersion: 1,
            portfolioMutationVersion: 1,
            lastMarketWriteAt: null,
            lastMutationAt: null,
        };
    }
    return g.__ascendCacheVersions;
}

/**
 * Returns current monotonic cache versions for server response caches.
 */
export function getCacheVersions(): Readonly<CacheVersionState> {
    const store = getCacheStore();
    return {
        marketDataVersion: store.marketDataVersion,
        portfolioMutationVersion: store.portfolioMutationVersion,
        lastMarketWriteAt: store.lastMarketWriteAt,
        lastMutationAt: store.lastMutationAt,
    };
}

/**
 * Bumps marketDataVersion and clears derived server portfolio caches.
 * Clears intraday / unadjusted replay caches only when requested (e.g. full sync / history update).
 */
export function invalidateMarketCaches(options: InvalidateMarketCachesOptions = {}): CacheVersionState {
    const g = globalThis as unknown as GlobalCacheStores;
    const store = getCacheStore();

    store.marketDataVersion += 1;
    store.lastMarketWriteAt = new Date();

    g._portfolio1DCache = null;
    if (g._ownerSnapshotCache instanceof Map) {
        g._ownerSnapshotCache.clear();
    }

    if (options.clearIntraday && g._marketIntradayCache instanceof Map) {
        if (options.symbols && options.symbols.length > 0) {
            for (const sym of options.symbols) {
                g._marketIntradayCache.delete(sym);
            }
        } else {
            g._marketIntradayCache.clear();
        }
    }

    if (options.clearDailyUnadjusted && g._marketDailyUnadjustedCache instanceof Map) {
        if (options.symbols && options.symbols.length > 0) {
            for (const sym of options.symbols) {
                g._marketDailyUnadjustedCache.delete(sym);
            }
        } else {
            g._marketDailyUnadjustedCache.clear();
        }
    }

    return store;
}

/**
 * Bumps portfolioMutationVersion and clears derived server portfolio caches
 * after activity, split, account, or benchmark writes.
 */
export function invalidatePortfolioMutationCaches(): CacheVersionState {
    const g = globalThis as unknown as GlobalCacheStores;
    const store = getCacheStore();

    store.portfolioMutationVersion += 1;
    store.lastMutationAt = new Date();

    g._portfolio1DCache = null;
    if (g._ownerSnapshotCache instanceof Map) {
        g._ownerSnapshotCache.clear();
    }

    return store;
}

export function resetCacheVersionsForTests(): void {
    const g = globalThis as unknown as GlobalCacheStores;
    g.__ascendCacheVersions = {
        marketDataVersion: 1,
        portfolioMutationVersion: 1,
        lastMarketWriteAt: null,
        lastMutationAt: null,
    };
    g._portfolio1DCache = null;
    g._ownerSnapshotCache?.clear();
}
