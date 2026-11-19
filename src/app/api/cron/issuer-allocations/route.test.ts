/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(
    'data:text/javascript,' +
        encodeURIComponent(`
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
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockIssuerCronAuth(...args);")
    };
  }
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const prisma = {
          investment: { findMany: (...args) => globalThis.__mockIssuerCronPrisma.investment.findMany(...args) },
          benchmark: { findMany: (...args) => globalThis.__mockIssuerCronPrisma.benchmark.findMany(...args) },
          activity: { findMany: (...args) => globalThis.__mockIssuerCronPrisma.activity.findMany(...args) },
          activityType: { findMany: (...args) => globalThis.__mockIssuerCronPrisma.activityType.findMany(...args) },
          marketDataCache: {
            findMany: (...args) => globalThis.__mockIssuerCronPrisma.marketDataCache.findMany(...args),
            update: (...args) => globalThis.__mockIssuerCronPrisma.marketDataCache.update(...args),
          },
          account: { findMany: (...args) => globalThis.__mockIssuerCronPrisma.account.findMany(...args) },
          currency: { findMany: (...args) => globalThis.__mockIssuerCronPrisma.currency.findMany(...args) },
        };
      \`)
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const MarketDataService = {};")
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
`)
);

(globalThis as any).__mockIssuerCronAuth = async () => null;
(globalThis as any).__mockIssuerCronPrisma = {
    investment: { findMany: async () => [] },
    benchmark: { findMany: async () => [] },
    activity: { findMany: async () => [] },
    activityType: { findMany: async () => [] },
    marketDataCache: {
        findMany: async () => [],
        update: async () => ({}),
    },
    account: { findMany: async () => [] },
    currency: { findMany: async () => [] },
};

const { GET, POST, dynamic } = await import('./route.ts');
const { getCacheVersions, resetCacheVersionsForTests } = await import('@/lib/cache-invalidation');
const { loadConfigFromEnv, runPushIssuerAllocations } = await import(
    '../../../../../scripts/push-issuer-allocations.ts'
);

