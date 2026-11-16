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
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockStatusAuth(...args);")
    };
  }
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const prisma = {
          investment: { findMany: (...args) => globalThis.__mockStatusPrisma.investment.findMany(...args) },
          benchmark: { findMany: (...args) => globalThis.__mockStatusPrisma.benchmark.findMany(...args) },
          activity: { findMany: (...args) => globalThis.__mockStatusPrisma.activity.findMany(...args) },
          activityType: { findMany: (...args) => globalThis.__mockStatusPrisma.activityType.findMany(...args) },
          marketDataCache: { findMany: (...args) => globalThis.__mockStatusPrisma.marketDataCache.findMany(...args) },
          account: { findMany: (...args) => globalThis.__mockStatusPrisma.account.findMany(...args) },
          currency: { findMany: (...args) => globalThis.__mockStatusPrisma.currency.findMany(...args) },
        };
      \`)
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const MarketDataService = {
          refreshPriceOnly: async () => 0,
          getPrice: async () => null,
          getDailyHistory: async () => ({}),
          getHistoricalPrices: async () => ({}),
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

(globalThis as any).__mockStatusAuth = async () => null;
(globalThis as any).__mockStatusPrisma = {
    investment: { findMany: async () => [] },
    benchmark: { findMany: async () => [] },
    activity: { findMany: async () => [] },
    activityType: { findMany: async () => [] },
    marketDataCache: { findMany: async () => [] },
    account: { findMany: async () => [] },
    currency: { findMany: async () => [] },
};

const { GET, dynamic } = await import('./route.ts');
const { resetSyncStateForTests } = await import('@/lib/sync-state');
const { resetCacheVersionsForTests, invalidateMarketCaches } = await import('@/lib/cache-invalidation');

test('GET /api/market-data/status', async (t) => {
    const savedEnv = { ...process.env };

    t.beforeEach(() => {
        resetSyncStateForTests();
        resetCacheVersionsForTests();
        (globalThis as any).__mockStatusAuth = async () => null;
        (globalThis as any).__mockStatusPrisma = {
            investment: { findMany: async () => [] },
            benchmark: { findMany: async () => [] },
            activity: { findMany: async () => [] },
            activityType: { findMany: async () => [] },
            marketDataCache: { findMany: async () => [] },
            account: { findMany: async () => [] },
            currency: { findMany: async () => [] },
        };
    });

    t.afterEach(() => {
        process.env = { ...savedEnv };
        resetSyncStateForTests();
        resetCacheVersionsForTests();
    });

    await t.test('exports force-dynamic configuration', () => {
        assert.strictEqual(dynamic, 'force-dynamic');
    });

    await t.test('returns 401 Unauthorized when unauthenticated and API key absent', async () => {
        const res = await GET(new Request('http://localhost/api/market-data/status'));
        assert.strictEqual(res.status, 401);
        const body = await res.json();
        assert.deepStrictEqual(body, { error: 'Unauthorized' });
    });

    await t.test('allows VIEWER, ADMIN, and valid x-api-key and returns sync telemetry fields', async (subT) => {
        subT.mock.timers.enable({
            apis: ['Date'],
            now: new Date('2026-07-15T15:00:00.000Z'), // Wed 11:00 ET -> market open
        });

        try {
            const freshAt = new Date(Date.now() - 20_000);
            const staleAt = new Date(Date.now() - 10 * 60_000);

            (globalThis as any).__mockStatusPrisma.investment.findMany = async () => [
                { symbol: 'AAPL', currencyCode: 'USD' },
                { symbol: 'MSFT', currencyCode: 'USD' },
            ];
            (globalThis as any).__mockStatusPrisma.activityType.findMany = async () => [
                { name: 'BUY', behavior: 'ADD' },
            ];
            (globalThis as any).__mockStatusPrisma.activity.findMany = async () => [
                { type: 'BUY', quantity: 5, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'AAPL' } },
                { type: 'BUY', quantity: 5, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'MSFT' } },
            ];
            (globalThis as any).__mockStatusPrisma.marketDataCache.findMany = async ({ where }: any) => {
                const syms: string[] = where?.symbol?.in || [];
                return syms.map((symbol) => ({
                    symbol,
                    price: 150,
                    lastUpdated: symbol === 'MSFT' ? staleAt : freshAt,
                }));
            };

            invalidateMarketCaches({ symbols: ['AAPL'] });

            // 1. VIEWER role
            (globalThis as any).__mockStatusAuth = async () => ({ user: { id: 'u1', role: 'VIEWER' } });
            const viewerRes = await GET(new Request('http://localhost/api/market-data/status'));
            assert.strictEqual(viewerRes.status, 200);
            const viewerBody = await viewerRes.json();

            assert.strictEqual(viewerBody.marketDataVersion, 2);
            assert.strictEqual(viewerBody.portfolioMutationVersion, 1);
            assert.strictEqual(viewerBody.isMarketOpen, true);
            assert.strictEqual(viewerBody.effectivePriceTtlMs, 120000);
            assert.ok(viewerBody.throttler && typeof viewerBody.throttler.isRateLimited === 'boolean');
            assert.ok(viewerBody.activeSymbolCount >= 2);
            assert.strictEqual(viewerBody.staleSymbolCount, 1);
            assert.strictEqual(viewerBody.oldestSyncAt, staleAt.toISOString());
            assert.strictEqual(viewerBody.newestSyncAt, freshAt.toISOString());

            // 2. ADMIN role
            (globalThis as any).__mockStatusAuth = async () => ({ user: { id: 'u2', role: 'ADMIN' } });
            const adminRes = await GET(new Request('http://localhost/api/market-data/status'));
            assert.strictEqual(adminRes.status, 200);

            // 3. Valid x-api-key without session
            (globalThis as any).__mockStatusAuth = async () => null;
            process.env.MCP_API_KEY = 'mcp-status-key';
            const apiKeyRes = await GET(new Request('http://localhost/api/market-data/status', {
                headers: { 'x-api-key': 'mcp-status-key' },
            }));
            assert.strictEqual(apiKeyRes.status, 200);
        } finally {
            subT.mock.timers.reset();
        }
    });
});
