/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const prisma = {
          investment: { findMany: (...args) => globalThis.__mockSyncPrisma.investment.findMany(...args) },
          benchmark: { findMany: (...args) => globalThis.__mockSyncPrisma.benchmark.findMany(...args) },
          activity: { findMany: (...args) => globalThis.__mockSyncPrisma.activity.findMany(...args) },
          activityType: { findMany: (...args) => globalThis.__mockSyncPrisma.activityType.findMany(...args) },
          marketDataCache: { findMany: (...args) => globalThis.__mockSyncPrisma.marketDataCache.findMany(...args) },
          account: { findMany: (...args) => globalThis.__mockSyncPrisma.account.findMany(...args) },
          currency: { findMany: (...args) => globalThis.__mockSyncPrisma.currency.findMany(...args) },
        };
      \`)
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const MarketDataService = {
          refreshPriceOnly: (...args) => globalThis.__mockSyncMarketData.refreshPriceOnly(...args),
          getPrice: (...args) => globalThis.__mockSyncMarketData.getPrice(...args),
          getDailyHistory: (...args) => globalThis.__mockSyncMarketData.getDailyHistory(...args),
          getHistoricalPrices: (...args) => globalThis.__mockSyncMarketData.getHistoricalPrices(...args),
        };
      \`)
    };
  }
  if (specifier.startsWith("@/")) {
    let relativePath = specifier.replace("@/", "./src/");
    if (!relativePath.endsWith(".ts") && !relativePath.endsWith(".js") && !relativePath.endsWith(".json")) {
      relativePath += ".ts";
    }
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

interface MockSyncGlobals {
    __mockSyncPrisma: {
        investment: { findMany: (...args: any[]) => Promise<any[]> };
        benchmark: { findMany: (...args: any[]) => Promise<any[]> };
        activity: { findMany: (...args: any[]) => Promise<any[]> };
        activityType: { findMany: (...args: any[]) => Promise<any[]> };
        marketDataCache: { findMany: (...args: any[]) => Promise<any[]> };
        account: { findMany: (...args: any[]) => Promise<any[]> };
        currency: { findMany: (...args: any[]) => Promise<any[]> };
    };
    __mockSyncMarketData: {
        refreshPriceOnly: (...args: any[]) => Promise<number>;
        getPrice: (...args: any[]) => Promise<any>;
        getDailyHistory: (...args: any[]) => Promise<any>;
        getHistoricalPrices: (...args: any[]) => Promise<any>;
    };
}

const g = globalThis as unknown as MockSyncGlobals;

g.__mockSyncPrisma = {
    investment: { findMany: async () => [] },
    benchmark: { findMany: async () => [] },
    activity: { findMany: async () => [] },
    activityType: { findMany: async () => [] },
    marketDataCache: { findMany: async () => [] },
    account: { findMany: async () => [] },
    currency: { findMany: async () => [] },
};

g.__mockSyncMarketData = {
    refreshPriceOnly: async () => 0,
    getPrice: async () => null,
    getDailyHistory: async () => ({}),
    getHistoricalPrices: async () => ({}),
};

const {
    collectSyncSymbols,
    getMarketSyncStatus,
    runFullMarketSync,
    runIncrementalSync,
} = await import('./market-sync.ts');
const { resetSyncStateForTests } = await import('./sync-state.ts');
const { getCacheVersions, resetCacheVersionsForTests } = await import('./cache-invalidation.ts');

test('market-sync orchestrator', async (t) => {
    const savedEnv = { ...process.env };

    t.beforeEach(() => {
        resetSyncStateForTests();
        resetCacheVersionsForTests();
        g.__mockSyncPrisma = {
            investment: { findMany: async () => [] },
            benchmark: { findMany: async () => [] },
            activity: { findMany: async () => [] },
            activityType: { findMany: async () => [] },
            marketDataCache: { findMany: async () => [] },
            account: { findMany: async () => [] },
            currency: { findMany: async () => [] },
        };
        g.__mockSyncMarketData = {
            refreshPriceOnly: async (syms: string | string[]) => Array.isArray(syms) ? syms.length : 1,
            getPrice: async () => ({ price: 100 }),
            getDailyHistory: async () => ({}),
            getHistoricalPrices: async () => ({}),
        };
    });

    t.afterEach(() => {
        process.env = { ...savedEnv };
        resetSyncStateForTests();
        resetCacheVersionsForTests();
    });

    await t.test('collectSyncSymbols excludes exited holdings from activeSymbols while retaining allSymbols, splits, benchmarks, and dynamic FX pairs', async () => {
        g.__mockSyncPrisma.investment.findMany = async () => [
            { symbol: 'AAPL', currencyCode: 'USD' },
            { symbol: 'SOLD.TO', currencyCode: 'CAD' },
            { symbol: 'NVDA', currencyCode: 'USD' },
            { symbol: 'NESN.SW', currencyCode: 'CHF' },
        ];
        g.__mockSyncPrisma.benchmark.findMany = async () => [
            { symbol: '^GSPC' },
        ];
        g.__mockSyncPrisma.account.findMany = async () => [
            { currency: 'GBP' },
        ];
        g.__mockSyncPrisma.currency.findMany = async () => [
            { code: 'JPY' },
        ];
        g.__mockSyncPrisma.activityType.findMany = async () => [
            { name: 'BUY', behavior: 'ADD' },
            { name: 'SELL', behavior: 'REMOVE' },
            { name: 'STOCK_SPLIT', behavior: 'SPLIT' },
        ];
        g.__mockSyncPrisma.activity.findMany = async () => [
            { type: 'BUY', quantity: 10, date: '2024-01-01T00:00:00Z', accountId: 'acc-1', investment: { symbol: 'AAPL' } },
            { type: 'BUY', quantity: 10, date: '2024-01-01T00:00:00Z', accountId: 'acc-1', investment: { symbol: 'SOLD.TO' } },
            { type: 'SELL', quantity: 10, date: '2024-02-01T00:00:00Z', accountId: 'acc-1', investment: { symbol: 'SOLD.TO' } },
            { type: 'BUY', quantity: 5, date: '2024-01-01T00:00:00Z', accountId: 'acc-1', investment: { symbol: 'NVDA' } },
            { type: 'STOCK_SPLIT', quantity: 10, date: '2024-06-10T00:00:00Z', accountId: 'acc-1', investment: { symbol: 'NVDA' } },
        ];

        const result = await collectSyncSymbols();

        assert.deepStrictEqual(result.activeHoldingSymbols.sort(), ['AAPL', 'NVDA']);
        assert.ok(!result.activeSymbols.includes('SOLD.TO'));
        assert.ok(result.allSymbols.includes('SOLD.TO'));
        assert.ok(result.activeSymbols.includes('^GSPC'));
        assert.ok(result.fxSymbols.includes('CAD=X'));
        assert.ok(result.fxSymbols.includes('CHF=X'));
        assert.ok(result.fxSymbols.includes('GBP=X'));
        assert.ok(result.fxSymbols.includes('JPY=X'));
        assert.ok(!result.fxSymbols.includes('USD=X'));
    });

    await t.test('runIncrementalSync coalesces concurrent calls (mobile + laptop + subset) into one bulk refresh', async () => {
        g.__mockSyncPrisma.investment.findMany = async () => [
            { symbol: 'AAPL', currencyCode: 'USD' },
            { symbol: 'MSFT', currencyCode: 'USD' },
        ];
        g.__mockSyncPrisma.activityType.findMany = async () => [
            { name: 'BUY', behavior: 'ADD' },
        ];
        g.__mockSyncPrisma.activity.findMany = async () => [
            { type: 'BUY', quantity: 5, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'AAPL' } },
            { type: 'BUY', quantity: 3, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'MSFT' } },
        ];

        let refreshCalls = 0;
        g.__mockSyncMarketData.refreshPriceOnly = async (batch: string[]) => {
            refreshCalls++;
            await new Promise((r) => setTimeout(r, 30));
            return batch.length;
        };

        const [first, second, subset] = await Promise.all([
            runIncrementalSync({ force: true, reason: 'mobile' }),
            runIncrementalSync({ force: true, reason: 'laptop' }),
            runIncrementalSync({ symbols: ['AAPL'], force: true, reason: 'subset' }),
        ]);

        assert.strictEqual(refreshCalls, 1);
        assert.strictEqual(first.ran, true);
        assert.strictEqual(first.coalesced, false);
        assert.strictEqual(second.ran, true);
        assert.strictEqual(second.coalesced, true);
        assert.strictEqual(subset.coalesced, true);
    });

    await t.test('runIncrementalSync enforces manual cooldown when respectCooldown is true and bypasses when force is true', async () => {
        process.env.MANUAL_REFRESH_COOLDOWN_MS = '15000';
        g.__mockSyncPrisma.investment.findMany = async () => [{ symbol: 'AAPL', currencyCode: 'USD' }];
        g.__mockSyncPrisma.activityType.findMany = async () => [{ name: 'BUY', behavior: 'ADD' }];
        g.__mockSyncPrisma.activity.findMany = async () => [
            { type: 'BUY', quantity: 2, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'AAPL' } },
        ];

        let refreshCalls = 0;
        g.__mockSyncMarketData.refreshPriceOnly = async (batch: string[]) => {
            refreshCalls++;
            return batch.length;
        };

        const first = await runIncrementalSync({ respectCooldown: true });
        assert.strictEqual(first.ran, true);
        assert.strictEqual(refreshCalls, 1);

        const blocked = await runIncrementalSync({ respectCooldown: true });
        assert.strictEqual(blocked.ran, false);
        assert.strictEqual(blocked.coalesced, false);
        assert.strictEqual(blocked.skippedReason, 'cooldown');
        assert.ok(blocked.cooldownRemainingMs > 0);
        assert.strictEqual(refreshCalls, 1);

        const forced = await runIncrementalSync({ respectCooldown: true, force: true });
        assert.strictEqual(forced.ran, true);
        assert.strictEqual(refreshCalls, 2);

        // Single-symbol forced sync must not clobber distinct batch cooldowns or portfolio telemetry
        const single = await runIncrementalSync({ symbols: ['NVDA'], force: true });
        assert.strictEqual(single.ran, true);
        const batchRun = await runIncrementalSync({ symbols: ['AAPL', 'MSFT'], respectCooldown: true });
        assert.strictEqual(batchRun.ran, true);
        const batchBlocked = await runIncrementalSync({ symbols: ['AAPL', 'MSFT'], respectCooldown: true });
        assert.strictEqual(batchBlocked.ran, false);
        assert.strictEqual(batchBlocked.skippedReason, 'cooldown');
    });

    await t.test('runIncrementalSync skips off-hours refresh when DB rows are fresh and runs when stale', async (subT) => {
        // Freeze wall clock to Saturday 2026-07-18T16:00:00Z (off-hours, 30 min TTL)
        subT.mock.timers.enable({
            apis: ['Date'],
            now: new Date('2026-07-18T16:00:00.000Z'),
        });

        try {
            g.__mockSyncPrisma.investment.findMany = async () => [{ symbol: 'AAPL', currencyCode: 'USD' }];
            g.__mockSyncPrisma.activityType.findMany = async () => [{ name: 'BUY', behavior: 'ADD' }];
            g.__mockSyncPrisma.activity.findMany = async () => [
                { type: 'BUY', quantity: 1, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'AAPL' } },
            ];

            let refreshCalls = 0;
            g.__mockSyncMarketData.refreshPriceOnly = async (batch: string[]) => {
                refreshCalls++;
                return batch.length;
            };

            // Initial run sets lastIncrementalSyncAt
            const initial = await runIncrementalSync({ force: true });
            assert.strictEqual(initial.ran, true);
            assert.strictEqual(refreshCalls, 1);

            // Advance clock by 5 minutes (still within 30m off-hours TTL); all active symbols fresh in DB
            subT.mock.timers.tick(5 * 60 * 1000);
            const now = new Date();
            g.__mockSyncPrisma.marketDataCache.findMany = async ({ where }: any) => {
                const syms: string[] = where?.symbol?.in || [];
                return syms.map((symbol) => ({ symbol, price: 150, lastUpdated: now }));
            };

            const skipped = await runIncrementalSync({ respectMarketHours: true });
            assert.strictEqual(skipped.ran, false);
            assert.strictEqual(skipped.skippedReason, 'off_hours_fresh');
            assert.strictEqual(refreshCalls, 1);

            // Now mark one symbol stale (45m old > 30m off-hours TTL) -> should run
            const staleAt = new Date(Date.now() - 45 * 60 * 1000);
            g.__mockSyncPrisma.marketDataCache.findMany = async ({ where }: any) => {
                const syms: string[] = where?.symbol?.in || [];
                return syms.map((symbol) => ({
                    symbol,
                    price: 150,
                    lastUpdated: symbol === 'AAPL' ? staleAt : now,
                }));
            };

            const ranOnStale = await runIncrementalSync({ respectMarketHours: true });
            assert.strictEqual(ranOnStale.ran, true);
            assert.strictEqual(refreshCalls, 2);
        } finally {
            subT.mock.timers.reset();
        }
    });

    await t.test('runIncrementalSync does not falsely coalesce uncovered custom symbols or force-bypass off-hours skips (B4)', async (subT) => {
        subT.mock.timers.enable({
            apis: ['Date'],
            now: new Date('2026-07-18T16:00:00.000Z'), // Saturday off-hours
        });

        try {
            g.__mockSyncPrisma.investment.findMany = async () => [{ symbol: 'AAPL', currencyCode: 'USD' }];
            g.__mockSyncPrisma.activityType.findMany = async () => [{ name: 'BUY', behavior: 'ADD' }];
            g.__mockSyncPrisma.activity.findMany = async () => [
                { type: 'BUY', quantity: 5, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'AAPL' } },
            ];

            const calls: string[][] = [];
            g.__mockSyncMarketData.refreshPriceOnly = async (batch: string[]) => {
                calls.push(batch);
                await new Promise((r) => setTimeout(r, 25));
                return batch.length;
            };

            // 1. Concurrent EXITED_SYM custom refresh must NOT coalesce onto in-flight __PORTFOLIO__
            const [portfolioRes, exitedRes] = await Promise.all([
                runIncrementalSync({ force: true, reason: 'portfolio' }),
                runIncrementalSync({ symbols: ['EXITED_SYM'], force: true, reason: 'custom-exited' }),
            ]);

            assert.strictEqual(portfolioRes.ran, true);
            assert.strictEqual(portfolioRes.coalesced, false);
            assert.strictEqual(exitedRes.ran, true);
            assert.strictEqual(exitedRes.coalesced, false);
            assert.ok(calls.some((b) => b.includes('EXITED_SYM')));

            // 2. Manual/forced refresh concurrent with off-hours skipping cron must NOT return off_hours_fresh
            const now = new Date();
            g.__mockSyncPrisma.marketDataCache.findMany = async ({ where }: any) => {
                await new Promise((r) => setTimeout(r, 20));
                const syms: string[] = where?.symbol?.in || [];
                return syms.map((symbol) => ({ symbol, price: 150, lastUpdated: now }));
            };

            calls.length = 0;
            const [cronRes, forcedRes] = await Promise.all([
                runIncrementalSync({ respectMarketHours: true, reason: 'cron' }),
                runIncrementalSync({ symbols: ['AAPL'], force: true, reason: 'manual' }),
            ]);

            assert.strictEqual(cronRes.ran, false);
            assert.strictEqual(cronRes.skippedReason, 'off_hours_fresh');
            assert.strictEqual(forcedRes.ran, true);
            assert.strictEqual(forcedRes.skippedReason, undefined);
            assert.deepStrictEqual(calls, [['AAPL']]);
        } finally {
            subT.mock.timers.reset();
        }
    });

    await t.test('runFullMarketSync skips fresh metadata/history, selectively hydrates stale symbols, and coalesces callers', async () => {
        const originalLog = console.log;
        console.log = () => {};

        try {
            const now = new Date();
            const veryStale = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

            g.__mockSyncPrisma.marketDataCache.findMany = async () => [
                {
                    symbol: 'FRESH',
                    metadataUpdatedAt: now,
                    historyUpdatedAt: now,
                    history: { '2026-01-01': 100 },
                },
                {
                    symbol: 'STALE_META',
                    metadataUpdatedAt: veryStale,
                    historyUpdatedAt: now,
                    history: { '2026-01-01': 200 },
                },
            ];

            const metadataCalls: string[] = [];
            const historyCalls: string[] = [];
            let pricePhaseCalls = 0;

            g.__mockSyncMarketData = {
                refreshPriceOnly: async (batch: string[]) => {
                    pricePhaseCalls++;
                    await new Promise((r) => setTimeout(r, 25));
                    return batch.length;
                },
                getPrice: async (sym: string) => {
                    metadataCalls.push(sym);
                    return { price: 200 };
                },
                getDailyHistory: async (sym: string) => {
                    historyCalls.push(`daily:${sym}`);
                    return {};
                },
                getHistoricalPrices: async (sym: string) => {
                    historyCalls.push(`hist:${sym}`);
                    return {};
                },
            };

            const versionBefore = getCacheVersions().marketDataVersion;
            const [resA, resB] = await Promise.all([
                runFullMarketSync({ symbols: ['FRESH', 'STALE_META'] }),
                runFullMarketSync({ symbols: ['FRESH', 'STALE_META'] }),
            ]);

            assert.strictEqual(pricePhaseCalls, 1);
            assert.strictEqual(resA.coalesced, false);
            assert.strictEqual(resB.coalesced, true);
            assert.strictEqual(resA.stats.total, 2);
            assert.strictEqual(resA.stats.skipped, 1);
            assert.strictEqual(resA.stats.success, 2);
            assert.deepStrictEqual(metadataCalls, ['STALE_META']);
            assert.deepStrictEqual(historyCalls, []);
            assert.ok(getCacheVersions().marketDataVersion > versionBefore);
        } finally {
            console.log = originalLog;
        }
    });

    await t.test('runFullMarketSync preserves daily unadjusted cache, skips FX/index metadataUpdatedAt, and avoids version bump when all skipped (B1, B3)', async () => {
        const originalLog = console.log;
        console.log = () => {};

        try {
            const globalStores = globalThis as Record<string, any>;
            const dailyCache = new Map<string, any>();
            globalStores._marketDailyUnadjustedCache = dailyCache;

            const now = new Date();
            const veryStale = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

            // Part 1: History update populates _marketDailyUnadjustedCache -> must NOT be wiped afterward
            g.__mockSyncPrisma.marketDataCache.findMany = async () => [
                {
                    symbol: 'AAPL',
                    metadataUpdatedAt: now,
                    historyUpdatedAt: veryStale,
                    history: { '2026-01-01': 180 },
                },
            ];
            g.__mockSyncMarketData = {
                refreshPriceOnly: async (batch: string[]) => batch.length,
                getPrice: async () => ({ price: 200 }),
                getDailyHistory: async (sym: string) => {
                    const series = { '2026-07-01': 210 };
                    dailyCache.set(sym, { data: series, fromTime: 0, timestamp: Date.now() });
                    return series;
                },
                getHistoricalPrices: async () => ({ '2026-07-01': 210 }),
            };

            const histRun = await runFullMarketSync({ symbols: ['AAPL'], onlyStaleMetadata: true });
            assert.strictEqual(histRun.stats.skipped, 0);
            assert.strictEqual(dailyCache.has('AAPL'), true);
            assert.deepStrictEqual(dailyCache.get('AAPL').data, { '2026-07-01': 210 });

            // Part 2: FX (=X) and index (^) with null metadataUpdatedAt + fresh history are skipped;
            // no-op onlyStaleMetadata run does not bump marketDataVersion or clear _portfolio1DCache.
            const metadataFetched: string[] = [];
            g.__mockSyncPrisma.marketDataCache.findMany = async () => [
                {
                    symbol: 'FRESH',
                    metadataUpdatedAt: now,
                    historyUpdatedAt: now,
                    history: { '2026-01-01': 100 },
                },
                {
                    symbol: 'CAD=X',
                    metadataUpdatedAt: null,
                    historyUpdatedAt: now,
                    history: { '2026-01-01': 1.38 },
                },
                {
                    symbol: '^GSPC',
                    metadataUpdatedAt: null,
                    historyUpdatedAt: now,
                    history: { '2026-01-01': 5500 },
                },
            ];
            g.__mockSyncMarketData.getPrice = async (sym: string) => {
                metadataFetched.push(sym);
                return { price: 1 };
            };

            globalStores._portfolio1DCache = { key: 'WARM', data: [1], timestamp: Date.now() };
            const versionBeforeSkip = getCacheVersions().marketDataVersion;

            const skipRun = await runFullMarketSync({
                symbols: ['FRESH', 'CAD=X', '^GSPC'],
                onlyStaleMetadata: true,
            });

            assert.strictEqual(skipRun.stats.total, 3);
            assert.strictEqual(skipRun.stats.skipped, 3);
            assert.deepStrictEqual(metadataFetched, []);
            assert.strictEqual(getCacheVersions().marketDataVersion, versionBeforeSkip);
            assert.ok(globalStores._portfolio1DCache);
            assert.strictEqual(dailyCache.has('AAPL'), true);
        } finally {
            console.log = originalLog;
        }
    });

    await t.test('flushBackgroundPriceSync retains lastSyncError if an earlier chunk fails and a later chunk succeeds', async () => {
        const {
            enqueueBackgroundPriceSync,
            flushBackgroundPriceSync,
            getSyncState,
            registerBackgroundPriceRunner,
        } = await import('./sync-state.ts');
        const originalRunner = getSyncState().backgroundRunner;
        process.env.INCREMENTAL_SYNC_BATCH_SIZE = '1';

        try {
            registerBackgroundPriceRunner(async (chunk: string[]) => {
                if (chunk[0] === 'FAIL_SYM') {
                    throw new Error('Chunk 1 Yahoo failure');
                }
                return chunk.length;
            });

            enqueueBackgroundPriceSync(['FAIL_SYM', 'OK_SYM']);
            await flushBackgroundPriceSync();

            assert.strictEqual(getSyncState().lastSyncError, 'Chunk 1 Yahoo failure');

            // Subsequent clean drain clears lastSyncError
            enqueueBackgroundPriceSync(['OK_SYM']);
            await flushBackgroundPriceSync();
            assert.strictEqual(getSyncState().lastSyncError, null);
        } finally {
            if (originalRunner) {
                registerBackgroundPriceRunner(originalRunner);
            }
        }
    });

    await t.test('getMarketSyncStatus computes activeSymbolCount, staleSymbolCount, oldestSyncAt, newestSyncAt, and cache versions', async (subT) => {
        subT.mock.timers.enable({
            apis: ['Date'],
            now: new Date('2026-07-15T15:00:00.000Z'), // Wednesday 11:00 ET (Regular hours, 2m TTL)
        });

        try {
            g.__mockSyncPrisma.investment.findMany = async () => [
                { symbol: 'AAPL', currencyCode: 'USD' },
                { symbol: 'MSFT', currencyCode: 'USD' },
            ];
            g.__mockSyncPrisma.activityType.findMany = async () => [{ name: 'BUY', behavior: 'ADD' }];
            g.__mockSyncPrisma.activity.findMany = async () => [
                { type: 'BUY', quantity: 5, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'AAPL' } },
                { type: 'BUY', quantity: 5, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'MSFT' } },
            ];

            const freshTime = new Date(Date.now() - 30 * 1000); // 30s ago -> fresh (<2m)
            const staleTime = new Date(Date.now() - 5 * 60 * 1000); // 5m ago -> stale (>2m)

            g.__mockSyncPrisma.marketDataCache.findMany = async ({ where }: any) => {
                const syms: string[] = where?.symbol?.in || [];
                return syms.map((symbol) => ({
                    symbol,
                    price: symbol === 'MSFT' ? 320 : 190,
                    lastUpdated: symbol === 'MSFT' ? staleTime : freshTime,
                }));
            };

            const status = await getMarketSyncStatus();

            assert.strictEqual(status.isMarketOpen, true);
            assert.strictEqual(status.effectivePriceTtlMs, 120000);
            assert.ok(status.activeSymbolCount >= 2);
            assert.strictEqual(status.staleSymbolCount, 1);
            assert.strictEqual(status.oldestSyncAt, staleTime.toISOString());
            assert.strictEqual(status.newestSyncAt, freshTime.toISOString());
            assert.strictEqual(status.marketDataVersion, getCacheVersions().marketDataVersion);
        } finally {
            subT.mock.timers.reset();
        }
    });
});
