import { ClientCache } from './client-cache.ts';
import { invalidateCurrencyCache } from './currencyCache.ts';

export type LiveSyncEventType =
    | 'MARKET_SYNCED'
    | 'PORTFOLIO_UPDATED'
    | 'ACTIVITIES_CHANGED'
    | 'SYNC_STATUS_CHANGED';

export interface LiveSyncEvent {
    id: string;
    sourceId: string;
    type: LiveSyncEventType;
    timestamp: number;
    version?: number;
    reason?: string;
    isRefreshing?: boolean;
    throttledUntil?: string | null;
}

export interface MarketSyncConvergenceInput {
    currentVersion?: number;
    isRefreshing?: boolean;
    staleCount?: number;
    throttledUntil?: string | null;
}

interface MarketStatusPollPayload {
    marketDataVersion?: number;
    isRefreshing?: boolean;
    staleSymbolCount?: number;
    throttler?: {
        isRateLimited?: boolean;
        resetTime?: string | number | null;
    };
}

const CHANNEL_NAME = 'ascend_sync_events';
const STORAGE_EVENT_KEY = 'ascend_sync_event_v1';
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 15;
const DEFAULT_NOOP_COOLDOWN_MS = 30_000;
const MAX_SEEN_EVENT_IDS = 200;

const TAB_INSTANCE_ID = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

type LiveSyncListener = (event: LiveSyncEvent) => void;

const listeners = new Set<LiveSyncListener>();
const seenEventIds: string[] = [];
const seenEventSet = new Set<string>();

let channel: BroadcastChannel | null = null;
let transportInitialized = false;

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollInFlight = false;
let pollEpoch = 0;
let pollAttempts = 0;
let trackedBaselineVersion: number | undefined;
let sawRefreshing = false;

let lastNoopVersion: number | undefined;
let lastNoopCompletedAt = 0;

let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
let maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS;

function recordSeenEvent(id: string): boolean {
    if (seenEventSet.has(id)) return false;
    seenEventSet.add(id);
    seenEventIds.push(id);
    if (seenEventIds.length > MAX_SEEN_EVENT_IDS) {
        const evicted = seenEventIds.shift();
        if (evicted) seenEventSet.delete(evicted);
    }
    return true;
}

function clearCachesForEvent(type: LiveSyncEventType): void {
    if (type === 'SYNC_STATUS_CHANGED') return;
    ClientCache.clearPortfolioCaches();
    if (type === 'MARKET_SYNCED') {
        invalidateCurrencyCache();
    }
}

function notifyListeners(event: LiveSyncEvent): void {
    for (const listener of Array.from(listeners)) {
        try {
            listener(event);
        } catch (err) {
            console.error('[LiveSync] Listener failed:', err);
        }
    }
}

function recordNoopConvergence(version?: number): void {
    const resolvedVersion = typeof version === 'number' ? version : trackedBaselineVersion;
    if (typeof resolvedVersion === 'number') {
        lastNoopVersion = resolvedVersion;
    }
    lastNoopCompletedAt = Date.now();
}

function resetNoopCooldown(): void {
    lastNoopVersion = undefined;
    lastNoopCompletedAt = 0;
}

function handleIncomingEvent(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const candidate = raw as Partial<LiveSyncEvent>;
    if (
        typeof candidate.id !== 'string' ||
        typeof candidate.sourceId !== 'string' ||
        typeof candidate.type !== 'string' ||
        typeof candidate.timestamp !== 'number'
    ) {
        return;
    }

    if (candidate.sourceId === TAB_INSTANCE_ID) return;
    if (!recordSeenEvent(candidate.id)) return;

    const event: LiveSyncEvent = {
        id: candidate.id,
        sourceId: candidate.sourceId,
        type: candidate.type as LiveSyncEventType,
        timestamp: candidate.timestamp,
        version: typeof candidate.version === 'number' ? candidate.version : undefined,
        reason: typeof candidate.reason === 'string' ? candidate.reason : undefined,
        isRefreshing: typeof candidate.isRefreshing === 'boolean' ? candidate.isRefreshing : undefined,
        throttledUntil:
            typeof candidate.throttledUntil === 'string' || candidate.throttledUntil === null
                ? candidate.throttledUntil
                : undefined,
    };

    if (event.type === 'MARKET_SYNCED') {
        resetNoopCooldown();
        stopConvergencePoller();
    } else if (event.type === 'SYNC_STATUS_CHANGED' && event.isRefreshing === false) {
        recordNoopConvergence(event.version);
        stopConvergencePoller();
    }

    clearCachesForEvent(event.type);
    notifyListeners(event);
}

