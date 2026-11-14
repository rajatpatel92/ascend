
import { MarketDataService } from './market-data';
import { Activity } from '@prisma/client';

export interface DailyPerformance {
    date: string;
    marketValue: number;
    nav: number; // Unitized Price
    netFlow: number;
    units: number;
    dividend: number;
    discoveryFlow?: number;
}

export interface PerformerAttribution {
    symbol: string;
    contribution: number;
    assetReturn: number;
    profit: number;
    isExited: boolean;
    return: number;
}

interface FlowData {
    date: string;
    inflow: number;
    outflow: number;
}

interface DividendData {
    date: string;
    amount: number;
}

export class PortfolioAnalytics {

    private static isIsoDateKey(key: string): boolean {
        return /^\d{4}-\d{2}-\d{2}$/.test(key);
    }

    private static getAccountPoolKey(activity: Activity): string {
        const withAccount = activity as Activity & { account?: { id?: string | null } | null };
        return activity.accountId || withAccount.account?.id || 'portfolio';
    }

    private static resolveFxRate(
        fxMap: Record<string, number> | undefined,
        dateStr: string,
        lastKnownRate?: number
    ): number | null {
        if (fxMap && fxMap[dateStr] !== undefined && fxMap[dateStr] > 0) {
            return fxMap[dateStr];
        }
        if (lastKnownRate !== undefined && lastKnownRate > 0) {
            return lastKnownRate;
        }
        if (fxMap) {
            const dateKeys = Object.keys(fxMap).filter(k => this.isIsoDateKey(k)).sort();
            let closestDate: string | null = null;
            for (const d of dateKeys) {
                if (d <= dateStr && fxMap[d] > 0) closestDate = d;
                else if (d > dateStr) break;
            }
            if (closestDate) return fxMap[closestDate];
            const firstValid = dateKeys.find(d => fxMap[d] > 0);
            if (firstValid) return fxMap[firstValid];
        }
        return null;
    }

    private static async batchProcess<T>(
        items: T[],
        batchSize: number,
        processor: (item: T) => Promise<void>
    ): Promise<void> {
        for (let i = 0; i < items.length; i += batchSize) {
            const batch = items.slice(i, i + batchSize);
            await Promise.all(batch.map(item => processor(item)));
        }
    }

    private static async fetchFxMaps(
        relevantCurrencies: string[],
        targetCurrency: string,
        lookback: Date,
        log?: (msg: string) => void
    ): Promise<Record<string, Record<string, number>>> {
        const fxMaps: Record<string, Record<string, number>> = {};
        const fxPairs = relevantCurrencies.map(c => ({ from: c, to: targetCurrency, symbol: `${c}${targetCurrency}=X` }));
        if (log) log(`[PortfolioAnalytics] Fetching FX Pairs: ${fxPairs.map(p => p.symbol).join(', ')}`);

        await this.batchProcess(fxPairs, 2, async ({ from, to, symbol }) => {
            let hist: Record<string, number> = { ...(await MarketDataService.getDailyHistory(symbol, lookback)) };

            // # Reason: Ascend's cron jobs refresh Yahoo USD-shorthand tickers (CAD=X, EUR=X, etc.)
            // rather than USDCAD=X/CADUSD=X; overlay any fresh shorthand history so FX rates don't lag.
            if (from === 'USD') {
                const shorthandSymbol = `${to}=X`;
                const shorthandHist = await MarketDataService.getDailyHistory(shorthandSymbol, lookback);
                Object.entries(shorthandHist).forEach(([date, rate]) => {
                    if (this.isIsoDateKey(date) && rate > 0) {
                        hist[date] = rate;
                    }
                });
            } else if (to === 'USD') {
                const shorthandSymbol = `${from}=X`;
                const shorthandHist = await MarketDataService.getDailyHistory(shorthandSymbol, lookback);
                Object.entries(shorthandHist).forEach(([date, rate]) => {
                    if (this.isIsoDateKey(date) && rate > 0) {
                        hist[date] = 1 / rate;
                    }
                });
            }

            // Fallback: Try Reverse Pair if combined history is still empty
            if (Object.keys(hist).length === 0) {
                const reverseSymbol = `${to}${from}=X`;
                if (log) log(`[PortfolioAnalytics] Direct FX ${symbol} empty. Trying reverse ${reverseSymbol}`);

                const reverseHist = await MarketDataService.getDailyHistory(reverseSymbol, lookback);
                if (Object.keys(reverseHist).length > 0) {
                    hist = {};
                    Object.entries(reverseHist).forEach(([date, rate]) => {
                        if (rate > 0) hist[date] = 1 / rate;
                    });
                    if (log) log(`[PortfolioAnalytics] Inverted ${Object.keys(hist).length} points from ${reverseSymbol}`);
                }
            }

            fxMaps[from] = hist;
        });

        return fxMaps;
    }

    private static seedLastKnownFx(
        relevantCurrencies: string[],
        fxMaps: Record<string, Record<string, number>>,
        referenceIso: string
    ): Record<string, number> {
        const lastKnownFx: Record<string, number> = {};
        relevantCurrencies.forEach(c => {
            const rate = this.resolveFxRate(fxMaps[c], referenceIso);
            if (rate !== null && rate > 0) {
                lastKnownFx[c] = rate;
            }
        });
        return lastKnownFx;
    }

    private static groupActivitiesByUtcDay<T extends Activity>(activities: T[]): Array<{ dateStr: string; items: T[] }> {
        const typeOrder = (t: string): number => {
            if (t === 'STOCK_SPLIT' || t === 'SPLIT') return 0;
            if (t === 'DIVIDEND') return 1;
            if (t === 'BUY' || t === 'DEPOSIT' || t === 'TRANSFER_IN') return 2;
            return 3;
        };
        const sorted = [...activities].sort((a, b) => {
            const diff = new Date(a.date).getTime() - new Date(b.date).getTime();
            if (diff !== 0) return diff;
            return typeOrder(a.type) - typeOrder(b.type);
        });
        const groups: Array<{ dateStr: string; items: T[] }> = [];
        for (const activity of sorted) {
            const dateStr = new Date(activity.date).toISOString().split('T')[0];
            const last = groups[groups.length - 1];
            if (last && last.dateStr === dateStr) {
                last.items.push(activity);
            } else {
                groups.push({ dateStr, items: [activity] });
            }
        }
        return groups;
    }

