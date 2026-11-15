import test from 'node:test';
import assert from 'node:assert/strict';
import {
    computeRebalancePlan,
    formatShareCount,
    inferPriceInDisplayCurrency,
    normalizeTargetsTo100,
    seedTargetsFromHoldings,
    buildGlidePathSeries,
    type RebalanceItem,
    type TargetConfig
} from './rebalance-planner.ts';

const SAMPLE_ITEMS: RebalanceItem[] = [
    {
        symbol: 'VFV.TO',
        currentPercent: 60,
        targetPercent: 50,
        glidePathPercent: -1,
        driftPercent: 10,
        currentValue: 6000,
        targetValue: 5000,
        driftValue: 1000,
        action: 'SELL',
        actionShares: 10,
        assetPrice: 100,
        assetCurrency: 'CAD'
    },
    {
        symbol: 'XEQT.TO',
        currentPercent: 30,
        targetPercent: 40,
        glidePathPercent: 1,
        driftPercent: -10,
        currentValue: 3000,
        targetValue: 4000,
        driftValue: -1000,
        action: 'BUY',
        actionShares: 25,
        assetPrice: 40,
        assetCurrency: 'CAD'
    },
    {
        symbol: 'ZAG.TO',
        currentPercent: 10,
        targetPercent: 10,
        glidePathPercent: null,
        driftPercent: 0,
        currentValue: 1000,
        targetValue: 1000,
        driftValue: 0,
        action: 'HOLD',
        actionShares: 0,
        assetPrice: 20,
        assetCurrency: 'CAD'
    }
];

test('computeRebalancePlan - FULL mode respects drift tolerance band and calculates turnover', () => {
    const plan = computeRebalancePlan(SAMPLE_ITEMS, {
        mode: 'FULL',
        newCash: 0,
        tolerancePercent: 1,
        wholeShares: false
    });

    assert.equal(plan.summary.totalValue, 10000);
    assert.equal(plan.summary.totalBuyValue, 1000);
    assert.equal(plan.summary.totalSellValue, 1000);
    assert.equal(plan.summary.buyCount, 1);
    assert.equal(plan.summary.sellCount, 1);
    assert.equal(plan.summary.holdCount, 1);
    assert.equal(plan.summary.portfolioTurnoverPercent, 10);
    assert.equal(plan.summary.maxAbsDrift, 10);
    assert.equal(plan.summary.targetSumPercent, 100);
    assert.equal(plan.summary.glideActiveCount, 2);

    const vfv = plan.rows.find((r) => r.symbol === 'VFV.TO')!;
    assert.equal(vfv.effectiveAction, 'SELL');
    assert.equal(vfv.tradeShares, 10);
    assert.equal(vfv.postTradePercent, 50);

    // High tolerance turns trades into HOLD and reports 0% actual turnover
    const wideBand = computeRebalancePlan(SAMPLE_ITEMS, {
        mode: 'FULL',
        newCash: 0,
        tolerancePercent: 12,
        wholeShares: false
    });
    assert.equal(wideBand.summary.buyCount, 0);
    assert.equal(wideBand.summary.sellCount, 0);
    assert.equal(wideBand.summary.holdCount, 3);
    assert.equal(wideBand.summary.portfolioTurnoverPercent, 0);
});

test('computeRebalancePlan - BUY_ONLY mode allocates new cash exclusively to underweight holdings', () => {
    const plan = computeRebalancePlan(SAMPLE_ITEMS, {
        mode: 'BUY_ONLY',
        newCash: 1000,
        tolerancePercent: 0.5,
        wholeShares: false
    });

    // At $11,000 total: VFV target=$5,500 (current $6,000 -> deficit 0),
    // XEQT target=$4,400 (current $3,000 -> deficit $1,400),
    // ZAG target=$1,100 (current $1,000 -> deficit $100). Total deficit = $1,500.
    // $1,000 new cash splits proportionally: XEQT gets 1000 * 1400/1500 = 933.33, ZAG gets 66.67. Zero sells!
    assert.equal(plan.summary.sellCount, 0);
    assert.equal(plan.summary.totalSellValue, 0);
    assert.ok(Math.abs(plan.summary.totalBuyValue - 1000) < 0.01);
    assert.ok(Math.abs(plan.summary.postTradeTotalValue - 11000) < 0.01);
    // One-way trade-based turnover: 1000 / (2 * 11000) * 100 = 4.545...%
    assert.ok(Math.abs(plan.summary.portfolioTurnoverPercent - (1000 / 22000) * 100) < 0.001);

    const vfv = plan.rows.find((r) => r.symbol === 'VFV.TO')!;
    const xeqt = plan.rows.find((r) => r.symbol === 'XEQT.TO')!;
    const zag = plan.rows.find((r) => r.symbol === 'ZAG.TO')!;

    assert.equal(vfv.effectiveAction, 'HOLD');
    assert.equal(xeqt.effectiveAction, 'BUY');
    assert.equal(zag.effectiveAction, 'BUY');
    assert.ok(Math.abs(xeqt.tradeValue - 933.3333) < 0.01);
    assert.ok(Math.abs(zag.tradeValue - 66.6667) < 0.01);
});

test('computeRebalancePlan - BUY_ONLY wholeShares floors shares to stay within cash budget', () => {
    const plan = computeRebalancePlan(SAMPLE_ITEMS, {
        mode: 'BUY_ONLY',
        newCash: 100,
        tolerancePercent: 0,
        wholeShares: true
    });

    // XEQT ($40/sh) gets ~93.33 -> 2 whole shares ($80). ZAG ($20/sh) gets ~6.67 -> 0 whole shares.
    assert.equal(plan.summary.totalBuyValue, 80);
    assert.equal(plan.summary.unallocatedCash, 20);
    assert.equal(plan.summary.postTradeTotalValue, 10100);
});

