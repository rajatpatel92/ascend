import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPeriodSnapshotFromDailyPerformance,
    buildUserDisplayMap,
    downsampleSparklinePoints,
    formatSnapshotPointLabel,
    getSnapshotRangeStartDateStr,
    groupActivitiesByOwner,
    parseSnapshotRange,
    resolveOwnerName,
    type OwnerActivityLike,
} from './owner-snapshot.ts';
import type { DailyPerformance } from './portfolio-analytics.ts';

function makeActivity(overrides: {
    id: string;
    symbol?: string;
    accountName?: string | null;
    accountId?: string | null;
}): OwnerActivityLike {
    return {
        id: overrides.id,
        accountId: overrides.accountId ?? 'acc-1',
        investmentId: 'inv-1',
        platformId: null,
        type: 'BUY',
        date: new Date('2026-01-10T00:00:00Z'),
        quantity: 10,
        price: 100,
        fee: 0,
        currency: 'USD',
        notes: null,
        createdAt: new Date('2026-01-10T00:00:00Z'),
        updatedAt: new Date('2026-01-10T00:00:00Z'),
        investment: {
            symbol: overrides.symbol ?? 'VFV.TO',
            currencyCode: 'CAD',
        },
        account: overrides.accountName === undefined
            ? { id: overrides.accountId ?? 'acc-1', name: 'rajat' }
            : overrides.accountName === null
                ? null
                : { id: overrides.accountId ?? 'acc-1', name: overrides.accountName },
    } as OwnerActivityLike;
}

test('parseSnapshotRange validates allowed ranges and defaults safely to 1D', () => {
    assert.equal(parseSnapshotRange('1D'), '1D');
    assert.equal(parseSnapshotRange('1w'), '1W');
    assert.equal(parseSnapshotRange('ytd'), 'YTD');
    assert.equal(parseSnapshotRange('ALL'), 'ALL');
    assert.equal(parseSnapshotRange('invalid'), '1D');
    assert.equal(parseSnapshotRange(undefined), '1D');
});

test('resolveOwnerName and groupActivitiesByOwner map usernames case-insensitively and fallback cleanly', () => {
    const users = [
        { username: 'RajatP', name: 'Rajat' },
        { username: 'priya', name: 'Priya' },
        { username: 'noname', name: null },
    ];

    const userMap = buildUserDisplayMap(users);
    assert.equal(resolveOwnerName('rajatp', userMap), 'Rajat');
    assert.equal(resolveOwnerName('Priya', userMap), 'Priya');
    assert.equal(resolveOwnerName('noname', userMap), 'noname');
    assert.equal(resolveOwnerName(null, userMap), 'Unassigned');

    const grouped = groupActivitiesByOwner(
        [
            makeActivity({ id: '1', accountName: 'rajatp', accountId: 'acc-tfsa' }),
            makeActivity({ id: '2', accountName: 'RAJATP', accountId: 'acc-rrsp' }),
            makeActivity({ id: '3', accountName: 'priya', accountId: 'acc-p1' }),
            makeActivity({ id: '4', accountName: null, accountId: null }),
        ],
        users
    );

    assert.equal(grouped.length, 3);
    assert.equal(grouped[0].name, 'Rajat');
    assert.equal(grouped[0].activities.length, 2);
    assert.equal(grouped[1].name, 'Priya');
    assert.equal(grouped[1].activities.length, 1);
    assert.equal(grouped[2].name, 'Unassigned');
    assert.equal(grouped[2].activities.length, 1);
});

test('getSnapshotRangeStartDateStr resolves UTC cutoffs consistently', () => {
    const ref = new Date('2026-06-15T18:30:00.000Z');
    assert.equal(getSnapshotRangeStartDateStr('1D', ref), '2026-06-14');
    assert.equal(getSnapshotRangeStartDateStr('1W', ref), '2026-06-08');
    assert.equal(getSnapshotRangeStartDateStr('1M', ref), '2026-05-15');
    assert.equal(getSnapshotRangeStartDateStr('YTD', ref), '2026-01-01');
    assert.equal(getSnapshotRangeStartDateStr('1Y', ref), '2025-06-15');
    assert.equal(getSnapshotRangeStartDateStr('ALL', ref), '2006-06-15');
});

test('downsampleSparklinePoints preserves endpoints and caps output length', () => {
    const short = [{ date: '2026-01-01', value: 10 }, { date: '2026-01-02', value: 12 }];
    assert.deepEqual(downsampleSparklinePoints(short, 24), short);

    const many = Array.from({ length: 60 }, (_, idx) => ({
        date: `2026-01-${String((idx % 28) + 1).padStart(2, '0')}`,
        value: 100 + idx,
    }));
    const sampled = downsampleSparklinePoints(many, 20);
    assert.equal(sampled.length, 20);
    assert.deepEqual(sampled[0], many[0]);
    assert.deepEqual(sampled[sampled.length - 1], many[many.length - 1]);
});

test('buildPeriodSnapshotFromDailyPerformance isolates deposits via flow-adjusted P&L and TWR', () => {
    const dailyPerf: DailyPerformance[] = [
        // Day before 1W window: baseline MV = 10,000, NAV = 100
        { date: '2026-06-07', marketValue: 10000, nav: 100, netFlow: 10000, units: 100, dividend: 0, unreinvestedDividends: 0 },
        // Day 1 of 1W: User deposits 5,000 (MV jumps to 15,000, NAV still 100 -> 0 market gain)
        { date: '2026-06-08', marketValue: 15000, nav: 100, netFlow: 5000, units: 150, dividend: 0, unreinvestedDividends: 0 },
        // End of 1W: Portfolio appreciates 10% (NAV = 110, MV = 16,500)
        { date: '2026-06-15', marketValue: 16500, nav: 110, netFlow: 0, units: 150, dividend: 0, unreinvestedDividends: 0 },
    ];

    const res = buildPeriodSnapshotFromDailyPerformance({
        dailyPerf,
        range: '1W',
        now: new Date('2026-06-15T16:00:00.000Z'),
    });

    assert.equal(res.netWorth, 16500);
    // True investment gain is 1,500 (16,500 - 10,000 - 5,000), not 6,500
    assert.equal(Math.round(res.change), 1500);
    // True TWR return is 10.00%
    assert.ok(Math.abs(res.changePercent - 10) < 1e-6);
    assert.equal(res.points.length, 2);
});

test('buildPeriodSnapshotFromDailyPerformance handles empty data safely', () => {
    const res = buildPeriodSnapshotFromDailyPerformance({
        dailyPerf: [],
        range: '1M',
    });
    assert.equal(res.netWorth, 0);
    assert.equal(res.change, 0);
    assert.equal(res.changePercent, 0);
    assert.deepEqual(res.points, []);
});

test('formatSnapshotPointLabel formats intraday times and daily dates concisely', () => {
    const intraday = formatSnapshotPointLabel('2026-06-15T14:30:00.000Z', '1D');
    assert.match(intraday, /^\d{2}:\d{2}$/);
    assert.equal(formatSnapshotPointLabel('2026-06-15', '1W'), 'Jun 15');
    assert.equal(formatSnapshotPointLabel('2026-06-15', 'ALL'), 'Jun 15, 26');
});
