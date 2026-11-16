export const CURRENCY_CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_KEY_PREFIX = 'rate_v4_';

interface CachedRate {
    rate: number;
    timestamp: number;
}

export interface GetExchangeRateOptions {
    forceRefresh?: boolean;
}

const inFlightRequests = new Map<string, Promise<number | null>>();
let cacheGeneration = 0;

function normalizeCurrencyCode(code: string): string {
    return (code || '').trim().toUpperCase();
}

function buildCacheKey(from: string, to: string): string {
    return `${CACHE_KEY_PREFIX}${from}_${to}`;
}

function getStorageKeys(): string[] {
    if (typeof window === 'undefined') return [];
    try {
        const keys = new Set<string>(Object.keys(localStorage));
        if (typeof localStorage.length === 'number' && typeof localStorage.key === 'function') {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key) keys.add(key);
            }
        }
        return Array.from(keys);
    } catch {
        return [];
    }
}

export function invalidateCurrencyCache(from?: string, to?: string): void {
    cacheGeneration += 1;

    if (from && to) {
        const normFrom = normalizeCurrencyCode(from);
        const normTo = normalizeCurrencyCode(to);
        const cacheKey = buildCacheKey(normFrom, normTo);
        inFlightRequests.delete(cacheKey);
        inFlightRequests.delete(`force:${cacheKey}`);

        if (typeof window !== 'undefined') {
            try {
                localStorage.removeItem(cacheKey);
            } catch {
                // Ignore restricted storage errors
            }
        }
        return;
    }

    inFlightRequests.clear();
    if (typeof window === 'undefined') return;
    try {
        for (const key of getStorageKeys()) {
            if (key.startsWith(CACHE_KEY_PREFIX)) {
                localStorage.removeItem(key);
            }
        }
    } catch {
        // Ignore restricted storage errors
    }
}

export async function getExchangeRate(
    from: string,
    to: string,
    options?: GetExchangeRateOptions
): Promise<number | null> {
    const normFrom = normalizeCurrencyCode(from);
    const normTo = normalizeCurrencyCode(to);
    if (!normFrom || !normTo) return null;
    if (normFrom === normTo) return 1;

    const cacheKey = buildCacheKey(normFrom, normTo);
    const forceRefresh = Boolean(options?.forceRefresh);

    // Try to load from local cache unless forcing a refresh
    if (!forceRefresh && typeof window !== 'undefined') {
        try {
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const parsed = JSON.parse(cached) as Partial<CachedRate>;
                if (
                    typeof parsed?.rate === 'number' &&
                    Number.isFinite(parsed.rate) &&
                    parsed.rate > 0 &&
                    typeof parsed?.timestamp === 'number' &&
                    Date.now() - parsed.timestamp < CURRENCY_CACHE_DURATION_MS
                ) {
                    return parsed.rate;
                }
            }
        } catch (e) {
            console.error('Failed to parse cached rate', e);
        }
    }

    const flightKey = forceRefresh ? `force:${cacheKey}` : cacheKey;
    const existingFlight = inFlightRequests.get(flightKey);
    if (existingFlight) {
        return existingFlight;
    }

    const requestGeneration = cacheGeneration;

    let requestPromise: Promise<number | null> | null = null;
    const rawPromise = (async (): Promise<number | null> => {
        try {
            const url = `/api/exchange-rate`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: normFrom, to: normTo })
            });

            if (res && typeof (res as { ok?: unknown }).ok === 'boolean' && !(res as Response).ok) {
                return null;
            }

            const data = await res.json();
            const rateToCache =
                typeof data?.rate === 'number' && Number.isFinite(data.rate) && data.rate > 0
                    ? data.rate
                    : null;

            // Save to cache ONLY if valid and not invalidated while in flight
            if (typeof window !== 'undefined' && rateToCache !== null && requestGeneration === cacheGeneration) {
                try {
                    localStorage.setItem(cacheKey, JSON.stringify({
                        rate: rateToCache,
                        timestamp: Date.now()
                    }));
                } catch {
                    // Ignore storage quota or private-mode errors
                }
            }

            return rateToCache;
        } catch (error) {
            console.error(`Failed to fetch rate for ${normFrom} -> ${normTo}`, error);
            return null;
        }
    })();

    requestPromise = rawPromise.finally(() => {
        if (inFlightRequests.get(flightKey) === requestPromise) {
            inFlightRequests.delete(flightKey);
        }
    });

    inFlightRequests.set(flightKey, requestPromise);
    return requestPromise;
}
