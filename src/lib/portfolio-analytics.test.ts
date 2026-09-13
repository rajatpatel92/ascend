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

test('PortfolioAnalytics.calculateComparisonHistory negative holdings protection', async (t) => {
    t.beforeEach(() => {
        MarketDataService.getDailyHistory = async (sym: string) => {
            if (sym === 'AAPL') {
                return {
                    '2023-01-01': 150,
                    '2023-01-02': 160,
                };
            }
            if (sym === '^GSPC') {
                return {
                    '2023-01-01': 4000,
                    '2023-01-02': 4050,
                };
            }
            return {};
        };
    });

    await t.test('treats selling more than held as implicit deposit to adjust netFlow and prevent negative holdings', async () => {
        // User bought 5 shares, but sells 10 shares (overselling deficit of 5 shares)
        const activities: any[] = [
            {
                type: 'BUY',
                quantity: 5,
                price: 100,
                date: new Date('2023-01-01'),
                investment: { symbol: 'AAPL', currency: 'CAD' }
            },
            {
                type: 'SELL',
                quantity: 10,
                price: 150,
                date: new Date('2023-01-02'),
                investment: { symbol: 'AAPL', currency: 'CAD' }
            }
        ];

        const startDate = new Date('2023-01-01');
        const res = await PortfolioAnalytics.calculateComparisonHistory(activities, '^GSPC', startDate, 'CAD');

        // On 2023-01-02:
        // Initial SELL netFlow calculation: -(10 * 150) = -1500
        // Deficit: holdings = 5 - 10 = -5 -> Math.abs(-5) = 5
        // Deficit value: 5 * 150 = 750
        // Adjusted netFlow: -1500 + 750 = -750
        // Holdings reset to 0
        const day2Perf = res.portfolio.find(p => p.date === '2023-01-02');
        assert.ok(day2Perf);
        assert.strictEqual(day2Perf.netFlow, -750);
        assert.strictEqual(day2Perf.marketValue, 0);
    });
});