test('/api/cron/issuer-allocations endpoint & push script', async (t) => {
    const savedEnv = { ...process.env };
    const updatedCalls: any[] = [];

    t.beforeEach(() => {
        resetCacheVersionsForTests();
        updatedCalls.length = 0;
        (globalThis as any).__mockIssuerCronAuth = async () => null;
        (globalThis as any).__mockIssuerCronPrisma = {
            investment: { findMany: async () => [] },
            benchmark: { findMany: async () => [] },
            activity: { findMany: async () => [] },
            activityType: { findMany: async () => [] },
            marketDataCache: {
                findMany: async () => [],
                update: async (args: any) => {
                    updatedCalls.push(args);
                    return args;
                },
            },
            account: { findMany: async () => [] },
            currency: { findMany: async () => [] },
        };
    });

    t.afterEach(() => {
        process.env = { ...savedEnv };
        resetCacheVersionsForTests();
    });

    await t.test('exports force-dynamic', () => {
        assert.strictEqual(dynamic, 'force-dynamic');
    });

    await t.test('enforces CRON_SECRET, MCP_API_KEY, or ADMIN session on GET and POST', async () => {
        process.env.CRON_SECRET = 'top-secret';
        process.env.MCP_API_KEY = 'mcp-secret';

        const noAuthGet = await GET(new Request('http://localhost/api/cron/issuer-allocations'));
        assert.strictEqual(noAuthGet.status, 401);

        const wrongPost = await POST(
            new Request('http://localhost/api/cron/issuer-allocations', {
                method: 'POST',
                headers: { Authorization: 'Bearer wrong' },
                body: JSON.stringify({ allocations: [] }),
            })
        );
        assert.strictEqual(wrongPost.status, 401);

        (globalThis as any).__mockIssuerCronAuth = async () => ({ user: { id: 'u1', role: 'VIEWER' } });
        const viewerGet = await GET(new Request('http://localhost/api/cron/issuer-allocations'));
        assert.strictEqual(viewerGet.status, 401);

        const apiKeyRes = await GET(
            new Request('http://localhost/api/cron/issuer-allocations', {
                headers: { 'x-api-key': 'mcp-secret' },
            })
        );
        assert.strictEqual(apiKeyRes.status, 200);

        (globalThis as any).__mockIssuerCronAuth = async () => ({ user: { id: 'a1', role: 'ADMIN' } });
        const adminRes = await GET(new Request('http://localhost/api/cron/issuer-allocations'));
        assert.strictEqual(adminRes.status, 200);
    });

    await t.test('GET returns discovered fund candidates and filters onlyMissingCountries', async () => {
        process.env.CRON_SECRET = 'top-secret';
        (globalThis as any).__mockIssuerCronPrisma.investment.findMany = async () => [
            { symbol: 'XEQT.TO', name: 'iShares Core Equity ETF Portfolio', type: 'ETF', currencyCode: 'CAD' },
            { symbol: 'XUU.TO', name: 'iShares Core S&P U.S. Total Market', type: 'ETF', currencyCode: 'CAD' },
            { symbol: 'AAPL', name: 'Apple Inc.', type: 'Equity', currencyCode: 'USD' },
        ];
        (globalThis as any).__mockIssuerCronPrisma.marketDataCache.findMany = async () => [
            {
                symbol: 'XEQT.TO',
                currency: 'CAD',
                countryAllocations: [{ 'United States': 0.45 }, { Canada: 0.25 }],
                sectorAllocations: [{ Technology: 0.25 }, { Financials: 0.2 }],
                metadataUpdatedAt: new Date('2026-11-18T00:00:00Z'),
            },
            {
                symbol: 'XUU.TO',
                currency: 'CAD',
                countryAllocations: [],
                sectorAllocations: [{ Technology: 0.3 }, { Healthcare: 0.15 }],
                metadataUpdatedAt: null,
            },
            {
                symbol: 'AAPL',
                currency: 'USD',
                countryAllocations: [],
                sectorAllocations: [],
                metadataUpdatedAt: null,
            },
        ];

        const allRes = await GET(
            new Request('http://localhost/api/cron/issuer-allocations', {
                headers: { Authorization: 'Bearer top-secret' },
            })
        );
        assert.strictEqual(allRes.status, 200);
        const allBody = await allRes.json();
        const xeqt = allBody.symbols.find((s: any) => s.symbol === 'XEQT.TO');
        const xuu = allBody.symbols.find((s: any) => s.symbol === 'XUU.TO');
        const aapl = allBody.symbols.find((s: any) => s.symbol === 'AAPL');
        const cadFx = allBody.symbols.find((s: any) => s.symbol === 'CAD=X');

        assert.strictEqual(cadFx, undefined);
        assert.strictEqual(xeqt.hasCountryAllocations, true);
        assert.strictEqual(xeqt.countryCount, 2);
        assert.strictEqual(xeqt.isFundCandidate, true);
        assert.strictEqual(xuu.hasCountryAllocations, false);
        assert.strictEqual(xuu.isFundCandidate, true);
        assert.strictEqual(aapl.isFundCandidate, false);

        const missingRes = await GET(
            new Request('http://localhost/api/cron/issuer-allocations?onlyMissingCountries=true', {
                headers: { 'x-cron-secret': 'top-secret' },
            })
        );
        assert.strictEqual(missingRes.status, 200);
        const missingBody = await missingRes.json();
        assert.strictEqual(
            missingBody.symbols.some((s: any) => s.symbol === 'XEQT.TO'),
            false
        );
        assert.strictEqual(
            missingBody.symbols.some((s: any) => s.symbol === 'XUU.TO'),
            true
        );
    });

    await t.test('POST normalizes allocations, preserves Yahoo sectors by default, skips uncached, and bumps cache version', async () => {
        process.env.CRON_SECRET = 'top-secret';
        const beforeVersion = getCacheVersions().marketDataVersion;

        (globalThis as any).__mockIssuerCronPrisma.marketDataCache.findMany = async () => [
            {
                symbol: 'XEQT.TO',
                sectorAllocations: [{ technology: 0.25 }, { financial_services: 0.2 }],
            },
            {
                symbol: 'EEMV',
                sectorAllocations: [],
            },
        ];

        const badRes = await POST(
            new Request('http://localhost/api/cron/issuer-allocations', {
                method: 'POST',
                headers: { Authorization: 'Bearer top-secret' },
                body: JSON.stringify({ wrongField: true }),
            })
        );
        assert.strictEqual(badRes.status, 400);

        const res = await POST(
            new Request('http://localhost/api/cron/issuer-allocations', {
                method: 'POST',
                headers: { Authorization: 'Bearer top-secret' },
                body: JSON.stringify({
                    allocations: [
                        {
                            symbol: 'XEQT.TO',
                            providerId: 'ishares',
                            // Pass percentage-like weights and alias country name to test normalization
                            countryAllocations: [{ US: 50 }, { Canada: 30 }, { Japan: 20 }],
                            sectorAllocations: [{ Technology: 0.99 }],
                        },
                        {
                            symbol: 'EEMV',
                            providerId: 'ishares',
                            countryAllocations: [{ China: 0.6 }, { India: 0.4 }],
                            sectorAllocations: [{ Financials: 0.5 }, { Technology: 0.5 }],
                        },
                        {
                            symbol: 'NOTCACHED',
                            providerId: 'ishares',
                            countryAllocations: [{ Canada: 1 }],
                        },
                        {
                            symbol: 'BAD',
                            countryAllocations: [],
                        },
                    ],
                }),
            })
        );

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.updated, 2);
        assert.strictEqual(body.skipped, 1);
        assert.strictEqual(body.failed, 1);

        assert.strictEqual(updatedCalls.length, 2);
        const xeqtUpdate = updatedCalls.find((c) => c.where.symbol === 'XEQT.TO');
        const eemvUpdate = updatedCalls.find((c) => c.where.symbol === 'EEMV');

        assert.deepStrictEqual(xeqtUpdate.data.countryAllocations, [
            { 'United States': 0.5 },
            { Canada: 0.3 },
            { Japan: 0.2 },
        ]);
        // Yahoo sectors already existed on XEQT.TO, so overwriteSectors=false preserves them
        assert.strictEqual(xeqtUpdate.data.sectorAllocations, undefined);

        // EEMV had empty sectors, so issuer sectors fill in (and normalize Financials -> Financial Services)
        assert.deepStrictEqual(eemvUpdate.data.sectorAllocations, [
            { 'Financial Services': 0.5 },
            { Technology: 0.5 },
        ]);

        assert.ok(getCacheVersions().marketDataVersion > beforeVersion);
    });

    await t.test('POST normalizes topHoldings keeping dual-class shares separate and GET filters onlyMissingTopHoldings', async () => {
        process.env.CRON_SECRET = 'top-secret';
        (globalThis as any).__mockIssuerCronPrisma.investment.findMany = async () => [
            { symbol: 'XEQT.TO', name: 'iShares Core Equity ETF Portfolio', type: 'ETF', currencyCode: 'CAD' },
            { symbol: 'ZEA.TO', name: 'BMO MSCI EAFE Index ETF', type: 'ETF', currencyCode: 'CAD' },
        ];
        (globalThis as any).__mockIssuerCronPrisma.marketDataCache.findMany = async () => [
            {
                symbol: 'XEQT.TO',
                sectorAllocations: [{ Technology: 0.25 }],
                countryAllocations: [{ 'United States': 0.45 }],
                topHoldings: [{ name: 'Apple Inc', ticker: 'AAPL', weight: 0.05 }],
            },
            {
                symbol: 'ZEA.TO',
                sectorAllocations: [{ Financials: 0.2 }],
                countryAllocations: [{ Japan: 0.22 }],
                topHoldings: [],
            },
        ];

        const missingHoldingsRes = await GET(
            new Request('http://localhost/api/cron/issuer-allocations?onlyMissingTopHoldings=true', {
                headers: { Authorization: 'Bearer top-secret' },
            })
        );
        assert.strictEqual(missingHoldingsRes.status, 200);
        const missingBody = await missingHoldingsRes.json();
        assert.strictEqual(missingBody.symbols.length, 1);
        assert.strictEqual(missingBody.symbols[0].symbol, 'ZEA.TO');
        assert.strictEqual(missingBody.symbols[0].hasTopHoldings, false);

        const postRes = await POST(
            new Request('http://localhost/api/cron/issuer-allocations', {
                method: 'POST',
                headers: { Authorization: 'Bearer top-secret' },
                body: JSON.stringify({
                    allocations: [
                        {
                            symbol: 'ZEA.TO',
                            providerId: 'bmo',
                            countryAllocations: [],
                            topHoldings: [
                                { name: 'Alphabet Inc Cl A', ticker: 'GOOGL', weight: 2.5 },
                                { name: 'Alphabet Inc Cl C', ticker: 'GOOG', weight: 2.1 },
                                { name: 'NVIDIA CORP', ticker: 'NVDA', weight: 5.0 },
                                { name: 'Nvidia Corporation', ticker: 'NVDA', weight: 1.0 },
                            ],
                        },
                    ],
                }),
            })
        );
        assert.strictEqual(postRes.status, 200);
        const postBody = await postRes.json();
        assert.strictEqual(postBody.updated, 1);
        assert.strictEqual(postBody.results[0].topHoldings, 3);

        const zeaUpdate = updatedCalls.find((c) => c.where.symbol === 'ZEA.TO');
        assert.ok(zeaUpdate);
        assert.strictEqual(zeaUpdate.data.countryAllocations, undefined);
        assert.strictEqual(zeaUpdate.data.topHoldings.length, 3);
        assert.strictEqual(zeaUpdate.data.topHoldings[0].ticker, 'NVDA');
        assert.ok(Math.abs(zeaUpdate.data.topHoldings[0].weight - 0.06) < 1e-6);
        assert.strictEqual(zeaUpdate.data.topHoldings[0].source, 'bmo');
        const tickers = zeaUpdate.data.topHoldings.map((h: any) => h.ticker);
        assert.ok(tickers.includes('GOOGL'));
        assert.ok(tickers.includes('GOOG'));
    });

    await t.test('runPushIssuerAllocations discovers candidates, resolves allocations, and POSTs to endpoint', async () => {
        const requests: Array<{ url: string; method: string; body?: any }> = [];
        const mockFetch: typeof fetch = async (input, init) => {
            const url = typeof input === 'string' ? input : input.toString();
            const method = init?.method || 'GET';
            const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
            requests.push({ url, method, body: parsedBody });

            if (method === 'GET') {
                return new Response(
                    JSON.stringify({
                        symbols: [
                            { symbol: 'XEQT.TO', name: 'iShares Core Equity ETF Portfolio', isFundCandidate: true },
                            { symbol: 'AAPL', name: 'Apple Inc.', isFundCandidate: false },
                        ],
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }

            return new Response(
                JSON.stringify({ success: true, updated: 1, skipped: 0, failed: 0 }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            );
        };

        const config = loadConfigFromEnv({
            ASCEND_URL: 'https://ascend.internal/',
            CRON_SECRET: 'netbird-secret',
            ISSUER_TIMEOUT_MS: '15000',
        });

        const summary = await runPushIssuerAllocations(config, {
            fetchFn: mockFetch,
            resolveFn: async (ctx) => ({
                providerId: 'ishares',
                countryAllocations: [{ 'United States': 0.5 }, { Canada: 0.5 }],
                topHoldings: [
                    { name: 'Apple Inc', ticker: 'AAPL', weight: 0.05, assetClass: 'EQUITY', source: 'ishares' },
                ],
                holdingsCount: 2,
                productId: ctx.symbol === 'XEQT.TO' ? '309480' : undefined,
            }),
            logFn: () => {},
        });

        assert.deepStrictEqual(summary, { discovered: 1, resolved: 1, pushed: 1 });
        assert.strictEqual(requests.length, 2);
        assert.strictEqual(requests[0].url, 'https://ascend.internal/api/cron/issuer-allocations');
        assert.strictEqual(requests[1].method, 'POST');
        assert.strictEqual(requests[1].body.allocations[0].symbol, 'XEQT.TO');
        assert.strictEqual(requests[1].body.allocations[0].topHoldings.length, 1);
    });
});
