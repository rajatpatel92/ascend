/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register module hook to resolve `@/auth`, `@/lib/prisma`, `@/lib/market-data`, and `next/server` to global mocks
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
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockAuth(...args);")
    };
  }
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const prisma = {
          investment: { findMany: (...args) => globalThis.__mockRefreshPrisma.investment.findMany(...args) },
          benchmark: { findMany: (...args) => globalThis.__mockRefreshPrisma.benchmark.findMany(...args) },
          activity: { findMany: (...args) => globalThis.__mockRefreshPrisma.activity.findMany(...args) },
          activityType: { findMany: (...args) => globalThis.__mockRefreshPrisma.activityType.findMany(...args) },
          marketDataCache: { findMany: (...args) => globalThis.__mockRefreshPrisma.marketDataCache.findMany(...args) },
          account: { findMany: (...args) => globalThis.__mockRefreshPrisma.account.findMany(...args) },
          currency: { findMany: (...args) => globalThis.__mockRefreshPrisma.currency.findMany(...args) },
        };
      \`)
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const MarketDataService = {
          refreshMarketData: (...args) => globalThis.__mockRefreshMarketData(...args),
          refreshPriceOnly: (...args) => globalThis.__mockRefreshPriceOnly(...args),
          getPrice: (...args) => globalThis.__mockGetPrice(...args),
          getDailyHistory: (...args) => globalThis.__mockGetDailyHistory(...args),
          getHistoricalPrices: (...args) => globalThis.__mockGetHistoricalPrices(...args),
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

// Setup global mock holders before importing route module
(globalThis as any).__mockAuth = async () => null;
(globalThis as any).__mockRefreshMarketData = async () => {};
(globalThis as any).__mockRefreshPriceOnly = async () => 0;
(globalThis as any).__mockGetPrice = async () => null;
(globalThis as any).__mockGetDailyHistory = async () => ({});
(globalThis as any).__mockGetHistoricalPrices = async () => ({});
(globalThis as any).__mockRefreshPrisma = {
    investment: { findMany: async () => [] },
    benchmark: { findMany: async () => [] },
    activity: { findMany: async () => [] },
    activityType: { findMany: async () => [] },
    marketDataCache: { findMany: async () => [] },
    account: { findMany: async () => [] },
    currency: { findMany: async () => [] },
};

// Import route POST function and helpers
const { POST } = await import('./route.ts');
const { resetSyncStateForTests } = await import('@/lib/sync-state');
const { resetCacheVersionsForTests } = await import('@/lib/cache-invalidation');

test('POST /api/market-data/refresh', async (t) => {
    const savedEnv = { ...process.env };

    t.beforeEach(() => {
        resetSyncStateForTests();
        resetCacheVersionsForTests();
        (globalThis as any).__mockAuth = async () => ({ user: { name: 'Test User', role: 'ADMIN' } });
        (globalThis as any).__mockRefreshMarketData = async () => {};
        (globalThis as any).__mockRefreshPriceOnly = async (syms: string | string[]) => Array.isArray(syms) ? syms.length : 1;
        (globalThis as any).__mockGetPrice = async () => ({ price: 100 });
        (globalThis as any).__mockGetDailyHistory = async () => ({});
        (globalThis as any).__mockGetHistoricalPrices = async () => ({});
        (globalThis as any).__mockRefreshPrisma = {
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

    await t.test('returns 401 Unauthorized when user is not authenticated', async () => {
        (globalThis as any).__mockAuth = async () => null;

        const request = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'AAPL' }),
            headers: { 'Content-Type': 'application/json' },
        });

        const response = await POST(request);
        assert.strictEqual(response.status, 401);

        const data = await response.json();
        assert.deepStrictEqual(data, { error: 'Unauthorized' });
    });

    await t.test('returns 403 Forbidden for VIEWER role and allows EDITOR role & valid x-api-key', async () => {
        (globalThis as any).__mockAuth = async () => ({ user: { name: 'Viewer', role: 'VIEWER' } });
        const viewerReq = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'AAPL' }),
            headers: { 'Content-Type': 'application/json' },
        });
        const viewerRes = await POST(viewerReq);
        assert.strictEqual(viewerRes.status, 403);

        (globalThis as any).__mockAuth = async () => ({ user: { name: 'Editor', role: 'EDITOR' } });
        const editorReq = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'AAPL' }),
            headers: { 'Content-Type': 'application/json' },
        });
        const editorRes = await POST(editorReq);
        assert.strictEqual(editorRes.status, 200);

        (globalThis as any).__mockAuth = async () => null;
        process.env.MCP_API_KEY = 'mcp-secret-key';
        const apiKeyReq = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'MSFT' }),
            headers: { 'Content-Type': 'application/json', 'x-api-key': 'mcp-secret-key' },
        });
        const apiKeyRes = await POST(apiKeyReq);
        assert.strictEqual(apiKeyRes.status, 200);
    });

    await t.test('returns 400 Bad Request when symbol is missing from request body', async () => {
        const request = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { 'Content-Type': 'application/json' },
        });

        const response = await POST(request);
        assert.strictEqual(response.status, 400);

        const data = await response.json();
        assert.deepStrictEqual(data, { error: 'Symbol is required' });
    });

    await t.test('calls MarketDataService.refreshMarketData and returns 200 success when symbol is provided', async () => {
        let refreshedSymbol: string | null = null;
        (globalThis as any).__mockRefreshMarketData = async (symbol: string) => {
            refreshedSymbol = symbol;
        };

        const request = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'AAPL' }),
            headers: { 'Content-Type': 'application/json' },
        });

        const response = await POST(request);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.deepStrictEqual(data, { success: true });
        assert.strictEqual(refreshedSymbol, 'AAPL');
    });

    await t.test('coalesces concurrent scope=portfolio refreshes and enforces manual cooldown', async () => {
        process.env.MANUAL_REFRESH_COOLDOWN_MS = '15000';
        (globalThis as any).__mockRefreshPrisma.investment.findMany = async () => [
            { symbol: 'AAPL', currencyCode: 'USD' },
        ];
        (globalThis as any).__mockRefreshPrisma.activityType.findMany = async () => [
            { name: 'BUY', behavior: 'ADD' },
        ];
        (globalThis as any).__mockRefreshPrisma.activity.findMany = async () => [
            { type: 'BUY', quantity: 5, date: '2025-01-01T00:00:00Z', accountId: 'a1', investment: { symbol: 'AAPL' } },
        ];

        let refreshCalls = 0;
        (globalThis as any).__mockRefreshPriceOnly = async (syms: string[]) => {
            refreshCalls++;
            await new Promise((r) => setTimeout(r, 30));
            return syms.length;
        };

        const makeReq = (body: Record<string, unknown>) =>
            new Request('http://localhost/api/market-data/refresh', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json' },
            });

        const [res1, res2] = await Promise.all([
            POST(makeReq({ scope: 'portfolio' })),
            POST(makeReq({ scope: 'portfolio' })),
        ]);
        assert.strictEqual(res1.status, 200);
        assert.strictEqual(res2.status, 200);

        const body1 = await res1.json();
        const body2 = await res2.json();
        assert.strictEqual(refreshCalls, 1);
        assert.strictEqual(body1.coalesced, false);
        assert.strictEqual(body2.coalesced, true);
        assert.strictEqual(body1.ran, true);
        assert.ok(body1.syncStatus);

        // Immediate follow-up hits 15s manual cooldown
        const resCooldown = await POST(makeReq({ scope: 'portfolio' }));
        assert.strictEqual(resCooldown.status, 200);
        const bodyCooldown = await resCooldown.json();
        assert.strictEqual(bodyCooldown.ran, false);
        assert.strictEqual(bodyCooldown.skippedReason, 'cooldown');
        assert.ok(bodyCooldown.cooldownRemainingMs > 0);
        assert.strictEqual(refreshCalls, 1);

        // force: true bypasses cooldown
        const resForce = await POST(makeReq({ scope: 'portfolio', force: true }));
        assert.strictEqual(resForce.status, 200);
        const bodyForce = await resForce.json();
        assert.strictEqual(bodyForce.ran, true);
        assert.strictEqual(refreshCalls, 2);
    });

    await t.test('supports symbol mode=price, symbols array mode=price/full, and scope=portfolio mode=full', async () => {
        const priceCalls: string[][] = [];
        const fullRefreshCalls: unknown[] = [];
        const fullSyncMetaCalls: string[] = [];

        (globalThis as any).__mockRefreshPriceOnly = async (syms: string[]) => {
            priceCalls.push(syms);
            return syms.length;
        };
        (globalThis as any).__mockRefreshMarketData = async (syms: unknown) => {
            fullRefreshCalls.push(syms);
        };
        (globalThis as any).__mockRefreshPrisma.investment.findMany = async () => [
            { symbol: 'AAPL', currencyCode: 'USD' },
        ];
        (globalThis as any).__mockGetPrice = async (sym: string) => {
            fullSyncMetaCalls.push(sym);
            return { price: 190 };
        };

        const makeReq = (body: Record<string, unknown>) =>
            new Request('http://localhost/api/market-data/refresh', {
                method: 'POST',
                body: JSON.stringify(body),
                headers: { 'Content-Type': 'application/json' },
            });

        // 1. Single symbol mode: 'price'
        const symPriceRes = await POST(makeReq({ symbol: 'AAPL', mode: 'price' }));
        assert.strictEqual(symPriceRes.status, 200);
        const symPriceBody = await symPriceRes.json();
        assert.strictEqual(symPriceBody.ran, true);
        assert.deepStrictEqual(priceCalls[0], ['AAPL']);

        // 2. Symbols array default mode='price'
        const batchPriceRes = await POST(makeReq({ symbols: ['AAPL', ' MSFT ', 'AAPL'] }));
        assert.strictEqual(batchPriceRes.status, 200);
        const batchPriceBody = await batchPriceRes.json();
        assert.strictEqual(batchPriceBody.mode, 'price');
        assert.deepStrictEqual(priceCalls[1], ['AAPL', 'MSFT']);

        // 3. Symbols array mode='full'
        const batchFullRes = await POST(makeReq({ symbols: ['AAPL', 'MSFT'], mode: 'full' }));
        assert.strictEqual(batchFullRes.status, 200);
        const batchFullBody = await batchFullRes.json();
        assert.strictEqual(batchFullBody.mode, 'full');
        assert.deepStrictEqual(fullRefreshCalls[0], ['AAPL', 'MSFT']);

        // 4. Scope='portfolio' mode='full'
        const origLog = console.log;
        console.log = () => {};
        try {
            const portFullRes = await POST(makeReq({ scope: 'portfolio', mode: 'full', force: true }));
            assert.strictEqual(portFullRes.status, 200);
            const portFullBody = await portFullRes.json();
            assert.strictEqual(portFullBody.mode, 'full');
            assert.ok(portFullBody.stats);
            assert.ok(portFullBody.syncStatus);
            assert.ok(fullSyncMetaCalls.includes('AAPL'));
        } finally {
            console.log = origLog;
        }
    });

    await t.test('returns 500 Internal Server Error when MarketDataService throws an error', async () => {
        const consoleErrorOriginal = console.error;
        let loggedError: any = null;
        console.error = (...args: any[]) => {
            loggedError = args;
        };

        try {
            (globalThis as any).__mockRefreshMarketData = async () => {
                throw new Error('API Rate Limit Exceeded');
            };

            const request = new Request('http://localhost/api/market-data/refresh', {
                method: 'POST',
                body: JSON.stringify({ symbol: 'AAPL' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            assert.strictEqual(response.status, 500);

            const data = await response.json();
            assert.deepStrictEqual(data, { error: 'Internal Server Error' });
            assert.ok(loggedError);
            assert.strictEqual(loggedError[0], 'Error in refresh endpoint:');
        } finally {
            console.error = consoleErrorOriginal;
        }
    });

    await t.test('returns 500 Internal Server Error when request body JSON is invalid', async () => {
        const consoleErrorOriginal = console.error;
        console.error = () => {};

        try {
            const request = new Request('http://localhost/api/market-data/refresh', {
                method: 'POST',
                body: 'invalid-json',
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            assert.strictEqual(response.status, 500);

            const data = await response.json();
            assert.deepStrictEqual(data, { error: 'Internal Server Error' });
        } finally {
            console.error = consoleErrorOriginal;
        }
    });
});
