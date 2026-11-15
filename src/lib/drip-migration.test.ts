import test from 'node:test';
import assert from 'node:assert';
import { scanDripCandidates, type DripScanActivity } from './drip-migration.ts';

function makeActivity(overrides: Partial<DripScanActivity>): DripScanActivity {
    return {
        id: 'act-1',
        type: 'BUY',
        date: '2025-03-15T00:00:00.000Z',
        quantity: 1,
        price: 100,
        fee: 0,
        currency: 'USD',
        investmentId: 'inv-1',
        accountId: 'acc-1',
        investment: { symbol: 'AAPL', name: 'Apple Inc.' },
        account: { name: 'Rajat', type: 'RRSP' },
        platform: { name: 'Wealthsimple' },
        ...overrides
    };
}

test('scanDripCandidates puts +-1 day exact cost and 4-decimal DRIP matches in HIGH confidence', () => {
    const activities: DripScanActivity[] = [
        // 1) Exact cost same-day batch pair
        makeActivity({
            id: 'div-1',
            type: 'DIVIDEND',
            date: '2025-03-15T00:00:00.000Z',
            quantity: 100,
            price: 0.25, // $25.00 dividend
            createdAt: '2025-03-15T12:00:00.000Z'
        }),
        makeActivity({
            id: 'buy-1',
            type: 'BUY',
            date: '2025-03-15T00:00:00.000Z',
            quantity: 0.25,
            price: 100, // $25.00 exact total cost
            fee: 0,
            createdAt: '2025-03-15T12:00:02.000Z'
        }),
        // 2) +1 day DRIP with 4-decimal rounding
        makeActivity({
            id: 'div-2',
            type: 'DIVIDEND',
            date: '2025-06-15T00:00:00.000Z',
            investmentId: 'inv-2',
            investment: { symbol: 'MSFT', name: 'Microsoft' },
            quantity: 50,
            price: 0.83 // $41.50
        }),
        makeActivity({
            id: 'buy-2',
            type: 'BUY',
            date: '2025-06-16T00:00:00.000Z',
            investmentId: 'inv-2',
            investment: { symbol: 'MSFT', name: 'Microsoft' },
            quantity: 0.0865,
            price: 480.0 // $41.52 ($0.02 diff within 4-dec rounding)
        }),
        // 3) -1 day posting difference with exact total cost
        makeActivity({
            id: 'div-3',
            type: 'DIVIDEND',
            date: '2025-09-15T00:00:00.000Z',
            investmentId: 'inv-3',
            investment: { symbol: 'VOO', name: 'Vanguard S&P 500' },
            quantity: 20,
            price: 1.5 // $30.00
        }),
        makeActivity({
            id: 'buy-3',
            type: 'BUY',
            date: '2025-09-14T00:00:00.000Z',
            investmentId: 'inv-3',
            investment: { symbol: 'VOO', name: 'Vanguard S&P 500' },
            quantity: 0.06,
            price: 500 // $30.00 exact match
        })
    ];

    const result = scanDripCandidates(activities);

    assert.strictEqual(result.candidates.length, 3);
    assert.strictEqual(result.summary.highCount, 3);
    assert.strictEqual(result.summary.mediumCount, 0);

    const byBuyId = new Map(result.candidates.map((c) => [c.buyId, c]));
    assert.strictEqual(byBuyId.get('buy-1')?.confidence, 'HIGH');
    assert.ok(byBuyId.get('buy-1')?.reasons.includes('Exact Cost Match'));
    assert.ok(byBuyId.get('buy-1')?.reasons.includes('Ascend Batch'));

    assert.strictEqual(byBuyId.get('buy-2')?.confidence, 'HIGH');
    assert.strictEqual(byBuyId.get('buy-2')?.dayDiff, 1);

    assert.strictEqual(byBuyId.get('buy-3')?.confidence, 'HIGH');
    assert.strictEqual(byBuyId.get('buy-3')?.dayDiff, -1);
    assert.ok(byBuyId.get('buy-3')?.reasons.includes('Exact Cost Match'));
});

