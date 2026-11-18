/* eslint-disable @typescript-eslint/no-explicit-any */
import YahooFinance from 'yahoo-finance2';
import { prisma } from './prisma.ts';
import { analyzeDividendHistory, type DividendEventPoint } from './dividend-estimator.ts';
import { getEffectivePriceTtlMs, getMarketConfig } from './market-hours.ts';
import { invalidateMarketCaches } from './cache-invalidation.ts';
import {
    enqueueBackgroundPriceSync,
    registerBackgroundPriceRunner,
    setThrottlerSnapshot,
    type ThrottlerStatusSnapshot,
} from './sync-state.ts';
import { resolveIssuerAllocations } from './issuers/index.ts';

export const yahooFinance = new YahooFinance({
    suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

// Throttler to prevent 429 Errors
export class Throttler {
    private queue: Array<{ fn: () => Promise<any>, resolve: (v: any) => void, reject: (e: any) => void }> = [];
    private activeCount = 0;
    private isRateLimited = false;
    private resetTime: Date | null = null;
    private maxConcurrent: number;
    private delayMs: number;
    private publishGlobal: boolean;

    constructor(maxConcurrent: number, delayMs: number, publishGlobal = false) {
        this.maxConcurrent = maxConcurrent;
        this.delayMs = delayMs;
        this.publishGlobal = publishGlobal;
    }

    getStatus(): ThrottlerStatusSnapshot {
        return {
            isRateLimited: this.isRateLimited,
            resetTime: this.resetTime ? this.resetTime.toISOString() : null,
            queueLength: this.queue.length,
            activeCount: this.activeCount,
        };
    }

    private publishStatus() {
        if (this.publishGlobal) {
            setThrottlerSnapshot(this.getStatus());
        }
    }

    reset() {
        this.queue = [];
        this.activeCount = 0;
        this.isRateLimited = false;
        this.resetTime = null;
        this.publishStatus();
    }

    add<T>(fn: () => Promise<T>): Promise<T> {
        if (this.isRateLimited) {
            const remaining = this.resetTime ? Math.ceil((this.resetTime.getTime() - Date.now()) / 1000) : 60;
            this.publishStatus();
            return Promise.reject(new Error(`Rate limit exceeded. Cooling down for ${remaining}s.`));
        }

        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.publishStatus();
            this.process();
        });
    }

    private process() {
        if (this.isRateLimited || this.activeCount >= this.maxConcurrent) return;

        const item = this.queue.shift();
        if (!item) {
            this.publishStatus();
            return;
        }

        this.activeCount++;
        this.publishStatus();

        Promise.resolve()
            .then(() => item.fn())
            .then(item.resolve)
            .catch((error: any) => {
                // Check for 429
                // Log the keys to help debugging if this fails again
                console.error('[THROTTLER ERROR]', JSON.stringify({ message: error.message, code: error.code, name: error.name }));

                if (
                    error.message?.includes('429') ||
                    error.message?.includes('Too Many Requests') ||
                    error.response?.status === 429 ||
                    error.status === 429 ||
                    error.code === 429 || // Yahoo Finance library often puts it here
                    (error.name === 'HTTPError' && error.message === 'Too Many Requests')
                ) {
                    this.triggerCircuitBreaker();
                }
                item.reject(error);
            })
            .finally(() => {
                const timer = setTimeout(() => {
                    this.activeCount = Math.max(0, this.activeCount - 1);
                    this.publishStatus();
                    this.process();
                }, this.delayMs);
                if (typeof timer.unref === 'function') {
                    timer.unref();
                }
            });
    }

    private triggerCircuitBreaker() {
        if (this.isRateLimited) return;

        console.error(' [THROTTLER] 429 DETECTED! Triggering Circuit Breaker for 60 seconds.');
        this.isRateLimited = true;
        this.resetTime = new Date(Date.now() + 60000); // 1 minute

        // Better to reject all pending to give immediate feedback to UI
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            item?.reject(new Error('Circuit Breaker: Rate limit exceeded. Request cancelled.'));
        }
        this.publishStatus();

        const timer = setTimeout(() => {
            console.log(' [THROTTLER] Circuit Breaker Reset. Resuming requests.');
            this.isRateLimited = false;
            this.resetTime = null;
            this.publishStatus();
            this.process();
        }, 60000);
        if (timer.unref) timer.unref();
    }
}

// Global instance: 5 concurrent requests, 300ms delay between completions
export const apiThrottler = new Throttler(5, 300, true);

export interface DividendEstimateDetails {
    nextDate?: Date;
    nextAmount?: number;
    trailingAnnualRate?: number;
}

export interface GetPriceOptions {
    forceRefresh?: boolean;
    mode?: 'swr' | 'blocking';
    includeMetadata?: boolean;
}

function getInFlightMap<T>(key: string): Map<string, Promise<T>> {
    const g = globalThis as Record<string, unknown>;
    if (!(g[key] instanceof Map)) {
        g[key] = new Map<string, Promise<T>>();
    }
    return g[key] as Map<string, Promise<T>>;
}

function firstPositive(...values: unknown[]): number | undefined {
    for (const val of values) {
        if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
            return val;
        }
    }
    return undefined;
}

function shouldEstimateDividends(symbol: string, quoteType?: string): boolean {
    if (!symbol || symbol.endsWith('=X') || symbol.startsWith('^')) return false;
    if (quoteType && ['CURRENCY', 'CRYPTOCURRENCY', 'INDEX'].includes(quoteType.toUpperCase())) {
        return false;
    }
    return true;
}

function isFundLikeAsset(quoteType?: string, profileCountry?: string, name?: string): boolean {
    const upperQuoteType = typeof quoteType === 'string' ? quoteType.toUpperCase() : '';
    if (upperQuoteType === 'ETF' || upperQuoteType === 'MUTUALFUND') {
        return true;
    }
    if (upperQuoteType && upperQuoteType !== 'ETF' && upperQuoteType !== 'MUTUALFUND') {
        return false;
    }
    return !profileCountry && Boolean(name && /\b(etf|ishares)\b/i.test(name));
}

function parseOptionalMarketDate(raw: unknown): Date | undefined {
    if (raw === null || raw === undefined || raw === '') return undefined;
    if (raw instanceof Date) {
        return Number.isNaN(raw.getTime()) ? undefined : raw;
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        // # Reason: With validateResult: false, Yahoo Finance returns epoch seconds (~1e9-1e10);
        // values >= 1e12 are already milliseconds.
        const ms = raw < 1e12 ? raw * 1000 : raw;
        const parsed = new Date(ms);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return undefined;
        if (/^\d+(\.\d+)?$/.test(trimmed)) {
            const numeric = Number(trimmed);
            if (Number.isFinite(numeric) && numeric > 0) {
                const ms = numeric < 1e12 ? numeric * 1000 : numeric;
                const parsed = new Date(ms);
                return Number.isNaN(parsed.getTime()) ? undefined : parsed;
            }
        }
        const parsed = new Date(trimmed);
        return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    }
    return undefined;
}

function parseMarketTime(raw: unknown, fallback: Date): Date {
    return parseOptionalMarketDate(raw) ?? fallback;
}

