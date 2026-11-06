import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';
import { auth } from '@/auth';
import { requireAuth } from '@/lib/api-auth';

export async function POST(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }


    try {
        const body = await request.json();
        const { symbol, type, date, quantity, price, fee, platformId, accountId, currency } = body;

        if (!symbol || !type || !date || !quantity || !price || !platformId || !currency) {
            return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
        }

        // 1. Find or Create Investment
        let investment = await prisma.investment.findUnique({
            where: { symbol },
        });

        if (!investment) {
            // Use provided name or fetch details from Yahoo Finance
            const marketData = await MarketDataService.getPrice(symbol);
            const currencyCode = marketData?.currency || 'USD';
            const name = body.name || marketData?.symbol || symbol;

            // Ensure Currency exists
            const dbCurrency = await prisma.currency.findUnique({ where: { code: currencyCode } });
            if (!dbCurrency) {
                // Default rate to 1 if unknown, should be updated via background job or API
                await prisma.currency.create({
                    data: { code: currencyCode, rateToBase: 1.0 },
                });
            }

            investment = await prisma.investment.create({
                data: {
                    symbol,
                    name,
                    type: body.investmentType || 'EQUITY',
                    currencyCode,
                },
            });
        } else if (body.name && investment.name === investment.symbol) {
            // If investment exists but name is just the symbol (fallback), update it with the provided name
            investment = await prisma.investment.update({
                where: { id: investment.id },
                data: { name: body.name }
            });
        }

        // 2. Create Activity
        const activity = await prisma.activity.create({
            data: {
                investmentId: investment.id,
                type,
                date: new Date(date),
                quantity: parseFloat(quantity),
                price: parseFloat(price),
                fee: fee ? parseFloat(fee) : 0,
                currency,
                platformId: platformId,
                accountId: accountId || null,
            },
        });

        // 3. Trigger Async Market Data Refresh
        // We don't await this so the UI returns immediately
        MarketDataService.refreshMarketData(symbol).catch(err =>
            console.error(`Background refresh failed for ${symbol}:`, err)
        );

        return NextResponse.json(activity);
    } catch (error) {
        console.error('Error creating activity:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}

export async function GET(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }


    try {
        const { searchParams } = new URL(request.url);
        const limitParam = searchParams.get('limit');
        const offsetParam = searchParams.get('offset');
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        const offset = offsetParam ? parseInt(offsetParam, 10) : undefined;

        const activities = await prisma.activity.findMany({
            take: limit && !isNaN(limit) && limit > 0 ? Math.min(limit, 500) : undefined,
            skip: offset && !isNaN(offset) && offset >= 0 ? offset : undefined,
            include: {
                investment: true,
                platform: true,
                account: true,
            },
            orderBy: [
                { date: 'desc' },
                { createdAt: 'desc' },
                { id: 'desc' }
            ],
        });
        return NextResponse.json(activities);
    } catch (error) {
        console.error('Error fetching activities:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
