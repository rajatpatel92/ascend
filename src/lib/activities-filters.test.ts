import test from 'node:test';
import assert from 'node:assert';
import {
    UNASSIGNED_OWNER_KEY,
    computeActivitiesSummary,
    computeActivityNetAmount,
    deriveActivityFilterOptions,
    filterActivities,
    normalizeActivityYmd,
    resolveActivityOwner,
    type ActivityRecord,
    type ActivityUser
} from './activities-filters.ts';

const sampleUsers: ActivityUser[] = [
    { id: 'u1', username: 'rajat', name: 'Rajat Patel' },
    { id: 'u2', username: 'priya', name: 'Priya Patel' },
    { id: 'u3', username: 'guest', name: '' }
];

const sampleActivities: ActivityRecord[] = [
    {
        id: 'a1',
        type: 'BUY',
        date: '2026-03-10T00:00:00.000Z',
        quantity: 10,
        price: 100,
        fee: 5,
        currency: 'CAD',
        investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
        platform: { id: 'p1', name: 'Wealthsimple' },
        account: { id: 'acc1', name: 'rajat', type: 'TFSA', platformId: 'p1' }
    },
    {
        id: 'a2',
        type: 'DIVIDEND',
        date: '2026-03-01T00:00:00.000Z',
        quantity: 10,
        price: 0.5,
        fee: 0,
        currency: 'CAD',
        investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
        platform: { id: 'p1', name: 'Questrade' },
        account: { id: 'acc2', name: 'rajat', type: 'RRSP', platformId: 'p2' }
    },
    {
        id: 'a3',
        type: 'SELL',
        date: '2025-11-15T00:00:00.000Z',
        quantity: 2,
        price: 200,
        fee: 10,
        currency: 'USD',
        investment: { symbol: 'AAPL', name: 'Apple Inc.', currencyCode: 'USD', type: 'Stock' },
        platform: { id: 'p2', name: 'Questrade' },
        account: { id: 'acc3', name: 'priya', type: 'Margin', platformId: 'p2' }
    },
    {
        id: 'a4',
        type: 'STOCK_SPLIT',
        date: '2025-06-01T00:00:00.000Z',
        quantity: 4,
        price: 0,
        fee: 0,
        currency: 'USD',
        investment: { symbol: 'NVDA', name: 'NVIDIA Corp.', currencyCode: 'USD', type: 'Stock' },
        platform: { id: 'p2', name: 'Questrade' },
        account: null
    }
];

test('resolveActivityOwner', () => {
    assert.deepStrictEqual(resolveActivityOwner({ name: 'rajat' }, sampleUsers), {
        key: 'rajat',
        label: 'Rajat Patel'
    });

    // Case-insensitive username match
    assert.deepStrictEqual(resolveActivityOwner({ name: 'PRIYA' }, sampleUsers), {
        key: 'PRIYA',
        label: 'Priya Patel'
    });

    // Falls back to raw username when user display name is blank
    assert.deepStrictEqual(resolveActivityOwner({ name: 'guest' }, sampleUsers), {
        key: 'guest',
        label: 'guest'
    });

    // Handles null/missing account cleanly
    assert.deepStrictEqual(resolveActivityOwner(null, sampleUsers), {
        key: UNASSIGNED_OWNER_KEY,
        label: 'Unassigned'
    });
});

test('deriveActivityFilterOptions deduplicates owners across multiple accounts and resolves names', () => {
    const options = deriveActivityFilterOptions(sampleActivities, sampleUsers);

    // rajat has TFSA + RRSP but should appear once as "Rajat Patel"
    assert.deepStrictEqual(options.owners, [
        { value: 'priya', label: 'Priya Patel' },
        { value: 'rajat', label: 'Rajat Patel' },
        { value: UNASSIGNED_OWNER_KEY, label: 'Unassigned' }
    ]);

    assert.deepStrictEqual(options.accountTypes, ['Margin', 'RRSP', 'TFSA']);
    assert.deepStrictEqual(options.platforms, ['Questrade', 'Wealthsimple']);
    assert.deepStrictEqual(options.symbols, ['AAPL', 'NVDA', 'VFV.TO']);
    assert.deepStrictEqual(options.activityTypes, ['BUY', 'DIVIDEND', 'SELL', 'STOCK_SPLIT']);
});

