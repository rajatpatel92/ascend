import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register module hook to resolve `@/auth`, `@/lib/prisma`, `@/lib/market-data`, `@/lib/xirr`, and `next/server` to global mocks
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
        export class NextRequest extends Request {}
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
      url: "data:text/javascript," + encodeURIComponent("export const prisma = { activity: { findMany: (...args) => globalThis.__mockPrisma.activity.findMany(...args) }, activityType: { findMany: (...args) => globalThis.__mockPrisma.activityType.findMany(...args) }, user: { findMany: (...args) => globalThis.__mockPrisma.user.findMany(...args) } };")
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const MarketDataService = { getPrice: (...args) => globalThis.__mockMarketDataService.getPrice(...args), getHistoricalPrices: (...args) => globalThis.__mockMarketDataService.getHistoricalPrices(...args), getExchangeRate: (...args) => globalThis.__mockMarketDataService.getExchangeRate(...args) };")
    };
  }
  if (specifier === "@/lib/xirr") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const calculateXIRR = () => 0.1; export class Transaction {}")
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

interface MockGlobals {
    __mockAuth: () => Promise<{ user: { name: string } } | null>;
    __mockPrisma: {
        activity: { findMany: () => Promise<unknown[]> };
        activityType: { findMany: () => Promise<unknown[]> };
        user: { findMany: () => Promise<unknown[]> };
    };
    __mockMarketDataService: {
        getPrice: (symbol: string) => Promise<Record<string, unknown> | null>;
        getHistoricalPrices: (symbol: string) => Promise<Record<string, number>>;
        getExchangeRate: (from: string, to: string) => Promise<number>;
    };
}

const mockGlobals = globalThis as unknown as MockGlobals;

// Setup global mock holders before importing route module
mockGlobals.__mockAuth = async () => null;
mockGlobals.__mockPrisma = {
    activity: {
        findMany: async () => []
    },
    activityType: {
        findMany: async () => []
    },
    user: {
        findMany: async () => []
    }
};
mockGlobals.__mockMarketDataService = {
    getPrice: async () => null,
    getHistoricalPrices: async () => ({}),
    getExchangeRate: async () => 1
};

// Import route GET function
const { GET } = await import('./route.ts');

