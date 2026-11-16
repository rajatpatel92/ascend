import test from 'node:test';
import assert from 'node:assert';
import {
    getCacheVersions,
    invalidateMarketCaches,
    invalidatePortfolioMutationCaches,
    resetCacheVersionsForTests,
} from './cache-invalidation.ts';

test('cache-invalidation version bumping and selective cache clearing', async (t) => {
    t.beforeEach(() => {
        resetCacheVersionsForTests();
    });

    await t.test('invalidateMarketCaches bumps marketDataVersion and clears derived portfolio caches selectively', () => {
        const g = globalThis as Record<string, unknown>;
        g._portfolio1DCache = { key: '1D_OLD', data: [1, 2], timestamp: Date.now() };
        g._ownerSnapshotCache = new Map([['1D_CAD', { data: {}, timestamp: Date.now() }]]);
        g._marketIntradayCache = new Map([
            ['AAPL', { data: [{ date: '2026-01-01', value: 100 }], timestamp: Date.now() }],
            ['MSFT', { data: [{ date: '2026-01-01', value: 200 }], timestamp: Date.now() }],
        ]);
        g._marketDailyUnadjustedCache = new Map([
            ['AAPL', { data: { '2026-01-01': 100 }, fromTime: 0, timestamp: Date.now() }],
        ]);

        const before = getCacheVersions();
        assert.strictEqual(before.marketDataVersion, 1);
        assert.strictEqual(before.portfolioMutationVersion, 1);

        // Incremental tick invalidation keeps intraday & daily unadjusted caches intact
        invalidateMarketCaches({ symbols: ['AAPL'] });
        const afterTick = getCacheVersions();
        assert.strictEqual(afterTick.marketDataVersion, 2);
        assert.ok(afterTick.lastMarketWriteAt instanceof Date);
        assert.strictEqual(g._portfolio1DCache, null);
        assert.strictEqual((g._ownerSnapshotCache as Map<string, unknown>).size, 0);
        assert.strictEqual((g._marketIntradayCache as Map<string, unknown>).size, 2);
        assert.strictEqual((g._marketDailyUnadjustedCache as Map<string, unknown>).size, 1);

        // Full/split invalidation with clearIntraday + clearDailyUnadjusted deletes only requested symbols
        invalidateMarketCaches({
            symbols: ['AAPL'],
            clearIntraday: true,
            clearDailyUnadjusted: true,
        });
        assert.strictEqual(getCacheVersions().marketDataVersion, 3);
        assert.strictEqual((g._marketIntradayCache as Map<string, unknown>).has('AAPL'), false);
        assert.strictEqual((g._marketIntradayCache as Map<string, unknown>).has('MSFT'), true);
        assert.strictEqual((g._marketDailyUnadjustedCache as Map<string, unknown>).has('AAPL'), false);
    });

    await t.test('invalidatePortfolioMutationCaches bumps portfolioMutationVersion and clears derived caches', () => {
        const g = globalThis as Record<string, unknown>;
        g._portfolio1DCache = { key: '1D_OLD', data: [1], timestamp: Date.now() };
        g._ownerSnapshotCache = new Map([['1M_CAD', { data: {}, timestamp: Date.now() }]]);

        invalidatePortfolioMutationCaches();
        const versions = getCacheVersions();
        assert.strictEqual(versions.marketDataVersion, 1);
        assert.strictEqual(versions.portfolioMutationVersion, 2);
        assert.ok(versions.lastMutationAt instanceof Date);
        assert.strictEqual(g._portfolio1DCache, null);
        assert.strictEqual((g._ownerSnapshotCache as Map<string, unknown>).size, 0);
    });
});
