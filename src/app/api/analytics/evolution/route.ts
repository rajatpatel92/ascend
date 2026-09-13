import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { auth } from '@/auth';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';

export async function POST(req: Request) {
    const session = await auth();
    if (!session?.user) {
        return new NextResponse('Unauthorized', { status: 401 });
    }

    try {
        const { filters, range, currency, mode } = await req.json();
        // Build base query
        const where: any = {};

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
        const filteredActivities = activities.filter(a => {
            if (!a.account) return false; // Filter out orphans

            if (filters?.assetClasses?.length > 0) {
                if (!filters.assetClasses.includes(a.investment.type)) return false;
            }
            if (filters?.accountTypes?.length > 0) {
                if (!filters.accountTypes.includes(a.account.type)) return false;
            }
            if (filters?.accountNames?.length > 0) {
                if (!filters.accountNames.includes(a.account.name)) return false;
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

        const response: any = {};

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

            const { portfolio, debug } = await PortfolioAnalytics.calculateComparisonHistory(
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
                    invested: cumulativeInvested
                };
            });
            response.evolution = evolutionWithInvested;
            if (mode === 'flows') {
                const keysM = response.dividends.month.map((d: any) => d.date);
                console.log(`[DiffDebug] Dividend Month Keys: ${keysM.slice(-3)}`);
            }
        }

        return NextResponse.json(response);

    } catch (error) {
        console.error('Evolution API Error:', error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