function mapCachedRowToMarketData(cached: any): MarketData {
    return {
        symbol: cached.symbol,
        price: cached.price,
        currency: cached.currency,
        regularMarketTime: cached.marketTime || cached.lastUpdated,
        regularMarketChange: cached.change,
        regularMarketChangePercent: cached.changePercent,
        sector: cached.sector || undefined,
        country: cached.country || undefined,
        sectorAllocations: cached.sectorAllocations as any[],
        countryAllocations: cached.countryAllocations as any[],
        dividendRate: cached.dividendRate || undefined,
        dividendYield: cached.dividendYield || undefined,
        exDividendDate: cached.exDividendDate || undefined,
        estNextDividendAmount: cached.estNextDividendAmount || undefined,
    };
}

// Helper to analyze trailing 12M dividend history and estimate next payout
export async function estimateDividendDetails(
    symbol: string,
    options: { rollForwardTo?: Date } = {}
): Promise<DividendEstimateDetails | undefined> {
    try {
        const endDate = options.rollForwardTo ? new Date(Math.max(Date.now(), options.rollForwardTo.getTime())) : new Date();
        const startDate = new Date(endDate);
        startDate.setFullYear(endDate.getFullYear() - 1); // Last 12 months

        let rawEvents: DividendEventPoint[] = [];

        try {
            const chartResult = await apiThrottler.add(() => yahooFinance.chart(symbol, {
                period1: startDate,
                period2: endDate,
                interval: '1d',
                events: 'div'
            })) as any;

            const chartDividends = chartResult?.events?.dividends;
            if (Array.isArray(chartDividends) && chartDividends.length > 0) {
                rawEvents = chartDividends.map((d: any) => ({
                    date: d?.date,
                    perShareAmount: Number(d?.amount)
                }));
            }
        } catch {
            // Fallback to historical() below if chart dividend feed fails
        }

        if (rawEvents.length === 0) {
            const events = await apiThrottler.add(() => yahooFinance.historical(symbol, {
                period1: startDate,
                period2: endDate,
                events: 'dividends'
            }));

            if (Array.isArray(events) && events.length > 0) {
                rawEvents = events.map((e: any) => ({
                    date: e?.date,
                    perShareAmount: Number(e?.dividends)
                }));
            }
        }

        if (rawEvents.length === 0) return undefined;

        const analyzed = analyzeDividendHistory(
            rawEvents,
            options.rollForwardTo
                ? { now: options.rollForwardTo, rollForward: true }
                : {}
        );
        if (!analyzed) return undefined;

        return {
            nextDate: analyzed.nextDate,
            nextAmount: analyzed.nextAmount,
            trailingAnnualRate: analyzed.trailingAnnualRate
        };
    } catch {
        return undefined;
    }
}

// Helper to estimate next dividend
export async function estimateNextDividend(symbol: string): Promise<{ date: Date, amount: number } | undefined> {
    const details = await estimateDividendDetails(symbol);
    if (!details?.nextDate || details.nextAmount === undefined) return undefined;
    return {
        date: details.nextDate,
        amount: details.nextAmount
    };
}

export interface StockSearchResult {
    symbol: string;
    name: string;
    exchange: string;
    type: string;
}

export interface MarketData {
    symbol: string;
    price: number;
    currency: string;
    regularMarketTime: Date;
    regularMarketChange: number;
    regularMarketChangePercent: number;
    sector?: string;
    country?: string;
    fiftyTwoWeekHigh?: number;
    fiftyTwoWeekLow?: number;
    sectorAllocations?: any[];
    countryAllocations?: any[];
    dividendRate?: number;
    dividendYield?: number;
    exDividendDate?: Date;
    estNextDividendAmount?: number;
    name?: string;
}

export class MarketDataService {
    /**
     * Search for symbols (stocks, ETFs, etc.)
     */
    static async searchSymbols(query: string): Promise<StockSearchResult[]> {
        try {
            // Simplify query options to reduce chance of 400 errors
            const results = await apiThrottler.add(() => yahooFinance.search(query, {
                quotesCount: 10,
                newsCount: 0,
                enableNavLinks: false,
                enableEnhancedTrivialQuery: false
            }, { validateResult: false })) as any;

            if (!results.quotes) return [];

            return results.quotes
                .filter((quote: any) => quote.isYahooFinance)
                .map((quote: any) => ({
                    symbol: quote.symbol,
                    name: quote.shortname || quote.longname || quote.symbol,
                    exchange: quote.exchange,
                    type: quote.quoteType,
                }));
        } catch (error) {
            console.error('Error searching symbols:', error);
            // Return empty array on error instead of crashing
            return [];
        }
    }

