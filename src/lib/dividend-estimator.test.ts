import test from 'node:test';
import assert from 'node:assert';
import {
    analyzeDividendHistory,
    buildPerShareDividendEventsFromActivities
} from './dividend-estimator.ts';

test('dividend-estimator', async (t) => {
    await t.test('rolls forward lagging monthly payouts and annualizes short holding history', () => {
        const now = new Date('2026-11-14T00:00:00.000Z');
        const result = analyzeDividendHistory(
            [
                { date: '2026-07-31T00:00:00.000Z', perShareAmount: 0.14 },
                { date: '2026-08-31T00:00:00.000Z', perShareAmount: 0.14 },
                { date: '2026-09-30T00:00:00.000Z', perShareAmount: 0.14 }
            ],
            {
                now,
                rollForward: true,
                annualizeShortHistory: true
            }
        );

        assert.ok(result);
        assert.strictEqual(result.nextAmount, 0.14);
        assert.ok(result.nextDate);
        // Rolled past 2026-10-30 (< 2026-11-14) into 2026-11-29 (>= 2026-11-14)
        assert.strictEqual(result.nextDate.toISOString().split('T')[0], '2026-11-29');
        assert.ok(Math.abs((result.trailingAnnualRate || 0) - 0.42) < 1e-6);
        assert.ok(Math.abs((result.annualizedRate || 0) - 1.68) < 1e-6);
    });

    await t.test('does not roll forward discontinued dividends beyond staleness threshold', () => {
        const now = new Date('2026-11-14T00:00:00.000Z');
        const result = analyzeDividendHistory(
            [
                { date: '2025-01-31T00:00:00.000Z', perShareAmount: 0.25 },
                { date: '2025-02-28T00:00:00.000Z', perShareAmount: 0.25 }
            ],
            {
                now,
                rollForward: true
            }
        );

        assert.ok(result);
        assert.ok(result.nextDate);
        assert.ok(result.nextDate < now);
    });

    await t.test('reconstructs per-share events from per-share, lump-sum, multi-account, and split activities', () => {
        const behaviorMap = new Map<string, string>([
            ['BUY', 'ADD'],
            ['SELL', 'REMOVE'],
            ['DIVIDEND', 'NEUTRAL'],
            ['STOCK_SPLIT', 'SPLIT']
        ]);

        const events = buildPerShareDividendEventsFromActivities(
            [
                { type: 'BUY', date: '2026-01-05T00:00:00.000Z', quantity: 60, price: 50 },
                { type: 'BUY', date: '2026-01-05T00:00:00.000Z', quantity: 40, price: 50 },
                // Multi-account explicit share dividends on the same day -> $0.20/share
                { type: 'DIVIDEND', date: '2026-02-01T00:00:00.000Z', quantity: 60, price: 0.20, fee: 0 },
                { type: 'DIVIDEND', date: '2026-02-01T00:00:00.000Z', quantity: 40, price: 0.20, fee: 0 },
                // 2-for-1 split makes prior $0.20/share equivalent to $0.10/share post-split
                { type: 'STOCK_SPLIT', date: '2026-02-15T00:00:00.000Z', quantity: 2, price: 0 },
                // Post-split lump-sum dividend (qty=1, price=30 across 200 shares -> $0.15/share)
                { type: 'DIVIDEND', date: '2026-03-01T00:00:00.000Z', quantity: 1, price: 30, fee: 0 }
            ],
            behaviorMap
        );

        assert.strictEqual(events.length, 2);
        assert.ok(Math.abs(events[0].perShareAmount - 0.10) < 1e-6);
        assert.ok(Math.abs(events[1].perShareAmount - 0.15) < 1e-6);
    });

    await t.test('does not compound multi-account STOCK_SPLIT rows (ratio^N bug regression)', () => {
        const behaviorMap = new Map<string, string>([
            ['BUY', 'ADD'],
            ['DIVIDEND', 'NEUTRAL'],
            ['STOCK_SPLIT', 'SPLIT']
        ]);

        const events = buildPerShareDividendEventsFromActivities(
            [
                { type: 'BUY', accountId: 'acc-1', date: '2026-01-05T00:00:00.000Z', quantity: 10, price: 100 },
                { type: 'BUY', accountId: 'acc-2', date: '2026-01-05T00:00:00.000Z', quantity: 10, price: 100 },
                // Pre-split dividend lump sum on 20 total shares ($20 -> $1.00/share pre-split)
                { type: 'DIVIDEND', accountId: 'acc-1', date: '2026-02-01T00:00:00.000Z', quantity: 1, price: 10, fee: 0 },
                { type: 'DIVIDEND', accountId: 'acc-2', date: '2026-02-01T00:00:00.000Z', quantity: 1, price: 10, fee: 0 },
                // SplitService writes one 2:1 split row per account
                { type: 'STOCK_SPLIT', accountId: 'acc-1', date: '2026-02-15T00:00:00.000Z', quantity: 2, price: 0 },
                { type: 'STOCK_SPLIT', accountId: 'acc-2', date: '2026-02-15T00:00:00.000Z', quantity: 2, price: 0 },
                // Post-split total shares should be 40 (not 80), lump-sum $20 -> $0.50/share
                { type: 'DIVIDEND', accountId: 'acc-1', date: '2026-03-01T00:00:00.000Z', quantity: 1, price: 10, fee: 0 },
                { type: 'DIVIDEND', accountId: 'acc-2', date: '2026-03-01T00:00:00.000Z', quantity: 1, price: 10, fee: 0 }
            ],
            behaviorMap
        );

        assert.strictEqual(events.length, 2);
        assert.ok(Math.abs(events[0].perShareAmount - 0.50) < 1e-6, `Expected 0.50, got ${events[0].perShareAmount}`);
        assert.ok(Math.abs(events[1].perShareAmount - 0.50) < 1e-6, `Expected 0.50, got ${events[1].perShareAmount}`);
    });

    await t.test('trims 12M boundary overlap for annual and semi-annual dividend series', () => {
        const now = new Date('2026-11-14T00:00:00.000Z');
        const annualRes = analyzeDividendHistory(
            [
                { date: '2025-11-15T00:00:00.000Z', perShareAmount: 2.0 },
                { date: '2026-11-14T00:00:00.000Z', perShareAmount: 2.0 }
            ],
            { now, filterLastYearFromNow: true }
        );
        assert.ok(annualRes);
        assert.ok(Math.abs((annualRes.trailingAnnualRate || 0) - 2.0) < 1e-6);

        const semiRes = analyzeDividendHistory(
            [
                { date: '2025-11-16T00:00:00.000Z', perShareAmount: 1.5 },
                { date: '2026-05-15T00:00:00.000Z', perShareAmount: 1.5 },
                { date: '2026-11-14T00:00:00.000Z', perShareAmount: 1.5 }
            ],
            { now, filterLastYearFromNow: true }
        );
        assert.ok(semiRes);
        assert.ok(Math.abs((semiRes.trailingAnnualRate || 0) - 3.0) < 1e-6);
    });

    await t.test('returns undefined when input events are empty or invalid', () => {
        assert.strictEqual(analyzeDividendHistory([]), undefined);
        assert.strictEqual(
            analyzeDividendHistory([{ date: 'not-a-date', perShareAmount: 0 }]),
            undefined
        );
    });
});
