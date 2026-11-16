import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isValidCronSecret } from '@/lib/api-auth';
import { runFullMarketSync } from '@/lib/market-sync';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    const bearerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    const headerKey = request.headers.get('x-cron-secret') || bearerToken;
    const streamMode = searchParams.get('stream') === 'true';
    const staleOnly = searchParams.get('staleOnly') === 'true';

    const session = await auth();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isAdmin = (session?.user as any)?.role === 'ADMIN';

    if (!isValidCronSecret(headerKey) && !isValidCronSecret(key) && !isAdmin) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (streamMode) {
        const encoder = new TextEncoder();
        let closed = false;
        const customStream = new ReadableStream({
            async start(controller) {
                const log = (msg: string) => {
                    if (closed) return;
                    try {
                        controller.enqueue(encoder.encode(msg + '\n'));
                    } catch {
                        closed = true;
                    }
                };
                try {
                    await runFullMarketSync({ force: !staleOnly }, log);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err || 'Unknown error');
                    log(`[Error] Sync aborted: ${msg}`);
                } finally {
                    if (!closed) {
                        closed = true;
                        try {
                            controller.close();
                        } catch {
                            // Stream already closed or canceled by client
                        }
                    }
                }
            },
            cancel() {
                closed = true;
            }
        });
        return new Response(customStream, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Transfer-Encoding': 'chunked',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    }

    const logs: string[] = [];
    const log = (msg: string) => {
        console.log(msg);
        logs.push(msg);
    };
    const result = await runFullMarketSync({ force: !staleOnly }, log);
    return NextResponse.json({
        message: 'Completed',
        stats: result.stats,
        coalesced: result.coalesced,
        logs,
        timestamp: new Date().toISOString()
    });
}
