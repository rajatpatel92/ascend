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

test('computeActivityNetAmount and computeActivitiesSummary compute accurate cash totals', () => {
    assert.strictEqual(computeActivityNetAmount(sampleActivities[0]), 1005); // BUY: 10*100 + 5
    assert.strictEqual(computeActivityNetAmount(sampleActivities[1]), 5); // DIVIDEND: 10*0.5 - 0
    assert.strictEqual(computeActivityNetAmount(sampleActivities[2]), 390); // SELL: 2*200 - 10
    assert.strictEqual(computeActivityNetAmount(sampleActivities[3]), 0); // STOCK_SPLIT: 0

    // Suppose CAD=1, USD=1.4
    const convert = (amount: number, cur: string) => (cur === 'USD' ? amount * 1.4 : amount);
    const summary = computeActivitiesSummary(sampleActivities, convert);

    assert.strictEqual(summary.totalCount, 4);
    assert.strictEqual(summary.uniqueSymbolsCount, 3);
    assert.strictEqual(summary.totalInvested, 1005);
    assert.strictEqual(Number(summary.totalProceeds.toFixed(2)), 546); // 390 * 1.4
    assert.strictEqual(summary.totalIncome, 5);
});
