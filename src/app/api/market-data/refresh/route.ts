import { NextResponse } from 'next/server';
import { MarketDataService } from '@/lib/market-data';
import { requireAuth } from '@/lib/api-auth';
import { getMarketSyncStatus, runFullMarketSync, runIncrementalSync } from '@/lib/market-sync';

export async function POST(request: Request) {
    try {
        const authResult = await requireAuth(request, ['ADMIN', 'EDITOR'], true);
        if (!authResult.authorized) {
            return authResult.response;
        }

        const body = await request.json();
        const { symbol, symbols, scope, mode, force } = body || {};

        if (typeof symbol === 'string' && symbol.trim().length > 0) {
            const trimmedSymbol = symbol.trim();
            if (mode === 'price') {
                const result = await runIncrementalSync({
                    symbols: [trimmedSymbol],
                    force: true,
                    reason: 'manual-symbol',
                });
                const syncStatus = await getMarketSyncStatus();
                return NextResponse.json({
                    success: true,
                    coalesced: result.coalesced,
                    ran: result.ran,
                    cooldownRemainingMs: result.cooldownRemainingMs,
                    stats: result.stats,
                    syncStatus,
                });
            }

            await MarketDataService.refreshMarketData(trimmedSymbol);
            return NextResponse.json({ success: true });
        }

        if (Array.isArray(symbols)) {
            const cleanSymbols = Array.from(
                new Set(
                    symbols
                        .filter((s: unknown): s is string => typeof s === 'string')
                        .map((s) => s.trim())
                        .filter(Boolean)
                )
            );

            if (cleanSymbols.length > 0) {
                if (mode === 'full') {
                    await MarketDataService.refreshMarketData(cleanSymbols);
                    const syncStatus = await getMarketSyncStatus();
                    return NextResponse.json({
                        success: true,
                        mode: 'full',
                        syncStatus,
                    });
                }

                const result = await runIncrementalSync({
                    symbols: cleanSymbols,
                    respectCooldown: true,
                    force: Boolean(force),
                    reason: 'manual-batch',
                });
                const syncStatus = await getMarketSyncStatus();
                return NextResponse.json({
                    success: true,
                    mode: 'price',
                    coalesced: result.coalesced,
                    ran: result.ran,
                    skippedReason: result.skippedReason,
                    cooldownRemainingMs: result.cooldownRemainingMs,
                    stats: result.stats,
                    syncStatus,
                });
            }
        }

        if (scope === 'portfolio' || scope === 'active') {
            if (mode === 'full') {
                const result = await runFullMarketSync({ force: Boolean(force) });
                const syncStatus = await getMarketSyncStatus();
                return NextResponse.json({
                    success: true,
                    mode: 'full',
                    coalesced: result.coalesced,
                    stats: result.stats,
                    syncStatus,
                });
            }

            const result = await runIncrementalSync({
                respectCooldown: true,
                force: Boolean(force),
                reason: 'manual-portfolio',
            });
            const syncStatus = await getMarketSyncStatus();
            return NextResponse.json({
                success: true,
                mode: 'price',
                coalesced: result.coalesced,
                ran: result.ran,
                skippedReason: result.skippedReason,
                cooldownRemainingMs: result.cooldownRemainingMs,
                stats: result.stats,
                syncStatus,
            });
        }

        return NextResponse.json({ error: 'Symbol is required' }, { status: 400 });
    } catch (error) {
        console.error('Error in refresh endpoint:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