    /**
     * Get current price for a symbol with market-hours aware SWR caching and singleflight deduplication.
     *
     * @param symbol - Ticker symbol (e.g., AAPL, XEQT.TO, CAD=X)
     * @param forceRefreshOrOptions - Boolean `forceRefresh` or `{ forceRefresh, mode: 'swr' | 'blocking', includeMetadata }`
     */
    static async getPrice(
        symbol: string,
        forceRefreshOrOptions: boolean | GetPriceOptions = false
    ): Promise<MarketData | null> {
        const forceRefresh = typeof forceRefreshOrOptions === 'boolean'
            ? forceRefreshOrOptions
            : Boolean(forceRefreshOrOptions?.forceRefresh);
        const mode: 'swr' | 'blocking' = forceRefresh
            ? 'blocking'
            : (typeof forceRefreshOrOptions === 'object' && forceRefreshOrOptions?.mode
                ? forceRefreshOrOptions.mode
                : 'swr');
        const includeMetadata = forceRefresh || (typeof forceRefreshOrOptions === 'object' && Boolean(forceRefreshOrOptions?.includeMetadata));

        try {
            // 1. Check Cache (unless forcing full synchronous refresh)
            const cached = await prisma.marketDataCache.findUnique({
                where: { symbol }
            });

            const hasUsableCached = Boolean(cached && cached.price > 0);
            const effectiveTtlMs = getEffectivePriceTtlMs().ttlMs;
            const lastUpdatedMs = cached?.lastUpdated ? new Date(cached.lastUpdated).getTime() : Number.NaN;
            const ageMs = Number.isFinite(lastUpdatedMs) ? (Date.now() - lastUpdatedMs) : Number.POSITIVE_INFINITY;
            const isStale = !cached || cached.price <= 0 || ageMs > effectiveTtlMs;

            if (!forceRefresh && hasUsableCached) {
                if (!isStale) {
                    return mapCachedRowToMarketData(cached);
                }

                // # Reason: Stale-While-Revalidate serves cached quotes instantaneously to interactive
                // browsers and coalesces a background quote batch across concurrent mobile/desktop loads.
                if (mode === 'swr') {
                    enqueueBackgroundPriceSync([symbol]);
                    return mapCachedRowToMarketData(cached);
                }
            }

            // 2. Singleflight Fetch from API (cold miss, blocking read, or forceRefresh)
            const inFlightMap = getInFlightMap<MarketData | null>('_marketPriceInFlight');
            const forcedFullKey = `forced-full:${symbol}`;
            const fullKey = `full:${symbol}`;
            const quoteKey = `quote:${symbol}`;
            const targetKey = forceRefresh ? forcedFullKey : (includeMetadata ? fullKey : quoteKey);

            // Never downgrade a forceRefresh caller onto a non-forced flight that swallows errors.
            if (forceRefresh) {
                if (inFlightMap.has(forcedFullKey)) {
                    return await inFlightMap.get(forcedFullKey)!;
                }
            } else {
                if (inFlightMap.has(forcedFullKey)) {
                    return await inFlightMap.get(forcedFullKey)!;
                }
                if (!includeMetadata && inFlightMap.has(fullKey)) {
                    return await inFlightMap.get(fullKey)!;
                }
                if (inFlightMap.has(targetKey)) {
                    return await inFlightMap.get(targetKey)!;
                }
            }

            const execPromise = (async (): Promise<MarketData | null> => {
                try {
                    const now = new Date();
                    const startOfToday = new Date(now);
                    startOfToday.setUTCHours(0, 0, 0, 0);

                    let quoteRealtime: any = null;
                    let lastError: any = null;
                    try {
                        quoteRealtime = await apiThrottler.add(() => yahooFinance.quote(symbol, {}, { validateResult: false })) as any;
                    } catch (e: any) {
                        lastError = e;
                    }

                    // Fetch heavy quoteSummary when explicitly requested for metadata-bearing symbols OR if fast quote omitted price.
                    const supportsMetadata = !symbol.endsWith('=X') && !symbol.startsWith('^');
                    let quoteSummary: any = null;
                    let quoteSummaryError: unknown = null;
                    const needsSummaryFallback = !quoteRealtime || !(typeof quoteRealtime.regularMarketPrice === 'number' && Number.isFinite(quoteRealtime.regularMarketPrice) && quoteRealtime.regularMarketPrice > 0);
                    if ((includeMetadata && supportsMetadata) || needsSummaryFallback) {
                        try {
                            quoteSummary = await apiThrottler.add(() => yahooFinance.quoteSummary(
                                symbol,
                                { modules: ['summaryProfile', 'summaryDetail', 'topHoldings', 'calendarEvents', 'defaultKeyStatistics'] },
                                { validateResult: false }
                            )) as any;
                        } catch (e: any) {
                            quoteSummaryError = e;
                            if (!lastError) lastError = e;
                        }
                    }

                    const rtPrice = typeof quoteRealtime?.regularMarketPrice === 'number' && Number.isFinite(quoteRealtime.regularMarketPrice) && quoteRealtime.regularMarketPrice > 0
                        ? quoteRealtime.regularMarketPrice
                        : 0;
                    const summaryPrice = typeof quoteSummary?.price?.regularMarketPrice === 'number' && Number.isFinite(quoteSummary.price.regularMarketPrice) && quoteSummary.price.regularMarketPrice > 0
                        ? quoteSummary.price.regularMarketPrice
                        : 0;
                    const priceVal = rtPrice || summaryPrice;

                    if (priceVal <= 0) {
                        if (forceRefresh && lastError) throw lastError;
                        throw new Error('Failed to fetch market data from API');
                    }

                    const changeVal = quoteRealtime?.regularMarketChange ?? quoteSummary?.price?.regularMarketChange ?? 0;
                    const changePercentVal = quoteRealtime?.regularMarketChangePercent ?? quoteSummary?.price?.regularMarketChangePercent ?? 0;
                    const currencyVal = quoteRealtime?.currency || quoteSummary?.price?.currency || cached?.currency || 'USD';
                    const nameVal = quoteRealtime?.longName || quoteRealtime?.shortName || quoteSummary?.price?.longName || quoteSummary?.price?.shortName;
                    const quoteType = quoteRealtime?.quoteType || quoteSummary?.price?.quoteType;

                    const marketTime = parseMarketTime(
                        quoteRealtime?.regularMarketTime ?? quoteSummary?.price?.regularMarketTime,
                        now
                    );

                    const profile: any = quoteSummary?.summaryProfile || {};
                    const detail: any = quoteSummary?.summaryDetail || {};
                    const holdings: any = quoteSummary?.topHoldings || {};
                    const calendar: any = quoteSummary?.calendarEvents || {};
                    const keyStats: any = quoteSummary?.defaultKeyStatistics || {};

                    let dividendRate = firstPositive(
                        detail.dividendRate,
                        quoteRealtime?.dividendRate,
                        detail.trailingAnnualDividendRate,
                        quoteRealtime?.trailingAnnualDividendRate
                    );
                    let dividendYield = firstPositive(
                        detail.dividendYield,
                        detail.yield,
                        detail.trailingAnnualDividendYield,
                        quoteRealtime?.trailingAnnualDividendYield,
                        keyStats.yield
                    );

                    if (!dividendRate && dividendYield && priceVal) {
                        dividendRate = priceVal * dividendYield;
                    }
                    if (!dividendYield && dividendRate && priceVal) {
                        dividendYield = dividendRate / priceVal;
                    }

                    const isFundLike = isFundLikeAsset(quoteType, profile.country, nameVal);
                    const issuerAllocations =
                        includeMetadata && supportsMetadata && isFundLike
                            ? await resolveIssuerAllocations({
                                  symbol,
                                  fundName: nameVal,
                                  quoteType,
                                  currency: currencyVal,
                              })
                            : null;

                    const cachedSectorAllocations = Array.isArray(cached?.sectorAllocations)
                        ? (cached.sectorAllocations as any[])
                        : [];
                    const cachedCountryAllocations = Array.isArray(cached?.countryAllocations)
                        ? (cached.countryAllocations as any[])
                        : [];

                    const yahooSectorAllocations = Array.isArray(holdings.sectorWeightings)
                        ? holdings.sectorWeightings
                        : [];
                    const hasIssuerSectors = Boolean(
                        issuerAllocations?.sectorAllocations && issuerAllocations.sectorAllocations.length > 0
                    );
                    const hasIssuerCountries = Boolean(
                        issuerAllocations?.countryAllocations && issuerAllocations.countryAllocations.length > 0
                    );

                    const resolvedSectorAllocations =
                        yahooSectorAllocations.length > 0
                            ? yahooSectorAllocations
                            : quoteSummary
                              ? hasIssuerSectors
                                ? issuerAllocations!.sectorAllocations
                                : isFundLike && cachedSectorAllocations.length > 0
                                  ? cachedSectorAllocations
                                  : []
                              : cachedSectorAllocations.length > 0
                                ? (cached?.sectorAllocations as any[])
                                : hasIssuerSectors
                                  ? issuerAllocations!.sectorAllocations
                                  : (cached?.sectorAllocations as any[] | undefined);

                    // # Reason: Yahoo quoteSummary omits ETF country weightings; preserve previously cached
                    // direct-issuer breakdown if an issuer lookup fails transiently on refresh.
                    const resolvedCountryAllocations = hasIssuerCountries
                        ? issuerAllocations!.countryAllocations
                        : isFundLike && cachedCountryAllocations.length > 0
                          ? cachedCountryAllocations
                          : quoteSummary
                            ? []
                            : (cached?.countryAllocations as any[] | undefined);

                    const data: MarketData = {
                        symbol,
                        price: priceVal,
                        currency: currencyVal,
                        regularMarketTime: marketTime,
                        regularMarketChange: typeof changeVal === 'number' && Number.isFinite(changeVal) ? changeVal : 0,
                        regularMarketChangePercent: typeof changePercentVal === 'number' && Number.isFinite(changePercentVal) ? changePercentVal : 0,
                        sector: profile.sector ?? cached?.sector ?? undefined,
                        country: profile.country ?? cached?.country ?? undefined,
                        fiftyTwoWeekHigh: detail.fiftyTwoWeekHigh,
                        fiftyTwoWeekLow: detail.fiftyTwoWeekLow,
                        sectorAllocations: resolvedSectorAllocations,
                        countryAllocations: resolvedCountryAllocations,
                        dividendRate,
                        dividendYield,
                        exDividendDate: parseOptionalMarketDate(calendar.exDividendDate) ?? parseOptionalMarketDate(quoteRealtime?.exDividendDate),
                        name: nameVal,
                    };

                    if (
                        forceRefresh &&
                        shouldEstimateDividends(symbol, quoteType) &&
                        (!data.dividendRate || !data.exDividendDate || data.exDividendDate < startOfToday || !data.estNextDividendAmount)
                    ) {
                        const details = await estimateDividendDetails(symbol, { rollForwardTo: startOfToday });
                        if (details) {
                            if (!data.dividendRate && details.trailingAnnualRate) {
                                data.dividendRate = details.trailingAnnualRate;
                                if (!data.dividendYield && data.price > 0) {
                                    data.dividendYield = details.trailingAnnualRate / data.price;
                                }
                            }
                            if (details.nextDate && (!data.exDividendDate || data.exDividendDate < startOfToday)) {
                                data.exDividendDate = details.nextDate;
                            }
                            if (details.nextAmount) {
                                data.estNextDividendAmount = details.nextAmount;
                            }
                        }
                    } else if (!forceRefresh && cached) {
                        // # Reason: Non-forced interactive/blocking reads skip the historical dividend check;
                        // preserve previously resolved ETF dividend metadata when quote/summary omits it.
                        if (!data.dividendRate && !data.dividendYield && cached.dividendRate) {
                            data.dividendRate = cached.dividendRate;
                            data.dividendYield = cached.dividendYield || (data.price > 0 ? cached.dividendRate / data.price : undefined);
                        }
                        if ((!data.exDividendDate || data.exDividendDate < startOfToday) && cached.exDividendDate && new Date(cached.exDividendDate) >= startOfToday) {
                            data.exDividendDate = cached.exDividendDate;
                        }
                        if (!data.estNextDividendAmount && cached.estNextDividendAmount) {
                            data.estNextDividendAmount = cached.estNextDividendAmount;
                        }
                    }

                    const metadataResolved = Boolean(quoteSummary) || (
                        includeMetadata &&
                        !quoteSummaryError &&
                        (!supportsMetadata || !shouldEstimateDividends(symbol, quoteType))
                    );

                    const updatePayload: Record<string, any> = {
                        price: data.price,
                        change: data.regularMarketChange,
                        changePercent: data.regularMarketChangePercent,
                        currency: data.currency,
                        dividendRate: data.dividendRate,
                        dividendYield: data.dividendYield,
                        exDividendDate: data.exDividendDate,
                        estNextDividendAmount: data.estNextDividendAmount,
                        marketTime: data.regularMarketTime,
                        lastUpdated: now,
                    };

                    if (quoteSummary) {
                        updatePayload.sector = data.sector;
                        updatePayload.country = data.country;
                        if (yahooSectorAllocations.length > 0 || hasIssuerSectors || !isFundLike) {
                            updatePayload.sectorAllocations = data.sectorAllocations ?? [];
                        }
                        if (hasIssuerCountries || !isFundLike) {
                            updatePayload.countryAllocations = data.countryAllocations ?? [];
                        }
                    } else {
                        if (hasIssuerSectors && cachedSectorAllocations.length === 0) {
                            updatePayload.sectorAllocations = data.sectorAllocations;
                        }
                        if (hasIssuerCountries) {
                            updatePayload.countryAllocations = data.countryAllocations;
                        }
                    }
                    if (metadataResolved) {
                        updatePayload.metadataUpdatedAt = now;
                    }

                    const createPayload: Record<string, any> = {
                        symbol: data.symbol,
                        price: data.price,
                        change: data.regularMarketChange,
                        changePercent: data.regularMarketChangePercent,
                        currency: data.currency,
                        sector: data.sector,
                        country: data.country,
                        sectorAllocations: data.sectorAllocations ?? [],
                        countryAllocations: data.countryAllocations ?? [],
                        dividendRate: data.dividendRate,
                        dividendYield: data.dividendYield,
                        exDividendDate: data.exDividendDate,
                        estNextDividendAmount: data.estNextDividendAmount,
                        marketTime: data.regularMarketTime,
                        lastUpdated: now,
                    };

                    if (metadataResolved) {
                        createPayload.metadataUpdatedAt = now;
                    }

                    await prisma.marketDataCache.upsert({
                        where: { symbol },
                        update: updatePayload as any,
                        create: createPayload as any,
                    });

                    invalidateMarketCaches({ symbols: [symbol] });
                    return data;
                } catch (error: any) {
                    const msg = error?.message || '';
                    if (msg.includes('Failed to fetch') || msg.includes('429') || msg.includes('crumb')) {
                        console.warn(`[MarketData] API Error for ${symbol} (${msg}). Using cache.`);
                    } else {
                        console.error(`Error fetching price for ${symbol}:`, error);
                    }

                    if (forceRefresh) throw error;

                    const fallbackCached = cached || await prisma.marketDataCache.findUnique({ where: { symbol } });
                    if (fallbackCached) {
                        return mapCachedRowToMarketData(fallbackCached);
                    }
                    return null;
                } finally {
                    inFlightMap.delete(targetKey);
                }
            })();

            inFlightMap.set(targetKey, execPromise);
            return await execPromise;
        } catch (error: any) {
            if (forceRefresh) throw error;

            const cached = await prisma.marketDataCache.findUnique({ where: { symbol } });
            if (cached) {
                return mapCachedRowToMarketData(cached);
            }
            return null;
        }
    }

