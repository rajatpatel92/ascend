/* eslint-disable @typescript-eslint/no-explicit-any */
import YahooFinance from 'yahoo-finance2';
import { prisma } from '@/lib/prisma';

const yahooFinance = new YahooFinance({
    suppressNotices: ['yahooSurvey'],
});

// Throttler to prevent 429 Errors
class Throttler {
    private queue: Array<{ fn: () => Promise<any>, resolve: (v: any) => void, reject: (e: any) => void }> = [];
    private activeCount = 0;
    private isRateLimited = false;
    private resetTime: Date | null = null;

    constructor(private maxConcurrent: number, private delayMs: number) { }

    add<T>(fn: () => Promise<T>): Promise<T> {
        if (this.isRateLimited) {
            const remaining = this.resetTime ? Math.ceil((this.resetTime.getTime() - Date.now()) / 1000) : 60;
            return Promise.reject(new Error(`Rate limit exceeded. Cooling down for ${remaining}s.`));
        }

        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this.process();
        });
    }

    private process() {
        if (this.isRateLimited || this.activeCount >= this.maxConcurrent) return;

        const item = this.queue.shift();
        if (!item) return;

        this.activeCount++;

        item.fn()
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
                setTimeout(() => {
                    this.activeCount--;
                    this.process();
                }, this.delayMs);
            });
    }

    private triggerCircuitBreaker() {
        if (this.isRateLimited) return;

        console.error(' [THROTTLER] 429 DETECTED! Triggering Circuit Breaker for 60 seconds.');
        this.isRateLimited = true;
        this.resetTime = new Date(Date.now() + 60000); // 1 minute

        // Clear queue or let them fail? 
        // Better to reject all pending to give immediate feedback to UI
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            item?.reject(new Error('Circuit Breaker: Rate limit exceeded. Request cancelled.'));
        }

        setTimeout(() => {
            console.log(' [THROTTLER] Circuit Breaker Reset. Resuming requests.');
            this.isRateLimited = false;
            this.resetTime = null;
            this.process();
        }, 60000);
    }
}

// Global instance: 2 concurrent requests, 300ms delay between completions
const apiThrottler = new Throttler(5, 300); // Adjust concurrency

