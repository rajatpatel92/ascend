import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    const session = await auth();
    if (!session?.user) {
        return new NextResponse('Unauthorized', { status: 401 });
    }

    try {
        const { filters, currency, mode } = await req.json();
        // Build base query
        const where: Record<string, unknown> = {};

        // Apply Filters if present
        if (filters?.accountIds?.length > 0) {
            where.accountId = { in: filters.accountIds };
        }

        const activities = await prisma.activity.findMany({
            where,
            include: {
                investment: true,
                account: true
            },
            orderBy: { date: 'asc' }
        });

        // 2. Apply granular filters
        // # Reason: Match /api/portfolio and /api/portfolio/history by retaining unassigned
        // activities unless an account-level filter is explicitly applied.
        const filteredActivities = activities.filter(a => {
            if (filters?.assetClasses?.length > 0) {
                if (!filters.assetClasses.includes(a.investment.type)) return false;
            }
            if (filters?.accountTypes?.length > 0) {
                if (!a.account || !filters.accountTypes.includes(a.account.type)) return false;
            }
            if (filters?.accountNames?.length > 0) {
                if (!a.account || !filters.accountNames.includes(a.account.name)) return false;
            }
            if (filters?.assets?.length > 0) {
                if (!filters.assets.includes(a.investment.symbol)) return false;
            }
            return true;
        }).map(a => ({
            ...a,
            investment: {
                ...a.investment,
                currency: a.investment.currencyCode
            }
        }));

        console.log(`[Evolution API] Total Activities: ${activities.length}`);
        console.log(`[Evolution API] Filtered Activities: ${filteredActivities.length}`);

        const response: Record<string, unknown> = {};

        // Mode Handling
        // 'flows': Contributions and Dividends (Fast)
        // 'evolution': Portfolio Value History (Slow)

        if (!mode || mode === 'flows') {
            const { contributions, dividends } = await PortfolioAnalytics.calculateFlows(
                filteredActivities,
                currency || 'CAD'
            );
            response.contributions = contributions;
            response.dividends = dividends;
        }

        if (!mode || mode === 'evolution') {
            const startDate = new Date();
            // Determine start date based on Range or Data
            if (filteredActivities.length > 0) {
                startDate.setTime(new Date(filteredActivities[0].date).getTime());
            } else {
                startDate.setFullYear(startDate.getFullYear() - 1);
            }

            const { portfolio } = await PortfolioAnalytics.calculateComparisonHistory(
                filteredActivities,
                '^GSPC', // Dummy
                startDate, // Calc from inception (or first activity) for accuracy
                currency || 'CAD'
            );

            // Map to HistoryPoint format
            let cumulativeInvested = 0;
            const evolutionWithInvested = portfolio.map(p => {
                cumulativeInvested += p.netFlow;
                return {
                    date: p.date,
                    value: p.marketValue,
                    invested: cumulativeInvested,
                    dividend: p.dividend || 0,
                    unreinvestedDividend: p.unreinvestedDividends ?? 0
                };
            });
            response.evolution = evolutionWithInvested;
        }

        return NextResponse.json(response);

    } catch (error) {
        console.error('Evolution API Error:', error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