test('filterActivities filters accurately by owner, date ranges, and combined criteria', () => {
    const refNow = new Date(2026, 2, 15); // 2026-03-15 local

    // Filter by Owner "rajat" includes both TFSA and RRSP activities
    const rajatOnly = filterActivities(sampleActivities, { range: 'ALL', owner: 'rajat' }, refNow);
    assert.deepStrictEqual(rajatOnly.map((a) => a.id), ['a1', 'a2']);

    // Filter by Unassigned owner
    const unassignedOnly = filterActivities(sampleActivities, { range: 'ALL', owner: UNASSIGNED_OWNER_KEY }, refNow);
    assert.deepStrictEqual(unassignedOnly.map((a) => a.id), ['a4']);

    // YTD filter (2026-01-01 onwards)
    const ytd = filterActivities(sampleActivities, { range: 'YTD' }, refNow);
    assert.deepStrictEqual(ytd.map((a) => a.id), ['a1', 'a2']);

    // 1W filter (from 2026-03-08)
    const oneWeek = filterActivities(sampleActivities, { range: '1W' }, refNow);
    assert.deepStrictEqual(oneWeek.map((a) => a.id), ['a1']);

    // Custom single-sided and bounded date range
    const customRange = filterActivities(
        sampleActivities,
        { range: 'CUSTOM', customStart: '2025-10-01', customEnd: '2026-03-05' },
        refNow
    );
    assert.deepStrictEqual(customRange.map((a) => a.id), ['a2', 'a3']);

    // Combined owner + accountType filter
    const rajatRrsp = filterActivities(
        sampleActivities,
        { range: 'ALL', owner: 'rajat', accountType: 'RRSP' },
        refNow
    );
    assert.deepStrictEqual(rajatRrsp.map((a) => a.id), ['a2']);
});

test('normalizeActivityYmd handles ISO and calendar dates', () => {
    assert.strictEqual(normalizeActivityYmd('2026-03-10T00:00:00.000Z'), '2026-03-10');
    assert.strictEqual(normalizeActivityYmd('2026-03-10'), '2026-03-10');
    assert.strictEqual(normalizeActivityYmd('invalid-date'), '');
});

test('computeActivityNetAmount and computeActivitiesSummary compute accurate net capital flows and fees', () => {
    assert.strictEqual(computeActivityNetAmount(sampleActivities[0]), 1005); // BUY: 10*100 + 5
    assert.strictEqual(computeActivityNetAmount(sampleActivities[1]), 5); // DIVIDEND: 10*0.5 - 0
    assert.strictEqual(computeActivityNetAmount(sampleActivities[2]), 390); // SELL: 2*200 - 10
    assert.strictEqual(computeActivityNetAmount(sampleActivities[3]), 0); // STOCK_SPLIT: 0

    // Suppose CAD=1, USD=1.4
    const convert = (amount: number, cur: string) => (cur === 'USD' ? amount * 1.4 : amount);
    const summary = computeActivitiesSummary(sampleActivities, convert);

    assert.strictEqual(summary.totalCount, 4);
    assert.strictEqual(summary.uniqueSymbolsCount, 3);
    assert.strictEqual(summary.buyCount, 1);
    assert.strictEqual(summary.sellCount, 1);
    assert.strictEqual(summary.dripCount, 0);
    assert.strictEqual(summary.capitalInflows, 1005); // DIVIDEND excluded
    assert.strictEqual(Number(summary.capitalOutflows.toFixed(2)), 546); // 390 * 1.4
    assert.strictEqual(Number(summary.netCapitalFlow.toFixed(2)), 459); // 1005 - 546 (net inflow)
    assert.strictEqual(Number(summary.totalFees.toFixed(2)), 19); // 5 + 10 * 1.4
});

