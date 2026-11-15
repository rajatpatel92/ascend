import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';
import { ACTIVE_QUANTITY_EPSILON } from '@/lib/activity-helpers';
import { MarketDataService } from '@/lib/market-data';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';
import {
    buildPeriodSnapshotFromDailyPerformance,
    downsampleSparklinePoints,
    groupActivitiesByOwner,
    parseSnapshotRange,
    type OwnerSnapshotEntry,
    type OwnerSnapshotResponse,
    type SnapshotPoint,
} from '@/lib/owner-snapshot';

export const dynamic = 'force-dynamic';

interface SnapshotCacheEntry {
    timestamp: number;
    data: OwnerSnapshotResponse;
}

const CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 24;

function getSnapshotCache(): Map<string, SnapshotCacheEntry> {
    const g = globalThis as typeof globalThis & {
        _ownerSnapshotCache?: Map<string, SnapshotCacheEntry>;
    };
    if (!g._ownerSnapshotCache) {
        g._ownerSnapshotCache = new Map<string, SnapshotCacheEntry>();
    }
    return g._ownerSnapshotCache;
}

export async function GET(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const { searchParams } = new URL(request.url);
        const range = parseSnapshotRange(searchParams.get('range'));
        const targetCurrency = (searchParams.get('currency') || 'CAD').trim().toUpperCase() || 'CAD';

        const [allActivities, users] = await Promise.all([
            prisma.activity.findMany({
                include: {
                    investment: true,
                    account: true,
                },
                orderBy: { date: 'asc' },
            }),
            prisma.user.findMany({
                select: {
                    username: true,
                    name: true,
                },
            }),
        ]);

        if (allActivities.length === 0) {
            const emptyResponse: OwnerSnapshotResponse = {
                range,
                currency: targetCurrency,
                updatedAt: new Date().toISOString(),
                total: { netWorth: 0, change: 0, changePercent: 0, points: [] },
                owners: [],
            };
            return NextResponse.json(emptyResponse);
        }

        const latestActTs = allActivities.reduce((max, a) => {
            const t = Math.max(
                new Date(a.date).getTime() || 0,
                new Date(a.updatedAt || 0).getTime() || 0
            );
            return t > max ? t : max;
        }, 0);

        const cacheKey = `${range}_${targetCurrency}_${allActivities.length}_${latestActTs}`;
        const cache = getSnapshotCache();
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
            return NextResponse.json(cached.data);
        }

        const mappedActivities = allActivities.map((a) => ({
            ...a,
            investment: {
                ...a.investment,
                currency: a.investment.currencyCode,
            },
        }));

        const ownerGroups = groupActivitiesByOwner(mappedActivities, users);
        const now = new Date();
        let owners: OwnerSnapshotEntry[] = [];
        let total = {
            netWorth: 0,
            change: 0,
            changePercent: 0,
            points: [] as SnapshotPoint[],
        };

        if (range === '1D') {
            const ownerHoldingsList = ownerGroups.map((group) => ({
                group,
                holdings: PortfolioAnalytics.computeHoldingsState(group.activities),
            }));

            const symbolCurrencyMap = new Map<string, string>();
            for (const act of mappedActivities) {
                symbolCurrencyMap.set(act.investment.symbol, act.investment.currency || 'USD');
            }

            const activeSymbols = new Set<string>();
            for (const { holdings } of ownerHoldingsList) {
                for (const [sym, qty] of Object.entries(holdings)) {
                    if (qty > ACTIVE_QUANTITY_EPSILON) {
                        activeSymbols.add(sym);
                    }
                }
            }

            const quoteMap = new Map<
                string,
                { price: number; change: number; currency: string }
            >();
            const sourceCurrencies = new Set<string>();
            const nowMs = now.getTime();

            await Promise.all(
                Array.from(activeSymbols).map(async (sym) => {
                    try {
                        const q = await MarketDataService.getPrice(sym);
                        const price = q?.price || 0;
                        let change = q?.regularMarketChange || 0;
                        const quoteCurrency = (q?.currency || symbolCurrencyMap.get(sym) || 'USD').toUpperCase();

                        if (q?.regularMarketTime) {
                            const dataMs = new Date(q.regularMarketTime).getTime();
                            const diffHours = (nowMs - dataMs) / (1000 * 60 * 60);
                            if (diffHours > 24) {
                                change = 0;
                            }
                        }

                        quoteMap.set(sym, { price, change, currency: quoteCurrency });
                        if (quoteCurrency !== 'USD') {
                            sourceCurrencies.add(quoteCurrency);
                        }
                    } catch {
                        const fallbackCur = (symbolCurrencyMap.get(sym) || 'USD').toUpperCase();
                        quoteMap.set(sym, { price: 0, change: 0, currency: fallbackCur });
                    }
                })
            );

            const rateToUsdMap = new Map<string, number>([['USD', 1]]);
            let usdToTarget = 1;

            await Promise.all([
                ...Array.from(sourceCurrencies).map(async (cur) => {
                    try {
                        const rate = await MarketDataService.getExchangeRate(cur, 'USD');
                        rateToUsdMap.set(cur, rate && rate > 0 ? rate : 1);
                    } catch {
                        rateToUsdMap.set(cur, 1);
                    }
                }),
                (async () => {
                    if (targetCurrency !== 'USD') {
                        try {
                            const rate = await MarketDataService.getExchangeRate('USD', targetCurrency);
                            if (rate && rate > 0) usdToTarget = rate;
                        } catch {
                            usdToTarget = 1;
                        }
                    }
                })(),
            ]);

            const activeOwners = ownerHoldingsList
                .map(({ group, holdings }) => {
                    let netWorth = 0;
                    let change = 0;

                    for (const [sym, qty] of Object.entries(holdings)) {
                        if (qty <= ACTIVE_QUANTITY_EPSILON) continue;
                        const quote = quoteMap.get(sym);
                        if (!quote || quote.price <= 0) continue;

                        const conversionRate = (rateToUsdMap.get(quote.currency) ?? 1) * usdToTarget;
                        netWorth += qty * quote.price * conversionRate;
                        change += qty * quote.change * conversionRate;
                    }

                    const prev = netWorth - change;
                    const changePercent = netWorth > 0 && prev > 0 ? (change / prev) * 100 : 0;

                    return {
                        group,
                        netWorth,
                        change,
                        changePercent,
                    };
                })
                .filter((o) => o.netWorth > 0.01 || Math.abs(o.change) > 0.01);

            const totalNetWorth = activeOwners.reduce((sum, o) => sum + o.netWorth, 0);
            const totalChange = activeOwners.reduce((sum, o) => sum + o.change, 0);
            const prevTotal = totalNetWorth - totalChange;
            const totalChangePercent =
                totalNetWorth > 0 && prevTotal > 0 ? (totalChange / prevTotal) * 100 : 0;

            const buildBaselinePoints = (nw: number, delta: number): SnapshotPoint[] => {
                if (nw <= 0.01) return [];
                const prevDate = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
                return [
                    { date: prevDate, value: Math.max(0, nw - delta) },
                    { date: now.toISOString(), value: nw },
                ];
            };

            const [totalIntraday, ...ownerIntradayLists] = await Promise.all([
                activeOwners.length > 0
                    ? PortfolioAnalytics.calculateIntradayHistory(mappedActivities, targetCurrency).catch(() => [])
                    : Promise.resolve([]),
                ...activeOwners.map((o) =>
                    PortfolioAnalytics.calculateIntradayHistory(o.group.activities, targetCurrency).catch(() => [])
                ),
            ]);

            const normalizeIntraday = (
                raw: Array<{ date: string; marketValue: number }>,
                fallbackNw: number,
                fallbackDelta: number
            ): SnapshotPoint[] => {
                const mapped = raw.map((p) => ({ date: p.date, value: p.marketValue }));
                if (mapped.length >= 2) {
                    return downsampleSparklinePoints(mapped, 24);
                }
                return buildBaselinePoints(fallbackNw, fallbackDelta);
            };

            owners = activeOwners.map((o, idx) => ({
                id: o.group.ownerKey,
                name: o.group.name,
                netWorth: o.netWorth,
                change: o.change,
                changePercent: o.changePercent,
                points: normalizeIntraday(ownerIntradayLists[idx] || [], o.netWorth, o.change),
            }));

            total = {
                netWorth: totalNetWorth,
                change: totalChange,
                changePercent: totalChangePercent,
                points: normalizeIntraday(totalIntraday, totalNetWorth, totalChange),
            };
        } else {
            const [totalResult, ...ownerResults] = await Promise.all([
                PortfolioAnalytics.calculateComparisonHistory(
                    mappedActivities,
                    '^GSPC',
                    new Date(mappedActivities[0].date),
                    targetCurrency
                ),
                ...ownerGroups.map((group) =>
                    PortfolioAnalytics.calculateComparisonHistory(
                        group.activities,
                        '^GSPC',
                        new Date(group.activities[0].date),
                        targetCurrency
                    )
                ),
            ]);

            const totalSnapshot = buildPeriodSnapshotFromDailyPerformance({
                dailyPerf: totalResult.portfolio,
                range,
                now,
            });

            total = {
                netWorth: totalSnapshot.netWorth,
                change: totalSnapshot.change,
                changePercent: totalSnapshot.changePercent,
                points: totalSnapshot.points,
            };

            owners = ownerGroups
                .map((group, idx) => {
                    const snap = buildPeriodSnapshotFromDailyPerformance({
                        dailyPerf: ownerResults[idx]?.portfolio || [],
                        range,
                        now,
                    });
                    return {
                        id: group.ownerKey,
                        name: group.name,
                        netWorth: snap.netWorth,
                        change: snap.change,
                        changePercent: snap.changePercent,
                        points: snap.points,
                        peakMarketValue: snap.peakMarketValue,
                    };
                })
                .filter(
                    (o) =>
                        o.netWorth > 0.01 ||
                        Math.abs(o.change) > 0.01 ||
                        o.peakMarketValue > 0.01
                )
                .map(({ peakMarketValue: _ignored, ...entry }) => {
                    void _ignored;
                    return entry;
                });
        }

        owners.sort((a, b) => {
            const diff = b.netWorth - a.netWorth;
            if (Math.abs(diff) > 0.01) return diff;
            return a.name.localeCompare(b.name);
        });

        const payload: OwnerSnapshotResponse = {
            range,
            currency: targetCurrency,
            updatedAt: now.toISOString(),
            total,
            owners,
        };

        if (cache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey) cache.delete(oldestKey);
        }
        cache.set(cacheKey, { timestamp: Date.now(), data: payload });

        return NextResponse.json(payload);
    } catch (error) {
        console.error('Error generating owner net worth snapshot:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
