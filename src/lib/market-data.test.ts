import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@prisma/client") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class PrismaClient { constructor() { this.marketDataCache = { findUnique() {}, upsert() {}, updateMany() {} }; this.$transaction = async () => {}; } }")
    };
  }
  if (specifier === "yahoo-finance2") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export default class YahooFinance { constructor() {} quote() {} quoteSummary() {} chart() {} search() {} historical() {} }")
    };
  }
  return nextResolve(specifier, context);
}
`));

const { prisma } = await import('./prisma.ts');
const { Throttler, apiThrottler, estimateNextDividend, MarketDataService, yahooFinance } = await import('./market-data.ts');
const { flushBackgroundPriceSync, resetSyncStateForTests } = await import('./sync-state.ts');
const { getCacheVersions, resetCacheVersionsForTests } = await import('./cache-invalidation.ts');

test('Throttler', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('executes queued tasks up to max concurrent limit', async () => {
        const throttler = new Throttler(2, 10);
        let active = 0;
        let maxObservedActive = 0;

        const makeTask = (id: number) => () => new Promise<number>((resolve) => {
            active++;
            if (active > maxObservedActive) maxObservedActive = active;
            setTimeout(() => {
                active--;
                resolve(id);
            }, 20);
        });

        const p1 = throttler.add(makeTask(1));
        const p2 = throttler.add(makeTask(2));
        const p3 = throttler.add(makeTask(3));

        const results = await Promise.all([p1, p2, p3]);

        assert.deepStrictEqual(results, [1, 2, 3]);
        assert.ok(maxObservedActive <= 2, `Max observed active requests ${maxObservedActive} exceeded limit 2`);
    });

    await t.test('triggers circuit breaker on 429 error and rejects queued tasks', async () => {
        const throttler = new Throttler(1, 10);

        const okTask = () => Promise.resolve('ok');
        const fail429Task = () => Promise.reject({ status: 429, message: 'Too Many Requests' });

        const p1 = throttler.add(fail429Task);
        const p2 = throttler.add(okTask);

        let error1: any;
        let error2: any;

        try { await p1; } catch (e) { error1 = e; }
        try { await p2; } catch (e) { error2 = e; }

        assert.strictEqual(error1?.status, 429);
        assert.strictEqual(error2?.message, 'Circuit Breaker: Rate limit exceeded. Request cancelled.');
    });

    await t.test('rejects new requests immediately when circuit breaker is active', async () => {
        const throttler = new Throttler(1, 10);
        const fail429Task = () => Promise.reject({ message: '429 Rate limited' });

        try { await throttler.add(fail429Task); } catch (_) {}

        let newReqError: any;
        try {
            await throttler.add(() => Promise.resolve('data'));
        } catch (e) {
            newReqError = e;
        }

        assert.ok(newReqError?.message.includes('Rate limit exceeded. Cooling down for'));
    });

    await t.test('maintains concurrency limit under high volume concurrent queueing', async () => {
        const concurrency = 5;
        const throttler = new Throttler(concurrency, 2);
        let activeCount = 0;
        let maxObservedActive = 0;
        const totalTasks = 50;

        const tasks = Array.from({ length: totalTasks }, (_, i) => {
            return throttler.add(() => new Promise<number>((resolve) => {
                activeCount++;
                if (activeCount > maxObservedActive) {
                    maxObservedActive = activeCount;
                }
                setTimeout(() => {
                    activeCount--;
                    resolve(i);
                }, 10);
            }));
        });

        const results = await Promise.all(tasks);

        assert.strictEqual(results.length, totalTasks);
        assert.deepStrictEqual(results, Array.from({ length: totalTasks }, (_, i) => i));
        assert.ok(maxObservedActive <= concurrency, `Max observed active (${maxObservedActive}) exceeded concurrency limit (${concurrency})`);

        // Wait a small delay to ensure all cleanup timers in finally() complete
        await new Promise((r) => setTimeout(r, 20));
    });

    await t.test('handles mixed resolution and rejection under high concurrency without exceeding limit', async () => {
        const concurrency = 4;
        const throttler = new Throttler(concurrency, 2);
        let activeCount = 0;
        let maxObservedActive = 0;
        const totalTasks = 40;

        const tasks = Array.from({ length: totalTasks }, (_, i) => {
            return throttler.add(() => new Promise<number>((resolve, reject) => {
                activeCount++;
                if (activeCount > maxObservedActive) {
                    maxObservedActive = activeCount;
                }
                setTimeout(() => {
                    activeCount--;
                    if (i % 3 === 0) {
                        reject(new Error(`Task ${i} error`));
                    } else {
                        resolve(i);
                    }
                }, 5);
            }));
        });

        const results = await Promise.allSettled(tasks);

        assert.strictEqual(results.length, totalTasks);
        assert.ok(maxObservedActive <= concurrency, `Max observed active (${maxObservedActive}) exceeded limit (${concurrency})`);

        let rejectedCount = 0;
        let fulfilledCount = 0;
        results.forEach((res, i) => {
            if (res.status === 'fulfilled') {
                fulfilledCount++;
                assert.strictEqual(res.value, i);
            } else {
                rejectedCount++;
                assert.strictEqual(res.reason.message, `Task ${i} error`);
            }
        });

        assert.strictEqual(fulfilledCount + rejectedCount, totalTasks);
        assert.ok(rejectedCount > 0, 'Expected some tasks to reject');

        // Wait a small delay to ensure cleanup timers complete
        await new Promise((r) => setTimeout(r, 20));
    });
});

test('estimateNextDividend', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('returns undefined for empty or insufficient dividend history', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => []);
        assert.strictEqual(await estimateNextDividend('AAPL'), undefined);

        subT.mock.method(yahooFinance, 'historical', async () => [{ date: '2023-01-01', dividends: 0.5 }]);
        assert.strictEqual(await estimateNextDividend('AAPL'), undefined);
    });

    await t.test('estimates next dividend for monthly schedule (~30 days)', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => [
            { date: '2023-01-01', dividends: 0.25 },
            { date: '2023-01-31', dividends: 0.25 }
        ]);

        const estimate = await estimateNextDividend('AAPL');
        assert.ok(estimate);
        assert.strictEqual(estimate.amount, 0.25);

        const expectedDate = new Date('2023-01-31');
        expectedDate.setDate(expectedDate.getDate() + 30);
        assert.strictEqual(estimate.date.toISOString().split('T')[0], expectedDate.toISOString().split('T')[0]);
    });

    await t.test('estimates next dividend for quarterly schedule (~90 days)', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => [
            { date: '2023-01-01', dividends: 0.50 },
            { date: '2023-04-01', dividends: 0.55 }
        ]);

        const estimate = await estimateNextDividend('AAPL');
        assert.ok(estimate);
        assert.strictEqual(estimate.amount, 0.55);

        const expectedDate = new Date('2023-04-01');
        expectedDate.setDate(expectedDate.getDate() + 91);
        assert.strictEqual(estimate.date.toISOString().split('T')[0], expectedDate.toISOString().split('T')[0]);
    });

    await t.test('estimates next dividend for annual schedule (~365 days)', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => [
            { date: '2022-03-15', dividends: 1.00 },
            { date: '2023-03-15', dividends: 1.10 }
        ]);

        const estimate = await estimateNextDividend('AAPL');
        assert.ok(estimate);
        assert.strictEqual(estimate.amount, 1.10);

        assert.strictEqual(estimate.date.toISOString().split('T')[0], '2024-03-15');
    });

    await t.test('estimates next dividend for irregular cadence', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => [
            { date: '2023-01-01', dividends: 0.40 },
            { date: '2023-02-15', dividends: 0.45 }
        ]);

        const estimate = await estimateNextDividend('AAPL');
        assert.ok(estimate);
        assert.strictEqual(estimate.amount, 0.45);

        const expectedDate = new Date('2023-02-15');
        expectedDate.setDate(expectedDate.getDate() + 45);
        assert.strictEqual(estimate.date.toISOString().split('T')[0], expectedDate.toISOString().split('T')[0]);
    });

    await t.test('returns undefined on API error', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => { throw new Error('API Error'); });
        assert.strictEqual(await estimateNextDividend('AAPL'), undefined);
    });

    await t.test('returns undefined when throttler circuit breaker or rate limit error occurs', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => {
            throw new Error('Circuit Breaker: Rate limit exceeded. Request cancelled.');
        });
        assert.strictEqual(await estimateNextDividend('AAPL'), undefined);
    });

    await t.test('returns undefined when yahooFinance returns null or malformed data', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => null);
        assert.strictEqual(await estimateNextDividend('AAPL'), undefined);

        subT.mock.method(yahooFinance, 'historical', async () => ({ unexpected: 'response' }));
        assert.strictEqual(await estimateNextDividend('AAPL'), undefined);
    });

    await t.test('returns undefined when historical event objects throw during property evaluation', async (subT) => {
        subT.mock.method(yahooFinance, 'historical', async () => [
            {
                get date() { throw new Error('Property evaluation error'); },
                dividends: 0.5
            },
            { date: '2023-01-01', dividends: 0.5 }
        ]);
        assert.strictEqual(await estimateNextDividend('AAPL'), undefined);
    });
});

test('MarketDataService.processHistory', async (t) => {
    await t.test('returns empty object for empty quotes', () => {
        assert.deepStrictEqual(MarketDataService.processHistory([]), {});
    });

    await t.test('processes daily quotes into date keys and calculates period snapshot keys', () => {
        const quotes = [
            { date: '2023-01-01T00:00:00.000Z', close: 100 },
            { date: '2023-01-02T00:00:00.000Z', close: 102 },
            { date: '2023-01-03T00:00:00.000Z', close: 105 }
        ];

        const history = MarketDataService.processHistory(quotes);

        assert.strictEqual(history['2023-01-01'], 100);
        assert.strictEqual(history['2023-01-02'], 102);
        assert.strictEqual(history['2023-01-03'], 105);

        assert.ok('1W' in history);
        assert.ok('1M' in history);
        assert.ok('1Y' in history);
        assert.ok('YTD' in history);
    });

    await t.test('handles adjClose if close is missing', () => {
        const quotes = [
            { date: '2023-01-01T00:00:00.000Z', adjClose: 99.5 }
        ];
        const history = MarketDataService.processHistory(quotes);
        assert.strictEqual(history['2023-01-01'], 99.5);
    });
});

test('MarketDataService.searchSymbols', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('searches symbols and returns mapped StockSearchResult array', async (subT) => {
        subT.mock.method(yahooFinance, 'search', async () => ({
            quotes: [
                {
                    isYahooFinance: true,
                    symbol: 'AAPL',
                    shortname: 'Apple Inc.',
                    exchange: 'NASDAQ',
                    quoteType: 'EQUITY'
                },
                {
                    isYahooFinance: false,
                    symbol: 'BAD',
                    shortname: 'Ignore Me'
                },
                {
                    isYahooFinance: true,
                    symbol: 'MSFT',
                    longname: 'Microsoft Corporation',
                    exchange: 'NASDAQ',
                    quoteType: 'EQUITY'
                }
            ]
        }));

        const results = await MarketDataService.searchSymbols('TECH');

        assert.strictEqual(results.length, 2);
        assert.deepStrictEqual(results[0], {
            symbol: 'AAPL',
            name: 'Apple Inc.',
            exchange: 'NASDAQ',
            type: 'EQUITY'
        });
        assert.deepStrictEqual(results[1], {
            symbol: 'MSFT',
            name: 'Microsoft Corporation',
            exchange: 'NASDAQ',
            type: 'EQUITY'
        });
    });

    await t.test('returns empty array when no quotes or error occurs', async (subT) => {
        subT.mock.method(yahooFinance, 'search', async () => ({ quotes: null }));
        assert.deepStrictEqual(await MarketDataService.searchSymbols('UNKNOWN'), []);

        subT.mock.method(yahooFinance, 'search', async () => { throw new Error('Search failed'); });
        assert.deepStrictEqual(await MarketDataService.searchSymbols('FAIL'), []);
    });
});

test('MarketDataService.getPrice', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('returns valid cached data including estNextDividendAmount when not stale and forceRefresh is false', async (subT) => {
        const now = new Date();
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => ({
            symbol: 'AAPL',
            price: 150,
            currency: 'USD',
            lastUpdated: now,
            marketTime: now,
            change: 2.5,
            changePercent: 1.6,
            sector: 'Technology',
            country: 'United States',
            sectorAllocations: [],
            countryAllocations: [],
            dividendRate: 0.92,
            dividendYield: 0.006,
            exDividendDate: null,
            estNextDividendAmount: 0.25
        }));

        const result = await MarketDataService.getPrice('AAPL', false);

        assert.ok(result);
        assert.strictEqual(result.symbol, 'AAPL');
        assert.strictEqual(result.price, 150);
        assert.strictEqual(result.currency, 'USD');
        assert.strictEqual(result.sector, 'Technology');
        assert.strictEqual(result.estNextDividendAmount, 0.25);
    });

    await t.test('fetches price from API when cache is stale or forceRefresh is true and persists dividend fields on create', async (subT) => {
        const futureExDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 15);
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 175.5,
            regularMarketChange: 3.2,
            regularMarketChangePercent: 1.86,
            currency: 'USD',
            longName: 'Apple Inc.'
        }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            summaryProfile: { sector: 'Technology', country: 'United States' },
            summaryDetail: { dividendRate: 0.96, dividendYield: 0.0055 },
            topHoldings: { sectorWeightings: [] },
            calendarEvents: { exDividendDate: futureExDate.toISOString() }
        }));
        subT.mock.method(yahooFinance, 'historical', async () => [
            { date: '2026-01-15', dividends: 0.24 },
            { date: '2026-04-15', dividends: 0.24 }
        ]);

        let upsertedData: any = null;
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: any) => {
            upsertedData = args;
            return {};
        });

        const result = await MarketDataService.getPrice('AAPL', true);

        assert.ok(result);
        assert.strictEqual(result.price, 175.5);
        assert.strictEqual(result.symbol, 'AAPL');
        assert.strictEqual(result.estNextDividendAmount, 0.24);
        assert.strictEqual(result.exDividendDate?.toISOString().split('T')[0], futureExDate.toISOString().split('T')[0]);
        assert.ok(upsertedData);
        assert.strictEqual(upsertedData.where.symbol, 'AAPL');
        assert.strictEqual(upsertedData.create.dividendRate, 0.96);
        assert.strictEqual(upsertedData.create.dividendYield, 0.0055);
        assert.strictEqual(upsertedData.create.estNextDividendAmount, 0.24);
        assert.ok(upsertedData.create.exDividendDate instanceof Date);
    });

    await t.test('recovers ETF trailing 12M rate with 13-month boundary trim and preserves future declared exDividendDate', async (subT) => {
        const declaredFutureExDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 10);
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 50,
            regularMarketChange: 0.2,
            regularMarketChangePercent: 0.4,
            currency: 'CAD',
            quoteType: 'ETF',
            longName: 'Monthly Cash ETF'
        }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            summaryProfile: {},
            summaryDetail: {},
            topHoldings: {},
            calendarEvents: { exDividendDate: declaredFutureExDate.toISOString() },
            defaultKeyStatistics: {}
        }));

        // 13 monthly payouts ~30 days apart -> should trim the oldest boundary payment (sum = 12 * 0.20 = 2.40)
        const baseTime = new Date('2025-01-01T00:00:00.000Z').getTime();
        const monthlyEvents = Array.from({ length: 13 }, (_, idx) => ({
            date: new Date(baseTime + idx * 30 * 24 * 60 * 60 * 1000).toISOString(),
            dividends: idx === 0 ? 0.50 : 0.20
        }));
        subT.mock.method(yahooFinance, 'historical', async () => monthlyEvents);
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => ({}));

        const result = await MarketDataService.getPrice('CASH.TO', true);

        assert.ok(result);
        assert.ok(Math.abs((result.dividendRate || 0) - 2.4) < 1e-6);
        assert.ok(Math.abs((result.dividendYield || 0) - 0.048) < 1e-6);
        assert.strictEqual(result.estNextDividendAmount, 0.20);
        assert.strictEqual(
            result.exDividendDate?.toISOString().split('T')[0],
            declaredFutureExDate.toISOString().split('T')[0]
        );
    });

    await t.test('serves stale cache immediately via SWR while enqueuing background refresh and preserves dividend metadata on blocking read', async (subT) => {
        resetSyncStateForTests();
        const staleDate = new Date(Date.now() - 1000 * 60 * 45);
        const futureExDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 12);
        let capturedBackgroundUpsert: Record<string, unknown> | null = null;
        let quoteCalls = 0;

        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => ({
            symbol: 'XEQT.TO',
            price: 34,
            currency: 'CAD',
            lastUpdated: staleDate,
            marketTime: staleDate,
            change: 0.1,
            changePercent: 0.3,
            sector: null,
            country: null,
            sectorAllocations: [],
            countryAllocations: [],
            dividendRate: 0.68,
            dividendYield: 0.02,
            exDividendDate: futureExDate,
            estNextDividendAmount: 0.17
        }));
        subT.mock.method(yahooFinance, 'quote', async () => {
            quoteCalls++;
            return {
                symbol: 'XEQT.TO',
                regularMarketPrice: 35,
                regularMarketChange: 0.5,
                regularMarketChangePercent: 1.4,
                currency: 'CAD',
                quoteType: 'ETF'
            };
        });
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            summaryProfile: {},
            summaryDetail: {},
            topHoldings: {},
            calendarEvents: {},
            defaultKeyStatistics: {}
        }));
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: { update: Record<string, unknown> }) => {
            capturedBackgroundUpsert = args.update;
            return args;
        });
        subT.mock.method(prisma, '$transaction', async (ops: unknown[]) => ops);

        // 1. Default interactive read returns stale cached price & metadata without blocking
        const swrResult = await MarketDataService.getPrice('XEQT.TO', false);
        assert.ok(swrResult);
        assert.strictEqual(swrResult.price, 34);
        assert.strictEqual(swrResult.dividendRate, 0.68);
        assert.strictEqual(quoteCalls, 0);

        // Flushing coalesced background sync persists updated price while preserving dividend fields
        await flushBackgroundPriceSync();
        assert.strictEqual(quoteCalls, 1);
        assert.ok(capturedBackgroundUpsert);
        assert.strictEqual((capturedBackgroundUpsert as Record<string, unknown>).price, 35);
        assert.ok(!('dividendRate' in capturedBackgroundUpsert!));

        // 2. Blocking stale read fetches updated price AND preserves cached ETF dividend metadata
        const blockingResult = await MarketDataService.getPrice('XEQT.TO', { mode: 'blocking' });
        assert.ok(blockingResult);
        assert.strictEqual(blockingResult.price, 35);
        assert.strictEqual(blockingResult.dividendRate, 0.68);
        assert.strictEqual(blockingResult.dividendYield, 0.02);
        assert.strictEqual(blockingResult.estNextDividendAmount, 0.17);
        assert.strictEqual(
            blockingResult.exDividendDate?.toISOString().split('T')[0],
            futureExDate.toISOString().split('T')[0]
        );
        resetSyncStateForTests();
    });

    await t.test('skips historical dividend estimation for FX pairs, indices, and cryptocurrencies', async (subT) => {
        let historicalCalled = 0;
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 1.38,
            regularMarketChange: 0,
            regularMarketChangePercent: 0,
            currency: 'CAD',
            quoteType: 'CURRENCY'
        }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({}));
        subT.mock.method(yahooFinance, 'historical', async () => {
            historicalCalled++;
            return [];
        });
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => ({}));

        await MarketDataService.getPrice('USDCAD=X', true);
        await MarketDataService.getPrice('^GSPC', true);

        assert.strictEqual(historicalCalled, 0);
    });

    await t.test('falls back to stale cache when API fails and forceRefresh is false', async (subT) => {
        const staleDate = new Date(Date.now() - 1000 * 60 * 60);
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => ({
            symbol: 'AAPL',
            price: 140,
            currency: 'USD',
            lastUpdated: staleDate,
            marketTime: staleDate,
            change: -1,
            changePercent: -0.7,
            sector: 'Technology',
            country: 'United States',
            sectorAllocations: [],
            countryAllocations: []
        }));

        subT.mock.method(yahooFinance, 'quote', async () => { throw new Error('API Error 429'); });
        subT.mock.method(yahooFinance, 'quoteSummary', async () => { throw new Error('API Error 429'); });

        const result = await MarketDataService.getPrice('AAPL', false);

        assert.ok(result);
        assert.strictEqual(result.price, 140);
    });

    await t.test('re-throws error when API fails and forceRefresh is true', async (subT) => {
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async () => { throw new Error('429 Rate Limit'); });
        subT.mock.method(yahooFinance, 'quoteSummary', async () => { throw new Error('429 Rate Limit'); });

        let errorCaught: any = null;
        try {
            await MarketDataService.getPrice('AAPL', true);
        } catch (e) {
            errorCaught = e;
        }

        assert.ok(errorCaught);
        assert.ok(errorCaught.message.includes('429 Rate Limit') || errorCaught.message.includes('Failed to fetch'));
    });

    await t.test('triggers estimateNextDividend when forceRefresh is true and handles estimate error gracefully', async (subT) => {
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 100,
            regularMarketChange: 1,
            regularMarketChangePercent: 1.0,
            currency: 'USD',
            longName: 'Test Corp'
        }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            summaryProfile: {},
            summaryDetail: { dividendRate: 2.0, dividendYield: 0.02 },
            topHoldings: {},
            calendarEvents: {}
        }));
        subT.mock.method(yahooFinance, 'historical', async () => {
            throw new Error('Historical API error');
        });
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => ({}));

        const result = await MarketDataService.getPrice('TEST_DIV_ERR', true);

        assert.ok(result);
        assert.strictEqual(result.symbol, 'TEST_DIV_ERR');
        assert.strictEqual(result.dividendRate, 2.0);
        assert.strictEqual(result.exDividendDate, undefined);
        assert.strictEqual(result.estNextDividendAmount, undefined);
    });

    await t.test('uses chart dividend events and rolls lagging monthly payout date into future window', async (subT) => {
        const now = new Date();
        const d1 = new Date(now);
        d1.setUTCDate(d1.getUTCDate() - 75);
        const d2 = new Date(d1);
        d2.setUTCDate(d2.getUTCDate() + 30); // ~45 days ago -> 1-step (+30d) is 15 days ago -> must roll forward again (+30d = +15d future)

        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 50,
            regularMarketChange: 0,
            regularMarketChangePercent: 0,
            currency: 'CAD',
            quoteType: 'ETF',
            longName: 'BMO Money Market ETF'
        }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            summaryProfile: {},
            summaryDetail: {},
            topHoldings: {},
            calendarEvents: {},
            defaultKeyStatistics: {}
        }));
        subT.mock.method(yahooFinance, 'chart', async () => ({
            events: {
                dividends: [
                    { date: d1, amount: 0.15 },
                    { date: d2, amount: 0.15 }
                ]
            }
        }));
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => ({}));

        const result = await MarketDataService.getPrice('ZMMK.TO', true);

        assert.ok(result);
        assert.ok(Math.abs((result.dividendRate || 0) - 0.30) < 1e-6);
        assert.strictEqual(result.estNextDividendAmount, 0.15);
        assert.ok(result.exDividendDate);

        const startOfToday = new Date(now);
        startOfToday.setUTCHours(0, 0, 0, 0);
        assert.ok(result.exDividendDate >= startOfToday);
    });

    await t.test('populates and persists iShares countryAllocations and fallback sectorAllocations on ETF metadata fetch', async (subT) => {
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 36,
            regularMarketChange: 0.4,
            regularMarketChangePercent: 1.1,
            currency: 'CAD',
            quoteType: 'ETF',
            longName: 'iShares Core Equity ETF Portfolio'
        }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            summaryProfile: {},
            summaryDetail: { dividendRate: 0.72, dividendYield: 0.02 },
            topHoldings: { sectorWeightings: [] },
            calendarEvents: { exDividendDate: new Date(Date.now() + 86400000).toISOString() },
            defaultKeyStatistics: {}
        }));
        subT.mock.method(yahooFinance, 'chart', async () => ({
            events: { dividends: [{ date: new Date().toISOString(), amount: 0.18 }] }
        }));

        subT.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('autoComplete.search')) {
                return new Response(JSON.stringify([
                    {
                        category: 'productAutocomplete',
                        id: '/ca/investors/en/products/309480/ishares-core-equity-etf-portfolio',
                        label: 'iShares Core Equity ETF Portfolio'
                    }
                ]), { status: 200 });
            }
            if (url.includes('/products/309480/fund/1464253357814.ajax')) {
                return new Response([
                    'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                    'MSFT,MICROSOFT CORP,Information Technology,Equity,500000,50.00,United States',
                    'RY,ROYAL BANK OF CANADA,Financials,Equity,300000,30.00,Canada',
                    'NESN,NESTLE SA,Consumer Staples,Equity,200000,20.00,Switzerland'
                ].join('\n'), { status: 200 });
            }
            return new Response('Not Found', { status: 404 });
        });

        let upsertedArgs: any = null;
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: any) => {
            upsertedArgs = args;
            return args;
        });

        const result = await MarketDataService.getPrice('XEQT.TO', true);

        assert.ok(result);
        assert.deepStrictEqual(result.countryAllocations, [
            { 'United States': 0.5 },
            { Canada: 0.3 },
            { Switzerland: 0.2 }
        ]);
        assert.deepStrictEqual(result.sectorAllocations, [
            { Technology: 0.5 },
            { 'Financial Services': 0.3 },
            { 'Consumer Defensive': 0.2 }
        ]);
        assert.ok(upsertedArgs);
        assert.deepStrictEqual(upsertedArgs.create.countryAllocations, result.countryAllocations);
        assert.deepStrictEqual(upsertedArgs.update.countryAllocations, result.countryAllocations);
        assert.deepStrictEqual(upsertedArgs.update.sectorAllocations, result.sectorAllocations);
    });

    await t.test('preserves cached ETF countryAllocations and sectorAllocations when issuer lookup fails transiently', async (subT) => {
        const cachedCountries = [{ 'United States': 0.45 }, { Canada: 0.25 }, { Japan: 0.06 }];
        const cachedSectors = [{ Technology: 0.25 }, { 'Financial Services': 0.2 }];

        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => ({
            symbol: 'XEQT.TO',
            price: 35,
            currency: 'CAD',
            lastUpdated: new Date(Date.now() - 86400000),
            marketTime: new Date(Date.now() - 86400000),
            change: 0,
            changePercent: 0,
            sector: null,
            country: null,
            sectorAllocations: cachedSectors,
            countryAllocations: cachedCountries,
            dividendRate: 0.7,
            dividendYield: 0.02,
            exDividendDate: new Date(Date.now() + 86400000),
            estNextDividendAmount: 0.17
        }));
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 36,
            regularMarketChange: 0.5,
            regularMarketChangePercent: 1.4,
            currency: 'CAD',
            quoteType: 'ETF',
            longName: 'iShares Core Equity ETF Portfolio'
        }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            summaryProfile: {},
            summaryDetail: { dividendRate: 0.7, dividendYield: 0.02 },
            topHoldings: { sectorWeightings: [] },
            calendarEvents: { exDividendDate: new Date(Date.now() + 86400000).toISOString() },
            defaultKeyStatistics: {}
        }));
        subT.mock.method(globalThis, 'fetch', async () => new Response('Access Denied', { status: 403 }));

        let upsertedArgs: any = null;
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: any) => {
            upsertedArgs = args;
            return args;
        });

        const result = await MarketDataService.getPrice('XEQT.TO', true);

        assert.ok(result);
        assert.deepStrictEqual(result.countryAllocations, cachedCountries);
        assert.deepStrictEqual(result.sectorAllocations, cachedSectors);
        assert.ok(upsertedArgs);
        assert.ok(!('countryAllocations' in upsertedArgs.update));
        assert.ok(!('sectorAllocations' in upsertedArgs.update));
    });

    await t.test('skips issuer HTTP lookup when includeMetadata is false on ETF cold miss', async (subT) => {
        let fetchCalled = 0;
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 36,
            regularMarketChange: 0.1,
            regularMarketChangePercent: 0.28,
            currency: 'CAD',
            quoteType: 'ETF',
            longName: 'iShares Core Equity ETF Portfolio'
        }));
        subT.mock.method(globalThis, 'fetch', async () => {
            fetchCalled++;
            return new Response('[]', { status: 200 });
        });
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => ({}));

        const result = await MarketDataService.getPrice('XEQT.TO', { mode: 'blocking', includeMetadata: false });
        assert.ok(result);
        assert.strictEqual(result.price, 36);
        assert.strictEqual(fetchCalled, 0);
    });

    await t.test('keeps returned and persisted sectorAllocations consistent when quoteSummary fails and cached sectors exist', async (subT) => {
        const cachedSectors = [{ technology: 0.30 }, { financial_services: 0.22 }];
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => ({
            symbol: 'XEQT.TO',
            price: 35,
            currency: 'CAD',
            lastUpdated: new Date(Date.now() - 86400000),
            marketTime: new Date(Date.now() - 86400000),
            change: 0,
            changePercent: 0,
            sector: null,
            country: null,
            sectorAllocations: cachedSectors,
            countryAllocations: [],
            dividendRate: 0.7,
            dividendYield: 0.02,
            exDividendDate: new Date(Date.now() + 86400000),
            estNextDividendAmount: 0.17
        }));
        subT.mock.method(yahooFinance, 'quote', async () => ({
            regularMarketPrice: 36,
            regularMarketChange: 0.4,
            regularMarketChangePercent: 1.1,
            currency: 'CAD',
            quoteType: 'ETF',
            longName: 'iShares Core Equity ETF Portfolio'
        }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => {
            throw new Error('Yahoo quoteSummary timeout');
        });
        subT.mock.method(yahooFinance, 'chart', async () => ({
            events: { dividends: [{ date: new Date().toISOString(), amount: 0.18 }] }
        }));
        subT.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('autoComplete.search')) {
                return new Response(JSON.stringify([
                    {
                        category: 'productAutocomplete',
                        id: '/ca/investors/en/products/309480/ishares-core-equity-etf-portfolio',
                        label: 'iShares Core Equity ETF Portfolio'
                    }
                ]), { status: 200 });
            }
            return new Response([
                'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                'MSFT,MICROSOFT CORP,Information Technology,Equity,500000,50.00,United States',
                'RY,ROYAL BANK OF CANADA,Financials,Equity,500000,50.00,Canada'
            ].join('\n'), { status: 200 });
        });

        let upsertedArgs: any = null;
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: any) => {
            upsertedArgs = args;
            return args;
        });

        const result = await MarketDataService.getPrice('XEQT.TO', { mode: 'blocking', includeMetadata: true });

        assert.ok(result);
        assert.deepStrictEqual(result.countryAllocations, [{ 'United States': 0.5 }, { Canada: 0.5 }]);
        assert.deepStrictEqual(result.sectorAllocations, cachedSectors);
        assert.ok(upsertedArgs);
        assert.deepStrictEqual(upsertedArgs.update.countryAllocations, [{ 'United States': 0.5 }, { Canada: 0.5 }]);
        assert.ok(!('sectorAllocations' in upsertedArgs.update));
    });

    await t.test('falls back to quoteSummary price module when quote() omits fields and emits onDiagnostic look-through logs', async (subT) => {
        let requestedModules: string[] = [];
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: unknown) => args);
        subT.mock.method(yahooFinance, 'quote', async () => {
            throw new Error('quote endpoint unavailable');
        });
        subT.mock.method(yahooFinance, 'quoteSummary', async (_sym: string, opts: { modules?: string[] }) => {
            requestedModules = opts?.modules ?? [];
            return {
                price: {
                    regularMarketPrice: 37.5,
                    regularMarketChange: 0.25,
                    regularMarketChangePercent: 0.67,
                    currency: 'CAD',
                    quoteType: 'ETF',
                    longName: 'iShares Core Equity ETF Portfolio',
                },
                summaryProfile: {},
                summaryDetail: { dividendRate: 0.75, dividendYield: 0.02 },
                topHoldings: { sectorWeightings: [] },
                calendarEvents: { exDividendDate: new Date(Date.now() + 86400000).toISOString() },
                defaultKeyStatistics: {},
            };
        });
        subT.mock.method(yahooFinance, 'chart', async () => ({
            events: { dividends: [{ date: new Date().toISOString(), amount: 0.19 }] },
        }));
        subT.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('autoComplete.search')) {
                return new Response(JSON.stringify([
                    {
                        category: 'productAutocomplete',
                        id: '/ca/investors/en/products/309480/ishares-core-equity-etf-portfolio',
                        label: 'iShares Core Equity ETF Portfolio',
                    },
                ]), { status: 200 });
            }
            return new Response([
                'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                'NVDA,NVIDIA CORP,Information Technology,Equity,700000,70.00,United States',
                'RY,ROYAL BANK OF CANADA,Financials,Equity,300000,30.00,Canada',
            ].join('\n'), { status: 200 });
        });

        const diagnostics: string[] = [];
        const result = await MarketDataService.getPrice('XEQT.TO', {
            forceRefresh: true,
            onDiagnostic: (msg) => diagnostics.push(msg),
        });

        assert.ok(requestedModules.includes('price'));
        assert.ok(result);
        assert.strictEqual(result.price, 37.5);
        assert.deepStrictEqual(result.countryAllocations, [
            { 'United States': 0.7 },
            { Canada: 0.3 },
        ]);
        assert.ok(diagnostics.some((m) => m.includes('Resolved ishares allocations for XEQT.TO: 2 countries')));
    });
});

test('MarketDataService.getExchangeRate', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('returns 1 when from and to currencies are identical', async () => {
        const rate = await MarketDataService.getExchangeRate('USD', 'USD');
        assert.strictEqual(rate, 1);
    });

    await t.test('fetches rate for direct currency pair', async (subT) => {
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async (symbol: string) => {
            if (symbol === 'EURUSD=X') {
                return { regularMarketPrice: 1.08, currency: 'USD' };
            }
            return null;
        });
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({}));
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => ({}));

        const rate = await MarketDataService.getExchangeRate('EUR', 'USD', true);
        assert.strictEqual(rate, 1.08);
    });

    await t.test('inverts rate using reverse pair if direct pair is missing', async (subT) => {
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(yahooFinance, 'quote', async (symbol: string) => {
            if (symbol === 'EURUSD=X') return null;
            if (symbol === 'EUR=X') return { regularMarketPrice: 0.92, currency: 'USD' };
            return null;
        });
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({}));

        const rate = await MarketDataService.getExchangeRate('EUR', 'USD', false);
        assert.ok(rate);
        assert.strictEqual(Number(rate!.toFixed(4)), Number((1 / 0.92).toFixed(4)));
    });
});

test('MarketDataService.getHistoricalExchangeRate', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('returns 1 when currencies match', async () => {
        const rate = await MarketDataService.getHistoricalExchangeRate('USD', 'USD', new Date());
        assert.strictEqual(rate, 1);
    });

    await t.test('finds closest historical rate on or before target date', async (subT) => {
        subT.mock.method(yahooFinance, 'chart', async () => ({
            quotes: [
                { date: '2023-01-01T00:00:00.000Z', close: 1.05 },
                { date: '2023-01-02T00:00:00.000Z', close: 1.06 },
                { date: '2023-01-10T00:00:00.000Z', close: 1.10 }
            ]
        }));

        const targetDate = new Date('2023-01-02T12:00:00.000Z');
        const rate = await MarketDataService.getHistoricalExchangeRate('EUR', 'USD', targetDate);
        assert.strictEqual(rate, 1.06);
    });
});

test('MarketDataService.refreshMarketData', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('refreshes market data for a single symbol and updates cache via transaction', async (subT) => {
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            price: { regularMarketPrice: 180, regularMarketChange: 2, regularMarketChangePercent: 1.1, currency: 'USD' },
            summaryProfile: { sector: 'Technology', country: 'United States' },
            summaryDetail: { dividendRate: 1.0, dividendYield: 0.005 },
            topHoldings: { sectorWeightings: [] },
            calendarEvents: {}
        }));
        subT.mock.method(yahooFinance, 'chart', async () => ({
            quotes: [{ date: '2023-01-01T00:00:00.000Z', close: 178 }]
        }));

        let transactionUpdatesLength = 0;
        subT.mock.method(prisma, '$transaction', async (updates: any) => {
            transactionUpdatesLength = updates.length;
            return updates;
        });

        await MarketDataService.refreshMarketData('AAPL');
        assert.strictEqual(transactionUpdatesLength, 1);
    });

    await t.test('refreshes market data for multiple symbols in batch using a single transaction', async (subT) => {
        subT.mock.method(yahooFinance, 'quoteSummary', async (symbol: string) => ({
            price: { regularMarketPrice: symbol === 'AAPL' ? 180 : 350, regularMarketChange: 1, regularMarketChangePercent: 0.5, currency: 'USD' },
            summaryProfile: { sector: 'Technology', country: 'United States' },
            summaryDetail: {},
            topHoldings: {},
            calendarEvents: {}
        }));
        subT.mock.method(yahooFinance, 'chart', async () => ({
            quotes: [{ date: '2023-01-01T00:00:00.000Z', close: 100 }]
        }));

        let transactionUpdatesLength = 0;
        subT.mock.method(prisma, '$transaction', async (updates: any) => {
            transactionUpdatesLength = updates.length;
            return updates;
        });

        await MarketDataService.refreshMarketData(['AAPL', 'MSFT']);
        assert.strictEqual(transactionUpdatesLength, 2);
    });

    await t.test('recovers and persists ETF trailing dividendRate and estNextDividendAmount when summaryDetail omits them', async (subT) => {
        subT.mock.method(globalThis, 'fetch', async () => new Response('Not Found', { status: 404 }));
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            price: { regularMarketPrice: 25, regularMarketChange: 0.1, regularMarketChangePercent: 0.4, currency: 'CAD', quoteType: 'ETF' },
            summaryProfile: {},
            summaryDetail: {},
            topHoldings: {},
            calendarEvents: {},
            defaultKeyStatistics: {}
        }));
        subT.mock.method(yahooFinance, 'chart', async () => ({
            quotes: [{ date: '2026-01-01T00:00:00.000Z', close: 25 }]
        }));
        subT.mock.method(yahooFinance, 'historical', async () => [
            { date: '2026-01-15T00:00:00.000Z', dividends: 0.25 },
            { date: '2026-04-15T00:00:00.000Z', dividends: 0.25 },
            { date: '2026-07-15T00:00:00.000Z', dividends: 0.25 },
            { date: '2026-10-15T00:00:00.000Z', dividends: 0.25 }
        ]);

        let capturedUpsert: {
            update: Record<string, unknown>;
            create: Record<string, unknown>;
        } | null = null;
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: {
            update: Record<string, unknown>;
            create: Record<string, unknown>;
        }) => {
            capturedUpsert = args;
            return args;
        });
        subT.mock.method(prisma, '$transaction', async (updates: unknown[]) => updates);

        await MarketDataService.refreshMarketData('ZHY.TO');

        assert.ok(capturedUpsert);
        assert.strictEqual(capturedUpsert.update.dividendRate, 1.0);
        assert.strictEqual(capturedUpsert.update.dividendYield, 0.04);
        assert.strictEqual(capturedUpsert.update.estNextDividendAmount, 0.25);
        assert.strictEqual(capturedUpsert.create.estNextDividendAmount, 0.25);
        assert.ok(capturedUpsert.update.exDividendDate instanceof Date);
        assert.ok(!('countryAllocations' in capturedUpsert.update));
        assert.ok(!('sectorAllocations' in capturedUpsert.update));
        assert.deepStrictEqual(capturedUpsert.create.countryAllocations, []);
    });

    await t.test('populates iShares countryAllocations in refreshMarketData while preferring Yahoo sectorWeightings when present', async (subT) => {
        subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
            price: {
                regularMarketPrice: 36,
                regularMarketChange: 0.2,
                regularMarketChangePercent: 0.5,
                currency: 'CAD',
                quoteType: 'ETF',
                longName: 'iShares Core Equity ETF Portfolio'
            },
            summaryProfile: {},
            summaryDetail: { dividendRate: 0.72, dividendYield: 0.02 },
            topHoldings: { sectorWeightings: [{ technology: 0.28 }, { financial_services: 0.19 }] },
            calendarEvents: { exDividendDate: new Date(Date.now() + 86400000).toISOString() },
            defaultKeyStatistics: {}
        }));
        subT.mock.method(yahooFinance, 'chart', async () => ({
            quotes: [{ date: '2026-01-01T00:00:00.000Z', close: 36 }],
            events: { dividends: [{ date: new Date().toISOString(), amount: 0.18 }] }
        }));
        subT.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
            const url = String(input);
            if (url.includes('autoComplete.search')) {
                return new Response(JSON.stringify([
                    {
                        category: 'productAutocomplete',
                        id: '/ca/investors/en/products/309480/ishares-core-equity-etf-portfolio',
                        label: 'iShares Core Equity ETF Portfolio'
                    }
                ]), { status: 200 });
            }
            if (url.includes('/products/309480/fund/1464253357814.ajax')) {
                return new Response([
                    'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                    'AAPL,APPLE INC,Information Technology,Equity,450000,45.00,United States',
                    'RY,ROYAL BANK OF CANADA,Financials,Equity,300000,30.00,Canada',
                    '7203,TOYOTA MOTOR CORP,Consumer Discretionary,Equity,250000,25.00,Japan'
                ].join('\n'), { status: 200 });
            }
            return new Response('Not Found', { status: 404 });
        });

        let capturedUpsert: {
            update: Record<string, unknown>;
            create: Record<string, unknown>;
        } | null = null;
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: {
            update: Record<string, unknown>;
            create: Record<string, unknown>;
        }) => {
            capturedUpsert = args;
            return args;
        });
        subT.mock.method(prisma, '$transaction', async (updates: unknown[]) => updates);

        await MarketDataService.refreshMarketData('XEQT.TO');

        assert.ok(capturedUpsert);
        assert.deepStrictEqual(capturedUpsert.update.countryAllocations, [
            { 'United States': 0.45 },
            { Canada: 0.3 },
            { Japan: 0.25 }
        ]);
        assert.deepStrictEqual(capturedUpsert.create.countryAllocations, capturedUpsert.update.countryAllocations);
        assert.deepStrictEqual(capturedUpsert.update.sectorAllocations, [
            { technology: 0.28 },
            { financial_services: 0.19 }
        ]);
    });
});

test('MarketDataService.refreshPriceOnly', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('returns 0 for empty array of symbols', async () => {
        const count = await MarketDataService.refreshPriceOnly([]);
        assert.strictEqual(count, 0);
    });

    await t.test('refreshes price for a single symbol string', async (subT) => {
        subT.mock.method(yahooFinance, 'quote', async (symbol: any) => {
            return {
                symbol,
                regularMarketPrice: 150.25,
                regularMarketChange: 1.5,
                regularMarketChangePercent: 1.01
            };
        });

        let transactionCalled = false;
        subT.mock.method(prisma, '$transaction', async (updates: any) => {
            transactionCalled = true;
            assert.strictEqual(updates.length, 1);
            return updates;
        });

        const count = await MarketDataService.refreshPriceOnly('AAPL');
        assert.strictEqual(count, 1);
        assert.ok(transactionCalled);
    });

    await t.test('refreshes prices in bulk for an array of symbols', async (subT) => {
        subT.mock.method(yahooFinance, 'quote', async (symbols: any) => {
            return [
                { symbol: 'AAPL', regularMarketPrice: 150, regularMarketChange: 1, regularMarketChangePercent: 0.67 },
                { symbol: 'MSFT', regularMarketPrice: 300, regularMarketChange: 2, regularMarketChangePercent: 0.67 }
            ];
        });

        let transactionCount = 0;
        subT.mock.method(prisma, '$transaction', async (updates: any) => {
            transactionCount = updates.length;
            return updates;
        });

        const count = await MarketDataService.refreshPriceOnly(['AAPL', 'MSFT']);
        assert.strictEqual(count, 2);
        assert.strictEqual(transactionCount, 2);
    });
});

test('MarketDataService.getIntradayPrices', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('fetches and filters intraday price points', async (subT) => {
        subT.mock.method(yahooFinance, 'chart', async () => ({
            quotes: [
                { date: '2023-01-01T10:00:00.000Z', close: 150.5 },
                { date: '2023-01-01T10:15:00.000Z', open: 151.0 },
                { date: null, close: 152.0 },
                { date: '2023-01-01T10:30:00.000Z' }
            ]
        }));

        const prices = await MarketDataService.getIntradayPrices('TEST_INTRADAY_UNIQUE');

        assert.strictEqual(prices.length, 2);
        assert.deepStrictEqual(prices[0], {
            date: '2023-01-01T10:00:00.000Z',
            value: 150.5
        });
        assert.deepStrictEqual(prices[1], {
            date: '2023-01-01T10:15:00.000Z',
            value: 151.0
        });
    });
});

test('MarketDataService.getIntradayHistory', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('transforms intraday price points array into key-value map with ISO date keys', async (subT) => {
        subT.mock.method(MarketDataService, 'getIntradayPrices', async () => [
            { date: '2023-01-01T10:00:00.000Z', value: 150.5 },
            { date: '2023-01-01T10:15:00.000Z', value: 151.25 }
        ]);

        const history = await MarketDataService.getIntradayHistory('AAPL');

        assert.deepStrictEqual(history, {
            '2023-01-01T10:00:00.000Z': 150.5,
            '2023-01-01T10:15:00.000Z': 151.25
        });
    });

    await t.test('returns empty record if getIntradayPrices returns empty list', async (subT) => {
        subT.mock.method(MarketDataService, 'getIntradayPrices', async () => []);

        const history = await MarketDataService.getIntradayHistory('EMPTY');

        assert.deepStrictEqual(history, {});
    });

    await t.test('handles and catches error from getIntradayPrices returning empty record', async (subT) => {
        subT.mock.method(MarketDataService, 'getIntradayPrices', async () => {
            throw new Error('Network error');
        });

        const history = await MarketDataService.getIntradayHistory('ERROR');

        assert.deepStrictEqual(history, {});
    });
});

test('MarketDataService.getDailyHistory', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
    });

    await t.test('returns unadjusted quotes from chart without overwriting DB split-adjusted history cache', async (subT) => {
        let dbFindCalled = 0;
        let dbUpsertCalled = 0;
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => {
            dbFindCalled++;
            return null;
        });
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => {
            dbUpsertCalled++;
            return {};
        });
        subT.mock.method(yahooFinance, 'chart', async () => ({
            quotes: [
                { date: '2024-06-01T00:00:00.000Z', close: 1200, adjclose: 120 },
                { date: '2024-06-10T00:00:00.000Z', close: 120, adjclose: 120 }
            ]
        }));

        const fromDate = new Date('2024-06-01T00:00:00.000Z');
        const history = await MarketDataService.getDailyHistory('NVDA_UNADJ_TEST', fromDate);

        assert.strictEqual(history['2024-06-01'], 1200);
        assert.strictEqual(history['2024-06-10'], 120);
        assert.strictEqual(dbUpsertCalled, 0);
        assert.strictEqual(dbFindCalled, 0);

        // Subsequent call within window should hit in-memory unadjusted cache without calling chart again
        let chartCalledAgain = 0;
        subT.mock.method(yahooFinance, 'chart', async () => {
            chartCalledAgain++;
            return { quotes: [] };
        });
        const cachedHistory = await MarketDataService.getDailyHistory('NVDA_UNADJ_TEST', new Date('2024-06-02T00:00:00.000Z'));
        assert.strictEqual(cachedHistory['2024-06-01'], 1200);
        assert.strictEqual(chartCalledAgain, 0);
    });
});

test('MarketDataService singleflight coalescing, canonical FX, upsert & throttler telemetry', async (t) => {
    t.beforeEach(() => {
        apiThrottler.reset();
        resetSyncStateForTests();
        resetCacheVersionsForTests();
    });

    t.afterEach(() => {
        resetSyncStateForTests();
        resetCacheVersionsForTests();
    });

    await t.test('deduplicates 5 concurrent getPrice cold misses via singleflight into 1 Yahoo quote call', async (subT) => {
        let quoteCalls = 0;
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => ({}));
        subT.mock.method(yahooFinance, 'quote', async () => {
            quoteCalls++;
            await new Promise((r) => setTimeout(r, 25));
            return {
                symbol: 'SINGLEFLIGHT_AAPL',
                regularMarketPrice: 210,
                regularMarketChange: 2,
                regularMarketChangePercent: 0.96,
                currency: 'USD',
            };
        });

        const versionBefore = getCacheVersions().marketDataVersion;
        const results = await Promise.all(
            Array.from({ length: 5 }, () => MarketDataService.getPrice('SINGLEFLIGHT_AAPL', false))
        );

        assert.strictEqual(quoteCalls, 1);
        for (const r of results) {
            assert.ok(r);
            assert.strictEqual(r.price, 210);
        }
        assert.ok(getCacheVersions().marketDataVersion > versionBefore);
    });

    await t.test('deduplicates concurrent getExchangeRate, getHistoricalPrices, getDailyHistory, and getIntradayPrices', async (subT) => {
        let quoteCalls = 0;
        let chartCalls = 0;
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        subT.mock.method(prisma.marketDataCache, 'upsert', async () => ({}));
        subT.mock.method(yahooFinance, 'quote', async (sym: string) => {
            quoteCalls++;
            await new Promise((r) => setTimeout(r, 20));
            return { symbol: sym, regularMarketPrice: 1.38, currency: 'CAD' };
        });
        subT.mock.method(yahooFinance, 'chart', async () => {
            chartCalls++;
            await new Promise((r) => setTimeout(r, 20));
            return {
                quotes: [
                    { date: '2026-05-01T14:00:00.000Z', close: 100 },
                    { date: '2026-05-02T14:00:00.000Z', close: 102 },
                ],
            };
        });

        const [fxResults, histResults, dailyResults, intradayResults] = await Promise.all([
            Promise.all([
                MarketDataService.getExchangeRate('CAD', 'USD', false),
                MarketDataService.getExchangeRate('CAD', 'USD', false),
                MarketDataService.getExchangeRate('CAD', 'USD', false),
            ]),
            Promise.all([
                MarketDataService.getHistoricalPrices('SF_HIST', false),
                MarketDataService.getHistoricalPrices('SF_HIST', false),
            ]),
            Promise.all([
                MarketDataService.getDailyHistory('SF_DAILY', new Date('2026-05-01T00:00:00.000Z')),
                MarketDataService.getDailyHistory('SF_DAILY', new Date('2026-05-01T00:00:00.000Z')),
            ]),
            Promise.all([
                MarketDataService.getIntradayPrices('SF_INTRA'),
                MarketDataService.getIntradayPrices('SF_INTRA'),
            ]),
        ]);

        assert.strictEqual(quoteCalls, 1);
        assert.strictEqual(chartCalls, 3); // 1x historical, 1x daily, 1x intraday
        assert.ok(Math.abs((fxResults[0] || 0) - 1 / 1.38) < 1e-6);
        assert.strictEqual(fxResults[0], fxResults[1]);
        assert.strictEqual(fxResults[1], fxResults[2]);
        assert.deepStrictEqual(histResults[0], histResults[1]);
        assert.deepStrictEqual(dailyResults[0], dailyResults[1]);
        assert.deepStrictEqual(intradayResults[0], intradayResults[1]);
    });

    await t.test('getExchangeRate prefers cached CAD=X shorthand inverted before querying CADUSD=X', async (subT) => {
        const queriedSymbols: string[] = [];
        subT.mock.method(prisma.marketDataCache, 'findUnique', async ({ where }: { where: { symbol: string } }) => {
            queriedSymbols.push(where.symbol);
            if (where.symbol === 'CAD=X') {
                return {
                    symbol: 'CAD=X',
                    price: 1.4,
                    currency: 'CAD',
                    lastUpdated: new Date(),
                    marketTime: new Date(),
                    change: 0,
                    changePercent: 0,
                };
            }
            return null;
        });

        const rate = await MarketDataService.getExchangeRate('CAD', 'USD', false);
        assert.ok(rate);
        assert.ok(Math.abs(rate - 1 / 1.4) < 1e-6);
        assert.deepStrictEqual(queriedSymbols, ['CAD=X']);
    });

    await t.test('refreshPriceOnly creates missing cache rows via upsert and preserves metadata/history on update', async (subT) => {
        const capturedUpserts: Array<{ where: unknown; update: Record<string, unknown>; create: Record<string, unknown> }> = [];
        subT.mock.method(yahooFinance, 'quote', async () => ([
            { symbol: 'AAPL', regularMarketPrice: 199, regularMarketChange: 2, regularMarketChangePercent: 1.0, currency: 'USD' },
        ]));
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: {
            where: unknown;
            update: Record<string, unknown>;
            create: Record<string, unknown>;
        }) => {
            capturedUpserts.push(args);
            return args;
        });
        subT.mock.method(prisma, '$transaction', async (ops: unknown[]) => ops);

        const versionBefore = getCacheVersions().marketDataVersion;
        const count = await MarketDataService.refreshPriceOnly(['AAPL']);

        assert.strictEqual(count, 1);
        assert.strictEqual(capturedUpserts.length, 1);
        assert.strictEqual(capturedUpserts[0].create.symbol, 'AAPL');
        assert.strictEqual(capturedUpserts[0].create.price, 199);
        assert.strictEqual(capturedUpserts[0].update.price, 199);
        assert.ok(!('history' in capturedUpserts[0].update));
        assert.ok(!('sector' in capturedUpserts[0].update));
        assert.ok(!('metadataUpdatedAt' in capturedUpserts[0].update));
        assert.ok(getCacheVersions().marketDataVersion > versionBefore);
    });

    await t.test('Throttler.getStatus accurately reports rate-limit circuit breaker state', async () => {
        const local = new Throttler(1, 5);
        assert.deepStrictEqual(local.getStatus(), {
            isRateLimited: false,
            resetTime: null,
            queueLength: 0,
            activeCount: 0,
        });

        try {
            await local.add(() => Promise.reject({ status: 429, message: 'Too Many Requests' }));
        } catch {
            // expected
        }

        const limitedStatus = local.getStatus();
        assert.strictEqual(limitedStatus.isRateLimited, true);
        assert.ok(limitedStatus.resetTime);

        local.reset();
        assert.strictEqual(local.getStatus().isRateLimited, false);
        assert.strictEqual(local.getStatus().resetTime, null);
    });

    await t.test('refreshPriceOnly skips zero/undefined quotes, parses Unix seconds marketTime, and deduplicates overlapping symbols (B2, M1)', async (subT) => {
        const upsertedSymbols: string[] = [];
        let capturedMarketTime: Date | undefined;
        const quoteBatches: unknown[] = [];

        subT.mock.method(yahooFinance, 'quote', async (arg: string | string[]) => {
            quoteBatches.push(arg);
            await new Promise((r) => setTimeout(r, 20));
            const list = Array.isArray(arg) ? arg : [arg];
            return list.map((sym: string) => {
                if (sym === 'ZERO_SYM') {
                    return { symbol: 'ZERO_SYM', regularMarketPrice: 0 };
                }
                if (sym === 'MISSING_SYM') {
                    return { symbol: 'MISSING_SYM' };
                }
                return {
                    symbol: sym,
                    regularMarketPrice: sym === 'AAPL' ? 200 : sym === 'MSFT' ? 400 : 120,
                    regularMarketTime: 1768400000, // Unix seconds (2026)
                    currency: 'USD',
                };
            });
        });

        subT.mock.method(
            prisma.marketDataCache,
            'upsert',
            async (args: { where: { symbol: string }; update: Record<string, unknown> }) => {
                upsertedSymbols.push(args.where.symbol);
                if (args.where.symbol === 'AAPL' && args.update.marketTime instanceof Date) {
                    capturedMarketTime = args.update.marketTime;
                }
                return args;
            }
        );
        subT.mock.method(prisma, '$transaction', async (ops: unknown[]) => ops);

        // Zero / missing price quotes must NOT be upserted as 0
        const partialCount = await MarketDataService.refreshPriceOnly(['AAPL', 'ZERO_SYM', 'MISSING_SYM']);
        assert.strictEqual(partialCount, 1);
        assert.deepStrictEqual(upsertedSymbols, ['AAPL']);
        assert.ok(capturedMarketTime !== undefined);
        const marketTimeDate = capturedMarketTime as Date;
        assert.ok(marketTimeDate instanceof Date);
        assert.ok(marketTimeDate.getUTCFullYear() >= 2026);

        // Overlapping concurrent batches: ['AAPL', 'MSFT'] + ['MSFT', 'NVDA'] -> MSFT queried only once
        quoteBatches.length = 0;
        const [countA, countB] = await Promise.all([
            MarketDataService.refreshPriceOnly(['AAPL', 'MSFT']),
            MarketDataService.refreshPriceOnly(['MSFT', 'NVDA']),
        ]);
        assert.strictEqual(countA, 2);
        assert.strictEqual(countB, 2);
        assert.strictEqual(quoteBatches.length, 2);
        assert.deepStrictEqual(quoteBatches[0], ['AAPL', 'MSFT']);
        assert.deepStrictEqual(quoteBatches[1], ['NVDA']);
    });

    await t.test('getPrice skips quoteSummary for FX/index symbols and keeps forceRefresh errors isolated from non-forced flights (B3, M4)', async (subT) => {
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => null);
        let capturedFxUpsert: {
            update?: Record<string, unknown>;
            create?: Record<string, unknown>;
        } | undefined;
        subT.mock.method(
            prisma.marketDataCache,
            'upsert',
            async (args: { update?: Record<string, unknown>; create?: Record<string, unknown> }) => {
                capturedFxUpsert = args;
                return args;
            }
        );

        let summaryCalled = false;
        subT.mock.method(yahooFinance, 'quoteSummary', async () => {
            summaryCalled = true;
            return {};
        });
        subT.mock.method(yahooFinance, 'quote', async (sym: string) => ({
            symbol: sym,
            regularMarketPrice: 1.39,
            currency: 'CAD',
        }));

        const fxData = await MarketDataService.getPrice('CAD=X', true);
        assert.ok(fxData);
        assert.strictEqual(summaryCalled, false);
        assert.ok(capturedFxUpsert?.update?.metadataUpdatedAt instanceof Date);
        assert.ok(capturedFxUpsert?.create?.metadataUpdatedAt instanceof Date);

        // Now simulate Yahoo outage: concurrent blocking non-forced vs forceRefresh=true
        subT.mock.method(prisma.marketDataCache, 'findUnique', async () => ({
            symbol: 'OUTAGE_SYM',
            price: 50,
            currency: 'USD',
            lastUpdated: new Date(Date.now() - 60 * 60 * 1000),
            marketTime: new Date(),
            change: 0,
            changePercent: 0,
        }));
        subT.mock.method(yahooFinance, 'quote', async () => {
            await new Promise((r) => setTimeout(r, 20));
            throw new Error('Upstream 503');
        });
        subT.mock.method(yahooFinance, 'quoteSummary', async () => {
            throw new Error('Upstream 503');
        });

        const origWarn = console.warn;
        const origErr = console.error;
        console.warn = () => {};
        console.error = () => {};
        try {
            const nonForcedPromise = MarketDataService.getPrice('OUTAGE_SYM', {
                mode: 'blocking',
                includeMetadata: true,
            });
            const forcedPromise = MarketDataService.getPrice('OUTAGE_SYM', true);

            const nonForcedRes = await nonForcedPromise;
            assert.strictEqual(nonForcedRes?.price, 50);

            await assert.rejects(() => forcedPromise, /Upstream 503|Failed to fetch/);
        } finally {
            console.warn = origWarn;
            console.error = origErr;
        }
    });

    await t.test('refreshMarketData rejects when Yahoo fails or returns $0 price instead of succeeding silently (M4)', async (subT) => {
        const origErr = console.error;
        console.error = () => {};
        try {
            subT.mock.method(yahooFinance, 'quoteSummary', async () => ({
                price: { regularMarketPrice: 0, currency: 'USD' },
            }));
            await assert.rejects(() => MarketDataService.refreshMarketData('BAD_ZERO'), /Invalid or missing quote price/);

            subT.mock.method(yahooFinance, 'quoteSummary', async () => {
                throw new Error('Rate limit 429');
            });
            await assert.rejects(() => MarketDataService.refreshMarketData('BAD_ERR'), /Rate limit 429/);
        } finally {
            console.error = origErr;
        }
    });
});