    /**
     * Processes one UTC day's non-split activities in deterministic order:
     * 1) DIVIDEND credits the account's dividend cash pool (available for same-day DRIP or future BUYs).
     * 2) BUY consumes from that pool first so reinvested dividends are excluded from out-of-pocket contributions.
     * 3) SELL/WITHDRAWAL/TRANSFER_OUT subtracts fees from proceeds and triggers oversell deficit protection.
     */
    private static applyNonSplitActivitiesForDay(params: {
        activities: (Activity & { investment: { symbol: string; currency: string } })[];
        dateStr: string;
        targetCurrency: string;
        fxMaps: Record<string, Record<string, number>>;
        lastKnownFx: Record<string, number>;
        holdings: Record<string, number>;
        dividendCashPool: Record<string, number>;
        log?: (msg: string) => void;
    }): {
        outOfPocketInflow: number;
        outOfPocketOutflow: number;
        netFlow: number;
        grossTradeFlow: number;
        dailyDividends: number;
        dailyDivBySym: Record<string, number>;
        symTradeFlowDelta: Record<string, { netInflow: number; buys: number }>;
    } {
        const { activities, dateStr, targetCurrency, fxMaps, lastKnownFx, holdings, dividendCashPool, log } = params;

        let outOfPocketInflow = 0;
        let outOfPocketOutflow = 0;
        let grossTradeFlow = 0;
        let dailyDividends = 0;
        const dailyDivBySym: Record<string, number> = {};
        const symTradeFlowDelta: Record<string, { netInflow: number; buys: number }> = {};

        const getActivityFx = (assetCurrency: string): number => {
            if (!assetCurrency || assetCurrency === targetCurrency) return 1;
            const resolved = this.resolveFxRate(fxMaps[assetCurrency], dateStr, lastKnownFx[assetCurrency]);
            const fxRate = resolved !== null && resolved > 0 ? resolved : 1;
            if (resolved !== null && resolved > 0) {
                lastKnownFx[assetCurrency] = resolved;
            }
            return fxRate;
        };

        const divActivities = activities.filter(a => a.type === 'DIVIDEND');
        const flowActivities = activities.filter(a => a.type !== 'DIVIDEND');

        // # Reason: Process DIVIDENDs before same-day BUYs so automated DRIPs (which share the exact same date)
        // draw from the dividend proceeds instead of inflating out-of-pocket capital contributions.
        for (const a of divActivities) {
            const symbol = a.investment.symbol;
            const fxRate = getActivityFx(a.investment.currency);
            const divVal = (a.quantity * a.price) * fxRate;
            dailyDividends += divVal;
            dailyDivBySym[symbol] = (dailyDivBySym[symbol] || 0) + divVal;

            if (divVal > 0) {
                const poolKey = this.getAccountPoolKey(a);
                dividendCashPool[poolKey] = (dividendCashPool[poolKey] || 0) + divVal;
            }
            if (log) {
                log(`[Dividend] ${a.date} ${symbol}: Qty=${a.quantity}, Price=${a.price}, FX=${fxRate} -> Val=${divVal} (DailyTotal=${dailyDividends})`);
            }
        }

        for (const a of flowActivities) {
            const symbol = a.investment.symbol;
            const fxRate = getActivityFx(a.investment.currency);
            if (!symTradeFlowDelta[symbol]) {
                symTradeFlowDelta[symbol] = { netInflow: 0, buys: 0 };
            }

            if (a.type === 'BUY' || a.type === 'DEPOSIT' || a.type === 'TRANSFER_IN') {
                const flowVal = (a.quantity * a.price) + (a.fee || 0);
                const flowConverted = flowVal * fxRate;
                grossTradeFlow += flowConverted;
                symTradeFlowDelta[symbol].netInflow += flowConverted;
                symTradeFlowDelta[symbol].buys += flowConverted;

                if (a.type === 'BUY' && flowConverted > 0) {
                    const poolKey = this.getAccountPoolKey(a);
                    const poolAvailable = dividendCashPool[poolKey] || 0;
                    const reinvestedFromDiv = Math.min(flowConverted, poolAvailable);
                    dividendCashPool[poolKey] = Math.max(0, poolAvailable - reinvestedFromDiv);
                    outOfPocketInflow += flowConverted - reinvestedFromDiv;
                } else {
                    outOfPocketInflow += flowConverted;
                }

                holdings[symbol] = (holdings[symbol] || 0) + a.quantity;
                if (holdings[symbol] < 0) holdings[symbol] = 0;
            } else if (a.type === 'SELL' || a.type === 'WITHDRAWAL' || a.type === 'TRANSFER_OUT') {
                const flowVal = (Math.abs(a.quantity) * a.price) - (a.fee || 0);
                const proceedsConverted = flowVal * fxRate;
                grossTradeFlow -= proceedsConverted;
                symTradeFlowDelta[symbol].netInflow -= proceedsConverted;

                if (proceedsConverted >= 0) {
                    outOfPocketOutflow += proceedsConverted;
                } else {
                    outOfPocketInflow += Math.abs(proceedsConverted);
                }

                holdings[symbol] = (holdings[symbol] || 0) - Math.abs(a.quantity);
                if (holdings[symbol] < 0) {
                    const deficit = Math.abs(holdings[symbol]);
                    const deficitVal = deficit * a.price * fxRate;
                    outOfPocketInflow += deficitVal;
                    grossTradeFlow += deficitVal;
                    symTradeFlowDelta[symbol].netInflow += deficitVal;
                    symTradeFlowDelta[symbol].buys += deficitVal;
                    holdings[symbol] = 0;
                }
            }
        }

        return {
            outOfPocketInflow,
            outOfPocketOutflow,
            netFlow: outOfPocketInflow - outOfPocketOutflow,
            grossTradeFlow,
            dailyDividends,
            dailyDivBySym,
            symTradeFlowDelta
        };
    }

    static async calculateFlows(
        activities: (Activity & { investment: { symbol: string; currency: string } })[],
        targetCurrency: string = 'CAD'
    ) {
        const sortedActivities = [...activities].sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
        );

        // 1. Identify currencies
        const assetCurrencies = Array.from(new Set(sortedActivities.map(a => a.investment.currency)));
        const relevantCurrencies = assetCurrencies.filter(c => c && c !== targetCurrency);

        // 2. Fetch FX Rates with 14-day lookback and reverse-pair fallback
        const lookback = new Date();
        if (sortedActivities.length > 0) {
            lookback.setTime(new Date(sortedActivities[0].date).getTime());
        } else {
            lookback.setUTCFullYear(lookback.getUTCFullYear() - 1);
        }
        lookback.setUTCDate(lookback.getUTCDate() - 14);

        const fxMaps = await this.fetchFxMaps(relevantCurrencies, targetCurrency, lookback);

        const flows = {
            day: new Map<string, FlowData>(),
            week: new Map<string, FlowData>(),
            month: new Map<string, FlowData>(),
            year: new Map<string, FlowData>()
        };

        const dividends = {
            month: new Map<string, DividendData>(),
            year: new Map<string, DividendData>()
        };

        const processMap = (map: Map<string, FlowData>, key: string, dateStr: string, inflow: number, outflow: number) => {
            if (!map.has(key)) map.set(key, { date: dateStr, inflow: 0, outflow: 0 });
            const e = map.get(key)!;
            e.inflow += inflow;
            e.outflow += outflow;
        };

