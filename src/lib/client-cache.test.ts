import test from 'node:test';
import assert from 'node:assert';

interface LocalStorageMock {
    readonly length: number;
    key: (index: number) => string | null;
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
    clear: () => void;
}

const g = globalThis as Record<string, unknown>;

// Mocking browser environment before importing ClientCache
const storage: Record<string, string> = {};
const nonEnumerableBacking: Record<string, string> = {};

const localStorageMock: LocalStorageMock = {
    get length() {
        return new Set([...Object.keys(storage), ...Object.keys(nonEnumerableBacking)]).size;
    },
    key: (index: number) => {
        const keys = Array.from(new Set([...Object.keys(storage), ...Object.keys(nonEnumerableBacking)]));
        return keys[index] ?? null;
    },
    getItem: (key: string) => storage[key] ?? nonEnumerableBacking[key] ?? null,
    setItem: (key: string, value: string) => {
        storage[key] = value;
    },
    removeItem: (key: string) => {
        delete storage[key];
        delete nonEnumerableBacking[key];
    },
    clear: () => {
        Object.keys(storage).forEach((k) => delete storage[k]);
        Object.keys(nonEnumerableBacking).forEach((k) => delete nonEnumerableBacking[k]);
    },
};

g.localStorage = localStorageMock;
g.window = {};
g.btoa = (str: string) => Buffer.from(str).toString('base64');

// DOMException mock for QuotaExceededError
class MockDOMException extends Error {
    constructor(message: string, name: string) {
        super(message);
        this.name = name;
    }
}
g.DOMException = MockDOMException;

// Now import ClientCache
import { ClientCache, DEFAULT_CLIENT_CACHE_TTL_MS } from './client-cache.ts';

const CACHE_PREFIX = 'portfolio_cache_';

