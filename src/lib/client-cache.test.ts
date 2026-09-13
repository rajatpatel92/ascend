import test from 'node:test';
import assert from 'node:assert';

// Mocking browser environment before importing ClientCache
const storage: Record<string, string> = {};
const localStorageMock = {
    getItem: (key: string) => storage[key] || null,
    setItem: (key: string, value: string) => {
        storage[key] = value;
        (localStorageMock as any)[key] = value;
    },
    removeItem: (key: string) => {
        delete storage[key];
        delete (localStorageMock as any)[key];
    },
    clear: () => {
        Object.keys(storage).forEach(k => {
            delete (localStorageMock as any)[k];
            delete storage[k];
        });
    },
};

(globalThis as any).localStorage = localStorageMock;
(globalThis as any).window = {};
(globalThis as any).btoa = (str: string) => Buffer.from(str).toString('base64');

// DOMException mock for QuotaExceededError
class MockDOMException extends Error {
    name: string;
    constructor(message: string, name: string) {
        super(message);
        this.name = name;
    }
}
(globalThis as any).DOMException = MockDOMException;

// Now import ClientCache
import { ClientCache } from './client-cache.ts';

const CACHE_PREFIX = 'portfolio_cache_';

test('ClientCache', async (t) => {
    t.beforeEach(() => {
        // Clear storage before each test
        Object.keys(storage).forEach(key => {
            delete storage[key];
            delete (localStorageMock as any)[key];
        });
    });

    await t.test('get - returns null if window is undefined', () => {
        const originalWindow = (globalThis as any).window;
        delete (globalThis as any).window;
        assert.strictEqual(ClientCache.get('key'), null);
        (globalThis as any).window = originalWindow;
    });

    await t.test('set - returns early if window is undefined', () => {
        const originalWindow = (globalThis as any).window;
        delete (globalThis as any).window;
        ClientCache.set('key', 'value');
        assert.strictEqual(Object.keys(storage).length, 0);
        (globalThis as any).window = originalWindow;
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

    await t.test('get - returns null and removes item on TTL expiration', () => {
        const key = 'expired';
        const expiredEntry = {
            timestamp: Date.now() - (25 * 60 * 60 * 1000), // 25 hours ago
            version: 2,
            data: 'expired data'
        };
        localStorageMock.setItem(CACHE_PREFIX + key, JSON.stringify(expiredEntry));

        const retrieved = ClientCache.get(key);
        assert.strictEqual(retrieved, null);
        assert.strictEqual(storage[CACHE_PREFIX + key], undefined);
    });

    await t.test('get - handles malformed JSON', () => {
        const key = 'malformed';
        storage[CACHE_PREFIX + key] = 'invalid json';
        (localStorageMock as any)[CACHE_PREFIX + key] = 'invalid json';

        // Should catch and return null
        const retrieved = ClientCache.get(key);
        assert.strictEqual(retrieved, null);
    });

    await t.test('set - handles QuotaExceededError by clearing and retrying', () => {
        const key = 'quota';
        const data = 'some data';

        // Prefill with some other keys
        ClientCache.set('other', 'other data');
        storage['not_our_prefix'] = 'leave me alone';
        (localStorageMock as any)['not_our_prefix'] = 'leave me alone';

        let setItemCalls = 0;
        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = (k: string, v: string) => {
            setItemCalls++;
            if (setItemCalls === 1) {
                throw new MockDOMException('Quota exceeded', 'QuotaExceededError');
            }
            storage[k] = v;
            (localStorageMock as any)[k] = v;
        };

        ClientCache.set(key, data);

        assert.strictEqual(setItemCalls, 2); // First failed, second succeeded after clear
        assert.strictEqual(storage[CACHE_PREFIX + 'other'], undefined); // Cleared
        assert.strictEqual(storage['not_our_prefix'], 'leave me alone'); // Not cleared
        assert.ok(storage[CACHE_PREFIX + key]);

        // Restore
        localStorageMock.setItem = originalSetItem;
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
            (localStorageMock as any)[k] = v;
        };

        assert.doesNotThrow(() => {
            ClientCache.set(key, data);
        });

        assert.strictEqual(setItemCalls, 2);
        assert.ok(storage[CACHE_PREFIX + key]);

        // Restore
        localStorageMock.setItem = originalSetItem;
    });

    await t.test('set - handles persistent QuotaExceededError when retry after clear fails', () => {
        const key = 'quota_persistent';
        const data = 'large data';

        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = () => {
            throw new MockDOMException('Quota exceeded', 'QuotaExceededError');
        };

        assert.doesNotThrow(() => {
            ClientCache.set(key, data);
        });

        // Restore
        localStorageMock.setItem = originalSetItem;
    });

    await t.test('set - handles generic storage error without throwing', () => {
        const key = 'generic_error';
        const data = 'some data';

        const originalSetItem = localStorageMock.setItem;
        localStorageMock.setItem = () => {
            throw new Error('SecurityError: Access is denied');
        };

        assert.doesNotThrow(() => {
            ClientCache.set(key, data);
        });

        // Restore
        localStorageMock.setItem = originalSetItem;
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

    await t.test('clear - removes only prefixed keys', () => {
        localStorageMock.setItem(CACHE_PREFIX + '1', 'val1');
        localStorageMock.setItem(CACHE_PREFIX + '2', 'val2');
        storage['other_app'] = 'val3';
        (localStorageMock as any)['other_app'] = 'val3';

        ClientCache.clear();

        assert.strictEqual(storage[CACHE_PREFIX + '1'], undefined);
        assert.strictEqual(storage[CACHE_PREFIX + '2'], undefined);
        assert.strictEqual(storage['other_app'], 'val3');
    });
});
