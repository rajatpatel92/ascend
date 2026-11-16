import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { getMarketSyncStatus } from '@/lib/market-sync';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) {
        return authResult.response;
    }

    try {
        const status = await getMarketSyncStatus();
        return NextResponse.json(status);
    } catch (error) {
        console.error('Error fetching market sync status:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
