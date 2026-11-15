import type { Activity } from '@prisma/client';
import { computePerformanceChartMetrics, type HistoryPointInput } from './performance-chart.ts';
import type { DailyPerformance } from './portfolio-analytics.ts';

export const OWNER_SNAPSHOT_RANGES = ['1D', '1W', '1M', 'YTD', '1Y', 'ALL'] as const;
export type OwnerSnapshotRange = (typeof OWNER_SNAPSHOT_RANGES)[number];

export const RANGE_DISPLAY_LABELS: Record<OwnerSnapshotRange, string> = {
    '1D': '24H',
    '1W': '1W',
    '1M': '1M',
    YTD: 'YTD',
    '1Y': '1Y',
    ALL: 'ALL',
};

export interface SnapshotPoint {
    date: string;
    value: number;
}

export interface OwnerSnapshotEntry {
    id: string;
    name: string;
    netWorth: number;
    change: number;
    changePercent: number;
    points: SnapshotPoint[];
}

export interface OwnerSnapshotResponse {
    range: OwnerSnapshotRange;
    currency: string;
    updatedAt: string;
    total: {
        netWorth: number;
        change: number;
        changePercent: number;
        points: SnapshotPoint[];
    };
    owners: OwnerSnapshotEntry[];
}

export type OwnerActivityLike = Activity & {
    investment: {
        symbol: string;
        currencyCode?: string | null;
        currency?: string | null;
    };
    account?: {
        id?: string | null;
        name?: string | null;
    } | null;
};

export interface OwnerGroup<T extends OwnerActivityLike> {
    ownerKey: string;
    name: string;
    activities: T[];
}

export function parseSnapshotRange(raw?: string | null): OwnerSnapshotRange {
    const normalized = (raw || '').trim().toUpperCase();
    if ((OWNER_SNAPSHOT_RANGES as readonly string[]).includes(normalized)) {
        return normalized as OwnerSnapshotRange;
    }
    return '1D';
}

export function buildUserDisplayMap(
    users: Array<{ username: string; name?: string | null }>
): Map<string, string> {
    const map = new Map<string, string>();
    for (const u of users) {
        if (u.username && u.name && u.name.trim()) {
            map.set(u.username.trim().toLowerCase(), u.name.trim());
        }
    }
    return map;
}

export function resolveOwnerName(
    accountName: string | null | undefined,
    userMap: Map<string, string>
): string {
    const raw = (accountName || '').trim();
    if (!raw) return 'Unassigned';
    return userMap.get(raw.toLowerCase()) || raw;
}

export function groupActivitiesByOwner<T extends OwnerActivityLike>(
    activities: T[],
    users: Array<{ username: string; name?: string | null }>
): OwnerGroup<T>[] {
    const userMap = buildUserDisplayMap(users);
    const groups = new Map<string, OwnerGroup<T>>();

    for (const activity of activities) {
        const name = resolveOwnerName(activity.account?.name, userMap);
        const ownerKey = name.toLowerCase();
        let group = groups.get(ownerKey);
        if (!group) {
            group = { ownerKey, name, activities: [] };
            groups.set(ownerKey, group);
        }
        group.activities.push(activity);
    }

    return Array.from(groups.values());
}

export function getSnapshotRangeStartDateStr(
    range: OwnerSnapshotRange,
    now: Date = new Date()
): string {
    const startDate = new Date(now);
    startDate.setUTCHours(0, 0, 0, 0);

    switch (range) {
        case '1D':
            startDate.setUTCDate(startDate.getUTCDate() - 1);
            break;
        case '1W':
            startDate.setUTCDate(startDate.getUTCDate() - 7);
            break;
        case '1M':
            startDate.setUTCMonth(startDate.getUTCMonth() - 1);
            break;
        case 'YTD':
            startDate.setUTCMonth(0, 1);
            break;
        case '1Y':
            startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
            break;
        case 'ALL':
            startDate.setUTCFullYear(startDate.getUTCFullYear() - 20);
            break;
    }

    return startDate.toISOString().split('T')[0];
}

