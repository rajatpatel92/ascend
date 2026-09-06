import test from 'node:test';
import assert from 'node:assert';
import { prisma } from './prisma.ts';
import { Throttler, apiThrottler, estimateNextDividend, MarketDataService, yahooFinance } from './market-data.ts';

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

    await t.test('returns valid cached data when not stale and forceRefresh is false', async (subT) => {
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
            exDividendDate: null
        }));

        const result = await MarketDataService.getPrice('AAPL', false);

        assert.ok(result);
        assert.strictEqual(result.symbol, 'AAPL');
        assert.strictEqual(result.price, 150);
        assert.strictEqual(result.currency, 'USD');
        assert.strictEqual(result.sector, 'Technology');
    });

    await t.test('fetches price from API when cache is stale or forceRefresh is true', async (subT) => {
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
            calendarEvents: {}
        }));

        let upsertedData: any = null;
        subT.mock.method(prisma.marketDataCache, 'upsert', async (args: any) => {
            upsertedData = args;
            return {};
        });

        const result = await MarketDataService.getPrice('AAPL', true);

        assert.ok(result);
        assert.strictEqual(result.price, 175.5);
        assert.strictEqual(result.symbol, 'AAPL');
        assert.ok(upsertedData);
        assert.strictEqual(upsertedData.where.symbol, 'AAPL');
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