// Helper to estimate next dividend
async function estimateNextDividend(symbol: string): Promise<{ date: Date, amount: number } | undefined> {
    try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setFullYear(endDate.getFullYear() - 1); // Last 12 months

        // @ts-ignore - yahooFinance types might not support events='dividends' explicitly in some versions but it works
        const events = await apiThrottler.add(() => yahooFinance.historical(symbol, {
            period1: startDate,
            period2: endDate,
            events: 'dividends'
        }));

        if (!Array.isArray(events) || events.length < 2) return undefined;

        // Sort descending
        events.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

        const lastDiv = new Date(events[0].date);
        const prevDiv = new Date(events[1].date);

        // Calculate interval in days
        const diffTime = Math.abs(lastDiv.getTime() - prevDiv.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        let projectedDate = new Date(lastDiv);

        // Simple logic: if ~30 days, add 30. If ~90, add 90.
        if (diffDays >= 25 && diffDays <= 35) {
            projectedDate.setDate(lastDiv.getDate() + 30);
        } else if (diffDays >= 85 && diffDays <= 95) {
            projectedDate.setDate(lastDiv.getDate() + 91);
        } else if (diffDays >= 360) {
            projectedDate.setFullYear(lastDiv.getFullYear() + 1);
        } else {
            // Irregular or unknown cadence, default to last known interval
            projectedDate.setDate(lastDiv.getDate() + diffDays);
        }

        // Ensure projected date is in future (or close to now)
        // If we projected a date that is already passed (e.g. today is Jan 5, projected was Jan 1), 
        // it means we might have missed a payment or it's late. Still useful to return.

        // Return valid data
        return {
            date: projectedDate,
            amount: events[0].dividends // Use the most recent dividend amount as the estimate
        };

    } catch (e) {
        return undefined;
    }
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
     * Get current price for a symbol with caching (15 min)
     * @param forceRefresh If true, forces a fresh fetch from Yahoo API (bypassing cache checks)
     */
    static async getPrice(symbol: string, forceRefresh = false): Promise<MarketData | null> {
        try {
            // 1. Check Cache
            const cached = await prisma.marketDataCache.findUnique({
                where: { symbol }
            });

            // Check Cache Age (e.g. 5 minutes)
            const CACHE_DURATION = 5 * 60 * 1000;
            const isStale = cached ? (new Date().getTime() - new Date(cached.lastUpdated).getTime() > CACHE_DURATION) : true;

            if (!forceRefresh && cached && !isStale) {
                // Return valid cache
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
                };
            }

            // 2. Fetch from API (Only if forceRefresh is true OR cache is missing)
            // Fetch both Quote (for realtime price) and Summary (for metadata)
            const now = new Date();
            // Execute sequentially to reduce rate-limiting (429) risk compared to Promise.all
            let quoteRealtime = null;
            let lastError: any = null;
            try {
                quoteRealtime = await apiThrottler.add(() => yahooFinance.quote(symbol, {}, { validateResult: false })) as any;
            } catch (e: any) {
                lastError = e;
            }

            let quoteSummary = null;
            try {
                quoteSummary = await apiThrottler.add(() => yahooFinance.quoteSummary(symbol, { modules: ['summaryProfile', 'summaryDetail', 'topHoldings', 'calendarEvents', 'defaultKeyStatistics'] }, { validateResult: false })) as any;
            } catch (e: any) {
                if (!lastError) lastError = e;
            }

            // If both failed, throw error to trigger cache fallback or cron retry
            if ((!quoteRealtime || !quoteRealtime.regularMarketPrice) && (!quoteSummary || !quoteSummary.price?.regularMarketPrice)) {
                if (forceRefresh && lastError) throw lastError; // Propagate Rate Limit or other specific errors

                const msg = 'Failed to fetch market data from API';
                if (forceRefresh) throw new Error(msg);
                throw new Error(msg);
            }

            // Prefer Realtime Quote for Price/Change
            const priceVal = quoteRealtime?.regularMarketPrice || quoteSummary?.price?.regularMarketPrice || 0;
            const changeVal = quoteRealtime?.regularMarketChange || quoteSummary?.price?.regularMarketChange || 0;
            const changePercentVal = quoteRealtime?.regularMarketChangePercent || quoteSummary?.price?.regularMarketChangePercent || 0;
            const currencyVal = quoteRealtime?.currency || quoteSummary?.price?.currency || 'USD';
            const nameVal = quoteRealtime?.longName || quoteRealtime?.shortName || quoteSummary?.price?.longName || quoteSummary?.price?.shortName;

            // Extract Market Time
            let marketTime = now;
            if (quoteRealtime?.regularMarketTime) {
                marketTime = new Date(quoteRealtime.regularMarketTime);
            } else if (quoteSummary?.price?.regularMarketTime) {
                marketTime = new Date(quoteSummary.price.regularMarketTime);
            }

            // Use Summary for Metadata
            const profile: any = quoteSummary?.summaryProfile || {};
            const detail: any = quoteSummary?.summaryDetail || {};
            const holdings: any = quoteSummary?.topHoldings || {};
            const calendar: any = quoteSummary?.calendarEvents || {};
            const keyStats: any = quoteSummary?.defaultKeyStatistics || {};

            let dividendRate = detail.dividendRate;
            let dividendYield = detail.dividendYield;

            // Fallback for Dividend Rate/Yield
            // Some ETFs/Funds provide 'yield' or 'trailingAnnualDividendYield' instead of 'dividendYield'
            if (!dividendYield) {
                if (detail.yield) {
                    dividendYield = detail.yield;
                } else if (detail.trailingAnnualDividendYield) {
                    dividendYield = detail.trailingAnnualDividendYield;
                } else if (keyStats.yield) {
                    dividendYield = keyStats.yield;
                }
            }

            if (!dividendRate) {
                if (detail.trailingAnnualDividendRate) {
                    dividendRate = detail.trailingAnnualDividendRate;
                }
            }

            // Calculate Rate if missing but Yield exists
            if (!dividendRate && dividendYield && priceVal) {
                dividendRate = priceVal * dividendYield;
            }

            // Calculate Yield if missing but Rate exists
            if (!dividendYield && dividendRate && priceVal) {
                dividendYield = dividendRate / priceVal;
            }

            const data: MarketData = {
                symbol: symbol,
                price: priceVal,
                currency: currencyVal,
                regularMarketTime: marketTime,
                regularMarketChange: changeVal,
                regularMarketChangePercent: changePercentVal,
                sector: profile.sector,
                country: profile.country,
                fiftyTwoWeekHigh: detail.fiftyTwoWeekHigh,
                fiftyTwoWeekLow: detail.fiftyTwoWeekLow,
                sectorAllocations: holdings.sectorWeightings || [],
                countryAllocations: [],

                dividendRate: dividendRate,
                dividendYield: dividendYield,
                exDividendDate: calendar.exDividendDate ? new Date(calendar.exDividendDate) : (quoteRealtime?.exDividendDate ? new Date(quoteRealtime.exDividendDate) : undefined),
                name: nameVal
            };

            // Smart Projection: If missing Ex-Date OR Amount, try to estimate from history
            // Only do this if we are forcing refresh (Background Job) to avoid slowing down user requests
            if ((!data.exDividendDate || !data.estNextDividendAmount) && (data.dividendYield || data.dividendRate) && forceRefresh) {
                const estimated = await estimateNextDividend(symbol);
                if (estimated) {
                    data.exDividendDate = estimated.date;
                    data.estNextDividendAmount = estimated.amount;
                }
            }

            // 3. Update Cache
            await prisma.marketDataCache.upsert({
                where: { symbol },
                update: {
                    price: data.price,
                    change: data.regularMarketChange,
                    changePercent: data.regularMarketChangePercent,
                    currency: data.currency,
                    sector: data.sector,
                    country: data.country,
                    sectorAllocations: data.sectorAllocations,
                    countryAllocations: data.countryAllocations,
                    dividendRate: data.dividendRate,
                    dividendYield: data.dividendYield,
                    exDividendDate: data.exDividendDate,
                    estNextDividendAmount: data.estNextDividendAmount,
                    marketTime: data.regularMarketTime, // Store valid market time
                    lastUpdated: now
                },
                create: {
                    symbol: data.symbol,
                    price: data.price,
                    change: data.regularMarketChange,
                    changePercent: data.regularMarketChangePercent,
                    currency: data.currency,
                    sector: data.sector,
                    country: data.country,
                    sectorAllocations: data.sectorAllocations,
                    countryAllocations: data.countryAllocations,
                    marketTime: data.regularMarketTime,
                    lastUpdated: now
                }
            });

            return data;
        } catch (error: any) {
            const msg = error.message || '';
            if (msg.includes('Failed to fetch') || msg.includes('429') || msg.includes('crumb')) {
                console.warn(`[MarketData] API Error for ${symbol} (${msg}). Using cache.`);
            } else {
                console.error(`Error fetching price for ${symbol}:`, error);
            }

            // Async Architecture: Re-throw if forcing refresh
            if (forceRefresh) throw error;

            // Fallback to cache if API fails, even if stale
            const cached = await prisma.marketDataCache.findUnique({ where: { symbol } });
            if (cached) {
                return {
                    symbol: cached.symbol,
                    price: cached.price,
                    currency: cached.currency,
                    regularMarketTime: cached.marketTime || cached.lastUpdated, // Use authentic time if possible
                    regularMarketChange: cached.change,
                    regularMarketChangePercent: cached.changePercent,
                    sector: cached.sector || undefined,
                    country: cached.country || undefined,
                    sectorAllocations: cached.sectorAllocations as any[],
                    countryAllocations: cached.countryAllocations as any[],
                    dividendRate: cached.dividendRate || undefined,
                    dividendYield: cached.dividendYield || undefined,
                    exDividendDate: cached.exDividendDate || undefined,
                    estNextDividendAmount: cached.estNextDividendAmount || undefined
                };
            };
        }
        return null;
    }


    /**
     * Get exchange rate between two currencies
     * Uses Yahoo Finance tickers like "USDINR=X"
     * Refactored to use standard getPrice() for consistent caching/async architecture.
     */
    static async getExchangeRate(from: string, to: string, forceRefresh = false): Promise<number | null> {
        if (from === to) return 1;

        // Try direct pair first
        // User requested logic: USD -> Any = Any=X (e.g. USD -> INR = INR=X)
        let symbol = `${from}${to}=X`;
        if (from === 'USD') {
            symbol = `${to}=X`;
        }

        // Use getPrice to handle caching/fetching unified logic
        const data = await this.getPrice(symbol, forceRefresh);
        if (data?.price) return data.price;

        // Fallback: Try reverse pair (e.g., INRUSD=X) and invert
        let reverseSymbol = `${to}${from}=X`;
        if (to === 'USD') {
            reverseSymbol = `${from}=X`;
        }

        const reverseData = await this.getPrice(reverseSymbol, forceRefresh);
        if (reverseData?.price) return 1 / reverseData.price;

        return null;
    }


    /**
     * Get historical exchange rate for a specific date
     */
    static async getHistoricalExchangeRate(from: string, to: string, date: Date): Promise<number | null> {
        if (from === to) return 1;

        const getRateForSymbol = async (ticker: string): Promise<number | null> => {
            try {
                // Fetch window around date to handle weekends/holidays
                const startDate = new Date(date);
                startDate.setDate(startDate.getDate() - 4); // Look back 4 days
                const endDate = new Date(date);
                endDate.setDate(endDate.getDate() + 1); // Look forward 1 day

                const result = await apiThrottler.add(() => yahooFinance.chart(ticker, {
                    period1: startDate,
                    period2: endDate,
                    interval: '1d'
                })) as any;

                const quotes = result?.quotes || [];
                if (quotes.length === 0) return null;

                // Find the quote closest to but usually before or on the transaction date
                // Since we sort by date, we can just grab the valid one closest to our target date
                // Reverse iterate to find the latest valid quote on or before the target date
                const targetTime = date.getTime();

                // Sort quotes just in case
                quotes.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

                let bestQuote = null;
                for (const q of quotes) {
                    const qTime = new Date(q.date).getTime();
                    if (qTime <= targetTime + (24 * 60 * 60 * 1000)) { // Allow same day (considering timezones)
                        if (q.close || q.adjClose) {
                            bestQuote = q;
                        }
                    }
                }

                // If we didn't find one before, maybe one slightly after (e.g. strict weekend boundary)?
                // Strict logic: Closest one available.
                if (!bestQuote && quotes.length > 0) bestQuote = quotes[quotes.length - 1];

                return bestQuote ? (bestQuote.close || bestQuote.adjClose) : null;

            } catch {
                return null;
            }
        };

        // Try direct pair
        let symbol = `${from}${to}=X`;
        if (from === 'USD') symbol = `${to}=X`;

        const rate = await getRateForSymbol(symbol);
        if (rate) return rate;

        // Try reverse pair
        let reverseSymbol = `${to}${from}=X`;
        if (to === 'USD') reverseSymbol = `${from}=X`;

        const reverseRate = await getRateForSymbol(reverseSymbol);
        if (reverseRate) return 1 / reverseRate;

        return null; // Both failed
    }

    /**
     * Helper to process raw quotes into a history object with period snapshots
     */
    static processHistory(quotes: any[]): Record<string, number> {
        if (!quotes || quotes.length === 0) return {};

        const prices: Record<string, number> = {};

        // 1. Store daily prices
        for (const quote of quotes) {
            if (quote.date && (quote.close || quote.adjClose)) {
                const dateStr = new Date(quote.date).toISOString().split('T')[0];
                prices[dateStr] = quote.close || quote.adjClose;
            }
        }

        // 2. Calculate period snapshots
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

        // 1 Week ago
        const oneWeekAgo = new Date(today);
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        prices['1W'] = findPrice(oneWeekAgo);

        // 1 Month ago
        const oneMonthAgo = new Date(today);
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        prices['1M'] = findPrice(oneMonthAgo);

        // 1 Year ago
        const oneYearAgo = new Date(today);
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        prices['1Y'] = findPrice(oneYearAgo);

        // YTD (Jan 1st of current year)
        const ytd = new Date(today.getFullYear(), 0, 1);
        prices['YTD'] = findPrice(ytd);

        return prices;
    }

    /**
     * Get historical prices for performance calculation with caching (24h)
     * Returns map of period -> price
     * UPDATED: Async Architecture - returns stale cache by default.
     */
    static async getHistoricalPrices(symbol: string, forceRefresh = false): Promise<Record<string, number>> {
        try {
            // 1. Check Cache
            const cached = await prisma.marketDataCache.findUnique({
                where: { symbol }
            });

            // Async Architecture: Return cached history if available and NOT forcing refresh.
            // We ignore expiry here because the background cron handles freshness.
            if (!forceRefresh && cached?.history) {
                // Check if history is valid JSON object
                if (typeof cached.history === 'object' && cached.history !== null) {
                    // Check if we have the required keys, if not, allow re-fetch
                    // Actually, for Async, we should return whatever we have to avoid API calls.
                    // Only re-fetch if completely empty or missing critical keys?
                    // Let's be strict: if we have history, return it. Cron will fix quality.
                    const h = cached.history as Record<string, number>;
                    if (Object.keys(h).length > 0) {
                        return h;
                    }
                }
            }

            // 2. Fetch from API (Only if forceRefresh=true OR cache is missing/empty)
            // If we are here, it means we HAVE to fetch (Cold Start).
            // This might trigger 429 if many symbols are new.
            // Throttler handles it, but circuit breaker might trip.
            const endDate = new Date();
            const startDate = new Date();
            startDate.setFullYear(startDate.getFullYear() - 20); // Fetch up to 20 years back
            startDate.setDate(startDate.getDate() - 7); // Add buffer

            const queryOptions = {
                period1: startDate,
                period2: endDate,
                interval: '1d' as const,
            };

            // Use chart() instead of historical() as the latter is deprecated/broken
            const result = await apiThrottler.add(() => yahooFinance.chart(symbol, queryOptions)) as any;
            const quotes = result?.quotes || [];

            const prices = this.processHistory(quotes);

            // 3. Update Cache (merge with existing if possible, but here we just update history)
            // DO NOT update 'lastUpdated' here. 'lastUpdated' should represent PRICE freshness.
            // If we update it here, 'getPrice' will think the price is fresh even if it's old.
            const now = new Date();
            await prisma.marketDataCache.upsert({
                where: { symbol },
                update: {
                    history: prices,
                    // lastUpdated: now // DISABLED to prevent cache-freshness false positive
                },
                create: {
                    symbol,
                    price: 0, // Placeholder if creating from history call first
                    change: 0,
                    changePercent: 0,
                    currency: 'USD', // Default
                    history: prices,
                    lastUpdated: new Date(0) // Initialize as OLD so price fetch triggers immediately
                }
            });

            return prices;

        } catch (error) {
            console.error(`Error fetching historical for ${symbol}:`, error);

            // Async Architecture: If forcing refresh (Cron), re-throw error so we know it failed.
            // Do NOT fallback to cache, because we want to retry or report error.
            if (forceRefresh) throw error;

            // Fallback to cache
            const cached = await prisma.marketDataCache.findUnique({ where: { symbol } });
            if (cached?.history && typeof cached.history === 'object') {
                return cached.history as Record<string, number>;
            }
            return {};
        }
    }

    /**
     * Get full daily history for a symbol from a start date.
     * Essential for Portfolio Unitization.
     */
    static async getDailyHistory(symbol: string, fromDate?: Date, forceRefresh = false): Promise<Record<string, number>> {
        try {
            // 1. Check Cache
            const cached = await prisma.marketDataCache.findUnique({
                where: { symbol }
            });

            // Async Architecture: Return cached history if available and NOT forcing refresh.
            // Check if history object has data (keys > 0)
            if (!forceRefresh && cached?.history && typeof cached.history === 'object' && Object.keys(cached.history).length > 0) {
                return cached.history as Record<string, number>;
            }

            // 2. Fetch from API
            const endDate = new Date();
            const startDate = fromDate || new Date(new Date().setFullYear(endDate.getFullYear() - 10)); // Default 10Y

            const queryOptions = {
                period1: startDate,
                period2: endDate,
                interval: '1d' as const,
                events: 'split'
            };

            const result = await apiThrottler.add(() => yahooFinance.chart(symbol, queryOptions)) as any;
            const quotes = result?.quotes || [];
            const splits = result?.events?.splits || {};
            // Splits is an Object: { "173874623": { date:..., numerator:3, denominator:1, splitRatio:"3:1" } }
            // Map splits to Date String for easy lookup
            // Yahoo usually puts event on the Ex-Date.
            // Split of 3:1 means on Ex-Date, opening price is 1/3.
            // So Previous Close must be * 3.

            const splitMap: Record<string, number> = {};
            if (splits && typeof splits === 'object') {
                const keys = Object.keys(splits);
                Object.values(splits).forEach((s: any) => {
                    // Parse Ratio assuming "Num:Den" or usage of numerator/denominator
                    let ratio = 1;
                    if (s.numerator && s.denominator) {
                        ratio = s.numerator / s.denominator;
                    }
                    // Date can be Date object, string, or unix timestamp (seconds)
                    let dObj: Date;
                    if (s.date instanceof Date) {
                        dObj = s.date;
                    } else if (typeof s.date === 'string') {
                        dObj = new Date(s.date);
                    } else {
                        dObj = new Date(s.date * 1000);
                    }
                    const d = dObj.toISOString().split('T')[0];
                    splitMap[d] = ratio;
                });
            }

            const prices: Record<string, number> = {};
            const availableDates: Date[] = [];

            // Process Backwards to accumulate split factor
            let splitFactor = 1;

            // Sort Descending (Newest First)
            const sortedQuotes = [...quotes].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

            for (const quote of sortedQuotes) {
                const d = new Date(quote.date);
                const dateStr = d.toISOString().split('T')[0];

                // If ID matches a split date? Or date matches?
                // Yahoo events usually align with quote dates.
                // If Split happened ON this date (Ex-Date), then OLDER prices need adjustment.
                // So we update factor AFTER processing this date?
                // No, if today is Ex-Date, Today is already Low.
                // Yesterday needs to be High.
                // so we update factor AFTER reading this quote, for the NEXT (older) quote.

                let price = quote.close || quote.adjClose;

                if (price && price > 0) {
                    // Apply cumulative factor
                    price = price * splitFactor;

                    prices[dateStr] = price;
                    availableDates.push(d); // Note: Order will be desc in availableDates, sorting might be needed for findPrice?
                    // findPrice iterates all, so order doesn't matter for correctness, but perf.
                }

                if (splitMap[dateStr]) {
                    splitFactor *= splitMap[dateStr];
                }
            }

            // Re-sort availableDates ascending for findPrice/consistency?
            availableDates.sort((a, b) => a.getTime() - b.getTime());

            // 3. Populate Summary Keys (1W, 1M, 1Y, YTD) to prevent cache thrashing by getHistoricalPrices()
            // Helper to find closest price
            const findPrice = (target: Date) => {
                let closest: { date: Date, price: number } | null = null;
                let minDiff = Infinity;
                for (const d of availableDates) {
                    const diff = Math.abs(d.getTime() - target.getTime());
                    if (diff < minDiff) {
                        minDiff = diff;
                        closest = { date: d, price: prices[d.toISOString().split('T')[0]] };
                    }
                }
                // Allow matches within 4 days (weekends)
                return (closest && minDiff < 4 * 24 * 60 * 60 * 1000) ? closest.price : 0;
            };

            const today = new Date();

            // 1W
            const oneWeekAgo = new Date(today);
            oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
            prices['1W'] = findPrice(oneWeekAgo);

            // 1M
            const oneMonthAgo = new Date(today);
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            prices['1M'] = findPrice(oneMonthAgo);

            // 1Y
            const oneYearAgo = new Date(today);
            oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
            prices['1Y'] = findPrice(oneYearAgo);

            // YTD
            const ytd = new Date(today.getFullYear(), 0, 1);
            prices['YTD'] = findPrice(ytd);

            // 4. Update Cache
            // DO NOT update 'lastUpdated' here. See getHistoricalPrices.
            const now = new Date();
            await prisma.marketDataCache.upsert({
                where: { symbol },
                update: {
                    history: prices,
                    // lastUpdated: now
                },
                create: {
                    symbol,
                    price: 0,
                    change: 0,
                    changePercent: 0,
                    currency: 'USD',
                    history: prices,
                    lastUpdated: new Date(0) // Start stale
                }
            });

            return prices;
        } catch (error) {
            console.error(`Error fetching daily history for ${symbol}:`, error);

            // Async Architecture: Re-throw if forcing refresh
            if (forceRefresh) throw error;

            // Fallback to cache without checking expiry
            try {
                const cached = await prisma.marketDataCache.findUnique({ where: { symbol } });
                if (cached?.history) return cached.history as Record<string, number>;
            } catch (ignore) { }
            return {};
        }
    }


    /**
     * Refresh all market data for a symbol (Price, Profile, History)
     * This is intended to be called in the background
     */
    static async refreshMarketData(symbol: string): Promise<void> {
        try {
            // Force rebuild
            console.log(`Refreshing market data for ${symbol}...`);
            const now = new Date();

            // 1. Fetch Quote (Price, Profile, Top Holdings for ETF)
            const quote = await apiThrottler.add(() => yahooFinance.quoteSummary(symbol, { modules: ['price', 'summaryProfile', 'summaryDetail', 'topHoldings', 'calendarEvents', 'defaultKeyStatistics'] })) as any;

            let priceData = {
                price: 0,
                change: 0,
                changePercent: 0,
                currency: 'USD',
                sector: undefined as string | undefined,
                country: undefined as string | undefined,
                sectorAllocations: undefined as any,
                countryAllocations: undefined as any,
                dividendRate: undefined as number | undefined,
                dividendYield: undefined as number | undefined,
                exDividendDate: undefined as Date | undefined
            };


            if (quote && quote.price) {
                const p = quote.price;
                const profile = quote.summaryProfile || {};
                const holdings = quote.topHoldings || {};
                const calendar = quote.calendarEvents || {};

                priceData = {
                    price: p.regularMarketPrice || 0,
                    change: p.regularMarketChange || 0,
                    changePercent: p.regularMarketChangePercent || 0,
                    currency: p.currency || 'USD',
                    sector: profile.sector,
                    country: profile.country,
                    sectorAllocations: holdings.sectorWeightings || [],
                    countryAllocations: [], // Yahoo doesn't provide country breakdown easily in this module, leaving empty for now

                    dividendRate: quote.summaryDetail?.dividendRate,
                    dividendYield: quote.summaryDetail?.dividendYield,
                    exDividendDate: calendar.exDividendDate ? new Date(calendar.exDividendDate) : undefined
                };

                const detail = quote.summaryDetail || {};
                const keyStats = quote.defaultKeyStatistics || {};

                let dividendRate = detail.dividendRate;
                let dividendYield = detail.dividendYield;

                // Fallback for Dividend Rate/Yield
                if (!dividendYield) {
                    if (detail.yield) {
                        dividendYield = detail.yield;
                    } else if (detail.trailingAnnualDividendYield) {
                        dividendYield = detail.trailingAnnualDividendYield;
                    } else if (keyStats.yield) {
                        dividendYield = keyStats.yield;
                    }
                }

                if (!dividendRate) {
                    if (detail.trailingAnnualDividendRate) {
                        dividendRate = detail.trailingAnnualDividendRate;
                    }
                }

                // Calculate Rate if missing but Yield exists
                if (!dividendRate && dividendYield && priceData.price) {
                    dividendRate = priceData.price * dividendYield;
                }

                // Calculate Yield if missing but Rate exists
                if (!dividendYield && dividendRate && priceData.price) {
                    dividendYield = dividendRate / priceData.price;
                }

                priceData.dividendRate = dividendRate;
                priceData.dividendYield = dividendYield;
            }

            // 2. Fetch History (Chart)
            const endDate = new Date();
            const startDate = new Date();
            startDate.setFullYear(startDate.getFullYear() - 20); // Support up to 20y for ALL/10Y
            startDate.setDate(startDate.getDate() - 7);

            const queryOptions = {
                period1: startDate,
                period2: endDate,
                interval: '1d' as const,
            };

            const chartResult = await yahooFinance.chart(symbol, queryOptions) as any;
            const quotes = chartResult?.quotes || [];

            const history = this.processHistory(quotes);

            // 3. Update Cache (Upsert)
            await prisma.marketDataCache.upsert({
                where: { symbol },
                update: {
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
                    history: history,
                    lastUpdated: now
                },
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
                    history: history,
                    lastUpdated: now
                }
            });

            console.log(`Market data refreshed for ${symbol}`);

        } catch (error) {
            console.error(`Error refreshing market data for ${symbol}:`, error);
            // We don't throw here to avoid crashing the background process
        }

    }

    /**
     * Efficiently updates ONLY current price and change data.
     * Skips history, profiles, dividends.
     * Used for frequent (e.g. 2 min) cron updates.
     */
    static async refreshPriceOnly(symbol: string): Promise<void> {
        try {
            const quote = await apiThrottler.add(() => yahooFinance.quote(symbol));
            if (!quote) return;

            const priceData = {
                price: quote.regularMarketPrice || 0,
                change: quote.regularMarketChange || 0,
                changePercent: quote.regularMarketChangePercent || 0,
                lastUpdated: new Date()
            };

            await prisma.marketDataCache.updateMany({
                where: { symbol },
                data: priceData
            });
        } catch (error) {
            throw error;
        }
    }


    static async getIntradayHistory(symbol: string): Promise<Record<string, number>> {
        const prices: Record<string, number> = {};
        try {
            const list = await this.getIntradayPrices(symbol);
            list.forEach(p => {
                // Ensure date is ISO string full timestamp
                const d = new Date(p.date).toISOString();
                prices[d] = p.value;
            });
        } catch (error) {
            console.error(`[MarketData] Failed to get intraday history for ${symbol}`, error);
        }
        return prices;
    }

    // Use global cache to survive module reloads
    private static get intradayCache() {
        if (!(global as any)._marketIntradayCache) {
            (global as any)._marketIntradayCache = new Map<string, { data: { date: string, value: number }[], timestamp: number }>();
        }
        return (global as any)._marketIntradayCache as Map<string, { data: { date: string, value: number }[], timestamp: number }>;
    }

    // Increased to 5 minutes to improve 1D chart loading
    private static INTRADAY_TTL = 5 * 60 * 1000; // 5 Minutes

    static async getIntradayPrices(symbol: string): Promise<{ date: string, value: number }[]> {
        const now = Date.now();
        const cached = this.intradayCache.get(symbol);

        // 1. Return Cache if Valid
        if (cached && (now - cached.timestamp < this.INTRADAY_TTL)) {
            return cached.data;
        }

        try {
            // Calculate start date (5 days ago to ensure we get full recent session)
            // Yahoo sometimes returns empty if weekend, so we need enough buffer to find the last valid session
            const startDate = new Date();
            startDate.setDate(startDate.getDate() - 5);

            const queryOptions = {
                period1: startDate,
                interval: '15m' as const,
                includePrePost: false
            };

            const result = await apiThrottler.add(() => yahooFinance.chart(symbol, queryOptions)) as any;
            const quotes = result?.quotes || [];

            // Return all quotes, filtering will happen in Analytics
            const data = quotes
                .filter((q: any) => q.date && (q.close || q.open))
                .map((q: any) => ({
                    date: new Date(q.date).toISOString(),
                    value: q.close || q.open
                }));

            // 2. Set Cache
            this.intradayCache.set(symbol, { data, timestamp: now });

            return data;

        } catch (error) {
            throw error;
        }
    }
}