/**
 * Uniformly downsamples a time series to at most `maxPoints` entries while
 * always preserving the opening and closing points so sparklines keep exact endpoints.
 */
export function downsampleSparklinePoints(
    points: SnapshotPoint[],
    maxPoints: number = 24
): SnapshotPoint[] {
    if (points.length <= maxPoints || maxPoints < 2) {
        return points;
    }

    const sampled: SnapshotPoint[] = [];
    const lastIdx = points.length - 1;

    for (let i = 0; i < maxPoints; i++) {
        const targetIdx = i === maxPoints - 1
            ? lastIdx
            : Math.round((i / (maxPoints - 1)) * lastIdx);
        sampled.push(points[targetIdx]);
    }

    return sampled;
}

export function buildPeriodSnapshotFromDailyPerformance(params: {
    dailyPerf: DailyPerformance[];
    range: OwnerSnapshotRange;
    now?: Date;
    maxPoints?: number;
}): {
    netWorth: number;
    change: number;
    changePercent: number;
    points: SnapshotPoint[];
    peakMarketValue: number;
} {
    const { dailyPerf, range, now = new Date(), maxPoints = 24 } = params;

    if (dailyPerf.length === 0) {
        return {
            netWorth: 0,
            change: 0,
            changePercent: 0,
            points: [],
            peakMarketValue: 0,
        };
    }

    let cumulativeFlow = 0;
    let cumulativeDividends = 0;

    const historyPoints: HistoryPointInput[] = dailyPerf.map((p) => {
        cumulativeFlow += p.netFlow;
        cumulativeDividends += p.dividend || 0;
        return {
            date: p.date,
            value: p.marketValue,
            nav: p.nav,
            invested: cumulativeFlow,
            dividend: cumulativeDividends,
            unreinvestedDividend: p.unreinvestedDividends ?? 0,
        };
    });

    const filterStartDateStr = getSnapshotRangeStartDateStr(range, now);
    const firstIdx = historyPoints.findIndex((p) => p.date >= filterStartDateStr);
    const windowPoints = firstIdx >= 0 ? historyPoints.slice(firstIdx) : [];

    if (windowPoints.length === 0) {
        const last = historyPoints[historyPoints.length - 1];
        return {
            netWorth: last?.value || 0,
            change: 0,
            changePercent: 0,
            points: [],
            peakMarketValue: last?.value || 0,
        };
    }

    const prev = firstIdx > 0
        ? historyPoints[firstIdx - 1]
        : { value: 0, invested: 0, nav: 100, unreinvestedDividend: 0 };

    windowPoints[0] = {
        ...windowPoints[0],
        priorValue: prev.value,
        priorInvested: prev.invested,
        priorNav: prev.nav,
        priorUnreinvestedDividend: prev.unreinvestedDividend,
    };

    const metrics = computePerformanceChartMetrics({
        data: windowPoints,
        range,
    });

    const rawPoints: SnapshotPoint[] = windowPoints.map((p) => ({
        date: p.date,
        value: p.value,
    }));

    const peakMarketValue = windowPoints.reduce(
        (max, p) => (p.value > max ? p.value : max),
        0
    );

    const lastPoint = windowPoints[windowPoints.length - 1];

    return {
        netWorth: lastPoint.value,
        change: metrics.valueChange,
        changePercent: metrics.returnChange,
        points: downsampleSparklinePoints(rawPoints, maxPoints),
        peakMarketValue,
    };
}

export function formatSnapshotPointLabel(dateStr: string, range: OwnerSnapshotRange): string {
    if (!dateStr) return '';

    // Intraday timestamps (ISO datetime) -> short HH:MM in local display
    if (range === '1D' && dateStr.includes('T')) {
        const parsed = new Date(dateStr);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });
        }
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const utcDate = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        if (range === 'ALL' || range === '1Y') {
            return utcDate.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: '2-digit',
                timeZone: 'UTC',
            });
        }
        return utcDate.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
        });
    }

    return dateStr;
}
