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
});
