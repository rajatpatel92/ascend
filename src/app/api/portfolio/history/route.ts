
import { NextResponse } from 'next/server';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const session = await auth();
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const range = searchParams.get('range') || '1M';
    const targetCurrency = searchParams.get('currency') || 'CAD';
    const customStart = searchParams.get('startDate');
    const customEnd = searchParams.get('endDate');
    const investmentTypes = searchParams.get('investmentTypes')?.split(',') || [];
    const accountTypes = searchParams.get('accountTypes')?.split(',') || [];

    try {
        // 1. Determine date range
        let startDate = new Date();

        if (range === 'CUSTOM' && customStart && customEnd) {
            startDate = new Date(customStart);
        } else {
            switch (range) {
                case '1D': startDate.setDate(startDate.getDate() - 1); break;
                case '1W': startDate.setDate(startDate.getDate() - 7); break;
                case '1M': startDate.setMonth(startDate.getMonth() - 1); break;
                case '3M': startDate.setMonth(startDate.getMonth() - 3); break;
                case '6M': startDate.setMonth(startDate.getMonth() - 6); break;
                case '1Y': startDate.setFullYear(startDate.getFullYear() - 1); break;
                case '2Y': startDate.setFullYear(startDate.getFullYear() - 2); break;
                case '3Y': startDate.setFullYear(startDate.getFullYear() - 3); break;
                case '5Y': startDate.setFullYear(startDate.getFullYear() - 5); break;
                case '10Y': startDate.setFullYear(startDate.getFullYear() - 10); break;
                case 'YTD': startDate.setMonth(0, 1); break;
                case 'ALL': startDate.setFullYear(startDate.getFullYear() - 20); break;
                default: startDate.setMonth(startDate.getMonth() - 1);
            }
        }

        // Store the requested start date for filtering
        const filterStartDate = new Date(startDate);
        const filterStartDateStr = filterStartDate.toISOString().split('T')[0];

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

        // Set calculation start date to the beginning of history (or first activity)
        if (activities.length > 0) {
            const firstDate = new Date(activities[0].date);
            startDate = firstDate;
        }

        // 3. Run Analytics
        const benchmarkSymbol = '^GSPC';

        // Map activities to match Analytics interface
        const mappedActivities = activities.map(a => ({
            ...a,
            investment: {
                ...a.investment,
                currency: a.investment.currencyCode
            }
        }));

        const result = await PortfolioAnalytics.calculateComparisonHistory(
            mappedActivities,
            benchmarkSymbol,
            startDate,
            targetCurrency
        );

        // 3.5. [NEW] Handle 1D Intraday Override
        if (range === '1D') {
            try {
                // [CACHE] Check In-Memory Cache for 1D
                const filterKey = `${investmentTypes.sort().join('-')}_${accountTypes.sort().join('-')}`;
                const CACHE_KEY = `1D_HISTORY_${targetCurrency}_${filterKey}`;
                const cached = (global as any)._portfolio1DCache;
                const CACHE_TTL = 5 * 60 * 1000; // 5 Minutes

                if (cached && cached.key === CACHE_KEY && (Date.now() - cached.timestamp < CACHE_TTL)) {
                    return NextResponse.json(cached.data);
                }

                // Calculate Intraday
                const intradayParams = mappedActivities;
                const intradayPortfolio = await PortfolioAnalytics.calculateIntradayHistory(intradayParams, targetCurrency);

                if (intradayPortfolio.length > 0) {
                    // Normalize for Chart
                    const openValue = intradayPortfolio[0].marketValue;

                    const normalized = intradayPortfolio.map(p => ({
                        date: p.date, // This is ISO timestamp including time
                        value: p.marketValue,
                        nav: 100 * (p.marketValue / openValue), // Intraday NAV
                        invested: openValue, // Flat line for 1D comparison
                        dividend: 0
                    }));

                    // [CACHE] Set Cache
                    (global as any)._portfolio1DCache = {
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
                dividend: cumulativeDividends
            };
        });

        // Filter out future dates if customEnd was used
        let finalPoints = historyPoints;
        if (range === 'CUSTOM' && customEnd) {
            const endD = new Date(customEnd).toISOString().split('T')[0];
            finalPoints = finalPoints.filter(p => p.date <= endD);
        }

        // Filter by requested Start Date
        finalPoints = finalPoints.filter(p => p.date >= filterStartDateStr);

        return NextResponse.json(finalPoints);

    } catch (error) {
        console.error('Error generating portfolio history:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
