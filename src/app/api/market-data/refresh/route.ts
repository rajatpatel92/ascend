import { NextResponse } from 'next/server';
import { MarketDataService } from '@/lib/market-data';
import { auth } from '@/auth';

export async function POST(request: Request) {
    try {
        const session = await auth();
        if (!session) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { symbol } = body;

        if (!symbol) {
            return NextResponse.json({ error: 'Symbol is required' }, { status: 400 });
        }

        // Trigger refresh but don't wait for it if we want it truly async, 
        // OR wait for it if this is a manual "Refresh" button click.
        // For the button, it's better to wait so we can show success state.
        await MarketDataService.refreshMarketData(symbol);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error in refresh endpoint:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
