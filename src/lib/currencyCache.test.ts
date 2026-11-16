import test from 'node:test';
import assert from 'node:assert';

interface MockFetchResponse {
    ok?: boolean;
    status?: number;
    json: () => Promise<unknown>;
}

const g = globalThis as Record<string, unknown>;

// Mock browser environment before importing currencyCache
const storage: Record<string, string> = {};
const localStorageMock = {
    get length() {
        return Object.keys(storage).length;
    },
    key: (index: number) => Object.keys(storage)[index] ?? null,
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
        storage[key] = value;
    },
    removeItem: (key: string) => {
        delete storage[key];
    },
    clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
    },
};

let fetchCalls: { url: string; options: RequestInit }[] = [];
let fetchResponse: MockFetchResponse | (() => Promise<MockFetchResponse>) = {
    ok: true,
    status: 200,
    json: async () => ({ rate: 1.25 }),
};
let fetchError: Error | null = null;

const fetchMock = async (url: string, options: RequestInit): Promise<MockFetchResponse> => {
    fetchCalls.push({ url, options });
    if (fetchError) {
        throw fetchError;
    }
    if (typeof fetchResponse === 'function') {
        return await fetchResponse();
    }
    return fetchResponse;
};

g.localStorage = localStorageMock;
g.window = {};
g.fetch = fetchMock;

// Import target after mocks
import {
    CURRENCY_CACHE_DURATION_MS,
    getExchangeRate,
    invalidateCurrencyCache,
} from './currencyCache.ts';

