
import { NextResponse } from 'next/server';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from '@/lib/prisma';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { auth } from '@/auth';
import { requireAuth } from '@/lib/api-auth';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';
import { getCacheVersions } from '@/lib/cache-invalidation';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    // Authenticate via requireAuth (evaluates await auth() and API key, returning 401 if unauthorized)
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }



    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '1M';
    const targetCurrency = searchParams.get('currency') || 'CAD';
    const customStart = searchParams.get('startDate');
    const customEnd = searchParams.get('endDate');
    const investmentTypes = searchParams.get('investmentTypes')?.split(',').map(s => s.trim()).filter(Boolean) || [];
    const accountTypes = searchParams.get('accountTypes')?.split(',').map(s => s.trim()).filter(Boolean) || [];

    try {
        // 1. Determine date range in UTC
        const startDate = new Date();
        startDate.setUTCHours(0, 0, 0, 0);

        if (range === 'CUSTOM' && customStart && customEnd) {
            const parsedStart = new Date(customStart);
            if (!Number.isNaN(parsedStart.getTime())) {
                startDate.setTime(parsedStart.getTime());
                startDate.setUTCHours(0, 0, 0, 0);
            }
        } else {
            switch (range) {
                case '1D': startDate.setUTCDate(startDate.getUTCDate() - 1); break;
                case '1W': startDate.setUTCDate(startDate.getUTCDate() - 7); break;
                case '1M': startDate.setUTCMonth(startDate.getUTCMonth() - 1); break;
                case '3M': startDate.setUTCMonth(startDate.getUTCMonth() - 3); break;
                case '6M': startDate.setUTCMonth(startDate.getUTCMonth() - 6); break;
                case '1Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 1); break;
                case '2Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 2); break;
                case '3Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 3); break;
                case '5Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 5); break;
                case '10Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 10); break;
                case 'YTD': startDate.setUTCMonth(0, 1); break;
                case 'ALL': startDate.setUTCFullYear(startDate.getUTCFullYear() - 20); break;
                default: startDate.setUTCMonth(startDate.getUTCMonth() - 1);
            }
        }

        // Store the requested start date for filtering
        const filterStartDateStr = startDate.toISOString().split('T')[0];

        // 2. Fetch ALL activities (include Account for filtering)
        const allActivities = await prisma.activity.findMany({
            include: {
                investment: true,
                account: true,
                platform: true
            },
            orderBy: { date: 'asc' }
        });

        // Apply Filters
        let activities = allActivities;
        if (investmentTypes.length > 0) {
            activities = activities.filter(a => investmentTypes.includes(a.investment.type));
        }
        if (accountTypes.length > 0) {
            activities = activities.filter(a => a.account && accountTypes.includes(a.account.type));
        }

        if (activities.length === 0) {
            return NextResponse.json([]);
        }

        // Map activities to match Analytics interface
        const mappedActivities = activities.map(a => ({
            ...a,
            investment: {
                ...a.investment,
                currency: a.investment.currencyCode
            }
        }));

        // 2.5. Fast-path 1D Intraday BEFORE full multi-year comparison replay
        if (range === '1D') {
            try {
                const filterKey = `${[...investmentTypes].sort().join('-')}_${[...accountTypes].sort().join('-')}`;
                const latestActTs = activities.reduce((max, a) => {
                    const t = Math.max(
                        new Date(a.date).getTime() || 0,
                        new Date((a as { updatedAt?: Date | string }).updatedAt || 0).getTime() || 0
                    );
                    return t > max ? t : max;
                }, 0);
                const { marketDataVersion, portfolioMutationVersion } = getCacheVersions();
                const CACHE_KEY = `1D_HISTORY_${targetCurrency}_${filterKey}_${activities.length}_${latestActTs}_v${marketDataVersion}_${portfolioMutationVersion}`;
                const cached = (globalThis as any)._portfolio1DCache;
                const CACHE_TTL = 5 * 60 * 1000; // 5 Minutes

                if (cached && cached.key === CACHE_KEY && (Date.now() - cached.timestamp < CACHE_TTL)) {
                    return NextResponse.json(cached.data);
                }

                const intradayPortfolio = await PortfolioAnalytics.calculateIntradayHistory(mappedActivities, targetCurrency);

                if (intradayPortfolio.length > 0) {
                    const openValue = intradayPortfolio[0].marketValue;
                    const normalized = intradayPortfolio.map(p => ({
                        date: p.date,
                        value: p.marketValue,
                        nav: openValue > 0 ? 100 * (p.marketValue / openValue) : 100,
                        invested: openValue,
                        dividend: 0,
                        unreinvestedDividend: 0
                    }));

                    (globalThis as any)._portfolio1DCache = {
                        key: CACHE_KEY,
                        data: normalized,
                        timestamp: Date.now()
                    };

                    return NextResponse.json(normalized);
                }
            } catch (e) {
                console.error('Intraday Calc Failed, falling back to daily', e);
            }
        }

        // 3. Run Analytics from earliest activity so principal, NAV, and dividend cash pools carry forward cleanly
        const benchmarkSymbol = '^GSPC';
        const calcStartDate = new Date(activities[0].date);
        const result = await PortfolioAnalytics.calculateComparisonHistory(
            mappedActivities,
            benchmarkSymbol,
            calcStartDate,
            targetCurrency
        );

        // 4. Map to Response
        let cumulativeFlow = 0;
        let cumulativeDividends = 0;
        const historyPoints = result.portfolio.map(p => {
            cumulativeFlow += p.netFlow;
            cumulativeDividends += (p.dividend || 0);

            return {
                date: p.date,
                value: p.marketValue,
                nav: p.nav,
                invested: cumulativeFlow,
                dividend: cumulativeDividends,
                unreinvestedDividend: p.unreinvestedDividends ?? 0
            };
        });

        // Filter out future dates if customEnd was used
        let boundedPoints = historyPoints;
        if (range === 'CUSTOM' && customEnd) {
            const parsedEnd = new Date(customEnd);
            if (!Number.isNaN(parsedEnd.getTime())) {
                const endD = parsedEnd.toISOString().split('T')[0];
                boundedPoints = boundedPoints.filter(p => p.date <= endD);
            }
        }

        // Filter by requested Start Date and attach pre-window baseline for accurate sub-range deltas
        const firstIdx = boundedPoints.findIndex(p => p.date >= filterStartDateStr);
        const finalPoints = firstIdx >= 0 ? boundedPoints.slice(firstIdx) : [];

        if (finalPoints.length > 0) {
            const prev = firstIdx > 0
                ? boundedPoints[firstIdx - 1]
                : { value: 0, invested: 0, nav: 100, unreinvestedDividend: 0 };
            finalPoints[0] = {
                ...finalPoints[0],
                priorValue: prev.value,
                priorInvested: prev.invested,
                priorNav: prev.nav,
                priorUnreinvestedDividend: prev.unreinvestedDividend
            } as typeof finalPoints[number] & {
                priorValue: number;
                priorInvested: number;
                priorNav: number;
                priorUnreinvestedDividend: number;
            };
        }

        return NextResponse.json(finalPoints);

    } catch (error) {
        console.error('Error generating portfolio history:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
