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
            if (sym === 'AAPL') {
                return {
                    '2023-01-01': 150,
                    '2023-01-02': 155,
                    '2023-01-03': 160,
                };
            }
            if (sym === 'USDCAD=X') {
                return {
                    '2023-01-01': 1.30,
                    '2023-01-02': 1.32,
                    '2023-01-03': 1.35,
                };
            }
            if (sym === '^GSPC') {
                return {
                    '2023-01-01': 3800,
                    '2023-01-02': 3850,
                    '2023-01-03': 3900,
                };
            }
            return {};
        };
    });

    await t.test('accumulates dividends prior to startDate with proper FX conversion', async () => {
        const activities: any[] = [
            {
                type: 'BUY',
                quantity: 10,
                price: 150,
                date: new Date('2022-12-15'),
                investment: { symbol: 'AAPL', currency: 'USD' }
            },
            {
                type: 'DIVIDEND',
                quantity: 10,
                price: 2.5, // 10 * 2.5 = 25 USD dividend
                date: new Date('2022-12-20'),
                investment: { symbol: 'AAPL', currency: 'USD' }
            },
            {
                type: 'DIVIDEND',
                quantity: 10,
                price: 1.0, // 10 * 1.0 = 10 USD dividend
                date: new Date('2023-01-02'),
                investment: { symbol: 'AAPL', currency: 'USD' }
            }
        ];

        const startDate = new Date('2023-01-01');
        const res = await PortfolioAnalytics.calculateComparisonHistory(activities, '^GSPC', startDate, 'CAD');

        // Initial dividend is before 2023-01-01.
        // USD dividend = 25. FX rate on or before 2022-12-20 defaults to earliest available ('2023-01-01': 1.30)
        // Initial dividend in CAD = 25 * 1.30 = 32.5 CAD.
        // On 2023-01-02, dividend = 10 USD * 1.32 (FX on 2023-01-02) = 13.2 CAD.
        // Accumulated dividends on 2023-01-02 should be 32.5 + 13.2 = 45.7 CAD.
        const day2 = res.portfolio.find(p => p.date === '2023-01-02');
        assert.ok(day2);

        const debugDividendLog = res.debug.find(line => line.includes('Initial Historical Dividends'));
        assert.ok(debugDividendLog);
        assert.ok(debugDividendLog.includes('32.5'));
    });

    await t.test('seeds prior closing prices on non-trading startDate and ignores summary keys', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        try {
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'AAPL') {
                    return {
                        '1M': 0,
                        '1W': 195,
                        'YTD': 0,
                        '2025-12-31': 200,
                        // '2026-01-01' omitted (market closed on New Year's Day)
                        '2026-01-02': 202,
                    };
                }
                if (sym === 'BTC-CAD') {
                    return {
                        '2025-12-31': 100000,
                        '2026-01-01': 100000,
                        '2026-01-02': 101000,
                    };
                }
                if (sym === 'USDCAD=X') {
                    return {
                        '1M': 0,
                        '2025-12-31': 1.4,
                        '2026-01-01': 1.4,
                        '2026-01-02': 1.4,
                    };
                }
                if (sym === '^GSPC') {
                    return {
                        'YTD': 0,
                        '2025-12-31': 5800,
                        // '2026-01-01' omitted (holiday)
                        '2026-01-02': 5858,
                    };
                }
                return {};
            };

            const activities = [
                {
                    type: 'BUY',
                    quantity: 100,
                    price: 180,
                    fee: 0,
                    date: new Date('2025-10-01T00:00:00.000Z'),
                    investment: { symbol: 'AAPL', currency: 'USD' }
                },
                {
                    type: 'BUY',
                    quantity: 0.01,
                    price: 90000,
                    fee: 0,
                    date: new Date('2025-10-01T00:00:00.000Z'),
                    investment: { symbol: 'BTC-CAD', currency: 'CAD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            const res = await PortfolioAnalytics.calculateComparisonHistory(
                activities,
                '^GSPC',
                new Date('2026-01-01T00:00:00.000Z'),
                'CAD'
            );

            const day1 = res.portfolio.find(p => p.date === '2026-01-01');
            const day2 = res.portfolio.find(p => p.date === '2026-01-02');
            assert.ok(day1 && day2);

            // Day 1 includes AAPL at 2025-12-31 close (100 * 200 * 1.4 = 28000) + BTC-CAD (1000)
            assert.ok(Math.abs(day1.marketValue - 29000) < 0.01);
            assert.strictEqual(day1.nav, 100);

            // Day 2 only reflects actual +1% market appreciation (no +2900% spike)
            assert.strictEqual(day2.discoveryFlow, 0);
            assert.ok(Math.abs(day2.marketValue - 29290) < 0.01);
            assert.ok(Math.abs(day2.nav - 101) < 0.01);

            const benchDay1 = res.benchmark.find(b => b.date === '2026-01-01');
            const benchDay2 = res.benchmark.find(b => b.date === '2026-01-02');
            assert.ok(benchDay1 && benchDay2);
            assert.strictEqual(benchDay1.value, 5800);
            assert.strictEqual(benchDay1.normalized, 100);
            assert.ok(Math.abs(benchDay2.normalized - 101) < 0.01);
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
        }
    });

    await t.test('excludes discoveryFlow from NAV growth when a holding receives its first price mid-period', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        try {
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'AAPL') {
                    return {
                        '2026-01-01': 100,
                        '2026-01-02': 100,
                        '2026-01-03': 102,
                    };
                }
                if (sym === 'NEWCO') {
                    return {
                        '2026-01-03': 50,
                    };
                }
                if (sym === '^GSPC') {
                    return {
                        '2026-01-01': 1000,
                        '2026-01-02': 1000,
                        '2026-01-03': 1000,
                    };
                }
                return {};
            };

            const activities = [
                {
                    type: 'BUY',
                    quantity: 10,
                    price: 100,
                    fee: 0,
                    date: new Date('2025-12-15T00:00:00.000Z'),
                    investment: { symbol: 'AAPL', currency: 'CAD' }
                },
                {
                    type: 'TRANSFER_IN',
                    quantity: 100,
                    price: 50,
                    fee: 0,
                    date: new Date('2026-01-02T00:00:00.000Z'),
                    investment: { symbol: 'NEWCO', currency: 'CAD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            const res = await PortfolioAnalytics.calculateComparisonHistory(
                activities,
                '^GSPC',
                new Date('2026-01-01T00:00:00.000Z'),
                'CAD'
            );

            const day3 = res.portfolio.find(p => p.date === '2026-01-03');
            assert.ok(day3);
            assert.strictEqual(day3.discoveryFlow, 5000);
            // Only AAPL moved from 100 to 102 (+2%), so NAV must be 102 rather than spiking from NEWCO discovery
            assert.ok(Math.abs(day3.nav - 102) < 0.01);
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
        }
    });

    await t.test('does not double-count start-day activity when startDate has non-midnight timestamp', async () => {
        const activities = [
            {
                type: 'BUY',
                quantity: 10,
                price: 150,
                fee: 0,
                date: new Date('2023-01-01T00:00:00.000Z'),
                investment: { symbol: 'AAPL', currency: 'USD' }
            }
        ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

        const res = await PortfolioAnalytics.calculateComparisonHistory(
            activities,
            '^GSPC',
            new Date('2023-01-01T18:30:00.000Z'),
            'USD'
        );

        const day1 = res.portfolio.find(p => p.date === '2023-01-01');
        assert.ok(day1);
        // 10 shares * 150 = 1500 (not 20 shares = 3000)
        assert.strictEqual(day1.marketValue, 1500);
        assert.strictEqual(day1.netFlow, 1500);
    });
});