test('getExchangeRate & invalidateCurrencyCache', async (t) => {
    t.beforeEach(() => {
        invalidateCurrencyCache();
        localStorageMock.clear();
        fetchCalls = [];
        fetchResponse = { ok: true, status: 200, json: async () => ({ rate: 1.25 }) };
        fetchError = null;
    });

    await t.test('returns 1 immediately when from === to (normalizing case/whitespace)', async () => {
        const rate = await getExchangeRate(' usd ', 'USD');
        assert.strictEqual(rate, 1);
        assert.strictEqual(fetchCalls.length, 0);
    });

    await t.test('returns null immediately for empty currency codes', async () => {
        assert.strictEqual(await getExchangeRate('', 'USD'), null);
        assert.strictEqual(await getExchangeRate('USD', ''), null);
        assert.strictEqual(fetchCalls.length, 0);
    });

    await t.test('returns cached rate when valid unexpired cache exists (< 10 minutes)', async () => {
        assert.strictEqual(CURRENCY_CACHE_DURATION_MS, 10 * 60 * 1000);
        const key = 'rate_v4_USD_EUR';
        storage[key] = JSON.stringify({
            rate: 0.85,
            timestamp: Date.now() - (9 * 60 * 1000 + 50 * 1000),
        });

        const rate = await getExchangeRate('USD', 'EUR');
        assert.strictEqual(rate, 0.85);
        assert.strictEqual(fetchCalls.length, 0);
    });

    await t.test('fetches fresh rate when cache entry is expired (>= 10 minutes old)', async () => {
        const key = 'rate_v4_USD_EUR';
        storage[key] = JSON.stringify({
            rate: 0.85,
            timestamp: Date.now() - (CURRENCY_CACHE_DURATION_MS + 1000),
        });
        fetchResponse = { ok: true, json: async () => ({ rate: 0.90 }) };

        const rate = await getExchangeRate('USD', 'EUR');
        assert.strictEqual(rate, 0.90);
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, '/api/exchange-rate');
        assert.strictEqual(fetchCalls[0].options.method, 'POST');
        assert.strictEqual(fetchCalls[0].options.body, JSON.stringify({ from: 'USD', to: 'EUR' }));

        const newCached = JSON.parse(storage[key]);
        assert.strictEqual(newCached.rate, 0.90);
    });

    await t.test('deduplicates concurrent in-flight fetches for the same currency pair', async () => {
        let resolveResponse!: (res: MockFetchResponse) => void;
        fetchResponse = () =>
            new Promise<MockFetchResponse>((resolve) => {
                resolveResponse = resolve;
            });

        const p1 = getExchangeRate('USD', 'JPY');
        const p2 = getExchangeRate('usd', 'jpy');
        const p3 = getExchangeRate('USD', 'JPY');

        assert.strictEqual(fetchCalls.length, 1);
        resolveResponse({ ok: true, json: async () => ({ rate: 152.4 }) });

        const results = await Promise.all([p1, p2, p3]);
        assert.deepStrictEqual(results, [152.4, 152.4, 152.4]);
        assert.strictEqual(fetchCalls.length, 1);

        // Subsequent call hits newly populated cache
        assert.strictEqual(await getExchangeRate('USD', 'JPY'), 152.4);
        assert.strictEqual(fetchCalls.length, 1);
    });

    await t.test('forceRefresh bypasses fresh cache and updates stored rate', async () => {
        const key = 'rate_v4_USD_CAD';
        storage[key] = JSON.stringify({
            rate: 1.35,
            timestamp: Date.now(),
        });
        fetchResponse = { ok: true, json: async () => ({ rate: 1.41 }) };

        const rate = await getExchangeRate('USD', 'CAD', { forceRefresh: true });
        assert.strictEqual(rate, 1.41);
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(JSON.parse(storage[key]).rate, 1.41);
    });

    await t.test('invalidateCurrencyCache clears targeted or all rate keys and blocks stale in-flight writes', async () => {
        storage['rate_v4_USD_EUR'] = JSON.stringify({ rate: 0.9, timestamp: Date.now() });
        storage['rate_v4_USD_CAD'] = JSON.stringify({ rate: 1.38, timestamp: Date.now() });
        storage['unrelated_key'] = 'keep';

        invalidateCurrencyCache('usd', 'eur');
        assert.strictEqual(storage['rate_v4_USD_EUR'], undefined);
        assert.ok(storage['rate_v4_USD_CAD']);
        assert.strictEqual(storage['unrelated_key'], 'keep');

        // Start in-flight fetch, invalidate mid-flight -> response must NOT overwrite cache
        let resolveStale!: (res: MockFetchResponse) => void;
        fetchResponse = () =>
            new Promise<MockFetchResponse>((resolve) => {
                resolveStale = resolve;
            });

        const inFlight = getExchangeRate('USD', 'GBP');
        assert.strictEqual(fetchCalls.length, 1);

        invalidateCurrencyCache();
        assert.strictEqual(storage['rate_v4_USD_CAD'], undefined);
        assert.strictEqual(storage['unrelated_key'], 'keep');

        resolveStale({ ok: true, json: async () => ({ rate: 0.77 }) });
        assert.strictEqual(await inFlight, 0.77);
        assert.strictEqual(storage['rate_v4_USD_GBP'], undefined);

        // Subsequent call performs a clean fresh fetch
        fetchResponse = { ok: true, json: async () => ({ rate: 0.79 }) };
        assert.strictEqual(await getExchangeRate('USD', 'GBP'), 0.79);
        assert.strictEqual(fetchCalls.length, 2);
        assert.strictEqual(JSON.parse(storage['rate_v4_USD_GBP']).rate, 0.79);
    });

    await t.test('fetches fresh rate when cache JSON is malformed', async () => {
        const key = 'rate_v4_USD_GBP';
        storage[key] = 'invalid-json-{';
        fetchResponse = { ok: true, json: async () => ({ rate: 0.75 }) };

        const rate = await getExchangeRate('USD', 'GBP');
        assert.strictEqual(rate, 0.75);
        assert.strictEqual(fetchCalls.length, 1);
    });

    await t.test('returns null without caching on non-OK HTTP response and cleans up in-flight map', async () => {
        fetchResponse = {
            ok: false,
            status: 500,
            json: async () => ({ error: 'Internal Server Error' }),
        };

        const failed = await getExchangeRate('USD', 'AUD');
        assert.strictEqual(failed, null);
        assert.strictEqual(storage['rate_v4_USD_AUD'], undefined);

        // Retry works immediately rather than sticking on failed in-flight promise
        fetchResponse = { ok: true, json: async () => ({ rate: 1.52 }) };
        const retried = await getExchangeRate('USD', 'AUD');
        assert.strictEqual(retried, 1.52);
        assert.strictEqual(fetchCalls.length, 2);
    });

    await t.test('does not save to cache if rate is null or missing in API response', async () => {
        fetchResponse = { ok: true, json: async () => ({ rate: null }) };

        const rate = await getExchangeRate('USD', 'XYZ');
        assert.strictEqual(rate, null);
        assert.strictEqual(storage['rate_v4_USD_XYZ'], undefined);
    });

    await t.test('handles synchronous or async fetch error gracefully and cleans up in-flight state', async () => {
        fetchError = new Error('Network failure');

        const rate = await getExchangeRate('USD', 'EUR');
        assert.strictEqual(rate, null);
        assert.strictEqual(storage['rate_v4_USD_EUR'], undefined);

        fetchError = null;
        fetchResponse = { ok: true, json: async () => ({ rate: 0.92 }) };
        assert.strictEqual(await getExchangeRate('USD', 'EUR'), 0.92);
        assert.strictEqual(fetchCalls.length, 2);
    });

    await t.test('handles JSON parse error in fetch response', async () => {
        fetchResponse = {
            ok: true,
            json: async () => {
                throw new Error('Invalid JSON response');
            },
        };

        const rate = await getExchangeRate('USD', 'JPY');
        assert.strictEqual(rate, null);
    });

    await t.test('works correctly when window is undefined (SSR)', async () => {
        const originalWindow = g.window;
        delete g.window;

        fetchResponse = { ok: true, json: async () => ({ rate: 1.10 }) };

        try {
            const rate = await getExchangeRate('EUR', 'USD');
            assert.strictEqual(rate, 1.10);
            assert.strictEqual(fetchCalls.length, 1);
            assert.strictEqual(Object.keys(storage).length, 0);
        } finally {
            g.window = originalWindow;
        }
    });
});
