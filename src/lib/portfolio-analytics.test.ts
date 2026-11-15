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

MarketDataService.getPrice = async () => null;
MarketDataService.getExchangeRate = async () => null;

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

    await t.test('ranks attribution leaders by portfolio impact rather than tiny exited high-ROI holdings', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        try {
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'CORE') {
                    return {
                        '2026-01-01': 100,
                        '2026-01-02': 105,
                        '2026-01-03': 110,
                    };
                }
                if (sym === 'EEMV') {
                    return {
                        '2026-01-01': 100,
                        '2026-01-02': 120,
                        '2026-01-03': 120,
                    };
                }
                if (sym === 'DRAG') {
                    return {
                        '2026-01-01': 100,
                        '2026-01-02': 90,
                        '2026-01-03': 85,
                    };
                }
                if (sym === '^GSPC') {
                    return {
                        '2026-01-01': 5000,
                        '2026-01-02': 5050,
                        '2026-01-03': 5100,
                    };
                }
                return {};
            };

            const activities = [
                {
                    type: 'BUY',
                    quantity: 1000, // $100,000 start value -> +$10,000 profit (+10% asset return)
                    price: 100,
                    fee: 0,
                    date: new Date('2025-12-15T00:00:00.000Z'),
                    investment: { symbol: 'CORE', currency: 'CAD' }
                },
                {
                    type: 'BUY',
                    quantity: 10, // $1,000 start value -> +$200 profit (+20% asset return)
                    price: 100,
                    fee: 0,
                    date: new Date('2025-12-15T00:00:00.000Z'),
                    investment: { symbol: 'EEMV', currency: 'CAD' }
                },
                {
                    type: 'BUY',
                    quantity: 100, // $10,000 start value -> -$1,500 profit (-15% asset return)
                    price: 100,
                    fee: 0,
                    date: new Date('2025-12-15T00:00:00.000Z'),
                    investment: { symbol: 'DRAG', currency: 'CAD' }
                },
                {
                    type: 'SELL',
                    quantity: 10, // Exited EEMV at $120 on 2026-01-02
                    price: 120,
                    fee: 0,
                    date: new Date('2026-01-02T00:00:00.000Z'),
                    investment: { symbol: 'EEMV', currency: 'CAD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            const res = await PortfolioAnalytics.calculateComparisonHistory(
                activities,
                '^GSPC',
                new Date('2026-01-01T00:00:00.000Z'),
                'CAD'
            );

            // CORE (+10% on $100k) must outrank EEMV (+20% on $1k exited)
            assert.strictEqual(res.performers.top.length, 2);
            assert.strictEqual(res.performers.top[0].symbol, 'CORE');
            assert.strictEqual(res.performers.top[0].isExited, false);
            assert.ok(Math.abs(res.performers.top[0].profit - 10000) < 0.01);
            assert.ok(Math.abs(res.performers.top[0].assetReturn - 10) < 0.01);

            assert.strictEqual(res.performers.top[1].symbol, 'EEMV');
            assert.strictEqual(res.performers.top[1].isExited, true);
            assert.ok(Math.abs(res.performers.top[1].profit - 200) < 0.01);
            assert.ok(Math.abs(res.performers.top[1].assetReturn - 20) < 0.01);
            assert.ok(res.performers.top[0].contribution > res.performers.top[1].contribution * 10);

            // Bottom laggards contain only DRAG (no overlap with positive leaders)
            assert.strictEqual(res.performers.bottom.length, 1);
            assert.strictEqual(res.performers.bottom[0].symbol, 'DRAG');
            assert.strictEqual(res.performers.bottom[0].isExited, false);
            assert.ok(Math.abs(res.performers.bottom[0].profit - (-1500)) < 0.01);

            // Sum of Carino-linked contributions equals total portfolio TWR
            const totalContribution =
                res.performers.top.reduce((s, p) => s + p.contribution, 0) +
                res.performers.bottom.reduce((s, p) => s + p.contribution, 0);
            assert.ok(Math.abs(totalContribution - res.summary.portfolioReturn) < 0.01);
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
        }
    });
});