function handleStorageEvent(e: StorageEvent): void {
    if (e.key !== STORAGE_EVENT_KEY || !e.newValue) return;
    try {
        handleIncomingEvent(JSON.parse(e.newValue));
    } catch {
        // Ignore malformed storage payload
    }
}

function ensureTransportInitialized(): void {
    if (transportInitialized || typeof window === 'undefined') return;
    transportInitialized = true;

    if (typeof BroadcastChannel !== 'undefined') {
        try {
            channel = new BroadcastChannel(CHANNEL_NAME);
            channel.onmessage = (msg: MessageEvent) => {
                handleIncomingEvent(msg.data);
            };
        } catch {
            channel = null;
        }
    }

    if (typeof window.addEventListener === 'function') {
        window.addEventListener('storage', handleStorageEvent);
    }
}

function stopConvergencePoller(): void {
    pollEpoch += 1;
    if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    pollAttempts = 0;
    sawRefreshing = false;
    trackedBaselineVersion = undefined;
}

function scheduleNextPoll(): void {
    if (pollTimer !== null || typeof window === 'undefined') return;
    if (listeners.size === 0) {
        stopConvergencePoller();
        return;
    }
    if (pollAttempts >= maxPollAttempts) {
        const version = trackedBaselineVersion;
        recordNoopConvergence(version);
        stopConvergencePoller();
        emitLiveSyncEvent('SYNC_STATUS_CHANGED', {
            version,
            reason: 'max-attempts',
            isRefreshing: false,
        });
        return;
    }

    pollTimer = setTimeout(() => {
        pollTimer = null;
        void runConvergencePollTick();
    }, pollIntervalMs);
}

async function runConvergencePollTick(): Promise<void> {
    if (pollInFlight || typeof window === 'undefined' || typeof fetch !== 'function') {
        return;
    }
    if (listeners.size === 0 || pollAttempts >= maxPollAttempts) {
        stopConvergencePoller();
        return;
    }

    const tickEpoch = pollEpoch;
    pollInFlight = true;
    pollAttempts += 1;

    try {
        const res = await fetch('/api/market-data/status', { cache: 'no-store' });
        if (tickEpoch !== pollEpoch || listeners.size === 0) {
            return;
        }
        if (!res.ok) {
            // Auth errors or hard rejections should stop background polling immediately
            if (res.status === 401 || res.status === 403) {
                const version = trackedBaselineVersion;
                stopConvergencePoller();
                emitLiveSyncEvent('SYNC_STATUS_CHANGED', {
                    version,
                    reason: 'auth-error',
                    isRefreshing: false,
                });
                return;
            }
            if (pollAttempts < maxPollAttempts && listeners.size > 0) {
                scheduleNextPoll();
            } else {
                const version = trackedBaselineVersion;
                recordNoopConvergence(version);
                stopConvergencePoller();
                emitLiveSyncEvent('SYNC_STATUS_CHANGED', {
                    version,
                    reason: 'http-error',
                    isRefreshing: false,
                });
            }
            return;
        }

        const status = (await res.json()) as MarketStatusPollPayload;
        if (tickEpoch !== pollEpoch || listeners.size === 0) {
            return;
        }
        const remoteVersion = typeof status.marketDataVersion === 'number' ? status.marketDataVersion : undefined;
        const remoteRefreshing = Boolean(status.isRefreshing);
        const staleCount = typeof status.staleSymbolCount === 'number' ? status.staleSymbolCount : 0;
        const rawResetTime = status.throttler?.resetTime;
        const throttledUntil =
            status.throttler?.isRateLimited && rawResetTime != null
                ? typeof rawResetTime === 'number'
                    ? new Date(rawResetTime).toISOString()
                    : rawResetTime
                : null;

        if (remoteRefreshing) {
            sawRefreshing = true;
        }

        if (trackedBaselineVersion === undefined && typeof remoteVersion === 'number') {
            trackedBaselineVersion = remoteVersion;
        }

        const versionAdvanced =
            typeof trackedBaselineVersion === 'number' &&
            typeof remoteVersion === 'number' &&
            remoteVersion > trackedBaselineVersion;

        if (versionAdvanced) {
            resetNoopCooldown();
            stopConvergencePoller();
            emitLiveSyncEvent('MARKET_SYNCED', {
                version: remoteVersion,
                reason: 'convergence-poll',
                isRefreshing: false,
            });
            return;
        }

        const completedWithoutWrite =
            (sawRefreshing && !remoteRefreshing) ||
            (!remoteRefreshing && staleCount === 0) ||
            (!remoteRefreshing && Boolean(status.throttler?.isRateLimited));

        if (completedWithoutWrite) {
            recordNoopConvergence(remoteVersion);
            stopConvergencePoller();
            emitLiveSyncEvent('SYNC_STATUS_CHANGED', {
                version: remoteVersion,
                reason: status.throttler?.isRateLimited ? 'rate-limited' : 'completed-no-change',
                isRefreshing: false,
                throttledUntil,
            });
            return;
        }

        if (pollAttempts < maxPollAttempts && listeners.size > 0) {
            scheduleNextPoll();
        } else {
            recordNoopConvergence(remoteVersion);
            stopConvergencePoller();
            emitLiveSyncEvent('SYNC_STATUS_CHANGED', {
                version: remoteVersion,
                reason: 'max-attempts',
                isRefreshing: false,
                throttledUntil,
            });
        }
    } catch {
        if (tickEpoch !== pollEpoch || listeners.size === 0) {
            return;
        }
        if (pollAttempts < maxPollAttempts && listeners.size > 0) {
            scheduleNextPoll();
        } else {
            const version = trackedBaselineVersion;
            recordNoopConvergence(version);
            stopConvergencePoller();
            emitLiveSyncEvent('SYNC_STATUS_CHANGED', {
                version,
                reason: 'network-error',
                isRefreshing: false,
            });
        }
    } finally {
        pollInFlight = false;
    }
}