    /**
     * Get exchange rate between two currencies with singleflight coalescing and canonical USD-pair resolution.
     */
    static async getExchangeRate(from: string, to: string, forceRefresh = false): Promise<number | null> {
        if (from === to) return 1;

        const fxInFlight = getInFlightMap<number | null>('_marketFxInFlight');
        const key = `${from}->${to}:${Boolean(forceRefresh)}`;
        if (fxInFlight.has(key)) {
            return await fxInFlight.get(key)!;
        }

        const promise = (async (): Promise<number | null> => {
            try {
                const candidates: Array<{ symbol: string; invert: boolean }> = [];

                if (from === 'USD') {
                    // Canonical Yahoo ticker USD->X is X=X (e.g., CAD=X)
                    candidates.push({ symbol: `${to}=X`, invert: false });
                    candidates.push({ symbol: `USD${to}=X`, invert: false });
                    candidates.push({ symbol: `${to}USD=X`, invert: true });
                } else if (to === 'USD') {
                    // Prefer cron-warmed X=X shorthand (inverted) before XUSD=X to avoid uncached misses
                    candidates.push({ symbol: `${from}=X`, invert: true });
                    candidates.push({ symbol: `${from}USD=X`, invert: false });
                } else {
                    candidates.push({ symbol: `${from}${to}=X`, invert: false });
                    candidates.push({ symbol: `${to}${from}=X`, invert: true });
                }

                for (const candidate of candidates) {
                    try {
                        const data = await this.getPrice(candidate.symbol, forceRefresh);
                        if (data?.price && data.price > 0) {
                            return candidate.invert ? 1 / data.price : data.price;
                        }
                    } catch {
                        // Candidate may fail under forceRefresh; continue trying fallback candidates
                    }
                }

                // Cross-currency triangulation fallback via USD (e.g. EUR -> USD -> CAD)
                if (from !== 'USD' && to !== 'USD') {
                    const [fromUsd, usdTo] = await Promise.all([
                        this.getExchangeRate(from, 'USD', forceRefresh),
                        this.getExchangeRate('USD', to, forceRefresh),
                    ]);
                    if (fromUsd && fromUsd > 0 && usdTo && usdTo > 0) {
                        return fromUsd * usdTo;
                    }
                }

                return null;
            } finally {
                fxInFlight.delete(key);
            }
        })();

        fxInFlight.set(key, promise);
        return await promise;
    }