        const processDivMap = (map: Map<string, DividendData>, key: string, dateStr: string, amount: number) => {
            if (!map.has(key)) map.set(key, { date: dateStr, amount: 0 });
            const e = map.get(key)!;
            e.amount += amount;
        };

        const dayGroups = this.groupActivitiesByUtcDay(sortedActivities);
        const startIso = dayGroups.length > 0
            ? dayGroups[0].dateStr
            : new Date().toISOString().split('T')[0];

        const lastKnownFx = this.seedLastKnownFx(relevantCurrencies, fxMaps, startIso);
        const holdings: Record<string, number> = {};
        const dividendCashPool: Record<string, number> = {};

        for (const { dateStr, items } of dayGroups) {
            const splitActivities = items.filter(a => a.type === 'STOCK_SPLIT' || a.type === 'SPLIT');
            const otherActivities = items.filter(a => a.type !== 'STOCK_SPLIT' && a.type !== 'SPLIT');

            for (const a of splitActivities) {
                const sym = a.investment.symbol;
                holdings[sym] = Math.max(0, (holdings[sym] || 0) * a.quantity);
            }

            const { outOfPocketInflow, outOfPocketOutflow, dailyDividends } = this.applyNonSplitActivitiesForDay({
                activities: otherActivities,
                dateStr,
                targetCurrency,
                fxMaps,
                lastKnownFx,
                holdings,
                dividendCashPool
            });

            const utcDate = new Date(`${dateStr}T00:00:00.000Z`);
            const yKey = String(utcDate.getUTCFullYear());
            const mKey = `${yKey}-${String(utcDate.getUTCMonth() + 1).padStart(2, '0')}`;
            const weekStart = new Date(Date.UTC(
                utcDate.getUTCFullYear(),
                utcDate.getUTCMonth(),
                utcDate.getUTCDate() - utcDate.getUTCDay()
            ));
            const wKey = weekStart.toISOString().split('T')[0];

            if (outOfPocketInflow > 0 || outOfPocketOutflow > 0) {
                processMap(flows.day, dateStr, dateStr, outOfPocketInflow, outOfPocketOutflow);
                processMap(flows.week, wKey, wKey, outOfPocketInflow, outOfPocketOutflow);
                processMap(flows.month, mKey, `${mKey}-01`, outOfPocketInflow, outOfPocketOutflow);
                processMap(flows.year, yKey, `${yKey}-01-01`, outOfPocketInflow, outOfPocketOutflow);
            }

            if (dailyDividends > 0) {
                processDivMap(dividends.month, mKey, `${mKey}-01`, dailyDividends);
                processDivMap(dividends.year, yKey, `${yKey}-01-01`, dailyDividends);
            }
        }

        const sort = <T extends { date: string }>(map: Map<string, T>) =>
            Array.from(map.values()).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        // UTC-consistent month and year gap filling
        const now = new Date();
        const nowUtcYear = now.getUTCFullYear();
        const nowUtcMonth = now.getUTCMonth();

        const startDate = sortedActivities.length > 0
            ? new Date(`${dayGroups[0].dateStr}T00:00:00.000Z`)
            : new Date(Date.UTC(nowUtcYear - 1, nowUtcMonth, 1));

        // 1. Fill Months
        {
            let year = startDate.getUTCFullYear();
            let month = startDate.getUTCMonth();
            while (year < nowUtcYear || (year === nowUtcYear && month <= nowUtcMonth)) {
                const key = `${year}-${String(month + 1).padStart(2, '0')}`;
                if (!flows.month.has(key)) {
                    flows.month.set(key, { date: `${key}-01`, inflow: 0, outflow: 0 });
                }
                if (!dividends.month.has(key)) {
                    dividends.month.set(key, { date: `${key}-01`, amount: 0 });
                }
                month += 1;
                if (month > 11) {
                    month = 0;
                    year += 1;
                }
            }
        }

        // 2. Fill Years
        {
            for (let year = startDate.getUTCFullYear(); year <= nowUtcYear; year += 1) {
                const key = String(year);
                if (!flows.year.has(key)) {
                    flows.year.set(key, { date: `${key}-01-01`, inflow: 0, outflow: 0 });
                }
                if (!dividends.year.has(key)) {
                    dividends.year.set(key, { date: `${key}-01-01`, amount: 0 });
                }
            }
        }

