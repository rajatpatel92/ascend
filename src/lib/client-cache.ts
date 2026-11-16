const CACHE_PREFIX = 'portfolio_cache_';
export const DEFAULT_CLIENT_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

interface CacheEntry<T> {
    timestamp: number;
    data: T;
    version: number;
}

export interface ClientCacheGetOptions {
    ttlMs?: number;
}

const CURRENT_VERSION = 2;

const PORTFOLIO_CACHE_PREFIXES = [
    'portfolio_summary_',
    'portfolio-history-',
    'comparison-',
    'evolution_',
    'analysis_',
];

const LEGACY_RAW_PREFIXES = [
    'portfolio_summary_',
    'analysis_',
];

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

export const ClientCache = {
    get: <T>(key: string, ttlOrOptions?: number | ClientCacheGetOptions): T | null => {
        if (typeof window === 'undefined') return null;
        try {
            const item = localStorage.getItem(CACHE_PREFIX + key);
            if (!item) return null;

            const entry: CacheEntry<T> = JSON.parse(item);

            // Version Check
            if (entry.version !== CURRENT_VERSION) {
                localStorage.removeItem(CACHE_PREFIX + key);
                return null;
            }

            const requestedTtl =
                typeof ttlOrOptions === 'number'
                    ? ttlOrOptions
                    : ttlOrOptions && typeof ttlOrOptions === 'object'
                        ? ttlOrOptions.ttlMs
                        : undefined;
            const ttlMs = requestedTtl !== undefined ? requestedTtl : DEFAULT_CLIENT_CACHE_TTL_MS;

            // TTL Check
            if (
                typeof entry.timestamp !== 'number' ||
                !Number.isFinite(entry.timestamp) ||
                typeof ttlMs !== 'number' ||
                !Number.isFinite(ttlMs) ||
                ttlMs <= 0 ||
                Date.now() - entry.timestamp > ttlMs
            ) {
                localStorage.removeItem(CACHE_PREFIX + key);
                return null;
            }

            return entry.data;
        } catch (e) {
            console.error('Cache Read Error', e);
            return null;
        }
    },

    set: <T>(key: string, data: T): void => {
        if (typeof window === 'undefined') return;
        const entry: CacheEntry<T> = {
            timestamp: Date.now(),
            data,
            version: CURRENT_VERSION
        };
        try {
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
        } catch (e) {
            // Handle QuotaExceeded
            if (e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
                console.warn('LocalStorage Quota Exceeded. Clearing old cache and retrying.');
                ClientCache.clear();
                try {
                    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
                } catch (retryError) {
                    console.error('Cache Write Error after clear', retryError);
                }
            } else {
                console.error('Cache Write Error', e);
            }
        }
    },

    generateKey: (base: string, params: Record<string, any>): string => {
        // Recursive stable stringify
        const stableStringify = (obj: any): string => {
            if (obj === null || typeof obj !== 'object') {
                return JSON.stringify(obj);
            }
            if (Array.isArray(obj)) {
                // Sort arrays primitives to ensure order independence for filters
                // For object arrays, simpler sort might be needed or just map-sort
                try {
                    const copy = [...obj].sort();
                    return '[' + copy.map(stableStringify).join(',') + ']';
                } catch {
                    return JSON.stringify(obj);
                }
            }
            // Sort object keys
            const keys = Object.keys(obj).sort();
            const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
            return '{' + parts.join(',') + '}';
        };

        const stableString = stableStringify(params);
        return `${base}_${btoa(stableString)}`;
    },

    invalidateByPrefix: (prefix: string): void => {
        if (typeof window === 'undefined' || !prefix) return;
        const fullPrefix = CACHE_PREFIX + prefix;
        try {
            for (const key of getStorageKeys()) {
                if (key.startsWith(fullPrefix)) {
                    localStorage.removeItem(key);
                }
            }
        } catch {
            // Ignore restricted storage errors
        }
    },

    clearPortfolioCaches: (): void => {
        if (typeof window === 'undefined') return;
        try {
            for (const key of getStorageKeys()) {
                if (PORTFOLIO_CACHE_PREFIXES.some(prefix => key.startsWith(CACHE_PREFIX + prefix))) {
                    localStorage.removeItem(key);
                } else if (LEGACY_RAW_PREFIXES.some(prefix => key.startsWith(prefix))) {
                    localStorage.removeItem(key);
                }
            }
        } catch {
            // Ignore restricted storage errors
        }
    },

    clear: (): void => {
        if (typeof window === 'undefined') return;
        try {
            for (const key of getStorageKeys()) {
                if (key.startsWith(CACHE_PREFIX)) {
                    localStorage.removeItem(key);
                }
            }
        } catch {
            // Ignore restricted storage errors
        }
    }
};