    /**
     * Get historical exchange rate for a specific date with singleflight coalescing.
     */
    static async getHistoricalExchangeRate(from: string, to: string, date: Date): Promise<number | null> {
        if (from === to) return 1;

        const dateKey = new Date(date).toISOString().split('T')[0];
        const histFxInFlight = getInFlightMap<number | null>('_marketHistoricalFxInFlight');
        const key = `${from}->${to}:${dateKey}`;
        if (histFxInFlight.has(key)) {
            return await histFxInFlight.get(key)!;
        }

        const getRateForSymbol = async (ticker: string): Promise<number | null> => {
            try {
                const startDate = new Date(date);
                startDate.setDate(startDate.getDate() - 4);
                const endDate = new Date(date);
                endDate.setDate(endDate.getDate() + 1);

                const result = await apiThrottler.add(() => yahooFinance.chart(ticker, {
                    period1: startDate,
                    period2: endDate,
                    interval: '1d'
                })) as any;

                const quotes = result?.quotes || [];
                if (quotes.length === 0) return null;

                const targetTime = date.getTime();
                quotes.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

                let bestQuote = null;
                for (const q of quotes) {
                    const qTime = new Date(q.date).getTime();
                    if (qTime <= targetTime + (24 * 60 * 60 * 1000)) {
                        if (q.close || q.adjClose) {
                            bestQuote = q;
                        }
                    }
                }

                if (!bestQuote && quotes.length > 0) bestQuote = quotes[quotes.length - 1];
                return bestQuote ? (bestQuote.close || bestQuote.adjClose) : null;
            } catch {
                return null;
            }
        };

        const promise = (async (): Promise<number | null> => {
            try {
                let symbol = `${from}${to}=X`;
                if (from === 'USD') symbol = `${to}=X`;

                const rate = await getRateForSymbol(symbol);
                if (rate && rate > 0) return rate;

                let reverseSymbol = `${to}${from}=X`;
                if (to === 'USD') reverseSymbol = `${from}=X`;

                const reverseRate = await getRateForSymbol(reverseSymbol);
                if (reverseRate && reverseRate > 0) return 1 / reverseRate;

                if (from !== 'USD' && to !== 'USD') {
                    const [fromUsd, usdTo] = await Promise.all([
                        this.getHistoricalExchangeRate(from, 'USD', date),
                        this.getHistoricalExchangeRate('USD', to, date),
                    ]);
                    if (fromUsd && fromUsd > 0 && usdTo && usdTo > 0) {
                        return fromUsd * usdTo;
                    }
                }

                return null;
            } finally {
                histFxInFlight.delete(key);
            }
        })();

        histFxInFlight.set(key, promise);
        return await promise;
    }

    /**
     * Helper to process raw quotes into a history object with period snapshots
     */
    static processHistory(quotes: any[]): Record<string, number> {
        if (!quotes || quotes.length === 0) return {};

        const prices: Record<string, number> = {};

        for (const quote of quotes) {
            if (quote.date && (quote.close || quote.adjClose)) {
                const dateStr = new Date(quote.date).toISOString().split('T')[0];
                prices[dateStr] = quote.close || quote.adjClose;
            }
        }

        const findPrice = (targetDate: Date) => {
            const targetTime = targetDate.getTime();
            let closest = quotes[0];

            for (const candle of quotes) {
                const candleTime = new Date(candle.date).getTime();
                if (candleTime <= targetTime) {
                    closest = candle;
                } else {
                    break;
                }
            }
            return closest?.close || closest?.adjClose || 0;
        };

        const today = new Date();

        const oneWeekAgo = new Date(today);
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        prices['1W'] = findPrice(oneWeekAgo);

        const oneMonthAgo = new Date(today);
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        prices['1M'] = findPrice(oneMonthAgo);

        const oneYearAgo = new Date(today);
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        prices['1Y'] = findPrice(oneYearAgo);

        const ytd = new Date(today.getFullYear(), 0, 1);
        prices['YTD'] = findPrice(ytd);

        return prices;
    }

    /**
     * Get historical prices for performance calculation with singleflight coalescing.
     * Returns map of period -> price.
     */
    static async getHistoricalPrices(symbol: string, forceRefresh = false): Promise<Record<string, number>> {
        const inFlightMap = getInFlightMap<Record<string, number>>('_marketHistoryInFlight');
        const key = `${symbol}:${Boolean(forceRefresh)}`;
        if (inFlightMap.has(key)) {
            return await inFlightMap.get(key)!;
        }

        const promise = (async (): Promise<Record<string, number>> => {
            try {
                const cached = await prisma.marketDataCache.findUnique({
                    where: { symbol }
                });

                if (!forceRefresh && cached?.history) {
                    if (typeof cached.history === 'object' && cached.history !== null) {
                        const h = cached.history as Record<string, number>;
                        if (Object.keys(h).length > 0) {
                            return h;
                        }
                    }
                }

                const endDate = new Date();
                const startDate = new Date();
                startDate.setFullYear(startDate.getFullYear() - 20);
                startDate.setDate(startDate.getDate() - 7);

                const queryOptions = {
                    period1: startDate,
                    period2: endDate,
                    interval: '1d' as const,
                };

                const result = await apiThrottler.add(() => yahooFinance.chart(symbol, queryOptions)) as any;
                const quotes = result?.quotes || [];
                const prices = this.processHistory(quotes);
                const now = new Date();

                await prisma.marketDataCache.upsert({
                    where: { symbol },
                    update: {
                        history: prices,
                        historyUpdatedAt: now,
                    } as any,
                    create: {
                        symbol,
                        price: 0,
                        change: 0,
                        changePercent: 0,
                        currency: 'USD',
                        history: prices,
                        historyUpdatedAt: now,
                        lastUpdated: new Date(0),
                    } as any,
                });

                invalidateMarketCaches({ symbols: [symbol] });
                return prices;
            } catch (error) {
                console.error(`Error fetching historical for ${symbol}:`, error);
                if (forceRefresh) throw error;

                const cached = await prisma.marketDataCache.findUnique({ where: { symbol } });
                if (cached?.history && typeof cached.history === 'object') {
                    return cached.history as Record<string, number>;
                }
                return {};
            } finally {
                inFlightMap.delete(key);
            }
        })();

        inFlightMap.set(key, promise);
        return await promise;
    }

