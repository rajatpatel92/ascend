import test from 'node:test';
import assert from 'node:assert';

interface MockFetchResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}

const g = globalThis as Record<string, unknown>;

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

type StorageListener = (e: StorageEvent) => void;
const storageListeners = new Set<StorageListener>();

const windowMock = {
    addEventListener: (event: string, listener: StorageListener) => {
        if (event === 'storage') {
            storageListeners.add(listener);
        }
    },
    removeEventListener: (event: string, listener: StorageListener) => {
        if (event === 'storage') {
            storageListeners.delete(listener);
        }
    },
};

const channelInstances = new Set<MockBroadcastChannel>();

class MockBroadcastChannel {
    readonly name: string;
    onmessage: ((msg: MessageEvent) => void) | null = null;
    private closed = false;

    constructor(name: string) {
        this.name = name;
        channelInstances.add(this);
    }

    postMessage(data: unknown): void {
        if (this.closed) return;
        for (const peer of Array.from(channelInstances)) {
            if (peer !== this && peer.name === this.name && !peer.closed && peer.onmessage) {
                peer.onmessage({ data } as MessageEvent);
            }
        }
    }

    close(): void {
        this.closed = true;
        channelInstances.delete(this);
    }
}

let fetchCalls: { url: string; init?: RequestInit }[] = [];
let fetchHandler: (url: string, init?: RequestInit) => Promise<MockFetchResponse> = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
});

const fetchMock = async (url: string, init?: RequestInit): Promise<MockFetchResponse> => {
    fetchCalls.push({ url, init });
    return await fetchHandler(url, init);
};

g.localStorage = localStorageMock;
g.window = windowMock;
g.BroadcastChannel = MockBroadcastChannel;
g.fetch = fetchMock;

import {
    emitLiveSyncEvent,
    subscribeLiveSync,
    ensureMarketSyncConvergence,
    __resetLiveSyncForTests,
    type LiveSyncEvent,
} from './live-sync.ts';

function dispatchStorageEvent(key: string | null, newValue: string | null): void {
    const event = { key, newValue } as StorageEvent;
    for (const listener of Array.from(storageListeners)) {
        listener(event);
    }
}

function waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('live-sync event bus & convergence poller', async (t) => {
    t.beforeEach(() => {
        __resetLiveSyncForTests({ pollIntervalMs: 10, maxPollAttempts: 3 });
        localStorageMock.clear();
        storageListeners.clear();
        channelInstances.clear();
        fetchCalls = [];
        fetchHandler = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ marketDataVersion: 1, isRefreshing: false, staleSymbolCount: 0 }),
        });
    });

    t.afterEach(() => {
        __resetLiveSyncForTests();
    });

    await t.test('emitLiveSyncEvent clears caches selectively by event type and notifies local subscribers', () => {
        const events: LiveSyncEvent[] = [];
        const unsubscribe = subscribeLiveSync((evt) => events.push(evt));

        storage['portfolio_cache_portfolio_summary_1'] = 'summary';
        storage['portfolio_summary_legacy'] = 'legacy';
        storage['rate_v4_USD_CAD'] = JSON.stringify({ rate: 1.38, timestamp: Date.now() });
        storage['dashboard_filters'] = 'keep-me';

        // 1. SYNC_STATUS_CHANGED must preserve both portfolio and currency caches
        emitLiveSyncEvent('SYNC_STATUS_CHANGED', { isRefreshing: true });
        assert.ok(storage['portfolio_cache_portfolio_summary_1']);
        assert.ok(storage['portfolio_summary_legacy']);
        assert.ok(storage['rate_v4_USD_CAD']);
        assert.strictEqual(storage['dashboard_filters'], 'keep-me');

        // 2. PORTFOLIO_UPDATED / ACTIVITIES_CHANGED clears portfolio caches but preserves FX cache
        emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason: 'account-edit' });
        assert.strictEqual(storage['portfolio_cache_portfolio_summary_1'], undefined);
        assert.strictEqual(storage['portfolio_summary_legacy'], undefined);
        assert.ok(storage['rate_v4_USD_CAD']);
        assert.strictEqual(storage['dashboard_filters'], 'keep-me');

        // Re-populate portfolio cache and emit MARKET_SYNCED -> clears BOTH portfolio + FX caches
        storage['portfolio_cache_comparison-1Y'] = 'cmp';
        emitLiveSyncEvent('MARKET_SYNCED', { version: 42 });
        assert.strictEqual(storage['portfolio_cache_comparison-1Y'], undefined);
        assert.strictEqual(storage['rate_v4_USD_CAD'], undefined);
        assert.strictEqual(storage['dashboard_filters'], 'keep-me');

        assert.deepStrictEqual(
            events.map((e) => e.type),
            ['SYNC_STATUS_CHANGED', 'PORTFOLIO_UPDATED', 'MARKET_SYNCED']
        );
        unsubscribe();
    });

    await t.test('cross-tab delivery via BroadcastChannel & storage event deduplicates duplicates and ignores self-echo', () => {
        const received: LiveSyncEvent[] = [];
        const unsubscribe = subscribeLiveSync((evt) => received.push(evt));

        // 1. Local emit creates an event with TAB_INSTANCE_ID
        const selfEvent = emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason: 'local' });
        assert.strictEqual(received.length, 1);

        // Echoing the exact same sourceId via storage or BroadcastChannel must be ignored
        dispatchStorageEvent('ascend_sync_event_v1', JSON.stringify({ ...selfEvent, id: 'echo_diff_id' }));
        assert.strictEqual(received.length, 1);

        // 2. Remote tab broadcasts event via BroadcastChannel -> received + caches cleared
        storage['portfolio_cache_analysis_AAPL'] = 'cached';
        storage['rate_v4_USD_EUR'] = JSON.stringify({ rate: 0.9, timestamp: Date.now() });

        const remoteTab = new MockBroadcastChannel('ascend_sync_events');
        const remoteEvent: LiveSyncEvent = {
            id: 'remote_evt_1',
            sourceId: 'remote_tab_abc',
            type: 'MARKET_SYNCED',
            timestamp: Date.now(),
            version: 7,
            reason: 'remote-refresh',
        };
        remoteTab.postMessage(remoteEvent);
        assert.strictEqual(received.length, 2);
        assert.strictEqual(received[1].id, 'remote_evt_1');
        assert.strictEqual(storage['portfolio_cache_analysis_AAPL'], undefined);
        assert.strictEqual(storage['rate_v4_USD_EUR'], undefined);

        // 3. Same event mirrored via localStorage storage event is deduplicated by event id
        dispatchStorageEvent('ascend_sync_event_v1', JSON.stringify(remoteEvent));
        assert.strictEqual(received.length, 2);

        // 4. New event delivered solely via storage event fallback triggers once; malformed or unrelated keys ignored
        const remoteStorageOnly: LiveSyncEvent = {
            id: 'remote_evt_2',
            sourceId: 'remote_tab_abc',
            type: 'ACTIVITIES_CHANGED',
            timestamp: Date.now(),
        };
        dispatchStorageEvent('other_key', JSON.stringify(remoteStorageOnly));
        dispatchStorageEvent('ascend_sync_event_v1', '{bad json');
        dispatchStorageEvent('ascend_sync_event_v1', JSON.stringify(remoteStorageOnly));
        assert.strictEqual(received.length, 3);
        assert.strictEqual(received[2].id, 'remote_evt_2');

        remoteTab.close();
        unsubscribe();
    });

    await t.test('ensureMarketSyncConvergence ignores calls without listeners, fresh status, or active throttle window', async () => {
        // No listeners -> no fetch
        ensureMarketSyncConvergence({ currentVersion: 1, isRefreshing: true, staleCount: 2 });
        await waitMs(25);
        assert.strictEqual(fetchCalls.length, 0);

        const unsubscribe = subscribeLiveSync(() => {});

        // Fresh & not refreshing -> no fetch
        ensureMarketSyncConvergence({ currentVersion: 1, isRefreshing: false, staleCount: 0 });
        await waitMs(25);
        assert.strictEqual(fetchCalls.length, 0);

        // Not refreshing & throttled into the future -> no fetch
        ensureMarketSyncConvergence({
            currentVersion: 1,
            isRefreshing: false,
            staleCount: 3,
            throttledUntil: new Date(Date.now() + 60_000).toISOString(),
        });
        await waitMs(25);
        assert.strictEqual(fetchCalls.length, 0);

        unsubscribe();
    });

    await t.test('ensureMarketSyncConvergence emits MARKET_SYNCED and clears caches once marketDataVersion advances', async () => {
        const received: LiveSyncEvent[] = [];
        const unsubscribe = subscribeLiveSync((evt) => received.push(evt));

        storage['portfolio_cache_portfolio_summary_x'] = 'stale';
        storage['rate_v4_USD_CAD'] = JSON.stringify({ rate: 1.35, timestamp: Date.now() });

        let pollCount = 0;
        fetchHandler = async () => {
            pollCount++;
            if (pollCount === 1) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        marketDataVersion: 10,
                        isRefreshing: true,
                        staleSymbolCount: 2,
                    }),
                };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    marketDataVersion: 11,
                    isRefreshing: false,
                    staleSymbolCount: 0,
                }),
            };
        };

        ensureMarketSyncConvergence({ currentVersion: 10, isRefreshing: false, staleCount: 2 });
        await waitMs(45);

        assert.strictEqual(fetchCalls.length, 2);
        assert.strictEqual(fetchCalls[0].url, '/api/market-data/status');
        assert.strictEqual(fetchCalls[0].init?.cache, 'no-store');
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].type, 'MARKET_SYNCED');
        assert.strictEqual(received[0].version, 11);
        assert.strictEqual(storage['portfolio_cache_portfolio_summary_x'], undefined);
        assert.strictEqual(storage['rate_v4_USD_CAD'], undefined);

        unsubscribe();
    });

    await t.test('ensureMarketSyncConvergence emits SYNC_STATUS_CHANGED on no-write completion and enforces 30s noop cooldown', async (subT) => {
        subT.mock.timers.enable({
            apis: ['Date'],
            now: new Date('2026-07-15T15:00:00.000Z'),
        });

        try {
            const received: LiveSyncEvent[] = [];
            const unsubscribe = subscribeLiveSync((evt) => received.push(evt));
            storage['portfolio_cache_portfolio_summary_x'] = 'keep-me';

            let tick = 0;
            fetchHandler = async () => {
                tick++;
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        marketDataVersion: 5,
                        isRefreshing: tick === 1,
                        staleSymbolCount: 1,
                    }),
                };
            };

            ensureMarketSyncConvergence({ currentVersion: 5, isRefreshing: true, staleCount: 1 });
            await waitMs(45);

            assert.strictEqual(fetchCalls.length, 2);
            assert.strictEqual(received.length, 1);
            assert.strictEqual(received[0].type, 'SYNC_STATUS_CHANGED');
            assert.strictEqual(received[0].reason, 'completed-no-change');
            assert.strictEqual(received[0].isRefreshing, false);
            assert.strictEqual(storage['portfolio_cache_portfolio_summary_x'], 'keep-me');

            // Within 30s at same version -> non-refreshing stale call suppressed by cooldown
            ensureMarketSyncConvergence({ currentVersion: 5, isRefreshing: false, staleCount: 1 });
            await waitMs(25);
            assert.strictEqual(fetchCalls.length, 2);

            // Advancing Date past 30s lifts cooldown
            subT.mock.timers.tick(31_000);
            fetchHandler = async () => ({
                ok: true,
                status: 200,
                json: async () => ({
                    marketDataVersion: 6,
                    isRefreshing: false,
                    staleSymbolCount: 0,
                }),
            });

            ensureMarketSyncConvergence({ currentVersion: 5, isRefreshing: false, staleCount: 1 });
            await waitMs(25);
            assert.strictEqual(fetchCalls.length, 3);
            assert.strictEqual(received[1].type, 'MARKET_SYNCED');
            assert.strictEqual(received[1].version, 6);

            unsubscribe();
        } finally {
            subT.mock.timers.reset();
        }
    });

    await t.test('ensureMarketSyncConvergence normalizes numeric and string throttler.resetTime on rate limit', async () => {
        const received: LiveSyncEvent[] = [];
        const unsubscribe = subscribeLiveSync((evt) => received.push(evt));

        const resetMs = Date.UTC(2026, 6, 15, 16, 0, 0);
        fetchHandler = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                marketDataVersion: 2,
                isRefreshing: false,
                staleSymbolCount: 1,
                throttler: {
                    isRateLimited: true,
                    resetTime: resetMs,
                },
            }),
        });

        ensureMarketSyncConvergence({ currentVersion: 2, isRefreshing: false, staleCount: 1 });
        await waitMs(25);

        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].type, 'SYNC_STATUS_CHANGED');
        assert.strictEqual(received[0].reason, 'rate-limited');
        assert.strictEqual(received[0].throttledUntil, new Date(resetMs).toISOString());

        unsubscribe();
    });

    await t.test('ensureMarketSyncConvergence stops immediately on 401/403 auth errors', async () => {
        const received: LiveSyncEvent[] = [];
        const unsubscribe = subscribeLiveSync((evt) => received.push(evt));

        fetchHandler = async () => ({
            ok: false,
            status: 401,
            json: async () => ({ error: 'Unauthorized' }),
        });

        ensureMarketSyncConvergence({ currentVersion: 1, isRefreshing: true, staleCount: 1 });
        await waitMs(40);

        assert.strictEqual(fetchCalls.length, 1);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].type, 'SYNC_STATUS_CHANGED');
        assert.strictEqual(received[0].reason, 'auth-error');
        assert.strictEqual(received[0].isRefreshing, false);

        unsubscribe();
    });

    await t.test('ensureMarketSyncConvergence caps polling at maxPollAttempts and cleans up on unsubscribe', async () => {
        const received: LiveSyncEvent[] = [];
        const unsubscribe = subscribeLiveSync((evt) => received.push(evt));

        fetchHandler = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                marketDataVersion: 1,
                isRefreshing: true,
                staleSymbolCount: 1,
            }),
        });

        ensureMarketSyncConvergence({ currentVersion: 1, isRefreshing: true, staleCount: 1 });
        await waitMs(70);

        assert.strictEqual(fetchCalls.length, 3);
        assert.strictEqual(received.length, 1);
        assert.strictEqual(received[0].type, 'SYNC_STATUS_CHANGED');
        assert.strictEqual(received[0].reason, 'max-attempts');
        unsubscribe();

        // Verify unsubscribing cancels pending poll before it fires
        fetchCalls = [];
        __resetLiveSyncForTests({ pollIntervalMs: 30, maxPollAttempts: 3 });
        const unsub2 = subscribeLiveSync(() => {});
        ensureMarketSyncConvergence({ currentVersion: 1, isRefreshing: true, staleCount: 1 });
        unsub2();
        await waitMs(50);
        assert.strictEqual(fetchCalls.length, 0);

        // Verify an already in-flight poll tick is ignored if stopped by a cross-tab MARKET_SYNCED event
        __resetLiveSyncForTests({ pollIntervalMs: 5, maxPollAttempts: 3 });
        const postEvents: LiveSyncEvent[] = [];
        const unsub3 = subscribeLiveSync((evt) => postEvents.push(evt));
        let resolveInFlight!: (res: MockFetchResponse) => void;
        fetchHandler = () =>
            new Promise<MockFetchResponse>((resolve) => {
                resolveInFlight = resolve;
            });

        ensureMarketSyncConvergence({ currentVersion: 10, isRefreshing: true, staleCount: 1 });
        await waitMs(15);
        assert.strictEqual(fetchCalls.length, 1);

        // Remote tab finishes sync while status fetch is still in flight
        const remote = new MockBroadcastChannel('ascend_sync_events');
        remote.postMessage({
            id: 'remote_supersede_1',
            sourceId: 'remote_peer_tab',
            type: 'MARKET_SYNCED',
            timestamp: Date.now(),
            version: 11,
        });
        assert.strictEqual(postEvents.length, 1);
        assert.strictEqual(postEvents[0].type, 'MARKET_SYNCED');

        // Resolve stale in-flight poll -> must NOT emit a trailing SYNC_STATUS_CHANGED
        resolveInFlight({
            ok: true,
            status: 200,
            json: async () => ({
                marketDataVersion: 11,
                isRefreshing: false,
                staleSymbolCount: 0,
            }),
        });
        await waitMs(20);
        assert.strictEqual(postEvents.length, 1);

        remote.close();
        unsub3();
    });
});