test('PortfolioAnalytics.calculateFlows & out-of-pocket principal', async (t) => {
    await t.test('matches calculateComparisonHistory cumulative netFlow across holiday FX, reverse FX, SELL fees, oversell, and UTC dates', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        try {
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'USDCAD=X') {
                    // Direct pair intentionally empty to verify reverse-pair inversion (CADUSD=X)
                    return {};
                }
                if (sym === 'CADUSD=X') {
                    return {
                        '1M': 0,
                        '2025-12-31': 0.8, // 1 / 0.8 = 1.25 CAD per USD (pre-activity lookback for 2026-01-01 holiday)
                        // '2026-01-01' omitted (holiday FX gap)
                        '2026-01-02': 0.8,
                        '2026-01-05': 0.8,
                    };
                }
                if (sym === 'AAPL') {
                    return {
                        '2025-12-31': 100,
                        '2026-01-02': 100,
                        '2026-01-05': 120,
                    };
                }
                if (sym === '^GSPC') {
                    return {
                        '2025-12-31': 5000,
                        '2026-01-02': 5050,
                        '2026-01-05': 5100,
                    };
                }
                return {};
            };

            // Intentionally unsorted input to confirm input is not mutated and chronological ordering holds
            const activities = [
                {
                    type: 'SELL',
                    quantity: 6, // Oversell by 1 share after buying 5 -> deficit protection triggers on 1 share
                    price: 120,
                    fee: 10, // Net USD proceeds = 6*120 - 10 = 710 USD (not 730!), deficit = 1*120 = 120 USD -> net outflow = 590 USD * 1.25 = 737.5 CAD
                    date: new Date('2026-01-05T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'AAPL', currency: 'USD' }
                },
                {
                    type: 'BUY',
                    quantity: 5,
                    price: 100,
                    fee: 10, // (5*100 + 10) * 1.25 = 637.5 CAD using 2025-12-31 lookback FX
                    date: new Date('2026-01-01T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'AAPL', currency: 'USD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateFlows>[0];

            const originalOrderFirstType = activities[0].type;
            const flowRes = await PortfolioAnalytics.calculateFlows(activities, 'CAD');
            assert.strictEqual(activities[0].type, originalOrderFirstType);

            const compRes = await PortfolioAnalytics.calculateComparisonHistory(
                activities as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0],
                '^GSPC',
                new Date('2026-01-01T00:00:00.000Z'),
                'CAD'
            );

            // BUY on 2026-01-01 = +637.5 CAD; SELL 6 when holding 5 = outflow 710*1.25 (887.5) & deficit inflow 120*1.25 (150)
            // Net = 637.5 + 150 - 887.5 = -100 CAD
            const daySum = flowRes.contributions.day.reduce((s, d) => s + d.inflow - d.outflow, 0);
            const monthSum = flowRes.contributions.month.reduce((s, d) => s + d.inflow - d.outflow, 0);
            const yearSum = flowRes.contributions.year.reduce((s, d) => s + d.inflow - d.outflow, 0);
            const evoInvested = compRes.portfolio.reduce((s, d) => s + d.netFlow, 0);

            assert.ok(Math.abs(daySum - (-100)) < 0.01);
            assert.ok(Math.abs(monthSum - evoInvested) < 0.01);
            assert.ok(Math.abs(yearSum - evoInvested) < 0.01);
            assert.strictEqual(flowRes.contributions.month[0].date, '2026-01-01');
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
        }
    });

    await t.test('excludes DRIP and dividend-funded buys from net contributions without reducing un-reinvested principal', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        try {
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'SCHD') {
                    return {
                        '2025-01-02': 100,
                        '2025-03-01': 100,
                        '2025-04-01': 100,
                    };
                }
                if (sym === 'XEQT') {
                    return {
                        '2025-04-01': 50,
                    };
                }
                if (sym === '^GSPC') {
                    return {
                        '2025-01-02': 5000,
                        '2025-03-01': 5000,
                        '2025-04-01': 5000,
                    };
                }
                return {};
            };

            const activities = [
                // 1) Initial out-of-pocket investment: $10,000 in acc-1
                {
                    type: 'BUY',
                    quantity: 100,
                    price: 100,
                    fee: 0,
                    date: new Date('2025-01-02T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'SCHD', currency: 'CAD' }
                },
                // 2) Same-day DRIP where BUY appears before DIVIDEND in input array:
                // $500 dividend + $500 DRIP BUY -> $0 out-of-pocket!
                {
                    type: 'BUY',
                    quantity: 5,
                    price: 100,
                    fee: 0,
                    date: new Date('2025-03-01T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'SCHD', currency: 'CAD' }
                },
                {
                    type: 'DIVIDEND',
                    quantity: 100,
                    price: 5,
                    fee: 0,
                    date: new Date('2025-03-01T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'SCHD', currency: 'CAD' }
                },
                // 3) Later $300 dividend in acc-1, partially funding a $1000 BUY of XEQT -> $700 out-of-pocket
                {
                    type: 'DIVIDEND',
                    quantity: 105,
                    price: 300 / 105,
                    fee: 0,
                    date: new Date('2025-03-15T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'SCHD', currency: 'CAD' }
                },
                {
                    type: 'BUY',
                    quantity: 20,
                    price: 50,
                    fee: 0,
                    date: new Date('2025-04-01T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'XEQT', currency: 'CAD' }
                },
                // 4) Un-reinvested dividend in acc-2 after buying $2000 -> out-of-pocket in acc-2 remains $2000 (not $1900)
                {
                    type: 'BUY',
                    quantity: 20,
                    price: 100,
                    fee: 0,
                    date: new Date('2025-01-02T00:00:00.000Z'),
                    accountId: 'acc-2',
                    investment: { symbol: 'SCHD', currency: 'CAD' }
                },
                {
                    type: 'DIVIDEND',
                    quantity: 20,
                    price: 5, // $100 dividend never reinvested
                    fee: 0,
                    date: new Date('2025-03-01T00:00:00.000Z'),
                    accountId: 'acc-2',
                    investment: { symbol: 'SCHD', currency: 'CAD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateFlows>[0];

            const flowRes = await PortfolioAnalytics.calculateFlows(activities, 'CAD');
            const totalNetFlow = flowRes.contributions.month.reduce((s, m) => s + m.inflow - m.outflow, 0);

            // Expected out-of-pocket: $10,000 (acc-1) + $0 (DRIP) + $700 (partial XEQT) + $2,000 (acc-2) = $12,700
            assert.ok(Math.abs(totalNetFlow - 12700) < 0.01);

            // Also verify calculateComparisonHistory agrees and preserves SCHD attribution profit (no double-counting)
            const compRes = await PortfolioAnalytics.calculateComparisonHistory(
                activities as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0],
                '^GSPC',
                new Date('2025-01-02T00:00:00.000Z'),
                'CAD'
            );
            const evoInvested = compRes.portfolio.reduce((s, d) => s + d.netFlow, 0);
            assert.ok(Math.abs(evoInvested - 12700) < 0.01);

            const lastCompPoint = compRes.portfolio[compRes.portfolio.length - 1];
            assert.ok(Math.abs((lastCompPoint.unreinvestedDividends ?? -1) - 100) < 0.01);
            const totalChartProfit = (lastCompPoint.marketValue - evoInvested) + (lastCompPoint.unreinvestedDividends ?? 0);
            assert.ok(Math.abs(totalChartProfit - 900) < 0.01);

            const schdAttr = compRes.performers.top.find(p => p.symbol === 'SCHD');
            assert.ok(schdAttr);
            // SCHD price stayed flat at $100, so total profit from SCHD = $500 + $300 + $100 = $900 (NOT $1,400 double-counted)
            assert.ok(Math.abs(schdAttr.profit - 900) < 0.05);

            // Sub-range run starting 2025-03-20 should carry forward the $300 dividend pool in acc-1
            // so the 2025-04-01 $1,000 BUY still records only $700 out-of-pocket netFlow
            const subRangeRes = await PortfolioAnalytics.calculateComparisonHistory(
                activities as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0],
                '^GSPC',
                new Date('2025-03-20T00:00:00.000Z'),
                'CAD'
            );
            const apr1 = subRangeRes.portfolio.find(p => p.date === '2025-04-01');
            assert.ok(apr1);
            assert.ok(Math.abs(apr1.netFlow - 700) < 0.01);
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
        }
    });

    await t.test('merges cron-refreshed USD-shorthand FX tickers (CAD=X) over stale USDCAD=X history', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        const originalGetPrice = MarketDataService.getPrice;
        const originalGetExchangeRate = MarketDataService.getExchangeRate;

        try {
            MarketDataService.getPrice = async () => null;
            MarketDataService.getExchangeRate = async () => null;
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'AAPL') {
                    return { '2025-01-01': 100, '2025-01-02': 100 };
                }
                if (sym === 'SHOP.TO') {
                    return { '2025-01-01': 140, '2025-01-02': 140 };
                }
                if (sym === 'USDCAD=X') {
                    return { '2025-01-01': 1.30, '2025-01-02': 1.30 };
                }
                if (sym === 'CADUSD=X') {
                    return { '2025-01-01': 0.70, '2025-01-02': 0.70 };
                }
                if (sym === 'CAD=X') {
                    // Fresh shorthand point for 2025-01-02 overrides stale USDCAD=X / CADUSD=X
                    return { '2025-01-02': 1.40 };
                }
                return {};
            };

            const usdActivities = [
                {
                    type: 'BUY',
                    quantity: 10,
                    price: 100,
                    fee: 0,
                    date: new Date('2025-01-02T12:00:00.000Z'),
                    investment: { symbol: 'AAPL', currency: 'USD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            const flowRes = await PortfolioAnalytics.calculateFlows(usdActivities, 'CAD');
            const totalInflowCad = flowRes.contributions.day.reduce((s, d) => s + d.inflow, 0);
            // 10 * 100 * 1.40 (from CAD=X) = 1400, NOT 1300 (from stale USDCAD=X)
            assert.ok(Math.abs(totalInflowCad - 1400) < 0.01);

            const cadComp = await PortfolioAnalytics.calculateComparisonHistory(
                usdActivities,
                '^GSPC',
                new Date('2025-01-02T00:00:00.000Z'),
                'CAD'
            );
            const jan2Cad = cadComp.portfolio.find(p => p.date === '2025-01-02');
            assert.ok(jan2Cad);
            assert.ok(Math.abs(jan2Cad.marketValue - 1400) < 0.01);

            // Reverse direction: CAD asset converted to USD uses 1 / CAD=X (1 / 1.40 = 0.7142857...)
            const cadActivities = [
                {
                    type: 'BUY',
                    quantity: 10,
                    price: 140,
                    fee: 0,
                    date: new Date('2025-01-02T12:00:00.000Z'),
                    investment: { symbol: 'SHOP.TO', currency: 'CAD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            const usdComp = await PortfolioAnalytics.calculateComparisonHistory(
                cadActivities,
                '^GSPC',
                new Date('2025-01-02T00:00:00.000Z'),
                'USD'
            );
            const jan2Usd = usdComp.portfolio.find(p => p.date === '2025-01-02');
            assert.ok(jan2Usd);
            // 10 * 140 * (1 / 1.40) = 1000 USD (not 10 * 140 * 0.70 = 980)
            assert.ok(Math.abs(jan2Usd.marketValue - 1000) < 0.01);
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
            MarketDataService.getPrice = originalGetPrice;
            MarketDataService.getExchangeRate = originalGetExchangeRate;
        }
    });

    await t.test('overlays today (endIso) with live getPrice and getExchangeRate matching dashboard net worth', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        const originalGetPrice = MarketDataService.getPrice;
        const originalGetExchangeRate = MarketDataService.getExchangeRate;

        try {
            const now = new Date();
            const endIso = now.toISOString().split('T')[0];
            const yesterday = new Date(now);
            yesterday.setUTCDate(yesterday.getUTCDate() - 1);
            const prevIso = yesterday.toISOString().split('T')[0];
            const twoDaysAgo = new Date(now);
            twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
            const startIso = twoDaysAgo.toISOString().split('T')[0];

            MarketDataService.getDailyHistory = async (sym: string) => {
                // Daily history has older/stale prices & FX and lacks today's live tick
                if (sym === 'AAPL') return { [startIso]: 190, [prevIso]: 200, [endIso]: 200 };
                if (sym === 'SAP') return { [startIso]: 100, [prevIso]: 100 };
                if (sym === 'FAILING') return { [startIso]: 50, [prevIso]: 52 };
                if (sym === 'USDCAD=X') return { [startIso]: 1.35, [prevIso]: 1.35 };
                if (sym === 'EURCAD=X') return { [startIso]: 1.45, [prevIso]: 1.45 };
                return {};
            };

            MarketDataService.getPrice = async (sym: string) => {
                if (sym === 'AAPL') {
                    return { symbol: 'AAPL', price: 215, currency: 'USD', regularMarketTime: now, regularMarketChange: 15, regularMarketChangePercent: 7.5 };
                }
                if (sym === 'SAP') {
                    // Quote returned in USD while asset record uses EUR -> tests cross-currency live normalization
                    return { symbol: 'SAP', price: 120, currency: 'USD', regularMarketTime: now, regularMarketChange: 0, regularMarketChangePercent: 0 };
                }
                if (sym === 'FAILING') {
                    throw new Error('Live quote unavailable');
                }
                return null;
            };

            MarketDataService.getExchangeRate = async (from: string, to: string) => {
                if (from === 'USD' && to === 'CAD') return 1.40;
                if (from === 'EUR' && to === 'USD') return 1.10;
                if (from === 'USD' && to === 'EUR') return 1 / 1.10;
                return null;
            };

            const activities = [
                {
                    type: 'BUY',
                    quantity: 10,
                    price: 190,
                    fee: 0,
                    date: new Date(`${startIso}T12:00:00.000Z`),
                    investment: { symbol: 'AAPL', currency: 'USD' }
                },
                {
                    type: 'BUY',
                    quantity: 5,
                    price: 100,
                    fee: 0,
                    date: new Date(`${startIso}T12:00:00.000Z`),
                    investment: { symbol: 'SAP', currency: 'EUR' }
                },
                {
                    type: 'BUY',
                    quantity: 2,
                    price: 50,
                    fee: 0,
                    date: new Date(`${startIso}T12:00:00.000Z`),
                    investment: { symbol: 'FAILING', currency: 'CAD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            const res = await PortfolioAnalytics.calculateComparisonHistory(
                activities,
                '^GSPC',
                new Date(`${startIso}T00:00:00.000Z`),
                'CAD'
            );

            const lastPoint = res.portfolio[res.portfolio.length - 1];
            assert.strictEqual(lastPoint.date, endIso);

            // AAPL: 10 * 215 * 1.40 = 3010 CAD
            // SAP: 5 * (120 * (1 / 1.10)) * (1.10 * 1.40) = 5 * 120 * 1.40 = 840 CAD
            // FAILING (throws on getPrice): falls back to yesterday's close 2 * 52 = 104 CAD
            const expectedEndValue = 3010 + 840 + 104;
            assert.ok(
                Math.abs(lastPoint.marketValue - expectedEndValue) < 0.01,
                `Expected ${expectedEndValue}, got ${lastPoint.marketValue}`
            );
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
            MarketDataService.getPrice = originalGetPrice;
            MarketDataService.getExchangeRate = originalGetExchangeRate;
        }
    });

    await t.test('handles multi-account STOCK_SPLIT once per account and divides lastKnownPrices only once', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        try {
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'SPLT') {
                    // Pre-split close on Jan 1 = 400; split day Jan 2 price omitted so lastKnownPrices carries forward
                    // then Jan 3 resumes at post-split 100
                    return {
                        '2026-01-01': 400,
                        '2026-01-03': 100
                    };
                }
                if (sym === '^GSPC') {
                    return { '2026-01-01': 5000, '2026-01-02': 5000, '2026-01-03': 5000 };
                }
                return {};
            };

            const activities = [
                {
                    type: 'BUY',
                    quantity: 5,
                    price: 400,
                    fee: 0,
                    date: new Date('2025-12-20T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'SPLT', currency: 'USD' }
                },
                {
                    type: 'BUY',
                    quantity: 5,
                    price: 400,
                    fee: 0,
                    date: new Date('2025-12-20T00:00:00.000Z'),
                    accountId: 'acc-2',
                    investment: { symbol: 'SPLT', currency: 'USD' }
                },
                {
                    type: 'STOCK_SPLIT',
                    quantity: 4,
                    price: 0,
                    fee: 0,
                    date: new Date('2026-01-02T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'SPLT', currency: 'USD' }
                },
                {
                    type: 'STOCK_SPLIT',
                    quantity: 4,
                    price: 0,
                    fee: 0,
                    date: new Date('2026-01-02T00:00:00.000Z'),
                    accountId: 'acc-2',
                    investment: { symbol: 'SPLT', currency: 'USD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            const state = PortfolioAnalytics.computeHoldingsState(activities as any);
            assert.strictEqual(state['SPLT'], 40);

            const res = await PortfolioAnalytics.calculateComparisonHistory(
                activities,
                '^GSPC',
                new Date('2026-01-01T00:00:00.000Z'),
                'USD'
            );

            const day1 = res.portfolio.find(p => p.date === '2026-01-01');
            const day2 = res.portfolio.find(p => p.date === '2026-01-02');
            const day3 = res.portfolio.find(p => p.date === '2026-01-03');
            assert.ok(day1 && day2 && day3);

            // Day 1: 10 shares * 400 = 4000; Day 2: 40 shares * (400/4 = 100) = 4000 (not 400/16 = 25 -> 1000!)
            assert.ok(Math.abs(day1.marketValue - 4000) < 0.01);
            assert.ok(Math.abs(day2.marketValue - 4000) < 0.01);
            assert.ok(Math.abs(day3.marketValue - 4000) < 0.01);
            assert.ok(Math.abs(day3.nav - 100) < 0.01);
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
        }
    });

    await t.test('does not crash NAV when discoveryFlow occurs on the same day as a small dividend', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        try {
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'MAIN') {
                    return { '2026-01-01': 100, '2026-01-02': 100 };
                }
                if (sym === 'NEWB') {
                    return { '2026-01-02': 50 };
                }
                if (sym === '^GSPC') {
                    return { '2026-01-01': 5000, '2026-01-02': 5000 };
                }
                return {};
            };

            const activities = [
                {
                    type: 'BUY',
                    quantity: 10,
                    price: 100,
                    fee: 0,
                    date: new Date('2025-12-20T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'MAIN', currency: 'USD' }
                },
                {
                    type: 'DIVIDEND',
                    quantity: 10,
                    price: 1, // $10 dividend on same day as NEWB discovery
                    fee: 0,
                    date: new Date('2026-01-02T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'MAIN', currency: 'USD' }
                },
                {
                    type: 'TRANSFER_IN',
                    quantity: 100,
                    price: 50,
                    fee: 0,
                    date: new Date('2026-01-01T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'NEWB', currency: 'USD' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            // Note: NEWB was absent from 2026-01-01 daily history, got its first price on 2026-01-02
            const res = await PortfolioAnalytics.calculateComparisonHistory(
                activities,
                '^GSPC',
                new Date('2026-01-01T00:00:00.000Z'),
                'USD'
            );
            const day2 = res.portfolio.find(p => p.date === '2026-01-02');
            assert.ok(day2);
            assert.ok(day2.nav >= 100, `NAV should not crash when discoveryFlow occurs with dividend, got ${day2.nav}`);
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
        }
    });

    await t.test('subtracts dividend fees, triangulates EUR->CAD via USD, resolves intermediate FX dates, and FX-normalizes benchmark returns', async () => {
        const originalGetDailyHistory = MarketDataService.getDailyHistory;
        try {
            MarketDataService.getDailyHistory = async (sym: string) => {
                if (sym === 'EURO') {
                    return { '2026-01-01': 100, '2026-01-05': 100 };
                }
                if (sym === 'EURUSD=X') {
                    return { '2026-01-01': 1.10, '2026-01-05': 1.10 };
                }
                if (sym === 'USDCAD=X') {
                    return { '2026-01-01': 1.30, '2026-01-03': 1.40, '2026-01-05': 1.40 };
                }
                if (sym === '^GSPC') {
                    // Unchanged index in USD (5000 -> 5000), but USD/CAD appreciated from 1.30 to 1.40 (+7.692%)
                    return { '2026-01-01': 5000, '2026-01-05': 5000 };
                }
                return {};
            };

            const activities = [
                {
                    type: 'BUY',
                    quantity: 10,
                    price: 100,
                    fee: 0,
                    date: new Date('2026-01-01T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'EURO', currency: 'EUR' }
                },
                {
                    type: 'DIVIDEND',
                    quantity: 10,
                    price: 5, // 50 EUR gross - 10 EUR withholding fee = 40 EUR net on 2026-01-05
                    fee: 10,
                    date: new Date('2026-01-05T00:00:00.000Z'),
                    accountId: 'acc-1',
                    investment: { symbol: 'EURO', currency: 'EUR' }
                }
            ] as unknown as Parameters<typeof PortfolioAnalytics.calculateComparisonHistory>[0];

            const flowRes = await PortfolioAnalytics.calculateFlows(activities as any, 'CAD');
            // BUY on Jan 1: 1000 EUR * (1.10 * 1.30 = 1.43) = 1430 CAD
            const totalInflow = flowRes.contributions.day.reduce((s, d) => s + d.inflow, 0);
            assert.ok(Math.abs(totalInflow - 1430) < 0.01);
            // DIVIDEND on Jan 5: (50 - 10) EUR * (1.10 * 1.40 = 1.54) = 61.60 CAD
            assert.ok(Math.abs((flowRes.dividends?.day[0]?.amount || 0) - 61.60) < 0.01);

            const compRes = await PortfolioAnalytics.calculateComparisonHistory(
                activities,
                '^GSPC',
                new Date('2026-01-01T00:00:00.000Z'),
                'CAD'
            );
            const benchJan1 = compRes.benchmark.find(b => b.date === '2026-01-01');
            const benchJan5 = compRes.benchmark.find(b => b.date === '2026-01-05');
            assert.ok(benchJan1 && benchJan5);
            // .value remains raw index level (5000), while .normalized & benchmarkReturn reflect USD->CAD (+7.6923%)
            assert.strictEqual(benchJan1.value, 5000);
            assert.strictEqual(benchJan5.value, 5000);
            const expectedFxReturn = ((1.40 - 1.30) / 1.30) * 100;
            assert.ok(Math.abs(compRes.summary.benchmarkReturn - expectedFxReturn) < 0.05);
        } finally {
            MarketDataService.getDailyHistory = originalGetDailyHistory;
        }
    });
});