/**
 * Broadcasts a state change across the active tab and any other open tabs,
 * immediately invalidating stale localStorage caches before subscribers re-fetch.
 */
export function emitLiveSyncEvent(
    type: LiveSyncEventType,
    payload?: {
        version?: number;
        reason?: string;
        isRefreshing?: boolean;
        throttledUntil?: string | null;
    }
): LiveSyncEvent {
    ensureTransportInitialized();
    clearCachesForEvent(type);

    if (type !== 'SYNC_STATUS_CHANGED') {
        resetNoopCooldown();
    }

    const event: LiveSyncEvent = {
        id: `${TAB_INSTANCE_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sourceId: TAB_INSTANCE_ID,
        type,
        timestamp: Date.now(),
        version: payload?.version,
        reason: payload?.reason,
        isRefreshing: payload?.isRefreshing,
        throttledUntil: payload?.throttledUntil,
    };

    recordSeenEvent(event.id);
    notifyListeners(event);

    if (typeof window !== 'undefined') {
        if (channel) {
            try {
                channel.postMessage(event);
            } catch {
                // Fallback handled via storage event below
            }
        }
        try {
            localStorage.setItem(STORAGE_EVENT_KEY, JSON.stringify(event));
        } catch {
            // Ignore private-mode or storage quota errors
        }
    }

    return event;
}

/**
 * Subscribes a UI component or context to live sync and mutation events.
 */
export function subscribeLiveSync(listener: LiveSyncListener): () => void {
    ensureTransportInitialized();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            stopConvergencePoller();
        }
    };
}

/**
 * Coordinates a single shared background status poller per tab whenever an API response
 * reports active background refreshing or stale symbols that are being updated via SWR.
 */
export function ensureMarketSyncConvergence(input: MarketSyncConvergenceInput): void {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return;
    if (listeners.size === 0) return;

    const isRefreshing = Boolean(input.isRefreshing);
    const staleCount = input.staleCount ?? 0;
    if (!isRefreshing && staleCount <= 0) return;

    const throttledMs = input.throttledUntil ? Date.parse(input.throttledUntil) : NaN;
    if (!isRefreshing && Number.isFinite(throttledMs) && throttledMs > Date.now()) {
        return;
    }

    const inNoopCooldown =
        lastNoopCompletedAt > 0 &&
        Date.now() - lastNoopCompletedAt < DEFAULT_NOOP_COOLDOWN_MS &&
        (typeof input.currentVersion !== 'number' ||
            (typeof lastNoopVersion === 'number' && input.currentVersion <= lastNoopVersion));
    if (inNoopCooldown && !isRefreshing) {
        return;
    }

    if (isRefreshing) {
        sawRefreshing = true;
    }

    if (typeof input.currentVersion === 'number') {
        trackedBaselineVersion =
            trackedBaselineVersion === undefined
                ? input.currentVersion
                : Math.max(trackedBaselineVersion, input.currentVersion);
    }

    if (pollTimer === null && !pollInFlight) {
        pollAttempts = 0;
        scheduleNextPoll();
    }
}

export function __resetLiveSyncForTests(options?: {
    pollIntervalMs?: number;
    maxPollAttempts?: number;
}): void {
    stopConvergencePoller();
    resetNoopCooldown();
    pollInFlight = false;
    listeners.clear();
    seenEventIds.length = 0;
    seenEventSet.clear();

    if (channel) {
        try {
            channel.close();
        } catch {
            // Ignore close errors
        }
        channel = null;
    }
    if (transportInitialized && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        window.removeEventListener('storage', handleStorageEvent);
    }
    transportInitialized = false;

    pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    maxPollAttempts = options?.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;
}