    private static get dailyUnadjustedCache() {
        if (!(globalThis as any)._marketDailyUnadjustedCache) {
            (globalThis as any)._marketDailyUnadjustedCache = new Map<string, { data: Record<string, number>, fromTime: number, timestamp: number }>();
        }
        return (globalThis as any)._marketDailyUnadjustedCache as Map<string, { data: Record<string, number>, fromTime: number, timestamp: number }>;
    }

    private static DAILY_UNADJUSTED_TTL = 12 * 60 * 60 * 1000; // 12 Hours

    /**
     * Get full unadjusted daily history for a symbol from a start date with singleflight coalescing.
     * Essential for Portfolio Unitization so holdings split multipliers align with historical closing prices.
     */
    static async getDailyHistory(symbol: string, fromDate?: Date, forceRefresh = false): Promise<Record<string, number>> {
        const defaultStart = new Date();
        defaultStart.setFullYear(defaultStart.getFullYear() - 10);
        const startDate = fromDate || defaultStart;
        const requestedFromTime = startDate.getTime();
        const cachedEntry = this.dailyUnadjustedCache.get(symbol);

        if (
            !forceRefresh &&
            cachedEntry &&
            (Date.now() - cachedEntry.timestamp < this.DAILY_UNADJUSTED_TTL) &&
            cachedEntry.fromTime <= requestedFromTime + 24 * 60 * 60 * 1000 &&
            Object.keys(cachedEntry.data).length > 0
        ) {
            return cachedEntry.data;
        }

        const inFlightMap = getInFlightMap<Record<string, number>>('_marketDailyInFlight');
        const dateBucket = startDate.toISOString().split('T')[0];
        const key = `${symbol}:${dateBucket}:${Boolean(forceRefresh)}`;
        if (inFlightMap.has(key)) {
            return await inFlightMap.get(key)!;
        }

        const promise = (async (): Promise<Record<string, number>> => {
            try {
                const endDate = new Date();
                const queryOptions = {
                    period1: startDate,
                    period2: endDate,
                    interval: '1d' as const,
                    events: 'split'
                };

                const result = await apiThrottler.add(() => yahooFinance.chart(symbol, queryOptions)) as any;
                const quotes = result?.quotes || [];
                const splits = result?.events?.splits || {};

                const splitMap: Record<string, number> = {};
                if (splits && typeof splits === 'object') {
                    Object.values(splits).forEach((s: any) => {
                        let ratio = 1;
                        if (s.numerator && s.denominator) {
                            ratio = s.numerator / s.denominator;
                        }
                        let dObj: Date;
                        if (s.date instanceof Date) {
                            dObj = s.date;
                        } else if (typeof s.date === 'string') {
                            dObj = new Date(s.date);
                        } else {
                            dObj = new Date(s.date * 1000);
                        }
                        const d = dObj.toISOString().split('T')[0];
                        if (Number.isFinite(ratio) && ratio > 0) {
                            splitMap[d] = ratio;
                        }
                    });
                }

                const prices: Record<string, number> = {};
                let splitFactor = 1;
                const sortedQuotes = [...quotes].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

                for (const quote of sortedQuotes) {
                    const d = new Date(quote.date);
                    const dateStr = d.toISOString().split('T')[0];
                    let price = quote.close || quote.adjClose;

                    if (price && price > 0) {
                        price = price * splitFactor;
                        prices[dateStr] = price;
                    }

                    if (splitMap[dateStr]) {
                        splitFactor *= splitMap[dateStr];
                    }
                }

                if (Object.keys(prices).length > 0) {
                    this.dailyUnadjustedCache.set(symbol, {
                        data: prices,
                        fromTime: requestedFromTime,
                        timestamp: Date.now()
                    });
                }

                return prices;
            } catch (error) {
                console.error(`Error fetching daily history for ${symbol}:`, error);
                if (forceRefresh) throw error;

                if (cachedEntry && Object.keys(cachedEntry.data).length > 0) {
                    return cachedEntry.data;
                }

                try {
                    const cached = await prisma.marketDataCache.findUnique({ where: { symbol } });
                    if (cached?.history && typeof cached.history === 'object') {
                        return cached.history as Record<string, number>;
                    }
                } catch { }
                return {};
            } finally {
                inFlightMap.delete(key);
            }
        })();

        inFlightMap.set(key, promise);
        return await promise;
    }

