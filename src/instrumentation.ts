export async function register() {
    console.log(`[Instrumentation] Registering. Runtime: ${process.env.NEXT_RUNTIME}`);

    if (process.env.NEXT_RUNTIME === 'nodejs' || !process.env.NEXT_RUNTIME) {
        const g = globalThis as { __ascendCronInitialized?: boolean };
        if (g.__ascendCronInitialized) {
            return;
        }
        g.__ascendCronInitialized = true;

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cron = require('node-cron');
        const { runIncrementalSync, runFullMarketSync } = await import('@/lib/market-sync');

        console.log('[Instrumentation] Initializing in-process market sync schedules...');

        // 1. Every 2 minutes: fast incremental price/FX sync (respects market hours cadence)
        cron.schedule('*/2 * * * *', async () => {
            try {
                const res = await runIncrementalSync({
                    respectMarketHours: true,
                    reason: 'cron',
                });
                if (res.ran) {
                    console.log(`[Cron:Incremental] Done. ${res.stats.success}/${res.stats.total} updated.`);
                }
            } catch (e) {
                console.error('[Cron] Failed incremental price refresh:', e);
            }
        });

        // 2. Every 6 hours: metadata, dividend, and 20Y chart hydration (skips fresh entries)
        cron.schedule('0 */6 * * *', async () => {
            console.log('[Cron] Triggering scheduled metadata & history sync...');
            try {
                await runFullMarketSync({ force: false });
            } catch (e) {
                console.error('[Cron] Failed metadata/history refresh:', e);
            }
        });

        // 3. Startup fast price warm-up (+5s)
        const startupFastTimer = setTimeout(async () => {
            console.log('[Startup] Running initial fast price sync...');
            try {
                await runIncrementalSync({ force: true, reason: 'startup' });
            } catch (e) {
                console.error('[Startup] Initial fast sync failed:', e);
            }
        }, 5000);
        if (typeof startupFastTimer.unref === 'function') startupFastTimer.unref();

        // 4. Startup stale metadata/history hydration (+25s, decoupled from fast price sync)
        const startupFullTimer = setTimeout(async () => {
            console.log('[Startup] Running initial stale metadata/history hydration...');
            try {
                await runFullMarketSync({ force: false, onlyStaleMetadata: true });
            } catch (e) {
                console.error('[Startup] Initial metadata hydration failed:', e);
            }
        }, 25000);
        if (typeof startupFullTimer.unref === 'function') startupFullTimer.unref();
    }
}
