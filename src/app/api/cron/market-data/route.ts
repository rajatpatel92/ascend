import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';

// Increase max duration for this function if hosting supports it (e.g. Vercel Pro)
// For Hobby, 10s is limit (serverless) or 60s (edge). 
// Since this is a "Reliability" fix, we process sequentially.
export const maxDuration = 60;
export const dynamic = 'force-dynamic';


export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    const headerKey = request.headers.get('x-cron-secret');
    const streamMode = searchParams.get('stream') === 'true';

    // Basic protection
    if (process.env.CRON_SECRET && key !== process.env.CRON_SECRET && headerKey !== process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Shared Logic Wrapper
    const runRefresh = async (log: (msg: string) => void) => {
        try {
            log('[Cron] Starting Market Data Refresh...');
            const investments = await prisma.investment.findMany({ select: { symbol: true } });
            const uniqueSymbols = Array.from(new Set(investments.map(i => i.symbol)));

            // Add Benchmark Symbols (both system and user configured)
            const benchmarks = await prisma.benchmark.findMany({ select: { symbol: true } });
            benchmarks.forEach(b => {
                if (!uniqueSymbols.includes(b.symbol)) uniqueSymbols.push(b.symbol);
            });

            // Add Currency Pairs
            const currencyPairs = ['CAD=X', 'EUR=X', 'GBP=X', 'INR=X', 'AUD=X', 'JPY=X'];
            currencyPairs.forEach(pair => {
                if (!uniqueSymbols.includes(pair)) uniqueSymbols.push(pair);
            });

            log(`[Cron] Found ${uniqueSymbols.length} unique symbols to update.`);

            const stats = { total: uniqueSymbols.length, success: 0, failed: 0 };

            for (const symbol of uniqueSymbols) {
                let retryCount = 0;
                const maxRetries = 3;
                let success = false;

                while (!success && retryCount <= maxRetries) {
                    try {
                        // 1. Force Refresh Price
                        await MarketDataService.getPrice(symbol, true);
                        // 2. Force Refresh History
                        await MarketDataService.getDailyHistory(symbol, undefined, true);

                        stats.success++;
                        success = true;
                        log(`[Context] ${symbol} updated successfully.`);
                        // Small delay
                        await new Promise(r => setTimeout(r, 1000));
                    } catch (e: any) {
                        const msg = e.message || '';
                        if (msg.includes('Rate limit') || msg.includes('429')) {
                            log(`[Warn] Rate limit for ${symbol}. Pausing...`);
                            let waitTime = 60;
                            const match = msg.match(/Cooling down for (\d+)s/);
                            if (match && match[1]) waitTime = parseInt(match[1], 10) + 5;

                            log(`[Wait] Sleeping ${waitTime}s...`);
                            await new Promise(r => setTimeout(r, waitTime * 1000));
                            retryCount++;
                        } else {
                            log(`[Error] Failed ${symbol}: ${msg}`);
                            stats.failed++;
                            break;
                        }
                    }
                }
            }

            log(`[Done] Refresh Complete. Success: ${stats.success}, Failed: ${stats.failed}`);
            return stats;
        } catch (error: any) {
            log(`[Critical] Failure: ${error.message}`);
            throw error;
        }
    };

    if (streamMode) {
        const encoder = new TextEncoder();
        const customStream = new ReadableStream({
            async start(controller) {
                const log = (msg: string) => {
                    controller.enqueue(encoder.encode(msg + '\n'));
                };
                await runRefresh(log);
                controller.close();
            }
        });
        return new Response(customStream, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Transfer-Encoding': 'chunked',
                'X-Content-Type-Options': 'nosniff',
            },
        });
    } else {
        // Standard JSON Response
        const logs: string[] = [];
        const log = (msg: string) => {
            console.log(msg); // Keep server logs
            logs.push(msg);
        };
        const stats = await runRefresh(log);
        return NextResponse.json({ message: 'Completed', stats, logs, timestamp: new Date().toISOString() });
    }
}