test('GET /api/portfolio', async (t) => {
    t.beforeEach(() => {
        mockGlobals.__mockAuth = async () => ({ user: { name: 'Test User' } });
        mockGlobals.__mockPrisma = {
            activity: {
                findMany: async () => []
            },
            activityType: {
                findMany: async () => []
            },
            user: {
                findMany: async () => []
            }
        };
        mockGlobals.__mockMarketDataService = {
            getPrice: async () => null,
            getHistoricalPrices: async () => ({}),
            getExchangeRate: async () => 1
        };
    });

    await t.test('returns 401 Unauthorized when user is not authenticated', async () => {
        mockGlobals.__mockAuth = async () => null;

        const request = new Request('http://localhost/api/portfolio');

        const response = await GET(request as Parameters<typeof GET>[0]);
        assert.strictEqual(response.status, 401);

        const data = await response.json();
        assert.deepStrictEqual(data, { error: 'Unauthorized' });
    });

    await t.test('returns 200 OK and portfolio summary when authenticated', async () => {
        const request = new Request('http://localhost/api/portfolio');

        const response = await GET(request as Parameters<typeof GET>[0]);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.ok('totalValue' in data);
        assert.ok('constituents' in data);
    });

    await t.test('populates allocationByAccount with resolved account names and aggregates by account name + platform', async () => {
        mockGlobals.__mockPrisma.user.findMany = async () => [
            { username: 'rajat', name: 'Rajat' }
        ];
        mockGlobals.__mockPrisma.activityType.findMany = async () => [
            { name: 'BUY', behavior: 'ADD' },
            { name: 'SELL', behavior: 'REMOVE' }
        ];
        mockGlobals.__mockPrisma.activity.findMany = async () => [
            {
                id: 'act-1',
                type: 'BUY',
                date: new Date('2025-01-10T00:00:00Z'),
                quantity: 10,
                price: 100,
                fee: 0,
                currency: 'USD',
                investment: { symbol: 'XEQT.TO', name: 'iShares Core Equity ETF', type: 'ETF' },
                platform: { name: 'WealthSimple' },
                account: { name: 'rajat', type: 'TFSA' }
            },
            {
                id: 'act-2',
                type: 'BUY',
                date: new Date('2025-01-11T00:00:00Z'),
                quantity: 5,
                price: 100,
                fee: 0,
                currency: 'USD',
                investment: { symbol: 'XEQT.TO', name: 'iShares Core Equity ETF', type: 'ETF' },
                platform: { name: 'WealthSimple' },
                account: { name: 'Rajat', type: 'RRSP' }
            },
            {
                id: 'act-3',
                type: 'BUY',
                date: new Date('2025-01-12T00:00:00Z'),
                quantity: 2,
                price: 50,
                fee: 0,
                currency: 'USD',
                investment: { symbol: 'BTC-CAD', name: 'Bitcoin CAD', type: 'CRYPTO' },
                platform: { name: 'Coinbase' },
                account: { name: 'Rajat', type: 'Crypto' }
            }
        ];
        mockGlobals.__mockMarketDataService.getPrice = async (symbol: string) => {
            if (symbol === 'XEQT.TO') {
                return { price: 100, currency: 'USD', regularMarketChange: 0, regularMarketChangePercent: 0 };
            }
            if (symbol === 'BTC-CAD') {
                return { price: 50, currency: 'USD', regularMarketChange: 0, regularMarketChangePercent: 0 };
            }
            return null;
        };

        const request = new Request('http://localhost/api/portfolio?currency=USD');
        const response = await GET(request as Parameters<typeof GET>[0]);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.deepStrictEqual(data.allocationByAccount, [
            { name: 'Rajat - WealthSimple', value: 1500, platformName: 'WealthSimple' },
            { name: 'Rajat - Coinbase', value: 100, platformName: 'Coinbase' }
        ]);
        assert.ok(!data.allocationByAccount.some((a: { name: string }) => a.name.includes('undefined')));
        assert.deepStrictEqual(data.allocationByAccountType, [
            { name: 'TFSA', value: 1000 },
            { name: 'RRSP', value: 500 },
            { name: 'Crypto', value: 100 }
        ]);
    });

    await t.test('handles missing account/platform, colons in account names, sold positions, and currency conversion', async () => {
        mockGlobals.__mockPrisma.activityType.findMany = async () => [
            { name: 'BUY', behavior: 'ADD' },
            { name: 'SELL', behavior: 'REMOVE' }
        ];
        mockGlobals.__mockPrisma.activity.findMany = async () => [
            {
                id: 'act-1',
                type: 'BUY',
                date: new Date('2025-01-10T00:00:00Z'),
                quantity: 4,
                price: 25,
                fee: 0,
                currency: 'USD',
                investment: { symbol: 'AAPL', name: 'Apple Inc.', type: 'EQUITY' },
                platform: { name: 'WealthSimple' },
                account: { name: 'Family:Joint', type: 'Taxable' }
            },
            {
                id: 'act-2',
                type: 'BUY',
                date: new Date('2025-01-10T00:00:00Z'),
                quantity: 1,
                price: 50,
                fee: 0,
                currency: 'USD',
                investment: { symbol: 'MSFT', name: 'Microsoft', type: 'EQUITY' },
                platform: null,
                account: null
            },
            {
                id: 'act-3',
                type: 'BUY',
                date: new Date('2025-01-10T00:00:00Z'),
                quantity: 3,
                price: 10,
                fee: 0,
                currency: 'USD',
                investment: { symbol: 'SOLD', name: 'Sold Co', type: 'EQUITY' },
                platform: { name: 'Questrade' },
                account: { name: 'Main', type: 'TFSA' }
            },
            {
                id: 'act-4',
                type: 'SELL',
                date: new Date('2025-01-11T00:00:00Z'),
                quantity: 3,
                price: 12,
                fee: 0,
                currency: 'USD',
                investment: { symbol: 'SOLD', name: 'Sold Co', type: 'EQUITY' },
                platform: { name: 'Questrade' },
                account: { name: 'Main', type: 'TFSA' }
            }
        ];
        mockGlobals.__mockMarketDataService.getPrice = async (symbol: string) => {
            if (symbol === 'AAPL') return { price: 25, currency: 'USD', regularMarketChange: 0, regularMarketChangePercent: 0 };
            if (symbol === 'MSFT') return { price: 50, currency: 'USD', regularMarketChange: 0, regularMarketChangePercent: 0 };
            if (symbol === 'SOLD') return { price: 12, currency: 'USD', regularMarketChange: 0, regularMarketChangePercent: 0 };
            return null;
        };
        mockGlobals.__mockMarketDataService.getExchangeRate = async (from: string, to: string) => {
            if (from === 'USD' && to === 'CAD') return 1.4;
            return 1;
        };

        const request = new Request('http://localhost/api/portfolio?currency=CAD');
        const response = await GET(request as Parameters<typeof GET>[0]);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.deepStrictEqual(data.allocationByAccount, [
            { name: 'Family:Joint - WealthSimple', value: 140, platformName: 'WealthSimple' },
            { name: 'Unassigned - Unknown', value: 70, platformName: 'Unknown' }
        ]);

        const aapl = data.constituents.find((c: { symbol: string }) => c.symbol === 'AAPL');
        assert.deepStrictEqual(aapl.accountNames, ['Family:Joint']);
        const breakdownEntry = Object.values(aapl.accountsBreakdown)[0] as { name: string };
        assert.strictEqual(breakdownEntry.name, 'Family:Joint');
    });

    await t.test('excludes sold dust positions from upcomingDividends and keeps YTD dividends from sold holdings', async () => {
        const currentYear = new Date().getUTCFullYear();
        const todayMidnightUTC = new Date();
        todayMidnightUTC.setUTCHours(0, 0, 0, 0);
        const upcomingExDate = new Date(todayMidnightUTC.getTime() + 5 * 24 * 60 * 60 * 1000);

        mockGlobals.__mockPrisma.activityType.findMany = async () => [
            { name: 'BUY', behavior: 'ADD' },
            { name: 'SELL', behavior: 'REMOVE' },
            { name: 'DIVIDEND', behavior: 'NEUTRAL' }
        ];
        mockGlobals.__mockPrisma.activity.findMany = async () => [
            // Sold ETF with IEEE-754 float dust: 10.1 + 20.2 - 30.3 !== 0 in JS float math
            {
                id: 'sold-1',
                type: 'BUY',
                date: new Date(`${currentYear}-01-05T00:00:00Z`),
                quantity: 10.1,
                price: 50,
                fee: 0,
                currency: 'CAD',
                investment: { symbol: 'CASH.TO', name: 'Global X Cash ETF', type: 'ETF' },
                platform: { name: 'WealthSimple' },
                account: { name: 'Rajat', type: 'TFSA' }
            },
            {
                id: 'sold-2',
                type: 'BUY',
                date: new Date(`${currentYear}-01-10T00:00:00Z`),
                quantity: 20.2,
                price: 50,
                fee: 0,
                currency: 'CAD',
                investment: { symbol: 'CASH.TO', name: 'Global X Cash ETF', type: 'ETF' },
                platform: { name: 'WealthSimple' },
                account: { name: 'Rajat', type: 'TFSA' }
            },
            {
                id: 'sold-3',
                type: 'DIVIDEND',
                date: new Date(`${currentYear}-01-01T00:00:00Z`),
                quantity: 1,
                price: 500,
                fee: 0,
                currency: 'CAD',
                investment: { symbol: 'CASH.TO', name: 'Global X Cash ETF', type: 'ETF' },
                platform: { name: 'WealthSimple' },
                account: { name: 'Rajat', type: 'TFSA' }
            },
            {
                id: 'sold-4',
                type: 'SELL',
                date: new Date(`${currentYear}-03-01T00:00:00Z`),
                quantity: 30.3,
                price: 50,
                fee: 0,
                currency: 'CAD',
                investment: { symbol: 'CASH.TO', name: 'Global X Cash ETF', type: 'ETF' },
                platform: { name: 'WealthSimple' },
                account: { name: 'Rajat', type: 'TFSA' }
            },
            // Active holding with exDate today (00:00 UTC) and valid payout
            {
                id: 'act-1',
                type: 'BUY',
                date: new Date(`${currentYear}-02-01T00:00:00Z`),
                quantity: 100,
                price: 30,
                fee: 0,
                currency: 'USD',
                investment: { symbol: 'VTI', name: 'Vanguard Total Stock Market', type: 'ETF' },
                platform: { name: 'WealthSimple' },
                account: { name: 'Rajat', type: 'RRSP' }
            },
            // Active holding with future exDate in window but $0 payout (must be filtered out)
            {
                id: 'act-2',
                type: 'BUY',
                date: new Date(`${currentYear}-02-01T00:00:00Z`),
                quantity: 50,
                price: 20,
                fee: 0,
                currency: 'CAD',
                investment: { symbol: 'ZERO.TO', name: 'Zero Payout ETF', type: 'ETF' },
                platform: { name: 'WealthSimple' },
                account: { name: 'Rajat', type: 'RRSP' }
            }
        ];

        mockGlobals.__mockMarketDataService.getPrice = async (symbol: string) => {
            if (symbol === 'CASH.TO') {
                return {
                    price: 50,
                    currency: 'CAD',
                    regularMarketChange: 0,
                    regularMarketChangePercent: 0,
                    dividendRate: 2.0,
                    dividendYield: 0.04,
                    exDividendDate: upcomingExDate.toISOString(),
                    estNextDividendAmount: 0.16
                };
            }
            if (symbol === 'VTI') {
                return {
                    price: 30,
                    currency: 'USD',
                    regularMarketChange: 0,
                    regularMarketChangePercent: 0,
                    dividendRate: 3.6,
                    dividendYield: 0.12,
                    exDividendDate: todayMidnightUTC.toISOString(),
                    estNextDividendAmount: 0.90
                };
            }
            if (symbol === 'ZERO.TO') {
                return {
                    price: 20,
                    currency: 'CAD',
                    regularMarketChange: 0,
                    regularMarketChangePercent: 0,
                    dividendRate: 0,
                    dividendYield: 0,
                    exDividendDate: upcomingExDate.toISOString(),
                    estNextDividendAmount: 0
                };
            }
            return null;
        };

        mockGlobals.__mockMarketDataService.getExchangeRate = async (from: string, to: string) => {
            if (from === 'CAD' && to === 'USD') return 0.7;
            if (from === 'USD' && to === 'CAD') return 1.4;
            return 1;
        };

        const request = new Request('http://localhost/api/portfolio?currency=CAD');
        const response = await GET(request as Parameters<typeof GET>[0]);
        assert.strictEqual(response.status, 200);

        const data = await response.json();

        // Sold dust position must be clamped to 0 and excluded from upcomingDividends
        const cashConstituent = data.constituents.find((c: { symbol: string }) => c.symbol === 'CASH.TO');
        assert.strictEqual(cashConstituent.quantity, 0);
        assert.strictEqual(cashConstituent.dividendsYTDNative, 500);
        assert.ok(Math.abs(cashConstituent.dividendsYTDTarget - 490) < 1e-6); // 500 * 0.7 * 1.4

        // Only VTI should remain in upcomingDividends (estNextDividendAmount 0.90 * 100 * 1.4 CAD/USD = 126)
        assert.strictEqual(data.upcomingDividends.length, 1);
        assert.strictEqual(data.upcomingDividends[0].symbol, 'VTI');
        assert.ok(Math.abs(data.upcomingDividends[0].estimatedAmount - 126) < 1e-6);

        // Projected annual reflects active VTI only (3.6 * 100 * 1.4 = 504 CAD), excluding sold CASH.TO
        assert.ok(Math.abs(data.projectedDividends - 504) < 1e-6);
        // Sold CASH.TO YTD dividend (Jan 1 UTC) is still counted in Received YTD
        assert.ok(Math.abs(data.dividendsYTD - 490) < 1e-6);
    });
});