    /**
     * Refresh all market data for symbols (Price, Profile, History)
     * Coalesced via singleflight and throttled through apiThrottler.
     */
    static async refreshMarketData(symbols: string | string[]): Promise<void> {
        const symbolList = Array.isArray(symbols)
            ? Array.from(new Set(symbols.map(s => s.trim()).filter(Boolean)))
            : (symbols ? [symbols.trim()] : []);
        if (symbolList.length === 0) return;

        const inFlightMap = getInFlightMap<void>('_marketFullRefreshInFlight');
        const batchKey = symbolList.slice().sort().join(',');
        if (inFlightMap.has(batchKey)) {
            return await inFlightMap.get(batchKey)!;
        }

        const promise = (async () => {
            try {
                console.log(`Refreshing market data for ${symbolList.length} symbol(s)...`);
                const now = new Date();
                const startOfToday = new Date(now);
                startOfToday.setUTCHours(0, 0, 0, 0);

                type SymbolProcessSuccess = {
                    ok: true;
                    symbol: string;
                    isFundLike: boolean;
                    priceData: {
                        price: number;
                        change: number;
                        changePercent: number;
                        currency: string;
                        sector: string | undefined;
                        country: string | undefined;
                        sectorAllocations: any[];
                        countryAllocations: any[];
                        dividendRate: number | undefined;
                        dividendYield: number | undefined;
                        exDividendDate: Date | undefined;
                        estNextDividendAmount: number | undefined;
                        marketTime: Date;
                    };
                    history: Record<string, number>;
                };
                type SymbolProcessFailure = {
                    ok: false;
                    symbol: string;
                    error: unknown;
                };

                const processSymbol = async (symbol: string): Promise<SymbolProcessSuccess | SymbolProcessFailure> => {
                    try {
                        const quote = await apiThrottler.add(() => yahooFinance.quoteSummary(
                            symbol,
                            { modules: ['price', 'summaryProfile', 'summaryDetail', 'topHoldings', 'calendarEvents', 'defaultKeyStatistics'] },
                            { validateResult: false }
                        )) as any;

                        const p = quote?.price;
                        const rawPrice = p?.regularMarketPrice;
                        if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice <= 0) {
                            throw new Error(`Invalid or missing quote price for ${symbol}`);
                        }

                        const profile = quote.summaryProfile || {};
                        const holdings = quote.topHoldings || {};
                        const calendar = quote.calendarEvents || {};
                        const detail = quote.summaryDetail || {};
                        const keyStats = quote.defaultKeyStatistics || {};
                        const quoteType: string | undefined = p.quoteType;
                        const fundName: string | undefined = p.longName || p.shortName;
                        const currency: string = p.currency || 'USD';

                        let dividendRate = firstPositive(
                            detail.dividendRate,
                            detail.trailingAnnualDividendRate
                        );
                        let dividendYield = firstPositive(
                            detail.dividendYield,
                            detail.yield,
                            detail.trailingAnnualDividendYield,
                            keyStats.yield
                        );

                        if (!dividendRate && dividendYield && rawPrice > 0) {
                            dividendRate = rawPrice * dividendYield;
                        }
                        if (!dividendYield && dividendRate && rawPrice > 0) {
                            dividendYield = dividendRate / rawPrice;
                        }

                        const isFundLike = isFundLikeAsset(quoteType, profile.country, fundName);
                        const issuerAllocations = isFundLike
                            ? await resolveIssuerAllocations({
                                  symbol,
                                  fundName,
                                  quoteType,
                                  currency,
                              })
                            : null;

                        const yahooSectorAllocations = Array.isArray(holdings.sectorWeightings)
                            ? holdings.sectorWeightings
                            : [];
                        const resolvedSectorAllocations =
                            yahooSectorAllocations.length > 0
                                ? yahooSectorAllocations
                                : (issuerAllocations?.sectorAllocations ?? []);
                        const resolvedCountryAllocations = issuerAllocations?.countryAllocations ?? [];

                        const priceData: SymbolProcessSuccess['priceData'] = {
                            price: rawPrice,
                            change: typeof p.regularMarketChange === 'number' && Number.isFinite(p.regularMarketChange) ? p.regularMarketChange : 0,
                            changePercent: typeof p.regularMarketChangePercent === 'number' && Number.isFinite(p.regularMarketChangePercent) ? p.regularMarketChangePercent : 0,
                            currency,
                            sector: profile.sector,
                            country: profile.country,
                            sectorAllocations: resolvedSectorAllocations,
                            countryAllocations: resolvedCountryAllocations,
                            dividendRate,
                            dividendYield,
                            exDividendDate: parseOptionalMarketDate(calendar.exDividendDate),
                            estNextDividendAmount: undefined,
                            marketTime: parseMarketTime(p.regularMarketTime, now),
                        };

                        if (
                            shouldEstimateDividends(symbol, quoteType) &&
                            (!priceData.dividendRate || !priceData.exDividendDate || priceData.exDividendDate < startOfToday || !priceData.estNextDividendAmount)
                        ) {
                            const details = await estimateDividendDetails(symbol, { rollForwardTo: startOfToday });
                            if (details) {
                                if (!priceData.dividendRate && details.trailingAnnualRate) {
                                    priceData.dividendRate = details.trailingAnnualRate;
                                    if (!priceData.dividendYield && priceData.price > 0) {
                                        priceData.dividendYield = details.trailingAnnualRate / priceData.price;
                                    }
                                }
                                if (details.nextDate && (!priceData.exDividendDate || priceData.exDividendDate < startOfToday)) {
                                    priceData.exDividendDate = details.nextDate;
                                }
                                if (details.nextAmount) {
                                    priceData.estNextDividendAmount = details.nextAmount;
                                }
                            }
                        }

                        const endDate = new Date();
                        const startDate = new Date();
                        startDate.setFullYear(startDate.getFullYear() - 20);
                        startDate.setDate(startDate.getDate() - 7);

                        const queryOptions = {
                            period1: startDate,
                            period2: endDate,
                            interval: '1d' as const,
                        };

                        const chartResult = await apiThrottler.add(() => yahooFinance.chart(symbol, queryOptions)) as any;
                        const quotes = chartResult?.quotes || [];
                        const history = this.processHistory(quotes);

                        return { ok: true, symbol, isFundLike, priceData, history };
                    } catch (error) {
                        console.error(`Error processing market data for ${symbol}:`, error);
                        return { ok: false, symbol, error };
                    }
                };

                const results = await Promise.all(symbolList.map(symbol => processSymbol(symbol)));
                const validResults = results.filter((r): r is SymbolProcessSuccess => r.ok);
                const failedResults = results.filter((r): r is SymbolProcessFailure => !r.ok);

                if (validResults.length > 0) {
                    const upserts = validResults.map(({ symbol, isFundLike, priceData, history }) => {
                        const updateFields: Record<string, any> = {
                            price: priceData.price,
                            change: priceData.change,
                            changePercent: priceData.changePercent,
                            currency: priceData.currency,
                            sector: priceData.sector,
                            country: priceData.country,
                            dividendRate: priceData.dividendRate,
                            dividendYield: priceData.dividendYield,
                            exDividendDate: priceData.exDividendDate,
                            estNextDividendAmount: priceData.estNextDividendAmount,
                            history: history,
                            marketTime: priceData.marketTime,
                            metadataUpdatedAt: now,
                            historyUpdatedAt: now,
                            lastUpdated: now
                        };
                        if (priceData.sectorAllocations.length > 0 || !isFundLike) {
                            updateFields.sectorAllocations = priceData.sectorAllocations;
                        }
                        if (priceData.countryAllocations.length > 0 || !isFundLike) {
                            updateFields.countryAllocations = priceData.countryAllocations;
                        }

                        return prisma.marketDataCache.upsert({
                            where: { symbol },
                            update: updateFields as any,
                            create: {
                                symbol,
                                price: priceData.price,
                                change: priceData.change,
                                changePercent: priceData.changePercent,
                                currency: priceData.currency,
                                sector: priceData.sector,
                                country: priceData.country,
                                sectorAllocations: priceData.sectorAllocations,
                                countryAllocations: priceData.countryAllocations,
                                dividendRate: priceData.dividendRate,
                                dividendYield: priceData.dividendYield,
                                exDividendDate: priceData.exDividendDate,
                                estNextDividendAmount: priceData.estNextDividendAmount,
                                history: history,
                                marketTime: priceData.marketTime,
                                metadataUpdatedAt: now,
                                historyUpdatedAt: now,
                                lastUpdated: now
                            } as any
                        });
                    });

                    await prisma.$transaction(upserts);
                    invalidateMarketCaches({
                        symbols: validResults.map(r => r.symbol),
                        clearIntraday: true,
                        clearDailyUnadjusted: true,
                    });
                    console.log(`Market data refreshed for ${validResults.length} symbol(s)`);
                }

                if (validResults.length === 0 && failedResults.length > 0) {
                    throw failedResults[0].error instanceof Error
                        ? failedResults[0].error
                        : new Error(String(failedResults[0].error || 'Failed to refresh market data'));
                }
            } catch (error) {
                console.error(`Error refreshing market data for symbols:`, error);
                throw error;
            } finally {
                inFlightMap.delete(batchKey);
            }
        })();

