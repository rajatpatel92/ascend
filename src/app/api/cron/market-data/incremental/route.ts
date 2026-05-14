
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';

export const maxDuration = 30; // Fast execution
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    // Basic protection
    const { searchParams } = new URL(request.url);
    const key = searchParams.get('key');
    const headerKey = request.headers.get('x-cron-secret');
    if (process.env.CRON_SECRET && key !== process.env.CRON_SECRET && headerKey !== process.env.CRON_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        console.log('[Cron:Incremental] Starting Price-Only Refresh...');

        // 1. Get Symbols
        const investments = await prisma.investment.findMany({ select: { symbol: true } });
        const uniqueSymbols = Array.from(new Set(investments.map(i => i.symbol)));

        // Add Benchmark Symbols (both system and user configured)
        const benchmarks = await prisma.benchmark.findMany({ select: { symbol: true } });
        benchmarks.forEach(b => {
            if (!uniqueSymbols.includes(b.symbol)) uniqueSymbols.push(b.symbol);
        });

        // Add Currencies
        const currencyPairs = ['CAD=X', 'EUR=X', 'GBP=X', 'INR=X', 'AUD=X', 'JPY=X'];
        currencyPairs.forEach(pair => {
            if (!uniqueSymbols.includes(pair)) uniqueSymbols.push(pair);
        });

        // 2. Process in Batches (Concurrency: 5)
        const BATCH_SIZE = 5;
        const results = { total: uniqueSymbols.length, success: 0, failed: 0 };

        for (let i = 0; i < uniqueSymbols.length; i += BATCH_SIZE) {
            const batch = uniqueSymbols.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(async (symbol) => {
                try {
                    await MarketDataService.refreshPriceOnly(symbol);
                    results.success++;
                } catch (e) {
                    // Silent fail for incremental to avoid log spam, or minimal log
                    results.failed++;
                }
            }));

            // Minimal pause between batches to be nice to API
            if (i + BATCH_SIZE < uniqueSymbols.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        console.log(`[Cron:Incremental] Done. ${results.success}/${results.total} updated.`);
        return NextResponse.json({ message: 'Incremental Refresh Done', stats: results });

    } catch (error: any) {
        console.error('[Cron:Incremental] Failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
