export interface CacheStore {
    get<T>(key: string, ttlOrOptions?: number | { ttlMs?: number }): T | null;
    set<T>(key: string, data: T): void;
}

export interface StaleWhileRevalidateOptions<T> {
    cache: CacheStore;
    cacheKey: string;
    ttlMs?: number;
    isValid: (value: unknown) => value is T;
    fetcher: (signal?: AbortSignal) => Promise<T>;
    signal?: AbortSignal;
    onCached: (cached: T) => void;
    onFresh: (fresh: T) => void;
    onLoadingChange: (loading: boolean) => void;
    onError?: (error: unknown, hasCached: boolean) => void;
}

/**
 * Loads data using a stale-while-revalidate strategy:
 * 1. Emits valid cached data immediately so the UI renders without delay.
 * 2. Always revalidates from the server in the background and updates both UI and cache.
 */
export async function fetchWithStaleWhileRevalidate<T>({
    cache,
    cacheKey,
    ttlMs,
    isValid,
    fetcher,
    signal,
    onCached,
    onFresh,
    onLoadingChange,
    onError,
}: StaleWhileRevalidateOptions<T>): Promise<void> {
    const cached = ttlMs !== undefined ? cache.get<T>(cacheKey, ttlMs) : cache.get<T>(cacheKey);
    const hasCached = isValid(cached);

    if (hasCached) {
        onCached(cached);
        onLoadingChange(false);
    } else {
        onLoadingChange(true);
    }

    try {
        const fresh = await fetcher(signal);
        if (signal?.aborted) return;
        if (isValid(fresh)) {
            onFresh(fresh);
            cache.set(cacheKey, fresh);
        }
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof Error && error.name === 'AbortError') return;
        if (!signal?.aborted) {
            onError?.(error, hasCached);
        }
    } finally {
        if (!signal?.aborted) {
            onLoadingChange(false);
        }
    }
}
