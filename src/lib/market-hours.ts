export type MarketSessionLabel = 'REGULAR' | 'PRE_MARKET' | 'AFTER_HOURS' | 'CLOSED_WEEKEND';

export interface MarketConfig {
    marketHoursAware: boolean;
    priceCacheTtlMs: number;
    offHoursPriceCacheTtlMs: number;
    metadataCacheTtlMs: number;
    historyCacheTtlMs: number;
    manualRefreshCooldownMs: number;
    incrementalBatchSize: number;
}

export interface MarketSessionInfo {
    isMarketOpen: boolean;
    sessionLabel: MarketSessionLabel;
    etWeekday: string;
    etMinutesSinceMidnight: number;
}

export interface EffectivePriceTtlResult extends MarketSessionInfo {
    ttlMs: number;
    marketHoursAware: boolean;
}

export const DEFAULT_PRICE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
export const DEFAULT_OFF_HOURS_PRICE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_METADATA_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
export const DEFAULT_HISTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_MANUAL_REFRESH_COOLDOWN_MS = 15 * 1000; // 15 seconds
export const DEFAULT_INCREMENTAL_BATCH_SIZE = 20;

const MARKET_OPEN_MINUTES_ET = 9 * 60 + 30; // 09:30 ET
const MARKET_CLOSE_MINUTES_ET = 16 * 60 + 15; // 16:15 ET (includes close settlement buffer)
const TRADING_WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function parsePositiveIntEnv(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return Math.min(Math.floor(parsed), max);
}

/**
 * Reads runtime-configurable freshness TTL, cooldown, and batch sizing settings from env vars.
 */
export function getMarketConfig(): MarketConfig {
    const awareRaw = (process.env.MARKET_HOURS_AWARE || 'true').trim().toLowerCase();
    const marketHoursAware = awareRaw !== 'false' && awareRaw !== '0' && awareRaw !== 'no';

    return {
        marketHoursAware,
        priceCacheTtlMs: parsePositiveIntEnv('PRICE_CACHE_TTL_MS', DEFAULT_PRICE_CACHE_TTL_MS, 0),
        offHoursPriceCacheTtlMs: parsePositiveIntEnv('OFF_HOURS_PRICE_CACHE_TTL_MS', DEFAULT_OFF_HOURS_PRICE_CACHE_TTL_MS, 0),
        metadataCacheTtlMs: parsePositiveIntEnv('METADATA_CACHE_TTL_MS', DEFAULT_METADATA_CACHE_TTL_MS, 0),
        historyCacheTtlMs: parsePositiveIntEnv('HISTORY_CACHE_TTL_MS', DEFAULT_HISTORY_CACHE_TTL_MS, 0),
        manualRefreshCooldownMs: parsePositiveIntEnv('MANUAL_REFRESH_COOLDOWN_MS', DEFAULT_MANUAL_REFRESH_COOLDOWN_MS, 0),
        incrementalBatchSize: parsePositiveIntEnv('INCREMENTAL_SYNC_BATCH_SIZE', DEFAULT_INCREMENTAL_BATCH_SIZE, 1, 50),
    };
}

/**
 * Evaluates North American equity market session status in America/New_York time.
 * Includes a 15-minute post-close buffer (09:30–16:15 ET) for settlement print stabilization.
 */
export function getMarketSessionInfo(now: Date = new Date()): MarketSessionInfo {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const etWeekday = parts.find((p) => p.type === 'weekday')?.value || 'Mon';
    const rawHour = Number(parts.find((p) => p.type === 'hour')?.value || '0');
    const hour = rawHour === 24 ? 0 : rawHour;
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || '0');
    const etMinutesSinceMidnight = hour * 60 + minute;

    if (!TRADING_WEEKDAYS.has(etWeekday)) {
        return {
            isMarketOpen: false,
            sessionLabel: 'CLOSED_WEEKEND',
            etWeekday,
            etMinutesSinceMidnight,
        };
    }

    if (etMinutesSinceMidnight < MARKET_OPEN_MINUTES_ET) {
        return {
            isMarketOpen: false,
            sessionLabel: 'PRE_MARKET',
            etWeekday,
            etMinutesSinceMidnight,
        };
    }

    if (etMinutesSinceMidnight > MARKET_CLOSE_MINUTES_ET) {
        return {
            isMarketOpen: false,
            sessionLabel: 'AFTER_HOURS',
            etWeekday,
            etMinutesSinceMidnight,
        };
    }

    return {
        isMarketOpen: true,
        sessionLabel: 'REGULAR',
        etWeekday,
        etMinutesSinceMidnight,
    };
}

export function isNorthAmericanMarketOpen(now: Date = new Date()): boolean {
    return getMarketSessionInfo(now).isMarketOpen;
}

/**
 * Returns the effective quote freshness threshold based on market-hours awareness and env overrides.
 */
export function getEffectivePriceTtlMs(now: Date = new Date()): EffectivePriceTtlResult {
    const config = getMarketConfig();
    const session = getMarketSessionInfo(now);

    const ttlMs = !config.marketHoursAware || session.isMarketOpen
        ? config.priceCacheTtlMs
        : config.offHoursPriceCacheTtlMs;

    return {
        ...session,
        ttlMs,
        marketHoursAware: config.marketHoursAware,
    };
}
