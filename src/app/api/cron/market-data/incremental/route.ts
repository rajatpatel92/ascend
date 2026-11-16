import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isValidCronSecret } from '@/lib/api-auth';
import { runIncrementalSync } from '@/lib/market-sync';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    const bearerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const headerKey = request.headers.get('x-cron-secret') || bearerToken;

    const session = await auth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isAdmin = (session?.user as any)?.role === 'ADMIN';

    if (!isValidCronSecret(headerKey) && !isValidCronSecret(key) && !isAdmin) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        console.log('[Cron:Incremental] Starting Price-Only Refresh...');
        const result = await runIncrementalSync({
            force: true,
            reason: 'cron-http',
        });

        console.log(`[Cron:Incremental] Done. ${result.stats.success}/${result.stats.total} updated.`);
        return NextResponse.json({
            message: 'Incremental Refresh Done',
            stats: result.stats,
            coalesced: result.coalesced,
            syncedAt: result.syncedAt,
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        console.error('[Cron:Incremental] Failed:', error);
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
