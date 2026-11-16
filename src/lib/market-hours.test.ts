import test from 'node:test';
import assert from 'node:assert';
import {
    DEFAULT_OFF_HOURS_PRICE_CACHE_TTL_MS,
    DEFAULT_PRICE_CACHE_TTL_MS,
    getEffectivePriceTtlMs,
    getMarketConfig,
    getMarketSessionInfo,
    isNorthAmericanMarketOpen,
} from './market-hours.ts';

test('market-hours session detection and env configuration', async (t) => {
    const savedEnv = { ...process.env };

    t.afterEach(() => {
        process.env = { ...savedEnv };
    });

    await t.test('identifies regular weekday session (Wed 11:00 ET -> UTC 15:00 EDT / 16:00 EST)', () => {
        // 2026-07-15 is a Wednesday (EDT = UTC-4 -> 15:00Z is 11:00 ET)
        const wedMidday = new Date('2026-07-15T15:00:00.000Z');
        const info = getMarketSessionInfo(wedMidday);
        assert.strictEqual(info.isMarketOpen, true);
        assert.strictEqual(info.sessionLabel, 'REGULAR');
        assert.strictEqual(isNorthAmericanMarketOpen(wedMidday), true);

        const ttlInfo = getEffectivePriceTtlMs(wedMidday);
        assert.strictEqual(ttlInfo.ttlMs, DEFAULT_PRICE_CACHE_TTL_MS);
    });

    await t.test('includes 15-minute post-close settlement buffer (16:10 ET)', () => {
        // 2026-07-15 20:10 UTC = 16:10 EDT
        const postCloseBuffer = new Date('2026-07-15T20:10:00.000Z');
        const info = getMarketSessionInfo(postCloseBuffer);
        assert.strictEqual(info.isMarketOpen, true);
        assert.strictEqual(info.sessionLabel, 'REGULAR');
    });

    await t.test('identifies pre-market, after-hours, and weekend sessions with off-hours TTL', () => {
        // Pre-market: 2026-07-15 11:30 UTC = 07:30 EDT
        const preMarket = getMarketSessionInfo(new Date('2026-07-15T11:30:00.000Z'));
        assert.strictEqual(preMarket.isMarketOpen, false);
        assert.strictEqual(preMarket.sessionLabel, 'PRE_MARKET');

        // After-hours: 2026-07-15 23:00 UTC = 19:00 EDT
        const afterHours = new Date('2026-07-15T23:00:00.000Z');
        const afterInfo = getMarketSessionInfo(afterHours);
        assert.strictEqual(afterInfo.isMarketOpen, false);
        assert.strictEqual(afterInfo.sessionLabel, 'AFTER_HOURS');
        assert.strictEqual(getEffectivePriceTtlMs(afterHours).ttlMs, DEFAULT_OFF_HOURS_PRICE_CACHE_TTL_MS);

        // Weekend: 2026-07-18 (Saturday)
        const weekend = new Date('2026-07-18T16:00:00.000Z');
        const weekendInfo = getMarketSessionInfo(weekend);
        assert.strictEqual(weekendInfo.isMarketOpen, false);
        assert.strictEqual(weekendInfo.sessionLabel, 'CLOSED_WEEKEND');
        assert.strictEqual(getEffectivePriceTtlMs(weekend).ttlMs, DEFAULT_OFF_HOURS_PRICE_CACHE_TTL_MS);
    });

    await t.test('respects custom TTL env vars and MARKET_HOURS_AWARE=false override', () => {
        process.env.PRICE_CACHE_TTL_MS = '90000';
        process.env.OFF_HOURS_PRICE_CACHE_TTL_MS = '1200000';
        process.env.METADATA_CACHE_TTL_MS = '7200000';
        process.env.HISTORY_CACHE_TTL_MS = '14400000';
        process.env.MANUAL_REFRESH_COOLDOWN_MS = '25000';
        process.env.INCREMENTAL_SYNC_BATCH_SIZE = '10';
        process.env.MARKET_HOURS_AWARE = 'false';

        const cfg = getMarketConfig();
        assert.strictEqual(cfg.priceCacheTtlMs, 90000);
        assert.strictEqual(cfg.offHoursPriceCacheTtlMs, 1200000);
        assert.strictEqual(cfg.metadataCacheTtlMs, 7200000);
        assert.strictEqual(cfg.historyCacheTtlMs, 14400000);
        assert.strictEqual(cfg.manualRefreshCooldownMs, 25000);
        assert.strictEqual(cfg.incrementalBatchSize, 10);
        assert.strictEqual(cfg.marketHoursAware, false);

        // Even on weekend, MARKET_HOURS_AWARE=false uses regular priceCacheTtlMs
        const weekend = new Date('2026-07-18T16:00:00.000Z');
        assert.strictEqual(getEffectivePriceTtlMs(weekend).ttlMs, 90000);
    });
});