        inFlightMap.set(batchKey, promise);
        await promise;
    }

    /**
     * Efficiently upserts ONLY current price, change, currency, and marketTime in chunked batches.
     * Creates missing cache rows cleanly while preserving existing metadata/history columns on update.
     * Deduplicates concurrent overlapping calls per symbol so overlapping cron/SWR/manual runs
     * never fire duplicate Yahoo quote requests.
     */
    static async refreshPriceOnly(symbols: string | string[]): Promise<number> {
        const rawList = Array.isArray(symbols) ? symbols : [symbols];
        const symbolList = Array.from(new Set(rawList.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean)));
        if (symbolList.length === 0) return 0;

        interface SymbolFlightDeferred {
            promise: Promise<boolean>;
            resolve: (updated: boolean) => void;
            reject: (err: unknown) => void;
        }

        const inFlightMap = getInFlightMap<boolean>('_marketPriceOnlySymbolInFlight');
        const waitPromises: Array<Promise<boolean>> = [];
        const toFetch: string[] = [];
        const claimed = new Map<string, SymbolFlightDeferred>();

        for (const sym of symbolList) {
            const existing = inFlightMap.get(sym);
            if (existing) {
                waitPromises.push(existing);
                continue;
            }

            let resolve!: (updated: boolean) => void;
            let reject!: (err: unknown) => void;
            const promise = new Promise<boolean>((res, rej) => {
                resolve = res;
                reject = rej;
            });
            // Prevent unhandled rejection crashes if an earlier chunk aborts before later chunks run.
            promise.catch(() => {});

            inFlightMap.set(sym, promise);
            claimed.set(sym, { promise, resolve, reject });
            waitPromises.push(promise);
            toFetch.push(sym);
        }

        if (toFetch.length > 0) {
            const batchSize = Math.max(1, getMarketConfig().incrementalBatchSize);
            try {
                for (let i = 0; i < toFetch.length; i += batchSize) {
                    const chunk = toFetch.slice(i, i + batchSize);
                    const quoteArg = !Array.isArray(symbols) && chunk.length === 1 && toFetch.length === 1
                        ? chunk[0]
                        : chunk;

                    const result = await apiThrottler.add(() =>
                        yahooFinance.quote(quoteArg as any, {}, { validateResult: false })
                    );
                    const quotes: any[] = !result ? [] : (Array.isArray(result) ? result : [result]);

                    const now = new Date();
                    const validQuotes = quotes.filter(
                        (q) =>
                            q &&
                            typeof q.symbol === 'string' &&
                            q.symbol.trim().length > 0 &&
                            typeof q.regularMarketPrice === 'number' &&
                            Number.isFinite(q.regularMarketPrice) &&
                            q.regularMarketPrice > 0
                    );

                    const chunkUpdatedSymbols: string[] = [];
                    if (validQuotes.length > 0) {
                        const upserts = validQuotes.map((q) => {
                            const sym = q.symbol.trim();
                            chunkUpdatedSymbols.push(sym);
                            const change = typeof q.regularMarketChange === 'number' && Number.isFinite(q.regularMarketChange)
                                ? q.regularMarketChange
                                : 0;
                            const changePercent = typeof q.regularMarketChangePercent === 'number' && Number.isFinite(q.regularMarketChangePercent)
                                ? q.regularMarketChangePercent
                                : 0;
                            const parsedMarketTime = q.regularMarketTime
                                ? parseMarketTime(q.regularMarketTime, now)
                                : undefined;

                            const updateData: Record<string, any> = {
                                price: q.regularMarketPrice,
                                change,
                                changePercent,
                                lastUpdated: now,
                            };
                            if (parsedMarketTime) {
                                updateData.marketTime = parsedMarketTime;
                            }
                            if (q.currency) {
                                updateData.currency = q.currency;
                            }

                            return prisma.marketDataCache.upsert({
                                where: { symbol: sym },
                                update: updateData,
                                create: {
                                    symbol: sym,
                                    price: q.regularMarketPrice,
                                    change,
                                    changePercent,
                                    currency: q.currency || 'USD',
                                    marketTime: parsedMarketTime ?? now,
                                    lastUpdated: now,
                                }
                            });
                        });

                        await prisma.$transaction(upserts);
                        invalidateMarketCaches({ symbols: chunkUpdatedSymbols });
                    }

                    const updatedUpper = new Set(chunkUpdatedSymbols.map((s) => s.toUpperCase()));
                    for (const sym of chunk) {
                        const deferred = claimed.get(sym);
                        if (deferred) {
                            inFlightMap.delete(sym);
                            claimed.delete(sym);
                            deferred.resolve(updatedUpper.has(sym.toUpperCase()));
                        }
                    }
                }
            } catch (err) {
                for (const [sym, deferred] of claimed.entries()) {
                    inFlightMap.delete(sym);
                    deferred.reject(err);
                }
                claimed.clear();
            } finally {
                for (const [sym, deferred] of claimed.entries()) {
                    inFlightMap.delete(sym);
                    deferred.resolve(false);
                }
                claimed.clear();
            }
        }

        const outcomes = await Promise.all(waitPromises);
        return outcomes.filter(Boolean).length;
    }

    static async getIntradayHistory(symbol: string): Promise<Record<string, number>> {
        const prices: Record<string, number> = {};
        try {
            const list = await this.getIntradayPrices(symbol);
            list.forEach(p => {
                const d = new Date(p.date).toISOString();
                prices[d] = p.value;
            });
        } catch (error) {
            console.error(`[MarketData] Failed to get intraday history for ${symbol}`, error);
        }
        return prices;
    }

    private static get intradayCache() {
        if (!(globalThis as any)._marketIntradayCache) {
            (globalThis as any)._marketIntradayCache = new Map<string, { data: { date: string, value: number }[], timestamp: number }>();
        }
        return (globalThis as any)._marketIntradayCache as Map<string, { data: { date: string, value: number }[], timestamp: number }>;
    }

    private static INTRADAY_TTL = 5 * 60 * 1000; // 5 Minutes

    /**
     * Fetches 15m intraday series for a symbol with 5-minute caching and singleflight coalescing.
     */
    static async getIntradayPrices(symbol: string): Promise<{ date: string, value: number }[]> {
        const now = Date.now();
        const cached = this.intradayCache.get(symbol);

        if (cached && (now - cached.timestamp < this.INTRADAY_TTL)) {
            return cached.data;
        }

        const inFlightMap = getInFlightMap<{ date: string, value: number }[]>('_marketIntradayInFlight');
        if (inFlightMap.has(symbol)) {
            return await inFlightMap.get(symbol)!;
        }

        const promise = (async (): Promise<{ date: string, value: number }[]> => {
            try {
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 5);

                const queryOptions = {
                    period1: startDate,
                    interval: '15m' as const,
                    includePrePost: false
                };

                const result = await apiThrottler.add(() => yahooFinance.chart(symbol, queryOptions)) as any;
                const quotes = result?.quotes || [];

                const data = quotes
                    .filter((q: any) => q.date && (q.close || q.open))
                    .map((q: any) => ({
                        date: new Date(q.date).toISOString(),
                        value: q.close || q.open
                    }));

                this.intradayCache.set(symbol, { data, timestamp: Date.now() });
                return data;
            } finally {
                inFlightMap.delete(symbol);
            }
        })();

        inFlightMap.set(symbol, promise);
        return await promise;
    }
}

// Register background SWR price flusher dynamically on MarketDataService so tests mocking refreshPriceOnly intercept it.
registerBackgroundPriceRunner((batch) => MarketDataService.refreshPriceOnly(batch));