test('computeRebalancePlan - wholeShares SELL never oversells held shares', () => {
    const exitItem: RebalanceItem[] = [
        {
            symbol: 'TINY',
            currentPercent: 100,
            targetPercent: 0,
            glidePathPercent: null,
            driftPercent: 100,
            currentValue: 100,
            targetValue: 0,
            driftValue: 100,
            action: 'SELL',
            actionShares: 1,
            assetPrice: 100,
            priceInTargetCurrency: 100,
            assetCurrency: 'USD',
            accounts: [
                { accountId: null, accountName: 'Broker', accountType: 'TAXABLE', platformName: 'Questrade', quantity: 0.99, value: 99 }
            ]
        }
    ];
    const plan = computeRebalancePlan(exitItem, {
        mode: 'FULL',
        newCash: 0,
        tolerancePercent: 0,
        wholeShares: true
    });
    assert.equal(plan.rows[0].tradeShares, 0);
    assert.equal(plan.rows[0].effectiveAction, 'HOLD');
    assert.ok(plan.rows[0].postTradeValue >= 0);

    const multiShareItem: RebalanceItem[] = [
        {
            symbol: 'EXIT.TO',
            currentPercent: 100,
            targetPercent: 0,
            glidePathPercent: null,
            driftPercent: 100,
            currentValue: 205,
            targetValue: 0,
            driftValue: 205,
            action: 'SELL',
            actionShares: 2.05,
            assetPrice: 100,
            priceInTargetCurrency: 100,
            assetCurrency: 'CAD',
            accounts: [
                { accountId: null, accountName: 'TFSA', accountType: 'TFSA', platformName: 'WS', quantity: 2.05, value: 205 }
            ]
        }
    ];
    const multiPlan = computeRebalancePlan(multiShareItem, {
        mode: 'FULL',
        newCash: 0,
        tolerancePercent: 0,
        wholeShares: true
    });
    // Rounded shares would be 2 (<= 2.05 held), never 3 even if drift slightly rounded up
    assert.equal(multiPlan.rows[0].tradeShares, 2);
    assert.ok(multiPlan.rows[0].tradeValue <= multiShareItem[0].currentValue);
});

test('inferPriceInDisplayCurrency prefers priceInTargetCurrency even when driftValue is 0', () => {
    const item: RebalanceItem = {
        symbol: 'AAPL',
        currentPercent: 50,
        targetPercent: 50,
        glidePathPercent: null,
        driftPercent: 0,
        currentValue: 1400,
        targetValue: 1400,
        driftValue: 0,
        action: 'HOLD',
        actionShares: 0,
        assetPrice: 100, // USD
        priceInTargetCurrency: 140, // CAD
        assetCurrency: 'USD'
    };
    assert.equal(inferPriceInDisplayCurrency(item), 140);
});

test('formatShareCount handles fractional and whole modes cleanly', () => {
    assert.equal(formatShareCount(0.24689, false), '0.2469');
    assert.equal(formatShareCount(0.24689, true), '0');
    assert.equal(formatShareCount(13.3333, false), '13.33');
    assert.equal(formatShareCount(13.3333, true), '13');
    assert.equal(formatShareCount(125.67, false), '125.7');
});

test('normalizeTargetsTo100 scales weights to sum to exactly 100.0%', () => {
    const input: TargetConfig[] = [
        { symbol: 'A', targetPercentage: 30, yearlyDriftAdjustment: null },
        { symbol: 'B', targetPercentage: 30, yearlyDriftAdjustment: null },
        { symbol: 'C', targetPercentage: 20, yearlyDriftAdjustment: null }
    ];
    const normalized = normalizeTargetsTo100(input);
    const total = normalized.reduce((s, t) => s + t.targetPercentage, 0);
    assert.equal(Math.round(total * 10) / 10, 100);
});

test('seedTargetsFromHoldings preserves existing glide paths and sums to 100%', () => {
    const existing: TargetConfig[] = [
        { symbol: 'VFV.TO', targetPercentage: 50, yearlyDriftAdjustment: -1.5 }
    ];
    const seeded = seedTargetsFromHoldings(SAMPLE_ITEMS, existing);
    assert.equal(seeded.length, 3);
    const vfv = seeded.find((t) => t.symbol === 'VFV.TO')!;
    assert.equal(vfv.targetPercentage, 60);
    assert.equal(vfv.yearlyDriftAdjustment, -1.5);
    const sum = seeded.reduce((s, t) => s + t.targetPercentage, 0);
    assert.equal(Math.round(sum * 10) / 10, 100);
});

test('buildGlidePathSeries projects target percentages over horizon clamping within [0%, 100%]', () => {
    const targets: TargetConfig[] = [
        { symbol: 'EQ', targetPercentage: 80, yearlyDriftAdjustment: -10 },
        { symbol: 'BOND', targetPercentage: 20, yearlyDriftAdjustment: 10 }
    ];
    const series = buildGlidePathSeries(targets, [0, 5, 10]);
    assert.equal(series[0].EQ, 80);
    assert.equal(series[0].BOND, 20);
    assert.equal(series[1].EQ, 30);
    assert.equal(series[1].BOND, 70);
    assert.equal(series[1].totalPercent, 100);
    // Year 10 clamps EQ at 0 and BOND at 100 (never 120)
    assert.equal(series[2].EQ, 0);
    assert.equal(series[2].BOND, 100);
    assert.equal(series[2].totalPercent, 100);
});
