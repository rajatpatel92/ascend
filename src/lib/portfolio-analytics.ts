
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

    static async calculateFlows(
        activities: (Activity & { investment: { symbol: string; currency: string } })[],
        targetCurrency: string = 'CAD'
    ) {
        // 1. Identify currencies
        const assetCurrencies = Array.from(new Set(activities.map(a => a.investment.currency)));
        const relevantCurrencies = assetCurrencies.filter(c => c && c !== targetCurrency);

        // 2. Fetch FX Rates
        const lookback = new Date(); // Determine oldest activity?
        if (activities.length > 0) {
            lookback.setTime(new Date(activities[0].date).getTime());
        } else {
            lookback.setFullYear(lookback.getFullYear() - 1);
        }

        const fxMaps: Record<string, Record<string, number>> = {};
        const fxPairs = relevantCurrencies.map(c => ({ from: c, to: targetCurrency, symbol: `${c}${targetCurrency}=X` }));

        await Promise.all(fxPairs.map(async ({ from, symbol }) => {
            const hist = await MarketDataService.getDailyHistory(symbol, lookback);
            fxMaps[from] = hist;
        }));

        // 3. Aggregate
        // We reuse the structure from route.ts but strictly typed here would be better
        // For now, return raw data so route can format? Or format here? 
        // Formatting (Week/Month/Year) is better done here to keep logic encapsulated.

        const flows = {
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

        activities.forEach(a => {
            const date = new Date(a.date);
            const dateStr = date.toISOString().split('T')[0];
            const assetCurrency = a.investment.currency;

            let fx = 1;
            if (assetCurrency !== targetCurrency) {
                fx = fxMaps[assetCurrency]?.[dateStr] || 1;
                // We could implement lastKnownFx logic here too for robustness
            }

            const amount = ((a.quantity * a.price) + (a.fee || 0)) * fx;
            const divAmount = (a.quantity * a.price) * fx;

            // Generate Keys
            const yKey = date.getFullYear().toString();
            const mKey = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;

            // Week Key
            const day = date.getDay();
            const diff = date.getDate() - day;
            const weekStart = new Date(date);
            weekStart.setDate(diff);
            const wKey = weekStart.toISOString().split('T')[0];

            if (a.type === 'BUY' || a.type === 'DEPOSIT') {
                processMap(flows.week, wKey, wKey, amount, 0);
                processMap(flows.month, mKey, `${mKey}-01`, amount, 0);
                processMap(flows.year, yKey, `${yKey}-01-01`, amount, 0);
            } else if (a.type === 'SELL' || a.type === 'WITHDRAWAL') {
                processMap(flows.week, wKey, wKey, 0, Math.abs(amount));
                processMap(flows.month, mKey, `${mKey}-01`, 0, Math.abs(amount));
                processMap(flows.year, yKey, `${yKey}-01-01`, 0, Math.abs(amount));
            } else if (a.type === 'DIVIDEND') {
                processDivMap(dividends.month, mKey, `${mKey}-01`, divAmount);
                processDivMap(dividends.year, yKey, `${yKey}-01-01`, divAmount);
            }
        });

        const sort = <T extends { date: string }>(map: Map<string, T>) => Array.from(map.values()).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        // Gap Filling Logic
        const fillGaps = (
            map: Map<string, any>,
            type: 'month' | 'year',
            minDate: Date,
            maxDate: Date = new Date()
        ) => {
            if (map.size === 0 && minDate > maxDate) return;

            // Adjust minDate to start of period
            const current = new Date(minDate);
            current.setDate(1); // Start of month

            while (current <= maxDate) {
                let key = '';
                let dateStr = '';

                if (type === 'month') {
                    key = `${current.getFullYear()}-${(current.getMonth() + 1).toString().padStart(2, '0')}`;
                    dateStr = `${key}-01`;
                    // Increment
                    current.setMonth(current.getMonth() + 1);
                } else if (type === 'year') {
                    key = current.getFullYear().toString();
                    dateStr = `${key}-01-01`;
                    // Increment
                    current.setFullYear(current.getFullYear() + 1);
                }

                if (!map.has(key)) {
                    // Check structure type (FlowData vs DividendData)
                    // We can infer or check existing, but "inflow" implies FlowData
                    // Simplest is to pass factory or check what map holds? 
                    // Let's assume generic fill based on known types.
                    // Actually, we can just check if any value exists to get shape?
                    // Or just use the known shape.

                    // Since specific maps are passed, we handle them outside or make this generic.
                    // Easier to just inline or strictly type.
                }
            }
        };

        // Inline simplified gap filler for specific maps
        const now = new Date();
        // Determine start date from activities (or 1 year ago if empty?)
        let startDate = new Date();
        if (activities.length > 0) {
            activities.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
            startDate = new Date(activities[0].date);
        } else {
            startDate.setFullYear(startDate.getFullYear() - 1);
        }

        // 1. Fill Months
        {
            const current = new Date(startDate);
            current.setDate(1); // Start of month

            // Go up to current month (inclusive)
            const endMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0); // End of current month? Or just ensure we hit the month.
            // Loop until current month is processed.
            // current <= now is enough if we increment by month.

            while (current <= now || (current.getMonth() === now.getMonth() && current.getFullYear() === now.getFullYear())) {
                const key = `${current.getFullYear()}-${(current.getMonth() + 1).toString().padStart(2, '0')}`;

                // Flows
                if (!flows.month.has(key)) {
                    flows.month.set(key, { date: `${key}-01`, inflow: 0, outflow: 0 });
                }

                // Dividends
                if (!dividends.month.has(key)) {
                    dividends.month.set(key, { date: `${key}-01`, amount: 0 });
                }

                current.setMonth(current.getMonth() + 1);
            }
        }

        // 2. Fill Years
        {
            const current = new Date(startDate);
            current.setMonth(0, 1); // Start of year

            while (current.getFullYear() <= now.getFullYear()) {
                const key = current.getFullYear().toString();

                // Flows
                if (!flows.year.has(key)) {
                    flows.year.set(key, { date: `${key}-01-01`, inflow: 0, outflow: 0 });
                }

                // Dividends
                if (!dividends.year.has(key)) {
                    dividends.year.set(key, { date: `${key}-01-01`, amount: 0 });
                }

                current.setFullYear(current.getFullYear() + 1);
            }
        }

        return {
            contributions: {
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
        performers: { top: { symbol: string, return: number }[], bottom: { symbol: string, return: number }[] },
        debug: string[]
    }> {

        const debug: string[] = [];
        const log = (msg: string) => {
            // console.log(msg); // Output to server console
            debug.push(msg);
        };

        log(`[PortfolioAnalytics] Starting Calculation. Target: ${targetCurrency}`);

        // 1. Identify all symbols and currencies
        const types = Array.from(new Set(activities.map(a => a.type)));
        log(`[PortfolioAnalytics] Activity Types Found: ${types.join(', ')}`);

        const symbols = Array.from(new Set(activities.map(a => a.investment.symbol)));
        // Do NOT push benchmarkSymbol here, we fetch it separately to ensure full history coverage
        // symbols.push(benchmarkSymbol);

        const assetCurrencies = Array.from(new Set(activities.map(a => a.investment.currency)));
        const relevantCurrencies = assetCurrencies.filter(c => c && c !== targetCurrency);

        log(`[PortfolioAnalytics] Asset Currencies: ${assetCurrencies.join(', ')}`);
        log(`[PortfolioAnalytics] Relevant Currencies for FX: ${relevantCurrencies.join(', ')}`);

        // 2. Parallel Fetching: Asset Prices + FX Rates
        // Fetch from the earliest activity date or startDate, whichever is earlier
        let firstActivityDate = startDate;
        if (activities.length > 0) {
            const firstDate = new Date(activities[0].date);
            if (firstDate < firstActivityDate) firstActivityDate = firstDate;
        }

        const lookback = new Date(firstActivityDate);
        lookback.setDate(lookback.getDate() - 7);
        log(`[PortfolioAnalytics] Fetching Data from ${lookback.toISOString().split('T')[0]}`);

        const priceMaps: Record<string, Record<string, number>> = {};
        const fxMaps: Record<string, Record<string, number>> = {};

        // Prepare FX pairs to fetch
        const fxPairs = relevantCurrencies.map(c => ({ from: c, to: targetCurrency, symbol: `${c}${targetCurrency}=X` }));
        log(`[PortfolioAnalytics] Fetching FX Pairs: ${fxPairs.map(p => p.symbol).join(', ')}`);

        // Helper to process items in batches (Concurrency Control)
        // MarketDataService handles API rate limits, but we batch to avoid overwhelming the DB/Event Loop if logical processing is heavy.
        const batchProcess = async <T>(
            items: T[],
            batchSize: number,
            delayMs: number,
            processor: (item: T) => Promise<void>
        ) => {
            // Processing all at once (limited by batchSize chunks) but without artificial delay
            // actually, we can just run them all if we trust MarketDataService.
            // But to be safe, we keep batching but remove delay.
            for (let i = 0; i < items.length; i += batchSize) {
                const batch = items.slice(i, i + batchSize);
                // log(`[PortfolioAnalytics] Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(items.length / batchSize)}`);
                await Promise.all(batch.map(item => processor(item)));
                // No artificial delay needed for Cache Hits.
            }
        };

        // 2. Fetch Data (Throttled)
        // Fetch Asset Prices in batches
        log(`[PortfolioAnalytics] Fetching history for ${symbols.length} symbols...`);
        await batchProcess(symbols, 2, 1000, async (sym) => {
            try {
                const hist = await MarketDataService.getDailyHistory(sym, lookback);
                priceMaps[sym] = hist;
            } catch (e: any) {
                log(`[PortfolioAnalytics] Error fetching ${sym}: ${e.message}`);
            }
        });

        // Fetch Benchmark (Single call, no batch needed but added for completeness/flow)
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

        // Fetch FX Rates in batches
        log(`[PortfolioAnalytics] Fetching history for ${fxPairs.length} FX pairs...`);
        await batchProcess(fxPairs, 2, 1000, async ({ from, to, symbol }) => {
            let hist = await MarketDataService.getDailyHistory(symbol, lookback);

            // Fallback: Try Reverse Pair if direct pair fails
            if (Object.keys(hist).length === 0) {
                const reverseSymbol = `${to}${from}=X`;
                log(`[PortfolioAnalytics] Direct FX ${symbol} empty. Trying reverse ${reverseSymbol}`);

                const reverseHist = await MarketDataService.getDailyHistory(reverseSymbol, lookback);
                if (Object.keys(reverseHist).length > 0) {
                    // Invert values
                    hist = {};
                    Object.entries(reverseHist).forEach(([date, rate]) => {
                        if (rate > 0) hist[date] = 1 / rate;
                    });
                    log(`[PortfolioAnalytics] Inverted ${Object.keys(hist).length} points from ${reverseSymbol}`);
                }
            }

            fxMaps[from] = hist;
        });

        log(`[PortfolioAnalytics] Fetch Complete. PriceKeys: ${Object.keys(priceMaps).length}, FXKeys: ${Object.keys(fxMaps).length}`);
        Object.keys(fxMaps).forEach(k => {
            const points = Object.keys(fxMaps[k]).length;
            log(`[PortfolioAnalytics] FX ${k}: ${points} data points. Sample: ${JSON.stringify(Object.entries(fxMaps[k]).slice(0, 3))}`);
        });

        // 3. Replay Engine
        const dailyPerf: DailyPerformance[] = [];

        const currentDate = new Date(startDate);
        const endDate = new Date(); // To Today

        let holdings: Record<string, number> = {};
        let units = 0;
        let nav = 100; // Start at 100
        let prevMarketValue = 0;

        const initialActivities = activities.filter(a => new Date(a.date) < startDate);
        holdings = this.computeHoldingsState(initialActivities);

        // [FIX] Also accumulate dividends from initial activities
        let initialDividends = 0;
        // We need FX for initial dividends. 
        // Logic: Iterate initialActivities, if DIVIDEND, find FX at that date and sum.
        // Problem: We need the FX maps populated first. They are populated above.
        // So we can do this calculation now.

        initialActivities.forEach(a => {
            if (a.type === 'DIVIDEND') {
                const d = new Date(a.date).toISOString().split('T')[0];
                const sym = a.investment.currency;
                const fxMap = fxMaps[sym];
                let fx = 1;

                if (sym !== targetCurrency) {
                    if (fxMap && fxMap[d]) fx = fxMap[d];
                    else {
                        // Find closest previous FX? 
                        // For simplicity, use 1 if missing (or lastKnownFx logic?)
                        // We haven't started limits yet.
                        // Let's rely on map. If missing, maybe try to find closest in map?
                        // Using 1 is safe fallback for now.
                    }
                }
                initialDividends += (a.quantity * a.price) * fx;
            }
        });
        log(`[PortfolioAnalytics] Initial Historical Dividends: ${initialDividends}`);

        // State for filling gaps (Prices & FX)
        const lastKnownPrices: Record<string, number> = {};
        const lastKnownFx: Record<string, number> = {};

        // Seed State
        const startIso = startDate.toISOString().split('T')[0];

        // Seed Prices
        Object.keys(priceMaps).forEach(sym => {
            const map = priceMaps[sym];
            if (map[startIso]) lastKnownPrices[sym] = map[startIso];
        });

        // Seed FX
        relevantCurrencies.forEach(c => {
            const map = fxMaps[c];
            if (map && map[startIso]) lastKnownFx[c] = map[startIso];
            else lastKnownFx[c] = 1; // Default to 1 if missing start (risky but better than 0)
        });

        // Seed Dividend Accumulator
        // Removed shadowed 'dividends' variable, just renamed locally for clarity if needed or use this.
        let accDividends = initialDividends;

        // Map Symbol -> Currency for fast lookup
        const symbolCurrencyMap: Record<string, string> = {};
        activities.forEach(a => symbolCurrencyMap[a.investment.symbol] = a.investment.currency);

        // Initial Market Value
        prevMarketValue = this.calculateMarketValue(
            holdings,
            priceMaps,
            fxMaps,
            startIso,
            lastKnownPrices,
            lastKnownFx,
            targetCurrency,
            symbolCurrencyMap
        ).mv;

        // [FIX] Initialize FX Rates for the loop
        // Ensure we start with a valid FX rate (e.g. from START_DATE or closest available)
        // rather than defaulting to 1.0 inside the loop, which causes massive drops.
        relevantCurrencies.forEach(c => {
            if (fxMaps[c]) {
                const dateKeys = Object.keys(fxMaps[c]).sort();
                // Find closest date <= startDate
                // Since dateKeys are ISO strings, string comparison works for YYYY-MM-DD
                const startStr = currentDate.toISOString().split('T')[0];
                let closestDate = null;
                for (const d of dateKeys) {
                    if (d <= startStr) closestDate = d;
                    else break;
                }
                // If found, seed it. Any later dates will update it in the loop.
                // If not found (startDate is before any history?), we rely on the first available? 
                // Or fallback to 1.0 (unavoidable if no history).
                if (closestDate) {
                    lastKnownFx[c] = fxMaps[c][closestDate];
                } else if (dateKeys.length > 0) {
                    // If no prior history, use the EARLIEST history available as the best guess
                    // This prevents 1.0 default if logic starts before data
                    lastKnownFx[c] = fxMaps[c][dateKeys[0]];
                }
                log(`[Init FX] ${c}: ${lastKnownFx[c]}`);
            }
        });

        // Initial Units
        if (prevMarketValue > 0) units = prevMarketValue / nav;

        // Iterate Day by Day
        while (currentDate <= endDate) {
            const dateStr = currentDate.toISOString().split('T')[0];
            const isLastDay = dateStr === endDate.toISOString().split('T')[0];

            // 1. Identify Activities ON this day
            // [FIX] STOCK SPLIT HANDLING
            // We must process Stock Splits BEFORE calculating Passive Market Value.
            // Why? Because Market Data (Price) for this day is likely already Split-Adjusted (Lower).
            // If we use yesterday's Holdings (Low Count) * Today's Price (Low Price), we get a massive value drop.
            // We must adjust Holdings FIRST to match the new Price regime.

            const rawDaysActivities = activities.filter(a => {
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
            const { mv: passiveMV, discovery: discoveryFlow } = this.calculateMarketValue(
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

            // Calculate Net Flow & Dividends (Converted to Target Currency)
            let netFlow = 0;
            let dailyDividends = 0;

            daysActivities.forEach(a => {
                // Determine FX Rate for this transaction's currency
                const assetCurrency = a.investment.currency;
                const symbol = a.investment.symbol;

                // For Transaction Flow, we usually use the historic rate ON THAT DAY (or close to it)
                // We can use our daily FX map
                let fxRate = 1;
                if (assetCurrency !== targetCurrency) {
                    fxRate = fxMaps[assetCurrency]?.[dateStr] || lastKnownFx[assetCurrency] || 1;
                    // Note: If we have NO rate ever, we might assume 1 or 0. Data gaps in FX are bad.
                }

                if (a.type === 'BUY' || a.type === 'DEPOSIT') {
                    // Cost = (Qty * Price) + Fee
                    // All in Asset Currency? Usually Price is Asset Currency. Fee might be Account Currency?
                    // Complex. For now, assume uniform currency for simplicity or map Fee separately if needed.
                    // Given previous impl just summed standard amounts, we assume everything is "Value" in Asset Currency.
                    const flowVal = (a.quantity * a.price) + (a.fee || 0);
                    netFlow += flowVal * fxRate;

                    holdings[a.investment.symbol] = (holdings[a.investment.symbol] || 0) + a.quantity;

                    // Negative Holdings Protection
                    if (holdings[a.investment.symbol] < 0) holdings[a.investment.symbol] = 0;
                } else if (a.type === 'SELL' || a.type === 'WITHDRAWAL') {
                    const flowVal = (Math.abs(a.quantity) * a.price) - (a.fee || 0); // Proceeds - Fee
                    netFlow -= flowVal * fxRate; // Outflow is negative

                    holdings[a.investment.symbol] = (holdings[a.investment.symbol] || 0) - Math.abs(a.quantity);

                    // [FIX] Negative Holdings Protection
                    // If we sell more than we have (due to missing history/splits), treat the deficit as an implicit deposit
                    // to prevent massive value drops.
                    if (holdings[a.investment.symbol] < 0) {
                        const deficit = Math.abs(holdings[a.investment.symbol]);
                        const deficitVal = deficit * a.price;
                        // Add back the value of the missing shares to netFlow 
                        // (effectively saying "We deposited these shares just before selling them")
                        netFlow += deficitVal * fxRate;
                        holdings[a.investment.symbol] = 0;
                    }
                } else if (a.type === 'DIVIDEND') {
                    const divVal = (a.quantity * a.price);
                    dailyDividends += divVal * fxRate;
                    log(`[Dividend] ${a.date} ${symbol}: Qty=${a.quantity}, Price=${a.price}, FX=${fxRate} -> Val=${divVal * fxRate} (DailyTotal=${dailyDividends})`);
                }

                // [FIX]: Ensure we update lastKnownPrices/Fx for the asset involved today.
                // If we don't, and this is a new asset, the NEXT day's calculateMarketValue loop
                // will see it as a "New Discovery" because lastKnownPrices[symbol] would be 0 or undefined,
                // causing a massive fake "inflow" equal to the entire position value.
                if (priceMaps[symbol]?.[dateStr]) {
                    lastKnownPrices[symbol] = priceMaps[symbol][dateStr];
                } else if (a.price > 0 && a.type !== 'DIVIDEND') {
                    // Fallback to execution price ONLY if we have no market data history for TODAY
                    // and this is NOT a dividend (dividend price is not asset price)
                    lastKnownPrices[symbol] = a.price;
                }

                if (assetCurrency !== targetCurrency) {
                    lastKnownFx[assetCurrency] = fxRate;
                }
            });

            // 3. Calculate Performance (NAV Change)
            // Accumulate dividends
            accDividends += dailyDividends;

            // Adjust passive MV to include the dividends received today for NAV calculation?
            // "Price Return" usually ignores dividends. "Total Return" includes them.
            // If we add dividends to 'passiveMV' effectively we simulate reinvesting them or just holding cash.
            const adjustablePassiveMV = passiveMV + dailyDividends;

            // [FIX] Epsilon Start Protection
            // Use a threshold (0.01) to avoid division by floating point dust (e.g. 1e-15)
            if (prevMarketValue > 0.01) {
                const growth = adjustablePassiveMV / prevMarketValue;
                nav = nav * growth;
            } else if (netFlow > 0 && nav === 100) {
                // First deposit
                nav = 100;
            }

            // 4. Update Structure
            // [FIX] Recalculate Final MV based on End-of-Day Holdings & Prices
            // Previously: const finalMV = passiveMV + netFlow; 
            // We use MTM (recalculated) to prevent Day 2 drops.
            // But we must fallback to Cost (passive + netFlow) if MTM is 0 (Data Missing),
            // otherwise we get massive downspikes.
            const { mv: recalculatedMV } = this.calculateMarketValue(
                holdings,
                priceMaps,
                fxMaps,
                dateStr,
                lastKnownPrices,
                lastKnownFx,
                targetCurrency,
                symbolCurrencyMap
            );

            const costBasisMV = passiveMV + netFlow;
            const finalMV = recalculatedMV > 0 ? recalculatedMV : costBasisMV;

            // Debug decision
            if (dateStr === '2023-10-15' || dateStr === '2023-10-16') {
                log(`[mv-debug] ${dateStr}: RecalcMV=${recalculatedMV}, CostBasis=${costBasisMV}, NetFlow=${netFlow}. Selected=${finalMV}`);
            }

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
            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Process Benchmark (Normalize to 100)
        // Benchmark is usually an index like ^GSPC (USD).
        // If we want to compare correctly, should we convert Benchmark to CAD?
        // Usually Benchmark Comparison is % return vs % return, so Currency doesn't matter for the Index Line itself
        // AS LONG AS we compare normalized values.
        // So we keep benchmark raw.
        const benchHist = priceMaps[benchmarkSymbol] || {};
        let lastBenchVal = 0;

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

        const portfolioReturn = portfolioStart && portfolioEnd.nav ? ((portfolioEnd.nav - portfolioStart.nav) / portfolioStart.nav) * 100 : 0;

        let benchmarkReturn = 0;
        const validBenchmark = benchmarkData.filter(d => d.value > 0);
        if (validBenchmark.length > 0) {
            const start = validBenchmark[0].value;
            const end = validBenchmark[validBenchmark.length - 1].value;
            benchmarkReturn = ((end - start) / start) * 100;
        }

        // Calculate Top/Bottom Performers (Personal ROI Impact over period)
        const performanceMap: { symbol: string, return: number }[] = [];
        const endIso = endDate.toISOString().split('T')[0];
        const startHoldings = this.computeHoldingsState(initialActivities);

        const getClosestValue = (map: Record<string, number>, targetDate: string) => {
            if (!map) return 0;
            const dates = Object.keys(map).sort();
            let closest = 0;
            for (const d of dates) {
                if (d <= targetDate) closest = map[d];
                else break;
            }
            return closest;
        };

        for (const sym of symbols) {
            if (sym === benchmarkSymbol) continue;

            const priceMap = priceMaps[sym];
            if (!priceMap) continue;

            const assetCurrency = symbolCurrencyMap[sym] || 'USD';
            const fxMap = fxMaps[assetCurrency];

            const startQty = startHoldings[sym] || 0;
            const startPrice = getClosestValue(priceMap, startIso);
            const startFx = assetCurrency === targetCurrency ? 1 : (getClosestValue(fxMap, startIso) || 1);
            const startValue = startQty * startPrice * startFx;

            const endQty = holdings[sym] || 0;
            const endPrice = getClosestValue(priceMap, endIso);
            const endFx = assetCurrency === targetCurrency ? 1 : (getClosestValue(fxMap, endIso) || 1);
            const endValue = endQty * endPrice * endFx;

            const periodActivities = activities.filter(a => {
                const d = new Date(a.date).getTime();
                return d >= startDate.getTime() && d <= endDate.getTime() && a.investment.symbol === sym;
            });

            let totalBuys = 0;
            let netInflows = 0; 
            let totalDividends = 0;

            periodActivities.forEach(a => {
                const aIso = new Date(a.date).toISOString().split('T')[0];
                const fx = assetCurrency === targetCurrency ? 1 : (getClosestValue(fxMap, aIso) || 1);
                
                if (a.type === 'BUY' || a.type === 'DEPOSIT') {
                    const val = ((a.quantity * a.price) + (a.fee || 0)) * fx;
                    netInflows += val;
                    totalBuys += val;
                } else if (a.type === 'SELL' || a.type === 'WITHDRAWAL') {
                    const val = ((Math.abs(a.quantity) * a.price) - (a.fee || 0)) * fx;
                    netInflows -= val;
                } else if (a.type === 'DIVIDEND') {
                    const val = (a.quantity * a.price) * fx;
                    totalDividends += val;
                }
            });

            const profit = endValue - startValue - netInflows + totalDividends;
            const investedBasis = startValue + totalBuys;

            if (investedBasis > 0.01) {
                const ret = (profit / investedBasis) * 100;
                performanceMap.push({ symbol: sym, return: ret });
            } else if (startQty > 0 || totalBuys > 0) {
                performanceMap.push({ symbol: sym, return: 0 });
            }
        }

        const sortedPerformers = performanceMap.sort((a, b) => b.return - a.return);
        const top5 = sortedPerformers.slice(0, 5);
        const bottom5 = sortedPerformers.slice(-5).reverse();

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
            if (a.type === 'BUY' || a.type === 'DEPOSIT') h[s] = (h[s] || 0) + a.quantity;
            if (a.type === 'SELL' || a.type === 'WITHDRAWAL') h[s] = (h[s] || 0) - Math.abs(a.quantity);
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
    ): { mv: number, discovery: number } {
        let mv = 0;
        let discovery = 0;

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

                // Debug Logging for Oct 2023 Spike
                if (log && (date === '2023-10-15' || date === '2023-10-16')) {
                    log(`[${date}] ${sym} (${assetCurrency}): Qty=${qty}, Price=${currentPrice}, FX=${fxRate}, Val=${currentValConverted.toFixed(2)}`);
                }

                // Discovery?
                if (previousPrice === 0 && currentPrice > 0) {
                    // New price found! Treated as Inflow.
                    discovery += currentValConverted;
                }

                mv += currentValConverted;
                if (log && date === '2023-10-15') {
                    log(`[accum] MV is now ${mv} (Added ${currentValConverted})`);
                }
            }
        });

        return { mv, discovery };
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

        // 3. Fetch Intraday Data
        const priceMaps: Record<string, Record<string, number>> = {};
        const fxMaps: Record<string, Record<string, number>> = {};

        // Fetch Asset Prices
        await Promise.all(symbols.map(async (sym) => {
            const hist = await MarketDataService.getIntradayHistory(sym);
            if (Object.keys(hist).length > 0) priceMaps[sym] = hist;
        }));

        // Fetch FX
        await Promise.all(fxPairs.map(async ({ from, symbol }) => {
            const hist = await MarketDataService.getIntradayHistory(symbol);
            if (Object.keys(hist).length > 0) fxMaps[from] = hist;
            // Fallback to reverse? (Skipping for brevity, adds complexity)
        }));

        // 4. Time Aggregation
        // Collect all unique timestamps
        const allTimestamps = new Set<string>();
        Object.values(priceMaps).forEach(map => Object.keys(map).forEach(t => allTimestamps.add(t)));

        const sortedTimestamps = Array.from(allTimestamps).sort();

        // Filter for "Today" (Last 24h or Same Day as latest data?)
        // Usually 1D means "The most recent Trading Session".
        // Let's take the Date of the *last* timestamp, and filter all points from that Date.
        if (sortedTimestamps.length === 0) return [];

        const lastTs = sortedTimestamps[sortedTimestamps.length - 1];
        const latestTime = new Date(lastTs).getTime();
        const cutoffTime = latestTime - (24 * 60 * 60 * 1000); // 24 hours rolling window

        // Filter to only include points from the last 24 hours of available data
        // This supports global portfolios where assets trade in different timezones
        const sessionTimestamps = sortedTimestamps.filter(t => new Date(t).getTime() > cutoffTime);

        // 5. Replay
        const result: DailyPerformance[] = [];
        const lastKnownPrices: Record<string, number> = {};
        const lastKnownFx: Record<string, number> = {};

        // Seed with standard daily history (close) if intraday starts mid-day? 
        // Or just assume 0.
        // Better: Use the FIRST intraday value as the seed for that asset.

        // 3a. Fetch Daily Data for Seeding
        // We need the CLOSE price of the previous day to seed 'lastKnownPrices'
        // This prevents massive dips at 9:30am if an illiquid asset hasn't traded yet (price=0).
        await Promise.all(symbols.map(async (sym) => {
            // Helper to treat daily history fetch safely
            try {
                // Fetch last 7 days of daily history
                const dailyLookback = new Date();
                dailyLookback.setDate(dailyLookback.getDate() - 7);
                const dailyHist = await MarketDataService.getDailyHistory(sym, dailyLookback);

                // Find latest price BEFORE the session date
                const dates = Object.keys(dailyHist).sort();
                let seedPrice = 0;

                // If we have sessionTimestamps, we know the session date.
                // If not (empty intraday), logic handles it below (returns empty).
                const sessionDate = sessionTimestamps.length > 0
                    ? sessionTimestamps[0].split('T')[0]
                    : new Date().toISOString().split('T')[0];

                for (let i = dates.length - 1; i >= 0; i--) {
                    if (dates[i] < sessionDate) {
                        seedPrice = dailyHist[dates[i]];
                        break;
                    }
                }

                if (seedPrice > 0) {
                    lastKnownPrices[sym] = seedPrice;
                    // console.log(`[Intraday Seed] ${sym} seeded at ${seedPrice} (Pre-${sessionDate})`);
                }
            } catch (e) {
                // Ignore seed errors, fallback to 0 is default behavior
            }
        }));

        // Seed FX as well
        await Promise.all(fxPairs.map(async ({ from, symbol }) => {
            try {
                const dailyLookback = new Date();
                dailyLookback.setDate(dailyLookback.getDate() - 7);
                const dailyHist = await MarketDataService.getDailyHistory(symbol, dailyLookback);

                const dates = Object.keys(dailyHist).sort();
                let seedFx = 0;

                const sessionDate = sessionTimestamps.length > 0
                    ? sessionTimestamps[0].split('T')[0]
                    : new Date().toISOString().split('T')[0];

                for (let i = dates.length - 1; i >= 0; i--) {
                    if (dates[i] < sessionDate) {
                        seedFx = dailyHist[dates[i]];
                        break;
                    }
                }
                if (seedFx > 0) lastKnownFx[from] = seedFx;

            } catch (e) { }
        }));


        sessionTimestamps.forEach(ts => {
            let totalValue = 0;

            symbols.forEach(sym => {
                // Update Price
                if (priceMaps[sym]?.[ts]) {
                    lastKnownPrices[sym] = priceMaps[sym][ts];
                }
                const price = lastKnownPrices[sym] || 0; // If missing, assume 0 or hold previous

                // Update FX
                const cur = symbolCurrencyMap[sym];
                let fx = 1;
                if (cur && cur !== targetCurrency) {
                    if (fxMaps[cur]?.[ts]) {
                        lastKnownFx[cur] = fxMaps[cur][ts];
                    }
                    fx = lastKnownFx[cur] || 1;
                }

                totalValue += (holdings[sym] * price * fx);
            });

            if (totalValue > 0) {
                result.push({
                    date: ts, // ISO Timestamp
                    marketValue: totalValue,
                    nav: 0, // Not needed for simple chart
                    netFlow: 0,
                    units: 0,
                    dividend: 0
                });
            }
        });

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