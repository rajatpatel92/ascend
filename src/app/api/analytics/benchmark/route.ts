
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';
import { requireAuth } from '@/lib/api-auth';
import { auth } from '@/auth';

export async function POST(req: Request) {
    const authResult = await requireAuth(req, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const body = await req.json();
        const { timeRange, benchmarkSymbol, filters } = body;

        // Determine Start Date
        let startDate = new Date();
        if (timeRange === 'ALL') {
            const firstActivity = await prisma.activity.findFirst({
                orderBy: { date: 'asc' },
                select: { date: true }
            });
            if (firstActivity) {
                startDate = new Date(firstActivity.date);
            } else {
                startDate.setFullYear(startDate.getFullYear() - 1); // Default if no data
            }
        } else {
            switch (timeRange) {
                case '1M': startDate.setMonth(startDate.getMonth() - 1); break;
                case '6M': startDate.setMonth(startDate.getMonth() - 6); break;
                case 'YTD': startDate.setMonth(0, 1); break;
                case '1Y': startDate.setFullYear(startDate.getFullYear() - 1); break;
                case '2Y': startDate.setFullYear(startDate.getFullYear() - 2); break;
                case '3Y': startDate.setFullYear(startDate.getFullYear() - 3); break;
                case '5Y': startDate.setFullYear(startDate.getFullYear() - 5); break;
                default: startDate.setFullYear(startDate.getFullYear() - 1);
            }
        }

        // Build Filter Query
        const whereClause: any = {
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

        // Run Calculation
        const result = await PortfolioAnalytics.calculateComparisonHistory(
            activities as any,
            benchmarkSymbol || '^GSPC',
            startDate
        );

        return NextResponse.json(result);

    } catch (error) {
        console.error('Benchmark Analytics Error', error);
        return NextResponse.json({ error: 'Failed to calculate analytics' }, { status: 500 });
    }
}
