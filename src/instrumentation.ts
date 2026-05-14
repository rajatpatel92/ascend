

export async function register() {
    console.log(`[Instrumentation] Registering. Runtime: ${process.env.NEXT_RUNTIME}`);

    if (process.env.NEXT_RUNTIME === 'nodejs' || !process.env.NEXT_RUNTIME) {
        // Only run on server-side (Node.js)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cron = require('node-cron');

        console.log('[Instrumentation] Initializing Cron Jobs...');

        // State to coordinate jobs
        let isFullRefreshRunning = false;

        // 1. Schedule: Every hour at minute 0 (HEAVY REFRESH: History + Metadata)
        cron.schedule('0 * * * *', async () => {
            if (isFullRefreshRunning) return; // Should not happen given schedule, but safety
            isFullRefreshRunning = true;
            console.log('[Cron] Triggering Scheduled Market Data Refresh (Full)...');
            try {
                const baseUrl = process.env.APP_URL || 'http://127.0.0.1:3000';
                await fetch(`${baseUrl}/api/cron/market-data`, {
                    headers: { 'x-cron-secret': process.env.CRON_SECRET || '' }
                });
            } catch (e) {
                console.error('[Cron] Failed to trigger full market data refresh:', e);
            } finally {
                isFullRefreshRunning = false;
                console.log('[Cron] Full Refresh Finished. Locking released.');
            }
        });

        // 2. Schedule: Every 2 minutes (LIGHT REFRESH: Price Only)
        // Note: logs here confirm scheduling works
        cron.schedule('*/2 * * * *', async () => {
            if (isFullRefreshRunning) {
                console.log('[Cron] Skipping Incremental Refresh (Full Refresh in progress).');
                return;
            }

            console.log('[Cron] Triggering Incremental Price Refresh...');
            try {
                const baseUrl = process.env.APP_URL || 'http://127.0.0.1:3000';
                const res = await fetch(`${baseUrl}/api/cron/market-data/incremental`, {
                    headers: { 'x-cron-secret': process.env.CRON_SECRET || '' }
                });
                if (!res.ok) console.error(`[Cron] Incremental failed: ${res.status}`);
            } catch (e) {
                console.error('[Cron] Failed to trigger incremental refresh:', e);
            }
        });

        // Trigger on Startup (One-off)
        setTimeout(async () => {
            console.log('[Startup] Triggering Initial Market Data Refresh...');
            try {
                const baseUrl = process.env.APP_URL || 'http://127.0.0.1:3000';
                await fetch(`${baseUrl}/api/cron/market-data`, {
                    headers: { 'x-cron-secret': process.env.CRON_SECRET || '' }
                });
            } catch (e) {
                console.error('[Startup] Failed to trigger initial refresh:', e);
            }
        }, 10000); // 10s delay
    }
}