test('computeActivitiesSummary handles net capital outflow, DEPOSIT/WITHDRAWAL, paired transfers, and standalone FEE', () => {
    const outflowAndTransferActivities: ActivityRecord[] = [
        {
            id: 't1',
            type: 'DEPOSIT',
            date: '2026-01-10T00:00:00.000Z',
            quantity: 1,
            price: 500,
            fee: 0,
            currency: 'USD',
            investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
            platform: { id: 'p1', name: 'Wealthsimple' },
            account: { id: 'acc1', name: 'rajat', type: 'TFSA' }
        },
        {
            id: 't2',
            type: 'WITHDRAWAL',
            date: '2026-02-10T00:00:00.000Z',
            quantity: 1,
            price: 1200,
            fee: 15,
            currency: 'USD',
            investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
            platform: { id: 'p1', name: 'Wealthsimple' },
            account: { id: 'acc1', name: 'rajat', type: 'TFSA' }
        },
        {
            id: 't3',
            type: 'TRANSFER_OUT',
            date: '2026-02-15T00:00:00.000Z',
            quantity: 5,
            price: 100,
            fee: 0,
            currency: 'USD',
            investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
            platform: { id: 'p1', name: 'Wealthsimple' },
            account: { id: 'acc1', name: 'rajat', type: 'TFSA' }
        },
        {
            id: 't4',
            type: 'TRANSFER_IN',
            date: '2026-02-15T00:00:00.000Z',
            quantity: 5,
            price: 100,
            fee: 0,
            currency: 'USD',
            investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
            platform: { id: 'p2', name: 'Questrade' },
            account: { id: 'acc2', name: 'rajat', type: 'TFSA' }
        },
        {
            id: 't5',
            type: 'FEE',
            date: '2026-02-20T00:00:00.000Z',
            quantity: 1,
            price: 25,
            fee: 0,
            currency: 'USD',
            investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
            platform: { id: 'p2', name: 'Questrade' },
            account: { id: 'acc2', name: 'rajat', type: 'TFSA' }
        }
    ];

    const summary = computeActivitiesSummary(outflowAndTransferActivities, (amt) => amt);

    // DEPOSIT (500) + TRANSFER_IN (500) = 1000
    assert.strictEqual(summary.capitalInflows, 1000);
    // WITHDRAWAL (1200 - 15 = 1185) + TRANSFER_OUT (500) = 1685
    assert.strictEqual(summary.capitalOutflows, 1685);
    // Paired transfers cancel cleanly -> net capital outflow of 685 (-685)
    assert.strictEqual(summary.netCapitalFlow, -685);
    // WITHDRAWAL fee (15) + standalone FEE (25) = 40
    assert.strictEqual(summary.totalFees, 40);

    // Paired transfers alone net strictly to 0
    const transfersOnly = computeActivitiesSummary([outflowAndTransferActivities[2], outflowAndTransferActivities[3]], (amt) => amt);
    assert.strictEqual(transfersOnly.netCapitalFlow, 0);
});

test('DRIP computes fee-inclusive net cost, increments dripCount, and is excluded from external capital inflows', () => {
    const activitiesWithDrip: ActivityRecord[] = [
        {
            id: 'd1',
            type: 'BUY',
            date: '2026-01-05T00:00:00.000Z',
            quantity: 10,
            price: 100,
            fee: 0,
            currency: 'CAD',
            investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
            platform: { id: 'p1', name: 'Wealthsimple' },
            account: { id: 'acc1', name: 'rajat', type: 'TFSA' }
        },
        {
            id: 'd2',
            type: 'DIVIDEND',
            date: '2026-02-05T00:00:00.000Z',
            quantity: 10,
            price: 2.5,
            fee: 0,
            currency: 'CAD',
            investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
            platform: { id: 'p1', name: 'Wealthsimple' },
            account: { id: 'acc1', name: 'rajat', type: 'TFSA' }
        },
        {
            id: 'd3',
            type: 'DRIP',
            date: '2026-02-05T00:00:00.000Z',
            quantity: 0.24,
            price: 100,
            fee: 1,
            currency: 'CAD',
            investment: { symbol: 'VFV.TO', name: 'Vanguard S&P 500', currencyCode: 'CAD', type: 'ETF' },
            platform: { id: 'p1', name: 'Wealthsimple' },
            account: { id: 'acc1', name: 'rajat', type: 'TFSA' }
        }
    ];

    // Row Total / cost basis for DRIP = (0.24 * 100) + 1 = 25
    assert.strictEqual(computeActivityNetAmount(activitiesWithDrip[2]), 25);

    const summary = computeActivitiesSummary(activitiesWithDrip, (amt) => amt);
    assert.strictEqual(summary.totalCount, 3);
    assert.strictEqual(summary.buyCount, 1);
    assert.strictEqual(summary.sellCount, 0);
    assert.strictEqual(summary.dripCount, 1);
    // External capital inflows only include the manual BUY (1000), NOT the DRIP (25)
    assert.strictEqual(summary.capitalInflows, 1000);
    assert.strictEqual(summary.netCapitalFlow, 1000);
    assert.strictEqual(summary.totalFees, 1);

    // Filter by DRIP returns only DRIP entries
    const dripOnly = filterActivities(activitiesWithDrip, { range: 'ALL', type: 'DRIP' });
    assert.deepStrictEqual(dripOnly.map((a) => a.id), ['d3']);
});
