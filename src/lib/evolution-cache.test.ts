import test from 'node:test';
import assert from 'node:assert';
import { fetchWithStaleWhileRevalidate, type CacheStore } from './evolution-cache.ts';

interface EvolutionPayload {
    evolution: Array<{ date: string; value: number; invested: number }>;
}

function createMemoryCache(initial: Record<string, unknown> = {}): CacheStore & { store: Map<string, unknown> } {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
        store,
        get<T>(key: string): T | null {
            return (store.get(key) as T | undefined) ?? null;
        },
        set<T>(key: string, data: T): void {
            store.set(key, data);
        }
    };
}

const isEvolutionPayload = (val: unknown): val is EvolutionPayload =>
    Boolean(val && typeof val === 'object' && Array.isArray((val as EvolutionPayload).evolution));

test('fetchWithStaleWhileRevalidate', async (t) => {
    await t.test('revalidates stale cached data from server and updates both UI and cache', async () => {
        const staleData: EvolutionPayload = {
            evolution: [{ date: '2026-10-01', value: 999999, invested: 100000 }]
        };
        const freshData: EvolutionPayload = {
            evolution: [{ date: '2026-10-01', value: 150000, invested: 100000 }]
        };
        const cache = createMemoryCache({ evo_key: staleData });

        const loadingStates: boolean[] = [];
        const emitted: EvolutionPayload[] = [];
        let fetchCount = 0;

        await fetchWithStaleWhileRevalidate({
            cache,
            cacheKey: 'evo_key',
            isValid: isEvolutionPayload,
            fetcher: async () => {
                fetchCount += 1;
                return freshData;
            },
            onCached: (data) => emitted.push(data),
            onFresh: (data) => emitted.push(data),
            onLoadingChange: (loading) => loadingStates.push(loading),
        });

        assert.strictEqual(fetchCount, 1);
        assert.deepStrictEqual(loadingStates, [false, false]);
        assert.deepStrictEqual(emitted, [staleData, freshData]);
        assert.deepStrictEqual(cache.get<EvolutionPayload>('evo_key'), freshData);
    });

    await t.test('fetches and caches data on cache miss while toggling loading state', async () => {
        const freshData: EvolutionPayload = {
            evolution: [{ date: '2026-11-13', value: 156000, invested: 149000 }]
        };
        const cache = createMemoryCache();

        const loadingStates: boolean[] = [];
        const cachedCalls: EvolutionPayload[] = [];
        const freshCalls: EvolutionPayload[] = [];

        await fetchWithStaleWhileRevalidate({
            cache,
            cacheKey: 'evo_key',
            isValid: isEvolutionPayload,
            fetcher: async () => freshData,
            onCached: (data) => cachedCalls.push(data),
            onFresh: (data) => freshCalls.push(data),
            onLoadingChange: (loading) => loadingStates.push(loading),
        });

        assert.deepStrictEqual(loadingStates, [true, false]);
        assert.strictEqual(cachedCalls.length, 0);
        assert.deepStrictEqual(freshCalls, [freshData]);
        assert.deepStrictEqual(cache.get<EvolutionPayload>('evo_key'), freshData);
    });

    await t.test('treats invalid cached payload as cache miss and replaces it with fresh data', async () => {
        const freshData: EvolutionPayload = {
            evolution: [{ date: '2026-11-13', value: 120000, invested: 100000 }]
        };
        const cache = createMemoryCache({ evo_key: { broken: true } });

        const loadingStates: boolean[] = [];
        const cachedCalls: EvolutionPayload[] = [];
        const freshCalls: EvolutionPayload[] = [];

        await fetchWithStaleWhileRevalidate({
            cache,
            cacheKey: 'evo_key',
            isValid: isEvolutionPayload,
            fetcher: async () => freshData,
            onCached: (data) => cachedCalls.push(data),
            onFresh: (data) => freshCalls.push(data),
            onLoadingChange: (loading) => loadingStates.push(loading),
        });

        assert.deepStrictEqual(loadingStates, [true, false]);
        assert.strictEqual(cachedCalls.length, 0);
        assert.deepStrictEqual(freshCalls, [freshData]);
        assert.deepStrictEqual(cache.get<EvolutionPayload>('evo_key'), freshData);
    });

    await t.test('invokes onError and preserves cached data if background revalidation fails', async () => {
        const staleData: EvolutionPayload = {
            evolution: [{ date: '2026-10-01', value: 150000, invested: 100000 }]
        };
        const cache = createMemoryCache({ evo_key: staleData });

        const loadingStates: boolean[] = [];
        let errorArgs: { error: unknown; hasCached: boolean } | null = null;

        await fetchWithStaleWhileRevalidate({
            cache,
            cacheKey: 'evo_key',
            isValid: isEvolutionPayload,
            fetcher: async () => {
                throw new Error('HTTP 500');
            },
            onCached: () => {},
            onFresh: () => {
                assert.fail('onFresh should not be called on error');
            },
            onLoadingChange: (loading) => loadingStates.push(loading),
            onError: (error, hasCached) => {
                errorArgs = { error, hasCached };
            }
        });

        assert.deepStrictEqual(loadingStates, [false, false]);
        assert.ok(errorArgs);
        assert.strictEqual((errorArgs as { hasCached: boolean }).hasCached, true);
        assert.deepStrictEqual(cache.get<EvolutionPayload>('evo_key'), staleData);
    });

    await t.test('ignores AbortError and does not update state or cache when aborted', async () => {
        const controller = new AbortController();
        const cache = createMemoryCache();

        let freshCalled = false;
        let errorCalled = false;

        await fetchWithStaleWhileRevalidate({
            cache,
            cacheKey: 'evo_key',
            isValid: isEvolutionPayload,
            signal: controller.signal,
            fetcher: async (sig) => {
                controller.abort();
                if (sig?.aborted) {
                    throw new DOMException('Aborted', 'AbortError');
                }
                return { evolution: [] };
            },
            onCached: () => {},
            onFresh: () => {
                freshCalled = true;
            },
            onLoadingChange: () => {},
            onError: () => {
                errorCalled = true;
            }
        });

        assert.strictEqual(freshCalled, false);
        assert.strictEqual(errorCalled, false);
        assert.strictEqual(cache.get('evo_key'), null);
    });
});
