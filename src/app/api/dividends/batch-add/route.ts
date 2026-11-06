import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireAuth } from '@/lib/api-auth';

export async function POST(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const body = await request.json();
        const { dividends } = body;

        if (!Array.isArray(dividends)) {
            return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
        }

        const results = [];
        const activitiesToCreate = [];

        // 1. Collect Unique Keys for Bulk Queries
        const uniqueSymbols = [...new Set(dividends.map(div => div.symbol))];
        const uniqueAccountIds = [...new Set(dividends.filter(div => !!div.accountId).map(div => div.accountId))];

        // 2. Bulk Fetch Required Data
        const [investments, accounts] = await Promise.all([
            prisma.investment.findMany({
                where: { symbol: { in: uniqueSymbols } }
            }),
            prisma.account.findMany({
                where: { id: { in: uniqueAccountIds } }
            })
        ]);

        // 3. Create Lookup Maps
        const investmentMap = new Map(investments.map(inv => [inv.symbol, inv]));
        const accountMap = new Map(accounts.map(acc => [acc.id, acc]));

        for (const div of dividends) {
            try {
                // 1. Find Investment from Map
                const investment = investmentMap.get(div.symbol);

                if (!investment) {
                    results.push({ symbol: div.symbol, status: 'error', message: 'Investment not found' });
                    continue;
                }

                // 2. Find Account and Platform from Map
                let platformId = null;
                if (div.accountId) {
                    const account = accountMap.get(div.accountId);
                    if (account) {
                        platformId = account.platformId;
                    }
                }

                // 3. Prepare Dividend Activity
                activitiesToCreate.push({
                    investmentId: investment.id,
                    type: 'DIVIDEND',
                    date: new Date(div.date),
                    quantity: div.quantity,
                    price: div.rate, // Storing rate in price field
                    fee: 0,
                    currency: div.currency,
                    accountId: div.accountId || null,
                    platformId: platformId
                });

                // 4. Handle Reinvestment (DRIP)
                if (div.reinvest && div.price > 0) {
                    const rawQty = div.amount / div.price;
                    const reinvestQty = Math.round(rawQty * 10000) / 10000;

                    activitiesToCreate.push({
                        investmentId: investment.id,
                        type: 'BUY',
                        date: new Date(div.date),
                        quantity: reinvestQty,
                        price: div.price,
                        fee: 0,
                        currency: div.currency,
                        accountId: div.accountId || null,
                        platformId: platformId
                    });
                }

                results.push({ symbol: div.symbol, status: 'success' });

            } catch (err) {
                console.error(`Error processing dividend for ${div.symbol}:`, err);
                results.push({ symbol: div.symbol, status: 'error', message: 'Internal error' });
            }
        }

        // 5. Bulk Create Activities
        if (activitiesToCreate.length > 0) {
            await prisma.activity.createMany({
                data: activitiesToCreate
            });
        }

        return NextResponse.json({ results });

    } catch (error) {
        console.error('Error batch adding dividends:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
