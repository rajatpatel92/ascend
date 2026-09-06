import test from 'node:test';
import assert from 'node:assert';
import { GET, dynamic } from './route.ts';
import { setAuthImpl } from '@/auth';
import { setMarketDataServiceImpl } from '@/lib/market-data';

test('GET /api/market-data/intraday endpoint', async (t) => {
  const originalConsoleError = console.error;

  t.afterEach(() => {
    console.error = originalConsoleError;
  });

  await t.test('exports dynamic configuration set to force-dynamic', () => {
    assert.strictEqual(dynamic, 'force-dynamic', 'dynamic export should be force-dynamic');
  });

  await t.test('returns 401 Unauthorized if user is not authenticated', async () => {
    setAuthImpl(async () => null);

    const request = new Request('http://localhost/api/market-data/intraday?symbol=AAPL');
    const response = await GET(request);

    assert.strictEqual(response.status, 401);
    const body = await response.json();
    assert.deepStrictEqual(body, { error: 'Unauthorized' });
  });

  await t.test('returns 400 Bad Request if symbol query parameter is missing', async () => {
    setAuthImpl(async () => ({ user: { id: 'user-123' } }));

    const request = new Request('http://localhost/api/market-data/intraday');
    const response = await GET(request);

    assert.strictEqual(response.status, 400);
    const body = await response.json();
    assert.deepStrictEqual(body, { error: 'Symbol is required' });
  });

  await t.test('returns 200 OK and intraday prices when authorized and symbol is provided', async () => {
    setAuthImpl(async () => ({ user: { id: 'user-123' } }));

    let passedSymbol = '';
    const mockData = [
      { timestamp: 1700000000, price: 150.25 },
      { timestamp: 1700003600, price: 152.50 },
    ];

    setMarketDataServiceImpl({
      getIntradayPrices: async (symbol: string) => {
        passedSymbol = symbol;
        return mockData;
      },
    });

    const request = new Request('http://localhost/api/market-data/intraday?symbol=AAPL');
    const response = await GET(request);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(passedSymbol, 'AAPL', 'Should pass correct symbol to MarketDataService');
    const body = await response.json();
    assert.deepStrictEqual(body, mockData);
  });

  await t.test('returns 500 Internal Server Error when MarketDataService throws', async () => {
    setAuthImpl(async () => ({ user: { id: 'user-123' } }));

    setMarketDataServiceImpl({
      getIntradayPrices: async () => {
        throw new Error('Market data fetch error');
      },
    });

    console.error = () => {};

    const request = new Request('http://localhost/api/market-data/intraday?symbol=FAIL');
    const response = await GET(request);

    assert.strictEqual(response.status, 500);
    const body = await response.json();
    assert.deepStrictEqual(body, { error: 'Internal Server Error' });
  });
});