test('scanDripCandidates prioritizes exact BUY total cost over co-occurring DCA buy and skips paired dividends', () => {
    const activities: DripScanActivity[] = [
        // Dividend of $47.83 on same day as BOTH a $500 DCA buy and a $47.83 DRIP buy
        makeActivity({
            id: 'div-a',
            type: 'DIVIDEND',
            date: '2025-04-01T00:00:00.000Z',
            quantity: 100,
            price: 0.4783 // $47.83
        }),
        makeActivity({
            id: 'buy-dca',
            type: 'BUY',
            date: '2025-04-01T00:00:00.000Z',
            quantity: 5,
            price: 100, // $500 DCA buy (should NOT match)
            fee: 0
        }),
        makeActivity({
            id: 'buy-exact-with-fee',
            type: 'BUY',
            date: '2025-04-01T00:00:00.000Z',
            quantity: 0.4683,
            price: 100,
            fee: 1.0, // total cost = 46.83 + 1.00 = $47.83 exact match!
        }),
        // Already-migrated DRIP dividend should NOT be matched again to a nearby buy
        makeActivity({
            id: 'div-already-drip',
            type: 'DIVIDEND',
            date: '2025-05-01T00:00:00.000Z',
            quantity: 100,
            price: 0.5 // $50.00
        }),
        makeActivity({
            id: 'drip-existing',
            type: 'DRIP',
            date: '2025-05-01T00:00:00.000Z',
            quantity: 0.5,
            price: 100 // $50.00 already DRIP
        }),
        makeActivity({
            id: 'buy-unrelated',
            type: 'BUY',
            date: '2025-05-01T00:00:00.000Z',
            quantity: 0.5,
            price: 100 // Same amount regular buy on same day -> must not steal div-already-drip
        })
    ];

    const result = scanDripCandidates(activities);

    assert.strictEqual(result.candidates.length, 1);
    assert.strictEqual(result.candidates[0].buyId, 'buy-exact-with-fee');
    assert.strictEqual(result.candidates[0].confidence, 'HIGH');
    assert.ok(result.candidates[0].reasons.includes('Exact Cost Match'));
    assert.strictEqual(result.summary.existingDripCount, 1);
    assert.strictEqual(result.summary.totalScannedBuys, 3);
});

test('scanDripCandidates classifies +2..+5d, whole-share, and net-of-tax matches in MEDIUM and rejects mismatches', () => {
    const activities: DripScanActivity[] = [
        // Whole-share DRIP (+2d): $210 dividend -> 2 shares @ $90 = $180 (< 1 share leftover)
        makeActivity({
            id: 'div-whole',
            type: 'DIVIDEND',
            date: '2025-01-10T00:00:00.000Z',
            investmentId: 'inv-whole',
            quantity: 100,
            price: 2.1 // $210
        }),
        makeActivity({
            id: 'buy-whole',
            type: 'BUY',
            date: '2025-01-12T00:00:00.000Z',
            investmentId: 'inv-whole',
            quantity: 2,
            price: 90 // $180, remainder $30 < $90 share price
        }),
        // Net-of-tax DRIP (+1d): $100 dividend -> $85 reinvested (15% WHT)
        makeActivity({
            id: 'div-wht',
            type: 'DIVIDEND',
            date: '2025-02-10T00:00:00.000Z',
            investmentId: 'inv-wht',
            quantity: 100,
            price: 1.0 // $100
        }),
        makeActivity({
            id: 'buy-wht',
            type: 'BUY',
            date: '2025-02-11T00:00:00.000Z',
            investmentId: 'inv-wht',
            quantity: 0.85,
            price: 100 // $85 (85% of $100)
        }),
        // Out of window (+10d) -> rejected
        makeActivity({
            id: 'div-late',
            type: 'DIVIDEND',
            date: '2025-03-01T00:00:00.000Z',
            investmentId: 'inv-late',
            quantity: 50,
            price: 1.0
        }),
        makeActivity({
            id: 'buy-late',
            type: 'BUY',
            date: '2025-03-11T00:00:00.000Z',
            investmentId: 'inv-late',
            quantity: 0.5,
            price: 100
        }),
        // Different account -> rejected
        makeActivity({
            id: 'div-other-acc',
            type: 'DIVIDEND',
            date: '2025-04-01T00:00:00.000Z',
            investmentId: 'inv-acc',
            accountId: 'acc-1',
            quantity: 50,
            price: 1.0
        }),
        makeActivity({
            id: 'buy-other-acc',
            type: 'BUY',
            date: '2025-04-01T00:00:00.000Z',
            investmentId: 'inv-acc',
            accountId: 'acc-2',
            quantity: 0.5,
            price: 100
        })
    ];

    const result = scanDripCandidates(activities);

    assert.strictEqual(result.candidates.length, 2);
    assert.strictEqual(result.summary.highCount, 0);
    assert.strictEqual(result.summary.mediumCount, 2);

    const byBuyId = new Map(result.candidates.map((c) => [c.buyId, c]));
    assert.strictEqual(byBuyId.get('buy-whole')?.matchKind, 'WHOLE_SHARE');
    assert.strictEqual(byBuyId.get('buy-wht')?.matchKind, 'NET_OF_TAX');
});