        return {
            contributions: {
                day: sort(flows.day),
                week: sort(flows.week),
                month: sort(flows.month),
                year: sort(flows.year)
            },
            dividends: {
                month: sort(dividends.month),
                year: sort(dividends.year)
            }
        };
    }

    static async calculateComparisonHistory(
        activities: (Activity & { investment: { symbol: string; currency: string } })[],
        benchmarkSymbol: string,
        startDate: Date,
        targetCurrency: string = 'CAD'
    ): Promise<{
        portfolio: DailyPerformance[],
        benchmark: { date: string, value: number, normalized: number }[],
        summary: { portfolioReturn: number, benchmarkReturn: number },
        performers: { top: PerformerAttribution[], bottom: PerformerAttribution[] },
        debug: string[]
    }> {
        const sortedActivities = [...activities].sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
        );

        const debug: string[] = [];
        const log = (msg: string) => {
            debug.push(msg);
        };

        log(`[PortfolioAnalytics] Starting Calculation. Target: ${targetCurrency}`);

        // 1. Identify all symbols and currencies
        const types = Array.from(new Set(sortedActivities.map(a => a.type)));
        log(`[PortfolioAnalytics] Activity Types Found: ${types.join(', ')}`);

        const symbols = Array.from(new Set(sortedActivities.map(a => a.investment.symbol)));
        const assetCurrencies = Array.from(new Set(sortedActivities.map(a => a.investment.currency)));
        const relevantCurrencies = assetCurrencies.filter(c => c && c !== targetCurrency);

        log(`[PortfolioAnalytics] Asset Currencies: ${assetCurrencies.join(', ')}`);
        log(`[PortfolioAnalytics] Relevant Currencies for FX: ${relevantCurrencies.join(', ')}`);

        // 2. Parallel Fetching: Asset Prices + FX Rates
        // Fetch from the earliest activity date or startDate, whichever is earlier
        let firstActivityDate = startDate;
        if (sortedActivities.length > 0) {
            const firstDate = new Date(sortedActivities[0].date);
            if (firstDate < firstActivityDate) firstActivityDate = firstDate;
        }

        const lookback = new Date(firstActivityDate);
        lookback.setDate(lookback.getDate() - 14);
        log(`[PortfolioAnalytics] Fetching Data from ${lookback.toISOString().split('T')[0]}`);

        const priceMaps: Record<string, Record<string, number>> = {};

        // Fetch Asset Prices in batches
        log(`[PortfolioAnalytics] Fetching history for ${symbols.length} symbols...`);
        await this.batchProcess(symbols, 2, async (sym) => {
            try {
                const hist = await MarketDataService.getDailyHistory(sym, lookback);
                priceMaps[sym] = hist;
            } catch (e: any) {
                log(`[PortfolioAnalytics] Error fetching ${sym}: ${e.message}`);
            }
        });

        // Fetch Benchmark
        try {
            const benchLookback = new Date(lookback);
            benchLookback.setFullYear(benchLookback.getFullYear() - 5);
            log(`[PortfolioAnalytics] Fetching Benchmark ${benchmarkSymbol} from ${benchLookback.toISOString()}`);
            const hist = await MarketDataService.getDailyHistory(benchmarkSymbol, benchLookback);
            priceMaps[benchmarkSymbol] = hist;
            log(`[PortfolioAnalytics] Benchmark Points: ${Object.keys(hist).length}`);
        } catch (e: any) {
            log(`[PortfolioAnalytics] Error fetching Benchmark ${benchmarkSymbol}: ${e.message}`);
        }

        // Fetch FX Rates in batches with reverse-pair fallback
        const fxMaps = await this.fetchFxMaps(relevantCurrencies, targetCurrency, lookback, log);

        log(`[PortfolioAnalytics] Fetch Complete. PriceKeys: ${Object.keys(priceMaps).length}, FXKeys: ${Object.keys(fxMaps).length}`);
        Object.keys(fxMaps).forEach(k => {
            const points = Object.keys(fxMaps[k]).length;
            log(`[PortfolioAnalytics] FX ${k}: ${points} data points. Sample: ${JSON.stringify(Object.entries(fxMaps[k]).slice(0, 3))}`);
        });

        // 3. Replay Engine
        const dailyPerf: DailyPerformance[] = [];
        const isIsoDateKey = (k: string) => this.isIsoDateKey(k);

        const startIso = startDate.toISOString().split('T')[0];
        const endDate = new Date(); // To Today
        const endIso = endDate.toISOString().split('T')[0];
        const currentDate = new Date(`${startIso}T00:00:00.000Z`);

        // Map Symbol -> Currency for fast lookup
        const symbolCurrencyMap: Record<string, string> = {};
        sortedActivities.forEach(a => symbolCurrencyMap[a.investment.symbol] = a.investment.currency);

        // # Reason: Align today's (endIso) valuation with Dashboard /api/portfolio, which uses
        // live/incremental 5-min cached quotes (getPrice & getExchangeRate) rather than yesterday's daily history close.
        const activitiesUpToEnd = sortedActivities.filter(
            a => new Date(a.date).toISOString().split('T')[0] <= endIso
        );
        const endHoldings = this.computeHoldingsState(activitiesUpToEnd);
        const activeEndSymbols = Object.keys(endHoldings).filter(sym => endHoldings[sym] > 1e-8);

        const resolveLiveFxRate = async (from: string, to: string): Promise<number | null> => {
            if (!from || !to || from === to) return 1;
            if (typeof MarketDataService.getExchangeRate !== 'function') return null;
            try {
                if (from === 'USD' || to === 'USD') {
                    return await MarketDataService.getExchangeRate(from, to);
                }
                const [toUsd, fromUsd] = await Promise.all([
                    MarketDataService.getExchangeRate(from, 'USD'),
                    MarketDataService.getExchangeRate('USD', to)
                ]);
                if (toUsd && toUsd > 0 && fromUsd && fromUsd > 0) {
                    return toUsd * fromUsd;
                }
                return await MarketDataService.getExchangeRate(from, to);
            } catch {
                return null;
            }
        };

        await this.batchProcess(relevantCurrencies, 2, async (c) => {
            const liveRate = await resolveLiveFxRate(c, targetCurrency);
            if (liveRate && liveRate > 0) {
                if (!fxMaps[c]) fxMaps[c] = {};
                fxMaps[c][endIso] = liveRate;
            }
        });

        if (typeof MarketDataService.getPrice === 'function' && activeEndSymbols.length > 0) {
            await this.batchProcess(activeEndSymbols, 5, async (sym) => {
                try {
                    const liveQuote = await MarketDataService.getPrice(sym);
                    if (liveQuote && liveQuote.price > 0) {
                        const assetCurrency = symbolCurrencyMap[sym] || liveQuote.currency || 'USD';
                        let normalizedLivePrice = liveQuote.price;

                        if (liveQuote.currency && liveQuote.currency !== assetCurrency) {
                            const quoteToAssetFx = await resolveLiveFxRate(liveQuote.currency, assetCurrency);
                            if (quoteToAssetFx && quoteToAssetFx > 0) {
                                normalizedLivePrice = liveQuote.price * quoteToAssetFx;
                            }
                        }

                        if (!priceMaps[sym]) priceMaps[sym] = {};
                        priceMaps[sym][endIso] = normalizedLivePrice;
                    }
                } catch {
                    // Preserve historical close fallback when live quote lookup fails
                }
            });
        }

        const holdings: Record<string, number> = {};
        const dividendCashPool: Record<string, number> = {};
        let units = 0;
        let nav = 100; // Start at 100
        let prevMarketValue = 0;

        const initialActivities = sortedActivities.filter(
            a => new Date(a.date).toISOString().split('T')[0] < startIso
        );

        // Seed FX at the earliest activity date (or startIso if none) before replaying initialActivities
        const firstInitialIso = initialActivities.length > 0
            ? new Date(initialActivities[0].date).toISOString().split('T')[0]
            : startIso;
        const initialLastKnownFx = this.seedLastKnownFx(relevantCurrencies, fxMaps, firstInitialIso);

        // Replay pre-start activities chronologically so both holdings and the unspent dividend pool
        // match an all-time inception replay at startIso.
        let initialDividends = 0;
        for (const { dateStr: initDateStr, items: initItems } of this.groupActivitiesByUtcDay(initialActivities)) {
            const initSplits = initItems.filter(a => a.type === 'STOCK_SPLIT' || a.type === 'SPLIT');
            const initOthers = initItems.filter(a => a.type !== 'STOCK_SPLIT' && a.type !== 'SPLIT');

            for (const a of initSplits) {
                const sym = a.investment.symbol;
                holdings[sym] = Math.max(0, (holdings[sym] || 0) * a.quantity);
            }

            const { dailyDividends } = this.applyNonSplitActivitiesForDay({
                activities: initOthers,
                dateStr: initDateStr,
                targetCurrency,
                fxMaps,
                lastKnownFx: initialLastKnownFx,
                holdings,
                dividendCashPool
            });
            initialDividends += dailyDividends;
        }
        log(`[PortfolioAnalytics] Initial Historical Dividends: ${initialDividends}`);

        // State for filling gaps (Prices & FX)
        const lastKnownPrices: Record<string, number> = {};

        // Seed Prices using the closest available price on or before startIso so
        // non-trading start dates (e.g. YTD Jan 1 or weekends) start with prior closing prices.
        Object.keys(priceMaps).forEach(sym => {
            const map = priceMaps[sym];
            // # Reason: cached market history may include summary keys ('1W', '1M', '1Y', 'YTD')
            // alongside YYYY-MM-DD entries; filter strictly to ISO dates so sort order is chronological.
            const dateKeys = Object.keys(map).filter(isIsoDateKey).sort();
            let closestDate: string | null = null;
            for (const d of dateKeys) {
                if (d <= startIso && map[d] > 0) closestDate = d;
                else if (d > startIso) break;
            }
            if (closestDate) {
                lastKnownPrices[sym] = map[closestDate];
            } else if ((holdings[sym] || 0) > 0) {
                const firstValidDate = dateKeys.find(d => map[d] > 0);
                if (firstValidDate) {
                    lastKnownPrices[sym] = map[firstValidDate];
                } else {
                    const lastPreStartTrade = [...initialActivities]
                        .reverse()
                        .find(
                            a =>
                                a.investment.symbol === sym &&
                                a.price > 0 &&
                                !['DIVIDEND', 'TRANSFER_IN', 'TRANSFER_OUT'].includes(a.type)
                        );
                    if (lastPreStartTrade) {
                        lastKnownPrices[sym] = lastPreStartTrade.price;
                    }
                }
            }
        });

        // [FIX] Initialize FX Rates for the loop at startIso
        const lastKnownFx = this.seedLastKnownFx(relevantCurrencies, fxMaps, startIso);

        // Seed Dividend Accumulator
        let accDividends = initialDividends;

        // Initial Market Value & per-symbol attribution state
        const initialEval = this.calculateMarketValue(
            holdings,
            priceMaps,
            fxMaps,
            startIso,
            lastKnownPrices,
            lastKnownFx,
            targetCurrency,
            symbolCurrencyMap
        );
        prevMarketValue = initialEval.mv;

        const symStartValue: Record<string, number> = {};
        let prevSymbolValues: Record<string, number> = {};
        const symHeldDuringPeriod = new Set<string>();
        Object.entries(holdings).forEach(([sym, qty]) => {
            if (qty > 1e-8) {
                symHeldDuringPeriod.add(sym);
                const val = initialEval.bySymbol[sym]?.val || 0;
                symStartValue[sym] = val;
                prevSymbolValues[sym] = val;
            }
        });

        const symLinkedContrib: Record<string, number> = {};
        const symUnlinkedContrib: Record<string, number> = {};
        const symNetInflows: Record<string, number> = {};
        const symTotalBuys: Record<string, number> = {};
        const symTotalDividends: Record<string, number> = {};
        let hasNonPositiveGrowthDay = false;

        // Initial Units
        if (prevMarketValue > 0) units = prevMarketValue / nav;

        // Iterate Day by Day
        while (currentDate.toISOString().split('T')[0] <= endIso) {
            const dateStr = currentDate.toISOString().split('T')[0];
            const isLastDay = dateStr === endIso;

            // 1. Identify Activities ON this day
            // [FIX] STOCK SPLIT HANDLING
            // We must process Stock Splits BEFORE calculating Passive Market Value.
            // Why? Because Market Data (Price) for this day is likely already Split-Adjusted (Lower).
            // If we use yesterday's Holdings (Low Count) * Today's Price (Low Price), we get a massive value drop.
            // We must adjust Holdings FIRST to match the new Price regime.

            const rawDaysActivities = sortedActivities.filter(a => {
                const aDate = new Date(a.date).toISOString().split('T')[0];
                return aDate === dateStr;
            });

            // Process Splits Pre-Market
            const splitActivities = rawDaysActivities.filter(a => a.type === 'STOCK_SPLIT' || a.type === 'SPLIT');
            const otherActivities = rawDaysActivities.filter(a => a.type !== 'STOCK_SPLIT' && a.type !== 'SPLIT');

            splitActivities.forEach(a => {
                const symbol = a.investment.symbol;
                // Apply Split Multiplier
                // e.g. 3:1 Split -> Quantity 3
                holdings[symbol] = (holdings[symbol] || 0) * a.quantity;

                // Negative Holdings Protection
                if (holdings[symbol] < 0) holdings[symbol] = 0;

                // Also adjust lastKnownPrice so the passive MV calculation on this day (and next)
                // doesn't spike if the new market price hasn't arrived yet.
                if (lastKnownPrices[symbol]) {
                    lastKnownPrices[symbol] /= a.quantity;
                }

                log(`[Pre-Market Split] ${symbol} multiplied by ${a.quantity}`);
            });

            // Use other activities for Net Flow calculation
            const daysActivities = otherActivities;

            // 2. Get Today's Value (Passive) - Now with Split-Adjusted Holdings if applicable
            const { mv: passiveMV, discovery: discoveryFlow, bySymbol: passiveBySymbol } = this.calculateMarketValue(
                holdings,
                priceMaps,
                fxMaps,
                dateStr,
                lastKnownPrices,
                lastKnownFx,
                targetCurrency,
                symbolCurrencyMap,
                // Pass log if date matches target range
                (dateStr === '2023-10-15' || dateStr === '2023-10-16' || dateStr === '2024-08-09') ? log : undefined
            );

            // Calculate Out-of-Pocket Net Flow & Dividends (Converted to Target Currency)
            const {
                netFlow,
                grossTradeFlow,
                dailyDividends,
                dailyDivBySym,
                symTradeFlowDelta
            } = this.applyNonSplitActivitiesForDay({
                activities: daysActivities,
                dateStr,
                targetCurrency,
                fxMaps,
                lastKnownFx,
                holdings,
                dividendCashPool,
                log
            });

            Object.entries(symTradeFlowDelta).forEach(([sym, delta]) => {
                symNetInflows[sym] = (symNetInflows[sym] || 0) + delta.netInflow;
                symTotalBuys[sym] = (symTotalBuys[sym] || 0) + delta.buys;
            });
            Object.entries(dailyDivBySym).forEach(([sym, divVal]) => {
                symTotalDividends[sym] = (symTotalDividends[sym] || 0) + divVal;
            });

            daysActivities.forEach(a => {
                const symbol = a.investment.symbol;
                symHeldDuringPeriod.add(symbol);

                // [FIX]: Ensure we update lastKnownPrices for the asset involved today.
                // If we don't, and this is a new asset, the NEXT day's calculateMarketValue loop
                // will see it as a "New Discovery" because lastKnownPrices[symbol] would be 0 or undefined,
                // causing a massive fake "inflow" equal to the entire position value.
                let priceUpdated = false;
                if (priceMaps[symbol]) {
                    if (priceMaps[symbol][dateStr] !== undefined && priceMaps[symbol][dateStr] > 0) {
                        lastKnownPrices[symbol] = priceMaps[symbol][dateStr];
                        priceUpdated = true;
                    } else {
                        // Find closest previous price if today's is missing
                        const dateKeys = Object.keys(priceMaps[symbol]).filter(isIsoDateKey).sort();
                        let closestDate = null;
                        for (const d of dateKeys) {
                            if (d <= dateStr && priceMaps[symbol][d] > 0) closestDate = d;
                            else if (d > dateStr) break;
                        }
                        if (closestDate) {
                            lastKnownPrices[symbol] = priceMaps[symbol][closestDate];
                            priceUpdated = true;
                        }
                    }
                }

                if (!priceUpdated && a.price > 0 && !['DIVIDEND', 'TRANSFER_IN', 'TRANSFER_OUT'].includes(a.type)) {
                    // Fallback to execution price ONLY if we have no market data history
                    // and this is NOT a dividend or transfer (which use historical costs/rates)
                    lastKnownPrices[symbol] = a.price;
                }
            });

            // 3. Calculate Performance (NAV Change)
            // Accumulate dividends
            accDividends += dailyDividends;

            // Adjust passive MV to include the dividends received today for NAV calculation
            // while excluding discoveryFlow (previously unpriced holding getting its first market price)
            // so missing prior price history cannot cause an artificial NAV spike.
            const adjustablePassiveMV = Math.max(0, passiveMV - discoveryFlow + dailyDividends);

            // [FIX] Epsilon Start Protection
            // Use a threshold (0.01) to avoid division by floating point dust (e.g. 1e-15)
            if (prevMarketValue > 0.01) {
                if (discoveryFlow === 0 || passiveMV > discoveryFlow || dailyDividends > 0) {
                    const growth = adjustablePassiveMV / prevMarketValue;
                    nav = nav * growth;

                    // # Reason: Attribute today's portfolio return to each symbol via its weighted
                    // daily P&L and smooth with Carino log factors so multi-day contributions
                    // sum to the portfolio's time-weighted return rather than ranking tiny positions first.
                    const dailyRet = growth - 1;
                    if (growth <= 0) {
                        hasNonPositiveGrowthDay = true;
                    }
                    const k_t = growth > 0
                        ? (Math.abs(dailyRet) > 1e-8 ? Math.log(growth) / dailyRet : 1)
                        : 1;

                    const activeDaySymbols = new Set<string>([
                        ...Object.keys(prevSymbolValues),
                        ...Object.keys(passiveBySymbol),
                        ...Object.keys(dailyDivBySym)
                    ]);

                    activeDaySymbols.forEach(sym => {
                        const prevVal = prevSymbolValues[sym] || 0;
                        const todayPassive = passiveBySymbol[sym]?.val || 0;
                        const symDiscovery = passiveBySymbol[sym]?.discovery || 0;
                        const symDiv = dailyDivBySym[sym] || 0;
                        const symPnl = (todayPassive - symDiscovery + symDiv) - prevVal;
                        const dailyContrib = symPnl / prevMarketValue;

                        symUnlinkedContrib[sym] = (symUnlinkedContrib[sym] || 0) + dailyContrib;
                        if (growth > 0) {
                            symLinkedContrib[sym] = (symLinkedContrib[sym] || 0) + dailyContrib * k_t;
                        }
                    });
                }
            } else if ((netFlow > 0 || grossTradeFlow > 0) && nav === 100) {
                // First deposit
                nav = 100;
            }

            // 4. Update Structure
            // Recalculate Final MV based on End-of-Day Holdings & Prices (MTM)
            // We use MTM to prevent Day 2 drops, but fallback to Cost (passive + grossTradeFlow)
            // if MTM is 0 despite having holdings (due to missing data).
            const { mv: recalculatedMV, bySymbol: endBySymbol } = this.calculateMarketValue(
                holdings,
                priceMaps,
                fxMaps,
                dateStr,
                lastKnownPrices,
                lastKnownFx,
                targetCurrency,
                symbolCurrencyMap
            );

            const costBasisMV = passiveMV + grossTradeFlow;
            const hasHoldings = Object.values(holdings).some(qty => qty > 0);
            const finalMV = (recalculatedMV === 0 && hasHoldings) ? costBasisMV : recalculatedMV;

            const nextPrevSymbolValues: Record<string, number> = {};
            Object.entries(endBySymbol).forEach(([sym, info]) => {
                nextPrevSymbolValues[sym] = info.val;
            });
            prevSymbolValues = nextPrevSymbolValues;

            // Log final day summary
            if (isLastDay) {
                log(`[Final Day ${dateStr}] FinalMV: ${finalMV}, PassiveMV: ${passiveMV}, NetFlow: ${netFlow}, Discovery: ${discoveryFlow}, Nav: ${nav}, Dividends: ${accDividends}`);
            }

            dailyPerf.push({
                date: dateStr,
                marketValue: finalMV,
                nav,
                netFlow: netFlow, // Store USER flows only. Discovery flow is excluded from Contribution stats.
                discoveryFlow: discoveryFlow,
                units,
                dividend: dailyDividends // Daily dividend (in target currency)
            });

            prevMarketValue = finalMV;
            currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }

        // Process Benchmark (Normalize to 100)
        // Benchmark is usually an index like ^GSPC (USD).
        // If we want to compare correctly, should we convert Benchmark to CAD?
        // Usually Benchmark Comparison is % return vs % return, so Currency doesn't matter for the Index Line itself
        // AS LONG AS we compare normalized values.
        // So we keep benchmark raw.
        const benchHist = priceMaps[benchmarkSymbol] || {};
        let lastBenchVal = 0;
        if (dailyPerf.length > 0) {
            const firstPerfDate = dailyPerf[0].date;
            const benchDates = Object.keys(benchHist).filter(isIsoDateKey).sort();
            for (const d of benchDates) {
                if (d <= firstPerfDate) {
                    if (benchHist[d] > 0) lastBenchVal = benchHist[d];
                } else {
                    break;
                }
            }
        }

        const benchmarkData = dailyPerf.map(d => {
            let val = benchHist[d.date];
            if (val) {
                lastBenchVal = val;
            } else {
                val = lastBenchVal;
            }
            return { date: d.date, value: val || 0, normalized: 0 };
        });


        // Normalize Benchmark
        const firstValid = benchmarkData.find(d => d.value > 0);
        if (firstValid) {
            const startVal = firstValid.value;
            benchmarkData.forEach(d => {
                if (d.value > 0) {
                    d.normalized = (d.value / startVal) * 100;
                } else {
                    // Backfill missing initial data (e.g. holidays) to 100 to prevent Division By Zero in Frontend
                    d.normalized = 100;
                }
            });
        } else {
            // No valid data found at all
            benchmarkData.forEach(d => d.normalized = 100);
        }

        // Calculate Summary Stats
        const portfolioStart = dailyPerf.find(d => d.marketValue > 0) || dailyPerf[0];
        const portfolioEnd = dailyPerf[dailyPerf.length - 1];

        const portfolioReturn =
            portfolioStart && portfolioEnd?.nav && portfolioStart.nav
                ? ((portfolioEnd.nav - portfolioStart.nav) / portfolioStart.nav) * 100
                : 0;

        let benchmarkReturn = 0;
        const validBenchmark = benchmarkData.filter(d => d.value > 0);
        if (validBenchmark.length > 0) {
            const start = validBenchmark[0].value;
            const end = validBenchmark[validBenchmark.length - 1].value;
            benchmarkReturn = ((end - start) / start) * 100;
        }

        // Calculate Top/Bottom Performers ranked by Portfolio Impact (Carino-linked return contribution)
        const performanceMap: PerformerAttribution[] = [];
        const totalRet = portfolioReturn / 100;
        const useCarino = !hasNonPositiveGrowthDay && (1 + totalRet) > 0;
        const totalCarinoK = useCarino
            ? (Math.abs(totalRet) > 1e-8 ? Math.log(1 + totalRet) / totalRet : 1)
            : 1;

        for (const sym of symHeldDuringPeriod) {
            if (sym === benchmarkSymbol) continue;

            const startValue = symStartValue[sym] || 0;
            const endValue = prevSymbolValues[sym] || 0;
            const netInflows = symNetInflows[sym] || 0;
            const totalBuys = symTotalBuys[sym] || 0;
            const totalDividends = symTotalDividends[sym] || 0;

            const profit = endValue - startValue - netInflows + totalDividends;
            const investedBasis = startValue + totalBuys;
            const assetReturn = investedBasis > 0.01 ? (profit / investedBasis) * 100 : 0;

            const contribution = useCarino
                ? ((symLinkedContrib[sym] || 0) / totalCarinoK) * 100
                : (symUnlinkedContrib[sym] || 0) * 100;

            const isExited = (holdings[sym] || 0) <= 1e-8;

            if (investedBasis > 0.01 || Math.abs(contribution) > 1e-6 || Math.abs(profit) > 0.01) {
                performanceMap.push({
                    symbol: sym,
                    contribution,
                    assetReturn,
                    profit,
                    isExited,
                    return: contribution
                });
            }
        }

        const sortedPerformers = performanceMap.sort((a, b) => b.contribution - a.contribution);
        const positives = sortedPerformers.filter(p => p.contribution > 0);
        const negatives = sortedPerformers.filter(p => p.contribution < 0).reverse();

        const top5 = positives.length > 0
            ? positives.slice(0, 5)
            : sortedPerformers.slice(0, 5);

        const topSymbols = new Set(top5.map(p => p.symbol));
        const nonTopAsc = [...sortedPerformers].reverse().filter(p => !topSymbols.has(p.symbol));
        const bottom5 = negatives.length > 0
            ? negatives.slice(0, 5)
            : nonTopAsc.slice(0, 5);

        return {
            portfolio: dailyPerf,
            benchmark: benchmarkData,
            summary: {
                portfolioReturn,
                benchmarkReturn
            },
            performers: {
                top: top5,
                bottom: bottom5
            },
            debug
        };
    }

    public static computeHoldingsState(activities: Activity[]) {
        const h: Record<string, number> = {};
        activities.forEach(a => {
            const s = (a as Activity & { investment: { symbol: string } }).investment.symbol;
            if (a.type === 'BUY' || a.type === 'DEPOSIT' || a.type === 'TRANSFER_IN') h[s] = (h[s] || 0) + a.quantity;
            if (a.type === 'SELL' || a.type === 'WITHDRAWAL' || a.type === 'TRANSFER_OUT') h[s] = (h[s] || 0) - Math.abs(a.quantity);
            if (a.type === 'STOCK_SPLIT' || a.type === 'SPLIT') h[s] = (h[s] || 0) * a.quantity;

            // Negative Holdings Protection: prevent negative balances due to missing history
            if (h[s] < 0) h[s] = 0;
        });
        return h;
    }

    private static calculateMarketValue(
        holdings: Record<string, number>,
        prices: Record<string, Record<string, number>>,
        fxMaps: Record<string, Record<string, number>>,
        date: string,
        lastKnownPrices: Record<string, number>,
        lastKnownFx: Record<string, number>,
        targetCurrency: string,
        symbolCurrencyMap: Record<string, string>,
        log?: (msg: string) => void
    ): { mv: number, discovery: number, bySymbol: Record<string, { val: number, discovery: number }> } {
        let mv = 0;
        let discovery = 0;
        const bySymbol: Record<string, { val: number, discovery: number }> = {};

        Object.entries(holdings).forEach(([sym, qty]) => {
            if (qty > 0) {
                const assetCurrency = symbolCurrencyMap[sym] || 'USD';

                const previousPrice = lastKnownPrices[sym] || 0;
                const todayPrice = prices[sym]?.[date];

                // Update Price
                if (todayPrice) lastKnownPrices[sym] = todayPrice;
                const currentPrice = lastKnownPrices[sym] || 0;

                // FX Rate
                let fxRate = 1;
                if (assetCurrency !== targetCurrency) {
                    const previousFx = lastKnownFx[assetCurrency] || 1;
                    const todayFx = fxMaps[assetCurrency]?.[date];
                    if (todayFx) lastKnownFx[assetCurrency] = todayFx;
                    fxRate = lastKnownFx[assetCurrency] || previousFx; // Use previousFx as fallback if lastKnownFx[assetCurrency] is still 0/undefined
                }

                const currentValConverted = qty * currentPrice * fxRate;
                let symDiscovery = 0;

                // Debug Logging for Oct 2023 Spike
                if (log && (date === '2023-10-15' || date === '2023-10-16')) {
                    log(`[${date}] ${sym} (${assetCurrency}): Qty=${qty}, Price=${currentPrice}, FX=${fxRate}, Val=${currentValConverted.toFixed(2)}`);
                }

                // Discovery?
                if (previousPrice === 0 && currentPrice > 0) {
                    // New price found! Treated as Inflow.
                    discovery += currentValConverted;
                    symDiscovery = currentValConverted;
                }

                bySymbol[sym] = { val: currentValConverted, discovery: symDiscovery };
                mv += currentValConverted;
                if (log && date === '2023-10-15') {
                    log(`[accum] MV is now ${mv} (Added ${currentValConverted})`);
                }
            }
        });

        return { mv, discovery, bySymbol };
    }

    static async calculateIntradayHistory(
        activities: Activity[],
        targetCurrency: string = 'CAD'
    ): Promise<DailyPerformance[]> {
        // 1. Calculate Current Holdings
        const holdings = this.computeHoldingsState(activities);
        const symbols = Object.keys(holdings).filter(s => holdings[s] !== 0);

        if (symbols.length === 0) return [];

        // 2. Identify Currencies
        // We need a map of Symbol -> Currency. 
        // We can get this from the activities list (last known currency for the symbol).
        const symbolCurrencyMap: Record<string, string> = {};
        const assetCurrencies = new Set<string>();

        activities.forEach(a => {
            const act = a as Activity & { investment: { symbol: string, currency: string, currencyCode: string } };
            const sym = act.investment?.symbol;
            const cur = act.investment?.currency || act.investment?.currencyCode;
            if (sym && cur) {
                symbolCurrencyMap[sym] = cur;
            }
        });

        // Fill in currencies for current holdings
        symbols.forEach(s => {
            if (symbolCurrencyMap[s]) assetCurrencies.add(symbolCurrencyMap[s]);
        });

        const relevantCurrencies = Array.from(assetCurrencies).filter(c => c !== targetCurrency);
        const fxPairs = relevantCurrencies.map(c => ({ from: c, to: targetCurrency, symbol: `${c}${targetCurrency}=X` }));

        // 3. Parallel Fetching: Intraday & Daily Seeding Data
        const priceMaps: Record<string, Record<string, number>> = {};
        const fxMaps: Record<string, Record<string, number>> = {};
        const dailyPriceMaps: Record<string, Record<string, number>> = {};
        const dailyFxMaps: Record<string, Record<string, number>> = {};

        const dailyLookback = new Date();
        dailyLookback.setDate(dailyLookback.getDate() - 7);

        const isNonEmptyMap = (obj: Record<string, number> | undefined) => {
            if (!obj) return false;
            for (const _ in obj) return true;
            return false;
        };

        // Batch all I/O calls concurrently
        await Promise.all([
            ...symbols.map(async (sym) => {
                const hist = await MarketDataService.getIntradayHistory(sym);
                if (isNonEmptyMap(hist)) priceMaps[sym] = hist;
            }),
            ...fxPairs.map(async ({ from, symbol }) => {
                const hist = await MarketDataService.getIntradayHistory(symbol);
                if (isNonEmptyMap(hist)) fxMaps[from] = hist;
            }),
            ...symbols.map(async (sym) => {
                try {
                    const dailyHist = await MarketDataService.getDailyHistory(sym, dailyLookback);
                    if (isNonEmptyMap(dailyHist)) dailyPriceMaps[sym] = dailyHist;
                } catch (e) { }
            }),
            ...fxPairs.map(async ({ from, symbol }) => {
                try {
                    const dailyHist = await MarketDataService.getDailyHistory(symbol, dailyLookback);
                    if (isNonEmptyMap(dailyHist)) dailyFxMaps[from] = dailyHist;
                } catch (e) { }
            })
        ]);

        // 4. Time Aggregation (Optimized traversal without Object.keys/Object.values allocations)
        const allTimestamps = new Set<string>();
        for (const sym in priceMaps) {
            const map = priceMaps[sym];
            for (const t in map) {
                allTimestamps.add(t);
            }
        }

        if (allTimestamps.size === 0) return [];

        const sortedTimestamps = Array.from(allTimestamps).sort();
        const lastTs = sortedTimestamps[sortedTimestamps.length - 1];
        const latestTime = new Date(lastTs).getTime();
        const cutoffTime = latestTime - (24 * 60 * 60 * 1000); // 24 hours rolling window

        // Filter to only include points from the last 24 hours of available data
        const sessionTimestamps = sortedTimestamps.filter(t => new Date(t).getTime() > cutoffTime);
        if (sessionTimestamps.length === 0) return [];

        const sessionDate = sessionTimestamps[0].split('T')[0];

        // 5. Seed initial prices & FX from daily history prior to sessionDate
        const lastKnownPrices: Record<string, number> = {};
        const lastKnownFx: Record<string, number> = {};

        symbols.forEach((sym) => {
            const dailyHist = dailyPriceMaps[sym];
            if (dailyHist) {
                let maxDate = '';
                for (const d in dailyHist) {
                    if (d < sessionDate && d > maxDate) maxDate = d;
                }
                if (maxDate && dailyHist[maxDate] > 0) {
                    lastKnownPrices[sym] = dailyHist[maxDate];
                }
            }
        });

        fxPairs.forEach(({ from }) => {
            const dailyHist = dailyFxMaps[from];
            if (dailyHist) {
                let maxDate = '';
                for (const d in dailyHist) {
                    if (d < sessionDate && d > maxDate) maxDate = d;
                }
                if (maxDate && dailyHist[maxDate] > 0) {
                    lastKnownFx[from] = dailyHist[maxDate];
                }
            }
        });

        // 6. Precompute symbol metadata for fast inner loop execution
        const symbolInfo = symbols.map(sym => {
            const cur = symbolCurrencyMap[sym];
            return {
                sym,
                qty: holdings[sym],
                cur: cur || '',
                needsFx: Boolean(cur && cur !== targetCurrency)
            };
        });

        // 7. Replay
        const result: DailyPerformance[] = [];

        for (let i = 0; i < sessionTimestamps.length; i++) {
            const ts = sessionTimestamps[i];
            let totalValue = 0;

            for (let j = 0; j < symbolInfo.length; j++) {
                const info = symbolInfo[j];
                const sym = info.sym;

                const pMap = priceMaps[sym];
                if (pMap) {
                    const val = pMap[ts];
                    if (val !== undefined) {
                        lastKnownPrices[sym] = val;
                    }
                }
                const price = lastKnownPrices[sym] || 0;

                let fx = 1;
                if (info.needsFx) {
                    const cur = info.cur;
                    const fMap = fxMaps[cur];
                    if (fMap) {
                        const val = fMap[ts];
                        if (val !== undefined) {
                            lastKnownFx[cur] = val;
                        }
                    }
                    fx = lastKnownFx[cur] || 1;
                }

                totalValue += (info.qty * price * fx);
            }

            if (totalValue > 0) {
                result.push({
                    date: ts, // ISO Timestamp
                    marketValue: totalValue,
                    nav: 0,
                    netFlow: 0,
                    units: 0,
                    dividend: 0
                });
            }
        }

        // 6. Calculate % Return for the day (Simplified NAV)
        // Base is the first point of the day
        if (result.length > 0) {
            const startVal = result[0].marketValue;
            result.forEach(r => {
                // Determine % change relative to start of day
                // Store in 'netFlow' or 'nav' as a proxy? 
                // The frontend expects 'value' and 'invested'.
                // HistoryPoint interface: value, invested.
                // We'll map this in the API route.
            });
        }

        return result;
    }
}