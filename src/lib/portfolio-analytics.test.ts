import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/prisma" || specifier === "./prisma" || specifier === "@prisma/client") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const prisma = {}; export class PrismaClient {} export const Activity = {};")
    };
  }
  if (specifier === "yahoo-finance2") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export default class YahooFinance { constructor() {} }")
    };
  }
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("@/")) {
    let target = specifier.startsWith("@/") ? specifier.replace("@/", "./src/") : specifier;
    if (!target.endsWith(".ts") && !target.endsWith(".tsx") && !target.endsWith(".js")) {
      target += ".ts";
    }
    return nextResolve(new URL(target, context.parentURL || ("file://" + process.cwd() + "/")).href, context);
  }
  return nextResolve(specifier, context);
}
`));

const { PortfolioAnalytics } = await import('./portfolio-analytics.ts');
const { MarketDataService } = await import('./market-data.ts');

test('PortfolioAnalytics.computeHoldingsState', async (t) => {
    await t.test('returns empty object for empty activities', () => {
        const result = PortfolioAnalytics.computeHoldingsState([]);
        assert.deepStrictEqual(result, {});
    });

    await t.test('handles BUY activities', () => {
        const activities: any[] = [
            { type: 'BUY', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
            { type: 'BUY', quantity: 5, investment: { symbol: 'MSFT' }, price: 300 },
            { type: 'BUY', quantity: 5, investment: { symbol: 'AAPL' }, price: 155 },
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 15, MSFT: 5 });
    });

    await t.test('handles BUY and SELL activities', () => {
        const activities: any[] = [
            { type: 'BUY', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
            { type: 'SELL', quantity: 3, investment: { symbol: 'AAPL' }, price: 160 },
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 7 });
    });

    await t.test('handles SELL with negative quantity (absolute value check)', () => {
        const activities: any[] = [
            { type: 'BUY', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
            { type: 'SELL', quantity: -3, investment: { symbol: 'AAPL' }, price: 160 },
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 7 });
    });

    await t.test('handles STOCK_SPLIT', () => {
        const activities: any[] = [
            { type: 'BUY', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
            { type: 'STOCK_SPLIT', quantity: 4, investment: { symbol: 'AAPL' }, price: 0 }, // 4:1 split
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 40 });
    });

    await t.test('ignores non-holding activities like DIVIDEND', () => {
        const activities: any[] = [
            { type: 'BUY', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
            { type: 'DIVIDEND', quantity: 0, price: 10, investment: { symbol: 'AAPL' } },
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 10 });
    });

    await t.test('prevents negative holdings (overselling)', () => {
        const activities: any[] = [
            { type: 'BUY', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
            { type: 'SELL', quantity: 15, investment: { symbol: 'AAPL' }, price: 160 },
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 0 });
    });

    await t.test('handles DEPOSIT as BUY', () => {
        const activities: any[] = [
            { type: 'DEPOSIT', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 10 });
    });

    await t.test('handles WITHDRAWAL as SELL', () => {
        const activities: any[] = [
            { type: 'DEPOSIT', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
            { type: 'WITHDRAWAL', quantity: 3, investment: { symbol: 'AAPL' }, price: 160 },
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 7 });
    });

    await t.test('handles SPLIT as alias for STOCK_SPLIT', () => {
        const activities: any[] = [
            { type: 'BUY', quantity: 10, investment: { symbol: 'AAPL' }, price: 150 },
            { type: 'SPLIT', quantity: 4, investment: { symbol: 'AAPL' }, price: 0 }, // 4:1 split
        ];

        const result = PortfolioAnalytics.computeHoldingsState(activities);
        assert.deepStrictEqual(result, { AAPL: 40 });
    });
});

test('PortfolioAnalytics.calculateIntradayHistory', async (t) => {
    t.beforeEach(() => {
        MarketDataService.getIntradayHistory = async (sym: string) => {
            if (sym === 'AAPL') {
                return {
                    '2023-10-25T14:00:00.000Z': 170,
                    '2023-10-25T14:15:00.000Z': 172
                };
            }
            if (sym === 'USDCAD=X') {
                return {
                    '2023-10-25T14:00:00.000Z': 1.35,
                    '2023-10-25T14:15:00.000Z': 1.36
                };
            }
            return {};
        };

        MarketDataService.getDailyHistory = async (sym: string) => {
            if (sym === 'AAPL') {
                return {
                    '2023-10-24': 169
                };
            }
            if (sym === 'USDCAD=X') {
                return {
                    '2023-10-24': 1.34
                };
            }
            return {};
        };
    });

    await t.test('returns empty array when no active holdings exist', async () => {
        const res = await PortfolioAnalytics.calculateIntradayHistory([]);
        assert.deepStrictEqual(res, []);
    });

    await t.test('calculates correct intraday valuation points and conversion', async () => {
        const activities: any[] = [
            {
                type: 'BUY',
                quantity: 10,
                price: 150,
                date: new Date('2023-01-01'),
                investment: { symbol: 'AAPL', currency: 'USD', currencyCode: 'USD' }
            }
        ];

        const res = await PortfolioAnalytics.calculateIntradayHistory(activities, 'CAD');

        assert.strictEqual(res.length, 2);
        assert.strictEqual(res[0].date, '2023-10-25T14:00:00.000Z');
        // 10 qty * 170 AAPL * 1.35 FX = 2295
        assert.strictEqual(res[0].marketValue, 2295);

        assert.strictEqual(res[1].date, '2023-10-25T14:15:00.000Z');
        // 10 qty * 172 AAPL * 1.36 FX = 2339.2
        assert.ok(Math.abs(res[1].marketValue - 2339.2) < 0.001);
    });
});

test('PortfolioAnalytics.calculateComparisonHistory', async (t) => {
    t.beforeEach(() => {
        MarketDataService.getDailyHistory = async (sym: string) => {
            if (sym === 'NVDA') {
                return {
                    '2024-06-06': 1200, // Pre-split price
                    '2024-06-07': 120,  // Post 10:1 split price
                    '2024-06-08': 125,
                };
            }
            if (sym === '^GSPC') {
                return {
                    '2024-06-06': 5000,
                    '2024-06-07': 5010,
                    '2024-06-08': 5020,
                };
            }
            return {};
        };
    });

    await t.test('processes stock splits pre-market so valuation remains steady', async () => {
        const activities: any[] = [
            {
                id: 'act-1',
                type: 'BUY',
                quantity: 10,
                price: 1000,
                fee: 0,
                date: new Date('2024-06-01'),
                investment: { symbol: 'NVDA', currency: 'USD' }
            },
            {
                id: 'act-2',
                type: 'STOCK_SPLIT',
                quantity: 10, // 10:1 split
                price: 0,
                fee: 0,
                date: new Date('2024-06-07'),
                investment: { symbol: 'NVDA', currency: 'USD' }
            }
        ];

        const startDate = new Date('2024-06-06');

        // Mock RealDate to freeze target end date to 2024-06-08
        const RealDate = globalThis.Date;
        const MockDate = class extends RealDate {
            constructor(...args: any[]) {
                if (args.length === 0) {
                    super('2024-06-08T12:00:00Z');
                } else {
                    // @ts-ignore
                    super(...args);
                }
            }
        } as DateConstructor;
        globalThis.Date = MockDate;

        try {
            const result = await PortfolioAnalytics.calculateComparisonHistory(
                activities,
                '^GSPC',
                startDate,
                'USD'
            );

            // June 6: 10 shares @ 1200 = 12000 MV
            // June 7: Pre-market split -> 100 shares. Price 120 -> 100 * 120 = 12000 MV (steady, no huge drop)
            // June 8: 100 shares @ 125 = 12500 MV
            const day1 = result.portfolio.find(p => p.date === '2024-06-06');
            const day2 = result.portfolio.find(p => p.date === '2024-06-07');
            const day3 = result.portfolio.find(p => p.date === '2024-06-08');

            assert.strictEqual(day1?.marketValue, 12000);
            assert.strictEqual(day2?.marketValue, 12000);
            assert.strictEqual(day3?.marketValue, 12500);
        } finally {
            globalThis.Date = RealDate;
        }
    });
});
