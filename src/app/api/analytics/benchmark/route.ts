
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    const authResult = await requireAuth(req, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const body = await req.json();
        const { timeRange, benchmarkSymbol, filters, currency } = body;
        const targetCurrency = typeof currency === 'string' && currency.trim() ? currency : 'CAD';

        // Determine Start Date using UTC midnight so ISO date partitioning stays exact
        const now = new Date();
        let startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        if (timeRange === 'ALL') {
            const firstActivity = await prisma.activity.findFirst({
                orderBy: { date: 'asc' },
                select: { date: true }
            });
            if (firstActivity) {
                startDate = new Date(firstActivity.date);
            } else {
                startDate.setUTCFullYear(startDate.getUTCFullYear() - 1); // Default if no data
            }
        } else {
            switch (timeRange) {
                case '1M': startDate.setUTCMonth(startDate.getUTCMonth() - 1); break;
                case '6M': startDate.setUTCMonth(startDate.getUTCMonth() - 6); break;
                case 'YTD': startDate.setUTCMonth(0, 1); break;
                case '1Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 1); break;
                case '2Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 2); break;
                case '3Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 3); break;
                case '5Y': startDate.setUTCFullYear(startDate.getUTCFullYear() - 5); break;
                default: startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
            }
        }

        // Build Filter Query
        const whereClause: Record<string, unknown> = {
            investment: { not: undefined } // Ensure linked investment
        };

        if (filters) {
            if (filters.accountIds && filters.accountIds.length > 0) {
                whereClause.accountId = { in: filters.accountIds };
            }
            if (filters.accountTypes && filters.accountTypes.length > 0) {
                whereClause.account = { type: { in: filters.accountTypes } };
            }
            if (filters.investmentTypes && filters.investmentTypes.length > 0) {
                // InvestmentType is usually on the Investment model
                whereClause.investment = {
                    type: { in: filters.investmentTypes }
                };
            }
        }

        // Fetch Activities
        const activities = await prisma.activity.findMany({
            where: whereClause,
            include: {
                investment: true,
                account: true
            },
            orderBy: { date: 'asc' }
        });

        const formattedActivities = activities.map((a) => ({
            ...a,
            investment: a.investment
                ? { ...a.investment, currency: a.investment.currencyCode }
                : a.investment
        }));

        // Run Calculation
        const result = await PortfolioAnalytics.calculateComparisonHistory(
            formattedActivities as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0],
            benchmarkSymbol || '^GSPC',
            startDate,
            targetCurrency
        );

        return NextResponse.json(result);

    } catch (error) {
        console.error('Benchmark Analytics Error', error);
        return NextResponse.json({ error: 'Failed to calculate analytics' }, { status: 500 });
    }
}
