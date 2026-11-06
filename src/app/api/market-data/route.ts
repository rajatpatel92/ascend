import { NextResponse } from 'next/server';
import { MarketDataService } from '@/lib/market-data';
import { requireAuth } from '@/lib/api-auth';
import { auth } from '@/auth';

export async function GET(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) return authResult.response;

    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');

    if (!symbol) {
        return NextResponse.json({ error: 'Symbol parameter is required' }, { status: 400 });
    }

    const data = await MarketDataService.getPrice(symbol);

    if (!data) {
        return NextResponse.json({ error: 'Symbol not found' }, { status: 404 });
    }

    return NextResponse.json(data);
}
