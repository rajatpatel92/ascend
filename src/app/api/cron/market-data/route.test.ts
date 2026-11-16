/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class NextResponse extends Response {
          static json(body, init) {
            const status = init?.status ?? 200;
            return new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json', ...(init?.headers || {}) }
            });
          }
        }
      \`)
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockFullCronAuth(...args);")
    };
  }
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const prisma = {
          investment: { findMany: (...args) => globalThis.__mockFullCronPrisma.investment.findMany(...args) },
          benchmark: { findMany: (...args) => globalThis.__mockFullCronPrisma.benchmark.findMany(...args) },
          activity: { findMany: (...args) => globalThis.__mockFullCronPrisma.activity.findMany(...args) },
          activityType: { findMany: (...args) => globalThis.__mockFullCronPrisma.activityType.findMany(...args) },
          marketDataCache: { findMany: (...args) => globalThis.__mockFullCronPrisma.marketDataCache.findMany(...args) },
          account: { findMany: (...args) => globalThis.__mockFullCronPrisma.account.findMany(...args) },
          currency: { findMany: (...args) => globalThis.__mockFullCronPrisma.currency.findMany(...args) },
        };
      \`)
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const MarketDataService = {
          refreshPriceOnly: (...args) => globalThis.__mockFullCronMarketData.refreshPriceOnly(...args),
          getPrice: (...args) => globalThis.__mockFullCronMarketData.getPrice(...args),
          getDailyHistory: (...args) => globalThis.__mockFullCronMarketData.getDailyHistory(...args),
          getHistoricalPrices: (...args) => globalThis.__mockFullCronMarketData.getHistoricalPrices(...args),
        };
      \`)
    };
  }
  if (specifier.startsWith("@/")) {
    let relativePath = specifier.replace("@/", "./src/");
    if (!relativePath.endsWith(".ts") && !relativePath.endsWith(".js") && !relativePath.endsWith(".json")) {
      relativePath += ".ts";
    }
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

(globalThis as any).__mockFullCronAuth = async () => null;
(globalThis as any).__mockFullCronPrisma = {
    investment: { findMany: async () => [] },
    benchmark: { findMany: async () => [] },
    activity: { findMany: async () => [] },
    activityType: { findMany: async () => [] },
    marketDataCache: { findMany: async () => [] },
    account: { findMany: async () => [] },
    currency: { findMany: async () => [] },
};
(globalThis as any).__mockFullCronMarketData = {
    refreshPriceOnly: async () => 0,
    getPrice: async () => null,
    getDailyHistory: async () => ({}),
    getHistoricalPrices: async () => ({}),
};

const { GET, dynamic } = await import('./route.ts');
const { resetSyncStateForTests } = await import('@/lib/sync-state');
const { resetCacheVersionsForTests } = await import('@/lib/cache-invalidation');

test('GET /api/cron/market-data endpoint', async (t) => {
    const savedEnv = { ...process.env };
    const originalLog = console.log;

    t.beforeEach(() => {
        resetSyncStateForTests();
        resetCacheVersionsForTests();
        console.log = () => {};
        (globalThis as any).__mockFullCronAuth = async () => null;
        (globalThis as any).__mockFullCronPrisma = {
            investment: { findMany: async () => [] },
            benchmark: { findMany: async () => [] },
            activity: { findMany: async () => [] },
            activityType: { findMany: async () => [] },
            marketDataCache: { findMany: async () => [] },
            account: { findMany: async () => [] },
            currency: { findMany: async () => [] },
        };
        (globalThis as any).__mockFullCronMarketData = {
            refreshPriceOnly: async (syms: string[]) => syms.length,
            getPrice: async () => ({ price: 100 }),
            getDailyHistory: async () => ({}),
            getHistoricalPrices: async () => ({}),
        };
    });

    t.afterEach(() => {
        process.env = { ...savedEnv };
        console.log = originalLog;
        resetSyncStateForTests();
        resetCacheVersionsForTests();
    });

    await t.test('exports force-dynamic configuration', () => {
        assert.strictEqual(dynamic, 'force-dynamic');
    });

    await t.test('returns 401 when cron secret is wrong, session is missing, or session is VIEWER', async () => {
        process.env.CRON_SECRET = 'cron-top-secret';

        const noAuthRes = await GET(new Request('http://localhost/api/cron/market-data'));
        assert.strictEqual(noAuthRes.status, 401);

        const wrongKeyRes = await GET(new Request('http://localhost/api/cron/market-data?key=wrong'));
        assert.strictEqual(wrongKeyRes.status, 401);

        (globalThis as any).__mockFullCronAuth = async () => ({ user: { id: 'u1', role: 'VIEWER' } });
        const viewerRes = await GET(new Request('http://localhost/api/cron/market-data'));
        assert.strictEqual(viewerRes.status, 401);
    });

    await t.test('executes full market sync with valid secret (header/query) or ADMIN session', async () => {
        process.env.CRON_SECRET = 'cron-top-secret';
        (globalThis as any).__mockFullCronPrisma.investment.findMany = async () => [
            { symbol: 'AAPL', currencyCode: 'USD' },
        ];

        const headerRes = await GET(new Request('http://localhost/api/cron/market-data', {
            headers: { 'x-cron-secret': 'cron-top-secret' },
        }));
        assert.strictEqual(headerRes.status, 200);
        const headerBody = await headerRes.json();
        assert.strictEqual(headerBody.message, 'Completed');
        assert.ok(headerBody.stats.total >= 1);
        assert.strictEqual(headerBody.stats.failed, 0);

        // Also allow ADMIN session without CRON_SECRET
        delete process.env.CRON_SECRET;
        (globalThis as any).__mockFullCronAuth = async () => ({ user: { id: 'admin-1', role: 'ADMIN' } });
        const adminRes = await GET(new Request('http://localhost/api/cron/market-data'));
        assert.strictEqual(adminRes.status, 200);
    });

    await t.test('staleOnly=true skips symbols with fresh metadataUpdatedAt and historyUpdatedAt', async () => {
        process.env.CRON_SECRET = 'cron-top-secret';
        const now = new Date();
        const veryOld = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

        (globalThis as any).__mockFullCronPrisma.investment.findMany = async () => [
            { symbol: 'FRESH', currencyCode: 'USD' },
            { symbol: 'STALE', currencyCode: 'USD' },
        ];
        (globalThis as any).__mockFullCronPrisma.marketDataCache.findMany = async ({ where }: any) => {
            const syms: string[] = where?.symbol?.in || [];
            return syms.map((symbol) => ({
                symbol,
                metadataUpdatedAt: symbol === 'STALE' ? veryOld : now,
                historyUpdatedAt: now,
                history: { '2026-01-01': 100 },
            }));
        };

        const metadataRefreshed: string[] = [];
        (globalThis as any).__mockFullCronMarketData.getPrice = async (sym: string) => {
            metadataRefreshed.push(sym);
            return { price: 100 };
        };

        const res = await GET(new Request('http://localhost/api/cron/market-data?staleOnly=true', {
            headers: { Authorization: 'Bearer cron-top-secret' },
        }));
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.deepStrictEqual(metadataRefreshed, ['STALE']);
        assert.ok(body.stats.skipped >= 1);
    });

    await t.test('stream=true streams progress log lines ending with Done summary', async () => {
        process.env.CRON_SECRET = 'cron-top-secret';
        (globalThis as any).__mockFullCronPrisma.investment.findMany = async () => [
            { symbol: 'AAPL', currencyCode: 'USD' },
        ];

        const res = await GET(new Request('http://localhost/api/cron/market-data?key=cron-top-secret&stream=true'));
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('Content-Type')?.includes('text/plain'));

        const text = await res.text();
        assert.ok(text.includes('[Cron] Starting Market Data Refresh...'));
        assert.ok(text.includes('[Done] Refresh Complete.'));
    });

    await t.test('stream=true completes runFullMarketSync safely when client cancels stream early (M3)', async () => {
        process.env.CRON_SECRET = 'cron-top-secret';
        (globalThis as any).__mockFullCronPrisma.investment.findMany = async () => [
            { symbol: 'SLOW1', currencyCode: 'USD' },
            { symbol: 'SLOW2', currencyCode: 'USD' },
        ];

        const processed: string[] = [];
        (globalThis as any).__mockFullCronMarketData.getPrice = async (sym: string) => {
            await new Promise((r) => setTimeout(r, 20));
            processed.push(sym);
            return { price: 100 };
        };

        const res = await GET(new Request('http://localhost/api/cron/market-data?key=cron-top-secret&stream=true'));
        assert.strictEqual(res.status, 200);
        const reader = res.body!.getReader();
        await reader.read(); // Read first chunk, then cancel stream like a disconnected tab
        await reader.cancel();

        // Allow background runFullMarketSync to finish without throwing ERR_INVALID_STATE
        await new Promise((r) => setTimeout(r, 600));
        assert.deepStrictEqual(processed, ['SLOW1', 'SLOW2']);
    });
});
