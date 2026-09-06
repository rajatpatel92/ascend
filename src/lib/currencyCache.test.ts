import test from 'node:test';
import assert from 'node:assert';

// Mock browser environment before importing currencyCache
const storage: Record<string, string> = {};
const localStorageMock = {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, value: string) => {
        storage[key] = value;
    },
    removeItem: (key: string) => {
        delete storage[key];
    },
    clear: () => {
        Object.keys(storage).forEach(k => delete storage[k]);
    },
};

let fetchCalls: { url: string; options: any }[] = [];
let fetchResponse: any = { json: async () => ({ rate: 1.25 }) };
let fetchError: Error | null = null;

const fetchMock = async (url: string, options: any) => {
    fetchCalls.push({ url, options });
    if (fetchError) {
        throw fetchError;
    }
    return fetchResponse;
};

(globalThis as any).localStorage = localStorageMock;
(globalThis as any).window = {};
(globalThis as any).fetch = fetchMock;

// Import target after mocks
import { getExchangeRate } from './currencyCache.ts';

test('getExchangeRate', async (t) => {
    t.beforeEach(() => {
        // Clear storage and call history before each test
        Object.keys(storage).forEach(k => delete storage[k]);
        fetchCalls = [];
        fetchResponse = { json: async () => ({ rate: 1.25 }) };
        fetchError = null;
    });

    await t.test('returns 1 immediately when from === to', async () => {
        const rate = await getExchangeRate('USD', 'USD');
        assert.strictEqual(rate, 1);
        assert.strictEqual(fetchCalls.length, 0);
    });

    await t.test('returns cached rate when valid unexpired cache exists', async () => {
        const key = 'rate_v4_USD_EUR';
        const cachedData = {
            rate: 0.85,
            timestamp: Date.now() - 1000 // 1 second ago
        };
        storage[key] = JSON.stringify(cachedData);

        const rate = await getExchangeRate('USD', 'EUR');
        assert.strictEqual(rate, 0.85);
        assert.strictEqual(fetchCalls.length, 0);
    });

    await t.test('fetches fresh rate when cache entry is expired (>= 8 hours old)', async () => {
        const key = 'rate_v4_USD_EUR';
        const expiredData = {
            rate: 0.85,
            timestamp: Date.now() - (8 * 60 * 60 * 1000 + 1000) // 8 hours and 1s ago
        };
        storage[key] = JSON.stringify(expiredData);
        fetchResponse = { json: async () => ({ rate: 0.90 }) };

        const rate = await getExchangeRate('USD', 'EUR');
        assert.strictEqual(rate, 0.90);
        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(fetchCalls[0].url, '/api/exchange-rate');
        assert.strictEqual(fetchCalls[0].options.method, 'POST');
        assert.strictEqual(fetchCalls[0].options.body, JSON.stringify({ from: 'USD', to: 'EUR' }));

        // Check cache updated
        const newCached = JSON.parse(storage[key]);
        assert.strictEqual(newCached.rate, 0.90);
    });

    await t.test('fetches fresh rate when cache JSON is malformed', async () => {
        const key = 'rate_v4_USD_GBP';
        storage[key] = 'invalid-json-{';
        fetchResponse = { json: async () => ({ rate: 0.75 }) };

        const rate = await getExchangeRate('USD', 'GBP');
        assert.strictEqual(rate, 0.75);
        assert.strictEqual(fetchCalls.length, 1);
    });

    await t.test('caches fresh rate on cache miss', async () => {
        fetchResponse = { json: async () => ({ rate: 1.35 }) };

        const rate = await getExchangeRate('USD', 'CAD');
        assert.strictEqual(rate, 1.35);

        const cached = JSON.parse(storage['rate_v4_USD_CAD']);
        assert.strictEqual(cached.rate, 1.35);
        assert.ok(typeof cached.timestamp === 'number');
    });

    await t.test('does not save to cache if rate is null or missing in API response', async () => {
        fetchResponse = { json: async () => ({ rate: null }) };

        const rate = await getExchangeRate('USD', 'XYZ');
        assert.strictEqual(rate, null);
        assert.strictEqual(storage['rate_v4_USD_XYZ'], undefined);
    });

    await t.test('handles fetch error gracefully and returns null', async () => {
        fetchError = new Error('Network failure');

        const rate = await getExchangeRate('USD', 'EUR');
        assert.strictEqual(rate, null);
        assert.strictEqual(storage['rate_v4_USD_EUR'], undefined);
    });

    await t.test('handles JSON parse error in fetch response', async () => {
        fetchResponse = {
            json: async () => {
                throw new Error('Invalid JSON response');
            }
        };

        const rate = await getExchangeRate('USD', 'JPY');
        assert.strictEqual(rate, null);
    });

    await t.test('works correctly when window is undefined (SSR)', async () => {
        const originalWindow = (globalThis as any).window;
        delete (globalThis as any).window;

        fetchResponse = { json: async () => ({ rate: 1.10 }) };

        try {
            const rate = await getExchangeRate('EUR', 'USD');
            assert.strictEqual(rate, 1.10);
            assert.strictEqual(fetchCalls.length, 1);
            // Verify storage was not accessed
            assert.strictEqual(Object.keys(storage).length, 0);
        } finally {
            (globalThis as any).window = originalWindow;
        }
    });
});
