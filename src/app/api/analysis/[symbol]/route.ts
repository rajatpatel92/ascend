import { NextResponse } from 'next/server';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';
import { requireAuth } from '@/lib/api-auth';
import { ACTIVE_QUANTITY_EPSILON, buildBehaviorMap } from '@/lib/activity-helpers';
import {
    analyzeDividendHistory,
    buildPerShareDividendEventsFromActivities,
    type PortfolioActivityLike
} from '@/lib/dividend-estimator';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, props: { params: Promise<{ symbol: string }> }) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) return authResult.response;

    const params = await props.params;
    const { symbol } = params;

    try {
        // 1. Fetch Investment and Activities
        const investment = await prisma.investment.findUnique({
            where: { symbol },
            include: {
                activities: {
                    include: {
                        platform: true,
                        account: true
                    },
                    orderBy: { date: 'asc' }
                }
            }
        });

        if (!investment) {
            return NextResponse.json({ error: 'Investment not found' }, { status: 404 });
        }

        // 2. Fetch Market Data
        const marketData = await MarketDataService.getPrice(symbol);

        // Auto-update name if we have a better one from market data
        if (marketData?.name && marketData.name !== investment.name) {
            await prisma.investment.update({
                where: { id: investment.id },
                data: { name: marketData.name }
            });
            investment.name = marketData.name;
        }

        const historicalPrices = await MarketDataService.getHistoricalPrices(symbol);

        // 3. Calculate Stats (Per-account cost basis + split scoping matching /api/portfolio)
        let totalFees = 0;
        const accountState: Record<string, {
            id: string;
            accountId: string | null;
            quantity: number;
            costBasis: number;
            value: number;
            name: string;
            type: string;
            platformName: string;
        }> = {};
        const appliedSplits = new Set<string>();

        const activityTypes = await prisma.activityType.findMany();
        const behaviorMap = buildBehaviorMap(activityTypes);

        let firstBuyDate: Date | null = null;
        let totalDividends = 0;
        const rawActivities: PortfolioActivityLike[] = [];

        for (const activity of investment.activities) {
            rawActivities.push({
                type: activity.type,
                date: activity.date,
                quantity: activity.quantity,
                price: activity.price,
                fee: activity.fee,
                accountId: activity.accountId
            });

            const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';
            const absQty = Math.abs(activity.quantity);
            const amount = absQty * activity.price;
            const fee = activity.fee || 0;
            totalFees += fee;

            if (behavior === 'SPLIT') {
                const multiplier = absQty;
                if (multiplier > 0) {
                    const dayKey = new Date(activity.date).toISOString().split('T')[0];
                    if (activity.accountId) {
                        for (const [key, acc] of Object.entries(accountState)) {
                            if (acc.accountId === activity.accountId && acc.quantity > 0) {
                                const dedupKey = `${dayKey}:${key}:${multiplier}`;
                                if (!appliedSplits.has(dedupKey)) {
                                    appliedSplits.add(dedupKey);
                                    acc.quantity *= multiplier;
                                }
                            }
                        }
                    } else {
                        const hasUnassigned = Object.values(accountState).some(acc => !acc.accountId && acc.quantity > 0);
                        for (const [key, acc] of Object.entries(accountState)) {
                            if (hasUnassigned && acc.accountId) continue;
                            if (acc.quantity > 0) {
                                const dedupKey = `${dayKey}:${key}:${multiplier}`;
                                if (!appliedSplits.has(dedupKey)) {
                                    appliedSplits.add(dedupKey);
                                    acc.quantity *= multiplier;
                                }
                            }
                        }
                    }
                }
                continue;
            }

            const platformName = activity.platform?.name || 'Unknown';
            const accKey = activity.account
                ? `${activity.account.id}:${platformName}`
                : `__unassigned__:${platformName}`;

            if (!accountState[accKey] && (behavior === 'ADD' || behavior === 'REMOVE')) {
                accountState[accKey] = {
                    id: accKey,
                    accountId: activity.accountId || null,
                    quantity: 0,
                    costBasis: 0,
                    value: 0,
                    name: activity.account?.name || 'Unassigned',
                    type: activity.account?.type || 'Unassigned',
                    platformName
                };
            }

            if (behavior === 'ADD') {
                const acc = accountState[accKey];
                acc.quantity += absQty;
                acc.costBasis += amount + fee;
                if (!firstBuyDate || new Date(activity.date) < firstBuyDate) {
                    firstBuyDate = new Date(activity.date);
                }
            } else if (behavior === 'REMOVE') {
                const acc = accountState[accKey];
                const proportion = acc.quantity > 0 ? Math.min(1, absQty / acc.quantity) : 0;
                const costToRemove = acc.costBasis * proportion;
                acc.quantity = Math.max(0, acc.quantity - absQty);
                if (acc.quantity < 1e-9) acc.quantity = 0;
                acc.costBasis = acc.quantity === 0 ? 0 : Math.max(0, acc.costBasis - costToRemove);
            } else if (activity.type === 'DIVIDEND') {
                totalDividends += Math.max(0, amount - fee);
            }
        }

        let totalQuantity = 0;
        let totalCost = 0;
        const price = marketData?.price || 0;

        Object.values(accountState).forEach(acc => {
            if (acc.quantity <= ACTIVE_QUANTITY_EPSILON) {
                acc.quantity = 0;
                acc.costBasis = 0;
                acc.value = 0;
            } else {
                acc.value = acc.quantity * price;
                totalQuantity += acc.quantity;
                totalCost += acc.costBasis;
            }
        });

        if (totalQuantity <= ACTIVE_QUANTITY_EPSILON) {
            totalQuantity = 0;
            totalCost = 0;
        }

        const value = totalQuantity > 0 ? totalQuantity * price : 0;
        const avgPrice = totalQuantity > 0 ? totalCost / totalQuantity : 0;
        const absoluteReturn = value - totalCost;
        const percentReturn = totalCost > 0 ? (absoluteReturn / totalCost) * 100 : 0;

        // Investment Age
        let investmentAge = 'N/A';
        if (firstBuyDate) {
            const diffTime = Math.abs(new Date().getTime() - firstBuyDate.getTime());
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays > 365) {
                investmentAge = `${(diffDays / 365).toFixed(1)} Years`;
            } else {
                investmentAge = `${diffDays} Days`;
            }
        }

        // Calculate Average Price History (matching post-split chart scale & including fees)
        const avgPriceHistory: Record<string, number> = {};
        const sortedActivities = [...investment.activities].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        const historicalDates = Object.keys(historicalPrices)
            .filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key))
            .sort();

        if (historicalDates.length > 0) {
            const histAccounts = new Map<string, { accountId: string | null; qty: number; cost: number }>();
            const histAppliedAccountSplits = new Set<string>();
            const histAppliedCorporateSplits = new Set<string>();
            let activityIndex = 0;
            let currentCumSplit = 1;

            for (const dateStr of historicalDates) {
                while (activityIndex < sortedActivities.length) {
                    const activity = sortedActivities[activityIndex];
                    const activityDateStr = new Date(activity.date).toISOString().split('T')[0];

                    if (activityDateStr > dateStr) break;

                    const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';
                    const absQty = Math.abs(activity.quantity);
                    const amount = absQty * activity.price;
                    const fee = activity.fee || 0;
                    const accKey = activity.accountId || '__unassigned__';

                    if (behavior === 'ADD') {
                        const acc = histAccounts.get(accKey) || { accountId: activity.accountId || null, qty: 0, cost: 0 };
                        acc.qty += absQty;
                        acc.cost += amount + fee;
                        histAccounts.set(accKey, acc);
                    } else if (behavior === 'REMOVE') {
                        const acc = histAccounts.get(accKey);
                        if (acc && acc.qty > 0) {
                            const proportion = Math.min(1, absQty / acc.qty);
                            acc.cost = Math.max(0, acc.cost - acc.cost * proportion);
                            acc.qty = Math.max(0, acc.qty - absQty);
                            if (acc.qty < 1e-9) {
                                acc.qty = 0;
                                acc.cost = 0;
                            }
                        }
                    } else if (behavior === 'SPLIT' && absQty > 0) {
                        if (activity.accountId) {
                            const acc = histAccounts.get(activity.accountId);
                            const splitAccKey = `${activityDateStr}:${activity.accountId}:${absQty}`;
                            if (acc && acc.qty > 0 && !histAppliedAccountSplits.has(splitAccKey)) {
                                histAppliedAccountSplits.add(splitAccKey);
                                acc.qty *= absQty;
                            }
                        } else {
                            const unassigned = histAccounts.get('__unassigned__');
                            if (unassigned && unassigned.qty > 0) {
                                const splitKey = `${activityDateStr}:__unassigned__:${absQty}`;
                                if (!histAppliedAccountSplits.has(splitKey)) {
                                    histAppliedAccountSplits.add(splitKey);
                                    unassigned.qty *= absQty;
                                }
                            } else {
                                const splitKey = `${activityDateStr}:__global__:${absQty}`;
                                if (!histAppliedAccountSplits.has(splitKey)) {
                                    histAppliedAccountSplits.add(splitKey);
                                    for (const acc of histAccounts.values()) {
                                        acc.qty *= absQty;
                                    }
                                }
                            }
                        }

                        const corpKey = `${activityDateStr}:${absQty}`;
                        if (!histAppliedCorporateSplits.has(corpKey)) {
                            histAppliedCorporateSplits.add(corpKey);
                            currentCumSplit *= absQty;
                        }
                    }

                    activityIndex++;
                }

                let dayQty = 0;
                let dayCost = 0;
                for (const acc of histAccounts.values()) {
                    if (acc.qty > ACTIVE_QUANTITY_EPSILON) {
                        dayQty += acc.qty;
                        dayCost += acc.cost;
                    }
                }

                avgPriceHistory[dateStr] = dayQty > ACTIVE_QUANTITY_EPSILON
                    ? (dayCost / dayQty) * currentCumSplit
                    : 0;
            }

            if (currentCumSplit !== 1) {
                for (const dateStr in avgPriceHistory) {
                    avgPriceHistory[dateStr] /= currentCumSplit;
                }
            }
        }

        // Local activity dividend fallback when Yahoo Finance omits ETF dividend metrics
        const startOfToday = new Date();
        startOfToday.setUTCHours(0, 0, 0, 0);
        const hasMarketDividendRate = Boolean(marketData?.dividendRate && marketData.dividendRate > 0);
        const activityDivEvents = !hasMarketDividendRate && rawActivities.length > 0
            ? buildPerShareDividendEventsFromActivities(rawActivities, behaviorMap)
            : [];
        const localDivEstimate = activityDivEvents.length > 0
            ? analyzeDividendHistory(activityDivEvents, {
                now: startOfToday,
                filterLastYearFromNow: true,
                rollForward: true,
                annualizeShortHistory: true
            })
            : undefined;
        const effectiveDividendRate = hasMarketDividendRate
            ? marketData!.dividendRate!
            : (localDivEstimate?.annualizedRate || localDivEstimate?.trailingAnnualRate);
        const effectiveDividendYield = (marketData?.dividendYield && marketData.dividendYield > 0)
            ? marketData.dividendYield
            : (effectiveDividendRate && price > 0 ? effectiveDividendRate / price : undefined);

        return NextResponse.json({
            symbol,
            name: investment.name,
            currency: marketData?.currency || investment.currencyCode || 'USD',
            stats: {
                quantity: totalQuantity,
                avgPrice,
                marketPrice: price,
                totalInvestment: totalCost,
                currentValue: value,
                absoluteReturn,
                percentReturn,
                totalFees,
                totalDividends,
                investmentAge,
                activityCount: investment.activities.length,
                fiftyTwoWeekHigh: marketData?.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: marketData?.fiftyTwoWeekLow,
                sector: marketData?.sector,
                country: marketData?.country,
                sectorAllocations: (marketData as any)?.sectorAllocations,
                countryAllocations: (marketData as any)?.countryAllocations,
                dividendRate: effectiveDividendRate,
                dividendYield: effectiveDividendYield
            },
            allocation: {
                accounts: Object.values(accountState).filter(a => a.quantity > ACTIVE_QUANTITY_EPSILON)
            },
            activities: investment.activities,
            historical: historicalPrices,
            avgPriceHistory
        });

    } catch (error) {
        console.error('Error fetching analysis data:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
