import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register loader hook to mock dependencies imported by `route.ts`
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class NextResponse {
          constructor(body, init) {
            this.body = body;
            this.init = init;
            this.status = init?.status || 200;
          }
          static json(data, init) {
            return {
              data,
              status: init?.status || 200,
              async json() { return data; }
            };
          }
        }
        export class NextRequest {
          constructor(url) {
            this.url = url;
          }
        }
      \`)
    };
  }
  if (specifier === "@/lib/prisma" || specifier === "./prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const prisma = globalThis.prismaMock;
      \`)
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const MarketDataService = globalThis.marketDataServiceMock;
      \`)
    };
  }
  if (specifier === "@/lib/portfolio-analytics") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const PortfolioAnalytics = globalThis.portfolioAnalyticsMock;
      \`)
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = () => globalThis.__mockAuth ? globalThis.__mockAuth() : Promise.resolve({ user: { id: 'test-user', role: 'ADMIN' } });")
    };
  }
  if (specifier.startsWith("@/")) {
    let relativePath = specifier.replace("@/", "./src/");
    if (!relativePath.endsWith('.ts') && !relativePath.endsWith('.js') && !relativePath.endsWith('.json')) {
      relativePath += '.ts';
    }
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

// Setup global mocks before importing the GET handler from route.ts
const prismaMock = {
    targetAllocation: {
        findMany: async () => [] as any[]
    },
    accountType: {
        findMany: async (_args?: any) => [] as any[]
    },
    investment: {
        findMany: async (_args?: any) => [] as any[]
    },
    activity: {
        findMany: async (_args?: any) => [] as any[]
    }
};

const marketDataServiceMock = {
    getPrice: async (symbol: string) => ({ symbol, price: 100, currency: 'USD' }),
    getExchangeRate: async (from: string, to: string) => 1.0
};

const portfolioAnalyticsMock = {
    computeHoldingsState: (activities: any[]) => ({} as Record<string, number>)
};

(globalThis as any).prismaMock = prismaMock;
(globalThis as any).marketDataServiceMock = marketDataServiceMock;
(globalThis as any).portfolioAnalyticsMock = portfolioAnalyticsMock;

// Import GET directly from src/app/api/rebalancer/route.ts
const { GET, dynamic } = await import('./route.ts');

test('GET /api/rebalancer route handler integration and unit test', async (t) => {
    t.beforeEach(() => {
        prismaMock.targetAllocation.findMany = async () => [];
        prismaMock.accountType.findMany = async () => [];
        prismaMock.investment.findMany = async () => [];
        prismaMock.activity.findMany = async () => [];
        marketDataServiceMock.getPrice = async (symbol: string) => ({ symbol, price: 100, currency: 'USD' });
        marketDataServiceMock.getExchangeRate = async (from: string, to: string) => 1.0;
        portfolioAnalyticsMock.computeHoldingsState = () => ({});
    });

    await t.test('Exports dynamic force-dynamic setting', () => {
        assert.strictEqual(dynamic, 'force-dynamic');
    });

    await t.test('Successfully returns empty rebalancer data when no targets or holdings exist', async () => {
        const { NextRequest } = await import('next/server' as any);
        const req = new NextRequest('http://localhost/api/rebalancer');

        const response = await GET(req as any);
        assert.strictEqual(response.status, 200);

        const body = await response.json();
        assert.strictEqual(body.currency, 'USD');
        assert.strictEqual(body.totalValue, 0);
        assert.deepStrictEqual(body.data, []);
    });

    await t.test('Correctly processes query parameters (currency, investmentTypes, accountTypes, excludeSymbols)', async () => {
        let passedActivities: any[] = [];

        prismaMock.targetAllocation.findMany = async () => [
            { symbol: 'AAPL', targetPercentage: 50, yearlyDriftAdjustment: null },
            { symbol: 'MSFT', targetPercentage: 50, yearlyDriftAdjustment: null },
            { symbol: 'EXCLUDED', targetPercentage: 0, yearlyDriftAdjustment: null }
        ];

        prismaMock.activity.findMany = async () => [
            { investment: { symbol: 'AAPL', type: 'STOCK' }, account: { type: 'ROTH', isActive: true } },
            { investment: { symbol: 'MSFT', type: 'CRYPTO' }, account: { type: 'TAXABLE', isActive: true } },
            { investment: { symbol: 'EXCLUDED', type: 'STOCK' }, account: { type: 'ROTH', isActive: true } }
        ];

        portfolioAnalyticsMock.computeHoldingsState = (activities: any[]) => {
            passedActivities = activities;
            const holdings: Record<string, number> = {};
            activities.forEach(a => {
                holdings[a.investment.symbol] = 10;
            });
            return holdings;
        };

        marketDataServiceMock.getPrice = async (symbol: string) => ({
            symbol,
            price: symbol === 'AAPL' ? 150 : 350,
            currency: 'USD'
        });

        const { NextRequest } = await import('next/server' as any);
        const req = new NextRequest('http://localhost/api/rebalancer?currency=EUR&investmentTypes=STOCK&accountTypes=ROTH&excludeSymbols=excluded,other');

        const response = await GET(req as any);
        assert.strictEqual(response.status, 200);

        const body = await response.json();
        assert.strictEqual(body.currency, 'EUR');

        // Verify activities were filtered correctly by investmentTypes, accountTypes, and excludeSymbols before holdings calculation
        assert.strictEqual(passedActivities.length, 1);
        assert.strictEqual(passedActivities[0].investment.symbol, 'AAPL');

        // Excluded symbol should not appear in rebalance data
        const symbolsInData = body.data.map((item: any) => item.symbol);
        assert.ok(!symbolsInData.includes('EXCLUDED'));
        assert.ok(symbolsInData.includes('AAPL'));
    });

    await t.test('Calculates drift, recommended actions (BUY/SELL/HOLD), and recommended share quantities', async () => {
        prismaMock.targetAllocation.findMany = async () => [
            { symbol: 'AAPL', targetPercentage: 50, yearlyDriftAdjustment: null },
            { symbol: 'MSFT', targetPercentage: 50, yearlyDriftAdjustment: null }
        ];

        prismaMock.activity.findMany = async () => [
            { investment: { symbol: 'AAPL', type: 'STOCK' }, account: { type: 'TAXABLE', isActive: true } },
            { investment: { symbol: 'MSFT', type: 'STOCK' }, account: { type: 'TAXABLE', isActive: true } }
        ];

        // AAPL holdings = 20 @ $150 = $3,000 (30% of total $10,000) -> Target 50% ($5,000) -> Underweight -> BUY
        // MSFT holdings = 20 @ $350 = $7,000 (70% of total $10,000) -> Target 50% ($5,000) -> Overweight -> SELL
        portfolioAnalyticsMock.computeHoldingsState = () => ({
            AAPL: 20,
            MSFT: 20
        });

        marketDataServiceMock.getPrice = async (symbol: string) => ({
            symbol,
            price: symbol === 'AAPL' ? 150 : 350,
            currency: 'USD'
        });

        const { NextRequest } = await import('next/server' as any);
        const req = new NextRequest('http://localhost/api/rebalancer');

        const response = await GET(req as any);
        const body = await response.json();

        assert.strictEqual(body.totalValue, 10000);
        assert.strictEqual(body.data.length, 2);

        // Sorting: Underweight (most negative drift) first -> AAPL first
        const aapl = body.data[0];
        assert.strictEqual(aapl.symbol, 'AAPL');
        assert.strictEqual(aapl.currentPercent, 30);
        assert.strictEqual(aapl.targetPercent, 50);
        assert.strictEqual(aapl.driftPercent, -20);
        assert.strictEqual(aapl.action, 'BUY');
        assert.strictEqual(aapl.actionShares, 2000 / 150); // $2000 / $150 per share = 13.3333

        const msft = body.data[1];
        assert.strictEqual(msft.symbol, 'MSFT');
        assert.strictEqual(msft.currentPercent, 70);
        assert.strictEqual(msft.targetPercent, 50);
        assert.strictEqual(msft.driftPercent, 20);
        assert.strictEqual(msft.action, 'SELL');
        assert.strictEqual(msft.actionShares, 2000 / 350); // $2000 / $350 per share = 5.71428
    });

    await t.test('Handles multi-currency conversions and non-USD target currency', async () => {
        prismaMock.targetAllocation.findMany = async () => [
            { symbol: 'BARC', targetPercentage: 100, yearlyDriftAdjustment: null }
        ];

        prismaMock.activity.findMany = async () => [
            { investment: { symbol: 'BARC', type: 'STOCK' }, account: { type: 'TAXABLE', isActive: true } }
        ];

        portfolioAnalyticsMock.computeHoldingsState = () => ({ BARC: 100 });

        // Price in GBP = 200 GBP per share
        marketDataServiceMock.getPrice = async (symbol: string) => ({
            symbol: 'BARC',
            price: 200,
            currency: 'GBP'
        });

        // GBP -> USD rate = 1.25 (1 GBP = 1.25 USD)
        // USD -> EUR rate = 0.90 (1 USD = 0.90 EUR)
        marketDataServiceMock.getExchangeRate = async (from: string, to: string) => {
            if (from === 'GBP' && to === 'USD') return 1.25;
            if (from === 'USD' && to === 'EUR') return 0.90;
            return 1.0;
        };

        const { NextRequest } = await import('next/server' as any);
        const req = new NextRequest('http://localhost/api/rebalancer?currency=EUR');

        const response = await GET(req as any);
        const body = await response.json();

        // 100 shares * 200 GBP * 1.25 GBP/USD = $25,000 USD
        // $25,000 USD * 0.90 USD/EUR = 22,500 EUR
        assert.strictEqual(body.currency, 'EUR');
        assert.strictEqual(body.totalValue, 22500);
        assert.strictEqual(body.data[0].assetCurrency, 'GBP');
        assert.strictEqual(body.data[0].currentValue, 22500);
    });

    await t.test('Catches internal errors and returns 500 status code', async () => {
        prismaMock.targetAllocation.findMany = async () => {
            throw new Error('Database connection failed');
        };

        const originalConsoleError = console.error;
        console.error = () => {};

        try {
            const { NextRequest } = await import('next/server' as any);
            const req = new NextRequest('http://localhost/api/rebalancer');

            const response = await GET(req as any);
            assert.strictEqual(response.status, 500);

            const body = await response.json();
            assert.strictEqual(body.error, 'Internal Server Error');
        } finally {
            console.error = originalConsoleError;
        }
    });

    await t.test('Excludes IEEE-754 dust quantities from holdings unless targeted', async () => {
        prismaMock.targetAllocation.findMany = async () => [
            { symbol: 'VFV.TO', targetPercentage: 100, yearlyDriftAdjustment: null }
        ];
        prismaMock.activity.findMany = async () => [];
        portfolioAnalyticsMock.computeHoldingsState = () => ({
            'VFV.TO': 10,
            'SOLD.DUST': 1e-12
        });

        const { NextRequest } = await import('next/server' as any);
        const req = new NextRequest('http://localhost/api/rebalancer');
        const response = await GET(req as any);
        const body = await response.json();

        const symbols = body.data.map((d: any) => d.symbol);
        assert.deepStrictEqual(symbols, ['VFV.TO']);
    });

    await t.test('Orders activities chronologically, preserves unassigned activities when all account types are selected, and returns per-account breakdown', async () => {
        let capturedFindManyArgs: any = null;
        let passedActivities: any[] = [];

        prismaMock.accountType.findMany = async () => [
            { name: 'TFSA' },
            { name: 'Non-Registered' }
        ];

        prismaMock.activity.findMany = async (args: any) => {
            capturedFindManyArgs = args;
            return [
                {
                    type: 'BUY',
                    quantity: 10,
                    date: new Date('2025-01-01'),
                    accountId: 'acc-tfsa',
                    investment: { symbol: 'VFV.TO', type: 'ETF' },
                    account: { id: 'acc-tfsa', name: 'My TFSA', type: 'TFSA', isActive: true },
                    platform: { name: 'Wealthsimple' }
                },
                {
                    type: 'BUY',
                    quantity: 5,
                    date: new Date('2025-02-01'),
                    accountId: null,
                    investment: { symbol: 'LEGACY', type: 'Stock' },
                    account: null,
                    platform: null
                }
            ];
        };

        portfolioAnalyticsMock.computeHoldingsState = (activities: any[]) => {
            passedActivities = activities;
            const map: Record<string, number> = {};
            activities.forEach(a => {
                map[a.investment.symbol] = (map[a.investment.symbol] || 0) + a.quantity;
            });
            return map;
        };

        const { NextRequest } = await import('next/server' as any);
        // 1. All configured account types selected -> unassigned retained
        const allReq = new NextRequest('http://localhost/api/rebalancer?accountTypes=TFSA,Non-Registered');
        const allRes = await GET(allReq as any);
        const allBody = await allRes.json();

        assert.deepStrictEqual(capturedFindManyArgs?.orderBy, { date: 'asc' });
        assert.strictEqual(passedActivities.length, 2);

        const vfv = allBody.data.find((d: any) => d.symbol === 'VFV.TO');
        assert.strictEqual(vfv.investmentType, 'ETF');
        assert.strictEqual(vfv.accounts.length, 1);
        assert.strictEqual(vfv.accounts[0].accountName, 'My TFSA');
        assert.strictEqual(vfv.accounts[0].quantity, 10);

        // 2. Narrow subset -> unassigned excluded
        const subsetReq = new NextRequest('http://localhost/api/rebalancer?accountTypes=TFSA');
        await GET(subsetReq as any);
        assert.strictEqual(passedActivities.length, 1);
        assert.strictEqual(passedActivities[0].investment.symbol, 'VFV.TO');
    });

    await t.test('Skips USD round-trip FX drift when asset currency equals target currency and exposes priceInTargetCurrency', async () => {
        let exchangeRateCalls = 0;

        prismaMock.targetAllocation.findMany = async () => [
            { symbol: 'XEQT.TO', targetPercentage: 100, yearlyDriftAdjustment: null }
        ];
        prismaMock.activity.findMany = async () => [
            {
                type: 'ADD',
                quantity: 10,
                date: new Date('2025-01-01'),
                accountId: 'acc-cad',
                investment: { symbol: 'XEQT.TO', type: 'ETF' },
                account: { id: 'acc-cad', name: 'CAD TFSA', type: 'TFSA', isActive: true },
                platform: { name: 'Wealthsimple' }
            },
            {
                type: 'STOCK_SPLIT',
                quantity: 2,
                date: new Date('2025-02-01'),
                accountId: 'acc-cad',
                investment: { symbol: 'XEQT.TO', type: 'ETF' },
                account: { id: 'acc-cad', name: 'CAD TFSA', type: 'TFSA', isActive: true },
                platform: { name: 'Wealthsimple' }
            },
            {
                type: 'REMOVE',
                quantity: 5,
                date: new Date('2025-03-01'),
                accountId: 'acc-cad',
                investment: { symbol: 'XEQT.TO', type: 'ETF' },
                account: { id: 'acc-cad', name: 'CAD TFSA', type: 'TFSA', isActive: true },
                platform: { name: 'Wealthsimple' }
            }
        ];

        // 10 * 2 - 5 = 15 shares
        portfolioAnalyticsMock.computeHoldingsState = () => ({ 'XEQT.TO': 15 });
        marketDataServiceMock.getPrice = async () => ({ symbol: 'XEQT.TO', price: 30, currency: 'CAD' });
        marketDataServiceMock.getExchangeRate = async () => {
            exchangeRateCalls++;
            return 0.72; // Deliberately asymmetric to prove no round-trip occurs
        };

        const { NextRequest } = await import('next/server' as any);
        const req = new NextRequest('http://localhost/api/rebalancer?currency=CAD');
        const res = await GET(req as any);
        const body = await res.json();

        assert.strictEqual(exchangeRateCalls, 0);
        assert.strictEqual(body.totalValue, 450);
        assert.strictEqual(body.data[0].priceInTargetCurrency, 30);
        assert.strictEqual(body.data[0].currentValue, 450);
        assert.strictEqual(body.data[0].accounts[0].quantity, 15);
        assert.strictEqual(body.data[0].accounts[0].value, 450);
    });
});