test('ClientCache', async (t) => {
    t.beforeEach(() => {
        localStorageMock.clear();
    });

    await t.test('get - returns null if window is undefined', () => {
        const originalWindow = g.window;
        delete g.window;
        assert.strictEqual(ClientCache.get('key'), null);
        g.window = originalWindow;
    });

    await t.test('set - returns early if window is undefined', () => {
        const originalWindow = g.window;
        delete g.window;
        ClientCache.set('key', 'value');
        assert.strictEqual(Object.keys(storage).length, 0);
        g.window = originalWindow;
    });

    await t.test('set and get valid data', () => {
        const key = 'testKey';
        const data = { foo: 'bar' };
        ClientCache.set(key, data);

        const retrieved = ClientCache.get(key);
        assert.deepStrictEqual(retrieved, data);
    });

    await t.test('get - returns null for missing key', () => {
        assert.strictEqual(ClientCache.get('missing'), null);
    });

    await t.test('get - returns null and removes item on version mismatch', () => {
        const key = 'versionMismatch';
        const oldEntry = {
            timestamp: Date.now(),
            version: 1, // Current is 2
            data: 'old data'
        };
        localStorageMock.setItem(CACHE_PREFIX + key, JSON.stringify(oldEntry));

        const retrieved = ClientCache.get(key);
        assert.strictEqual(retrieved, null);
        assert.strictEqual(storage[CACHE_PREFIX + key], undefined);
    });

    await t.test('get - defaults to 15 minute TTL and expires entries past DEFAULT_CLIENT_CACHE_TTL_MS', () => {
        assert.strictEqual(DEFAULT_CLIENT_CACHE_TTL_MS, 15 * 60 * 1000);

        const freshKey = 'fresh14m';
        localStorageMock.setItem(
            CACHE_PREFIX + freshKey,
            JSON.stringify({
                timestamp: Date.now() - (14 * 60 * 1000 + 50 * 1000),
                version: 2,
                data: 'still valid',
            })
        );
        assert.strictEqual(ClientCache.get(freshKey), 'still valid');

        const staleKey = 'expired15m';
        localStorageMock.setItem(
            CACHE_PREFIX + staleKey,
            JSON.stringify({
                timestamp: Date.now() - (DEFAULT_CLIENT_CACHE_TTL_MS + 1000),
                version: 2,
                data: 'expired data',
            })
        );
        assert.strictEqual(ClientCache.get(staleKey), null);
        assert.strictEqual(storage[CACHE_PREFIX + staleKey], undefined);
    });

    await t.test('get - supports numeric and options-object ttlMs overrides and rejects invalid TTLs', () => {
        const analyticsKey = 'analytics20m';
        localStorageMock.setItem(
            CACHE_PREFIX + analyticsKey,
            JSON.stringify({
                timestamp: Date.now() - (20 * 60 * 1000),
                version: 2,
                data: { points: [1, 2, 3] },
            })
        );

        // Default 15m rejects it if read directly without override -> first test with 30m number & object override
        assert.deepStrictEqual(ClientCache.get(analyticsKey, 30 * 60 * 1000), { points: [1, 2, 3] });
        assert.deepStrictEqual(ClientCache.get(analyticsKey, { ttlMs: 30 * 60 * 1000 }), { points: [1, 2, 3] });

        // Shorter TTL expires and cleans up
        assert.strictEqual(ClientCache.get(analyticsKey, { ttlMs: 10 * 60 * 1000 }), null);
        assert.strictEqual(storage[CACHE_PREFIX + analyticsKey], undefined);

        // Non-positive or non-finite TTL evicts entry immediately
        localStorageMock.setItem(
            CACHE_PREFIX + 'zeroTtl',
            JSON.stringify({ timestamp: Date.now(), version: 2, data: 'x' })
        );
        assert.strictEqual(ClientCache.get('zeroTtl', 0), null);
        assert.strictEqual(storage[CACHE_PREFIX + 'zeroTtl'], undefined);
    });

    await t.test('get - handles malformed JSON and logs error', () => {
        const key = 'malformed';
        localStorageMock.setItem(CACHE_PREFIX + key, '{ invalid json ');

        const originalConsoleError = console.error;
        let loggedError: unknown[] | null = null;
        console.error = (...args: unknown[]) => {
            loggedError = args;
        };

        try {
            const retrieved = ClientCache.get(key);
            assert.strictEqual(retrieved, null);
            assert.ok(loggedError);
            assert.strictEqual(loggedError[0], 'Cache Read Error');
        } finally {
            console.error = originalConsoleError;
        }
    });

    await t.test('get - handles localStorage.getItem exception', () => {
        const key = 'throwOnGet';
        const originalGetItem = localStorageMock.getItem;
        localStorageMock.getItem = () => {
            throw new Error('Access denied');
        };

        const originalConsoleError = console.error;
        let loggedError: unknown[] | null = null;
        console.error = (...args: unknown[]) => {
            loggedError = args;
        };

        try {
            const retrieved = ClientCache.get(key);
            assert.strictEqual(retrieved, null);
            assert.ok(loggedError);
            assert.strictEqual(loggedError[0], 'Cache Read Error');
        } finally {
            localStorageMock.getItem = originalGetItem;
            console.error = originalConsoleError;
        }
    });

    await t.test('set - handles generic write error', () => {
        const key = 'genericWriteError';
        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = () => {
            throw new Error('Storage write disabled');
        };

        const originalConsoleError = console.error;
        let loggedError: unknown[] | null = null;
        console.error = (...args: unknown[]) => {
            loggedError = args;
        };

        try {
            ClientCache.set(key, { data: 123 });
            assert.ok(loggedError);
            assert.strictEqual(loggedError[0], 'Cache Write Error');
        } finally {
            localStorageMock.setItem = originalSetItem;
            console.error = originalConsoleError;
        }
    });

    await t.test('set - handles QuotaExceededError when retry after clear also fails', () => {
        const key = 'quotaRetryFail';
        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = () => {
            throw new MockDOMException('Quota exceeded', 'QuotaExceededError');
        };

        const originalConsoleError = console.error;
        const originalConsoleWarn = console.warn;
        let loggedError: unknown[] | null = null;
        let loggedWarn: unknown[] | null = null;
        console.error = (...args: unknown[]) => {
            loggedError = args;
        };
        console.warn = (...args: unknown[]) => {
            loggedWarn = args;
        };

        try {
            ClientCache.set(key, { data: 123 });
            assert.ok(loggedWarn);
            assert.strictEqual(loggedWarn[0], 'LocalStorage Quota Exceeded. Clearing old cache and retrying.');
            assert.ok(loggedError);
            assert.strictEqual(loggedError[0], 'Cache Write Error after clear');
        } finally {
            localStorageMock.setItem = originalSetItem;
            console.error = originalConsoleError;
            console.warn = originalConsoleWarn;
        }
    });

    await t.test('set - handles QuotaExceededError by clearing and retrying', () => {
        const key = 'quota';
        const data = 'some data';

        ClientCache.set('other', 'other data');
        storage['not_our_prefix'] = 'leave me alone';

        let setItemCalls = 0;
        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = (k: string, v: string) => {
            setItemCalls++;
            if (setItemCalls === 1) {
                throw new MockDOMException('Quota exceeded', 'QuotaExceededError');
            }
            storage[k] = v;
        };

        try {
            ClientCache.set(key, data);

            assert.strictEqual(setItemCalls, 2);
            assert.strictEqual(storage[CACHE_PREFIX + 'other'], undefined);
            assert.strictEqual(storage['not_our_prefix'], 'leave me alone');
            assert.ok(storage[CACHE_PREFIX + key]);
        } finally {
            localStorageMock.setItem = originalSetItem;
        }
    });

    await t.test('set - handles NS_ERROR_DOM_QUOTA_REACHED error by clearing and retrying', () => {
        const key = 'quota_firefox';
        const data = 'some data';

        let setItemCalls = 0;
        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = (k: string, v: string) => {
            setItemCalls++;
            if (setItemCalls === 1) {
                throw new MockDOMException('Quota exceeded', 'NS_ERROR_DOM_QUOTA_REACHED');
            }
            storage[k] = v;
        };

        try {
            assert.doesNotThrow(() => {
                ClientCache.set(key, data);
            });

            assert.strictEqual(setItemCalls, 2);
            assert.ok(storage[CACHE_PREFIX + key]);
        } finally {
            localStorageMock.setItem = originalSetItem;
        }
    });

    await t.test('set - handles persistent QuotaExceededError when retry after clear fails', () => {
        const key = 'quota_persistent';
        const data = 'large data';

        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = () => {
            throw new MockDOMException('Quota exceeded', 'QuotaExceededError');
        };

        try {
            assert.doesNotThrow(() => {
                ClientCache.set(key, data);
            });
        } finally {
            localStorageMock.setItem = originalSetItem;
        }
    });

    await t.test('set - handles generic storage error without throwing', () => {
        const key = 'generic_error';
        const data = 'some data';

        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = () => {
            throw new Error('SecurityError: Access is denied');
        };

        try {
            assert.doesNotThrow(() => {
                ClientCache.set(key, data);
            });
        } finally {
            localStorageMock.setItem = originalSetItem;
        }
    });

    await t.test('generateKey - produces stable keys', () => {
        const base = 'base';
        const params1 = { b: 2, a: 1 };
        const params2 = { a: 1, b: 2 };

        const key1 = ClientCache.generateKey(base, params1);
        const key2 = ClientCache.generateKey(base, params2);

        assert.strictEqual(key1, key2);
        assert.ok(key1.startsWith('base_'));
    });

    await t.test('generateKey - handles nested objects and arrays', () => {
        const base = 'nested';
        const params1 = { filters: ['z', 'a'], options: { y: 2, x: 1 } };
        const params2 = { options: { x: 1, y: 2 }, filters: ['a', 'z'] };

        const key1 = ClientCache.generateKey(base, params1);
        const key2 = ClientCache.generateKey(base, params2);

        assert.strictEqual(key1, key2);
    });

    await t.test('invalidateByPrefix - removes only matching prefixed entries via Web Storage key(i)', () => {
        nonEnumerableBacking[CACHE_PREFIX + 'evolution_1'] = 'val1';
        nonEnumerableBacking[CACHE_PREFIX + 'evolution_2'] = 'val2';
        nonEnumerableBacking[CACHE_PREFIX + 'comparison-1'] = 'keep';
        nonEnumerableBacking['other_key'] = 'keep';

        ClientCache.invalidateByPrefix('evolution_');

        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'evolution_1'], undefined);
        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'evolution_2'], undefined);
        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'comparison-1'], 'keep');
        assert.strictEqual(nonEnumerableBacking['other_key'], 'keep');
    });

    await t.test('clearPortfolioCaches - removes current and legacy portfolio keys without touching unrelated settings', () => {
        // Store in nonEnumerableBacking to verify Web Storage length/key(i) enumeration
        nonEnumerableBacking[CACHE_PREFIX + 'portfolio_summary_abc'] = '1';
        nonEnumerableBacking[CACHE_PREFIX + 'portfolio-history-1Y-CAD'] = '2';
        nonEnumerableBacking[CACHE_PREFIX + 'comparison-1M'] = '3';
        nonEnumerableBacking[CACHE_PREFIX + 'evolution_xyz'] = '4';
        nonEnumerableBacking[CACHE_PREFIX + 'analysis_AAPL'] = '5';
        nonEnumerableBacking['portfolio_summary_legacy'] = '6';
        nonEnumerableBacking['analysis_AAPL'] = '7';

        // Should remain untouched
        nonEnumerableBacking[CACHE_PREFIX + 'ui_pref'] = 'keep-pref';
        nonEnumerableBacking['dashboard_filters'] = 'keep-filters';
        nonEnumerableBacking['rate_v4_USD_CAD'] = 'keep-fx';

        ClientCache.clearPortfolioCaches();

        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'portfolio_summary_abc'], undefined);
        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'portfolio-history-1Y-CAD'], undefined);
        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'comparison-1M'], undefined);
        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'evolution_xyz'], undefined);
        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'analysis_AAPL'], undefined);
        assert.strictEqual(nonEnumerableBacking['portfolio_summary_legacy'], undefined);
        assert.strictEqual(nonEnumerableBacking['analysis_AAPL'], undefined);

        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + 'ui_pref'], 'keep-pref');
        assert.strictEqual(nonEnumerableBacking['dashboard_filters'], 'keep-filters');
        assert.strictEqual(nonEnumerableBacking['rate_v4_USD_CAD'], 'keep-fx');
    });

    await t.test('clear - removes only prefixed keys', () => {
        localStorageMock.setItem(CACHE_PREFIX + '1', 'val1');
        localStorageMock.setItem(CACHE_PREFIX + '2', 'val2');
        nonEnumerableBacking[CACHE_PREFIX + '3'] = 'val3';
        storage['other_app'] = 'val4';

        ClientCache.clear();

        assert.strictEqual(storage[CACHE_PREFIX + '1'], undefined);
        assert.strictEqual(storage[CACHE_PREFIX + '2'], undefined);
        assert.strictEqual(nonEnumerableBacking[CACHE_PREFIX + '3'], undefined);
        assert.strictEqual(storage['other_app'], 'val4');
    });
});
