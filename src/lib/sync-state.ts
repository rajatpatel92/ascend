import { getMarketConfig } from './market-hours.ts';

export interface ThrottlerStatusSnapshot {
    isRateLimited: boolean;
    resetTime: string | null;
    queueLength: number;
    activeCount: number;
}

export interface SyncStatsSnapshot {
    total: number;
    success: number;
    failed: number;
}

export type BackgroundPriceRunner = (symbols: string[]) => Promise<number>;

export interface GlobalSyncState {
    isIncrementalRunning: boolean;
    isFullSyncRunning: boolean;
    lastIncrementalSyncAt: Date | null;
    lastFullSyncAt: Date | null;
    lastSyncError: string | null;
    lastIncrementalStats: SyncStatsSnapshot | null;
    lastFullSyncStats: SyncStatsSnapshot | null;
    incrementalScopeCooldowns: Map<string, { syncedAt: Date; stats: SyncStatsSnapshot }>;
    throttlerStatus: ThrottlerStatusSnapshot;
    pendingBackgroundSymbols: Set<string>;
    backgroundBatchTimer: ReturnType<typeof setTimeout> | null;
    backgroundRunner: BackgroundPriceRunner | null;
    backgroundInFlightPromise: Promise<void> | null;
}

interface GlobalSyncContainer {
    __ascendSyncState?: GlobalSyncState;
}

const BACKGROUND_COALESCE_WINDOW_MS = 50;

export function getSyncState(): GlobalSyncState {
    const g = globalThis as unknown as GlobalSyncContainer;
    if (!g.__ascendSyncState) {
        g.__ascendSyncState = {
            isIncrementalRunning: false,
            isFullSyncRunning: false,
            lastIncrementalSyncAt: null,
            lastFullSyncAt: null,
            lastSyncError: null,
            lastIncrementalStats: null,
            lastFullSyncStats: null,
            incrementalScopeCooldowns: new Map(),
            throttlerStatus: {
                isRateLimited: false,
                resetTime: null,
                queueLength: 0,
                activeCount: 0,
            },
            pendingBackgroundSymbols: new Set<string>(),
            backgroundBatchTimer: null,
            backgroundRunner: null,
            backgroundInFlightPromise: null,
        };
    }
    return g.__ascendSyncState;
}

export function isSyncActive(): boolean {
    const state = getSyncState();
    return (
        state.isIncrementalRunning ||
        state.isFullSyncRunning ||
        state.pendingBackgroundSymbols.size > 0 ||
        state.backgroundInFlightPromise !== null
    );
}

export function setThrottlerSnapshot(status: ThrottlerStatusSnapshot): void {
    const state = getSyncState();
    state.throttlerStatus = { ...status };
}

export function getThrottlerSnapshot(): ThrottlerStatusSnapshot {
    return { ...getSyncState().throttlerStatus };
}

export function registerBackgroundPriceRunner(runner: BackgroundPriceRunner): void {
    getSyncState().backgroundRunner = runner;
}

/**
 * Drains queued background symbols in chunked batches through the registered price runner.
 * Overlapping flushes chain onto the active promise so identical requests coalesce cleanly.
 */
export async function flushBackgroundPriceSync(): Promise<void> {
    const state = getSyncState();

    if (state.backgroundBatchTimer) {
        clearTimeout(state.backgroundBatchTimer);
        state.backgroundBatchTimer = null;
    }

    if (state.backgroundInFlightPromise) {
        await state.backgroundInFlightPromise;
        if (state.pendingBackgroundSymbols.size === 0) {
            return;
        }
    }

    const drainLoop = async () => {
        const config = getMarketConfig();
        const batchSize = Math.max(1, config.incrementalBatchSize);
        let anyError = false;

        while (state.pendingBackgroundSymbols.size > 0) {
            const runner = state.backgroundRunner;
            if (!runner) {
                state.pendingBackgroundSymbols.clear();
                return;
            }

            const symbols = Array.from(state.pendingBackgroundSymbols);
            state.pendingBackgroundSymbols.clear();

            for (let i = 0; i < symbols.length; i += batchSize) {
                const chunk = symbols.slice(i, i + batchSize);
                try {
                    await runner(chunk);
                } catch (err) {
                    anyError = true;
                    const msg = err instanceof Error ? err.message : String(err || 'Background sync failed');
                    state.lastSyncError = msg;
                }
            }
        }

        if (!anyError) {
            state.lastSyncError = null;
        }
    };

    const run = drainLoop().finally(() => {
        if (state.backgroundInFlightPromise === run) {
            state.backgroundInFlightPromise = null;
        }
    });

    state.backgroundInFlightPromise = run;
    await run;
}

/**
 * Schedules symbols for coalesced non-blocking background price refresh.
 * Multiple concurrent callers (e.g. mobile + laptop dashboard opens) collapse into a single bulk batch.
 */
export function enqueueBackgroundPriceSync(symbols: string[]): void {
    const state = getSyncState();
    let added = false;

    for (const raw of symbols) {
        const sym = typeof raw === 'string' ? raw.trim() : '';
        if (sym) {
            state.pendingBackgroundSymbols.add(sym);
            added = true;
        }
    }

    if (!added || state.backgroundBatchTimer) return;

    const timer = setTimeout(() => {
        state.backgroundBatchTimer = null;
        void flushBackgroundPriceSync();
    }, BACKGROUND_COALESCE_WINDOW_MS);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }
    state.backgroundBatchTimer = timer;
}

export function resetSyncStateForTests(): void {
    const state = getSyncState();
    if (state.backgroundBatchTimer) {
        clearTimeout(state.backgroundBatchTimer);
        state.backgroundBatchTimer = null;
    }
    state.isIncrementalRunning = false;
    state.isFullSyncRunning = false;
    state.lastIncrementalSyncAt = null;
    state.lastFullSyncAt = null;
    state.lastSyncError = null;
    state.lastIncrementalStats = null;
    state.lastFullSyncStats = null;
    if (state.incrementalScopeCooldowns instanceof Map) {
        state.incrementalScopeCooldowns.clear();
    } else {
        state.incrementalScopeCooldowns = new Map();
    }
    state.pendingBackgroundSymbols.clear();
    state.backgroundInFlightPromise = null;
    state.throttlerStatus = {
        isRateLimited: false,
        resetTime: null,
        queueLength: 0,
        activeCount: 0,
    };
}
