import { NextResponse, NextRequest } from 'next/server';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';
import { calculateXIRR, Transaction } from '@/lib/xirr';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const targetCurrency = searchParams.get('currency') || 'USD';
        const investmentTypes = searchParams.get('investmentTypes')?.split(',') || [];
        const accountTypes = searchParams.get('accountTypes')?.split(',') || [];

        // 1. Fetch all activities and activity types
        const [allActivities, activityTypes] = await Promise.all([
            prisma.activity.findMany({
                include: {
                    investment: true,
                    platform: true,
                    account: true,
                },
                orderBy: { date: 'asc' }
            }),
            prisma.activityType.findMany()
        ]);

        // Apply Filters
        let activities = allActivities;
        if (investmentTypes.length > 0) {
            activities = activities.filter(a => investmentTypes.includes(a.investment.type));
        }
        if (accountTypes.length > 0) {
            activities = activities.filter(a => a.account && accountTypes.includes(a.account.type));
        }

        // Map activity type name to behavior
        const behaviorMap = new Map<string, string>();
        activityTypes.forEach(t => behaviorMap.set(t.name, t.behavior));

        // Default behaviors if not found (fallback)
        if (!behaviorMap.has('BUY')) behaviorMap.set('BUY', 'ADD');
        if (!behaviorMap.has('SELL')) behaviorMap.set('SELL', 'REMOVE');
        if (!behaviorMap.has('DIVIDEND')) behaviorMap.set('DIVIDEND', 'NEUTRAL');
        if (!behaviorMap.has('TRANSFER_IN')) behaviorMap.set('TRANSFER_IN', 'ADD');
        if (!behaviorMap.has('TRANSFER_OUT')) behaviorMap.set('TRANSFER_OUT', 'REMOVE');

        // Fetch Users for Display Name mapping
        const users = await prisma.user.findMany();
        const userMap = new Map<string, string>();
        users.forEach(u => {
            if (u.name) {
                userMap.set(u.username.toLowerCase(), u.name);
            }
        });

        // 2. Calculate holdings
        const holdingsMap = new Map<string, {
            quantity: number,
            investment: any,
            platforms: Map<string, number>,
            accounts: Map<string, { quantity: number, platformName: string, accountType: string, costBasis: number, lifetimeDividends: number, dividendsYTD: number, realizedGain: number, cashFlows: Transaction[], firstBuyDate: Date | null }>
        }>();

        for (const activity of activities) {
            const symbol = activity.investment.symbol;
            if (!holdingsMap.has(symbol)) {
                holdingsMap.set(symbol, {
                    quantity: 0,
                    investment: activity.investment,
                    platforms: new Map(),
                    accounts: new Map()
                });
            }

            const current = holdingsMap.get(symbol)!;
            const platformName = activity.platform?.name || 'Unknown';

            // Resolve Account Name to Display Name if available
            let accountName = activity.account?.name || 'Unassigned';
            // Check if account name matches a username (case-insensitive)
            const displayName = userMap.get(accountName.toLowerCase());
            if (displayName) {
                accountName = displayName;
            }

            const accountType = activity.account?.type || 'Unassigned';
            const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';
            const absQty = Math.abs(activity.quantity);

            // Per-Account Cash Flow tracking
            const amount = absQty * activity.price;
            const fee = activity.fee || 0;

            // Generate Unique Key for Account aggregation
            // User might have multiple accounts with same Name but different Type
            // Generate Unique Key for Account aggregation
            // User might have multiple accounts with same Name but different Type
            // AND same Name/Type across different Platforms. Must include Platform to separate.
            const accountKey = `${accountName}:${accountType}:${platformName}`;

            // Get account data or init
            let acc = current.accounts.get(accountKey);
            if (!acc) {
                acc = { quantity: 0, platformName, accountType, costBasis: 0, lifetimeDividends: 0, dividendsYTD: 0, realizedGain: 0, cashFlows: [], firstBuyDate: null };
                current.accounts.set(accountKey, acc);
            }

            if (behavior === 'ADD') {
                current.quantity += absQty;
                // Cost Basis Aggruction Add: (Qty * Price) + Fee
                const cost = (absQty * activity.price) + fee;
                current.platforms.set(platformName, (current.platforms.get(platformName) || 0) + absQty);

                acc.quantity += absQty;
                acc.costBasis += cost;
                acc.cashFlows.push({ amount: -(amount + fee), date: activity.date });

                // Track First Buy Date
                if (!acc.firstBuyDate || new Date(activity.date) < new Date(acc.firstBuyDate)) {
                    acc.firstBuyDate = activity.date;
                }

            } else if (behavior === 'REMOVE') {
                const prevQty = current.quantity;
                current.quantity -= absQty;
                current.platforms.set(platformName, Math.max(0, (current.platforms.get(platformName) || 0) - absQty));

                const proportion = acc.quantity > 0 ? (absQty / acc.quantity) : 0;
                const costToRemove = acc.costBasis * proportion;

                // Realized ID: (Proceeds) - (Cost of these specific shares)
                const realized = (amount - fee) - costToRemove;
                acc.realizedGain += realized;

                acc.quantity = Math.max(0, acc.quantity - absQty);
                acc.costBasis = Math.max(0, acc.costBasis - costToRemove);
                acc.cashFlows.push({ amount: (amount - fee), date: activity.date });

            } else if (activity.type === 'DIVIDEND') {
                // Dividends are cash inflows for the account
                acc.cashFlows.push({ amount: (amount - fee), date: activity.date });
                acc.lifetimeDividends += (amount - fee);

                if (new Date(activity.date).getFullYear() === new Date().getFullYear()) {
                    acc.dividendsYTD += (amount - fee);
                }

            } else if (behavior === 'SPLIT') {
                const multiplier = absQty;
                if (multiplier > 0) {
                    current.quantity *= multiplier;
                    for (const [pName, pQty] of current.platforms.entries()) {
                        current.platforms.set(pName, pQty * multiplier);
                    }
                    for (const [_, aData] of current.accounts.entries()) {
                        // Split doesn't affect cash flows (no money changed hands), just share count
                        aData.quantity *= multiplier;
                    }
                }
            }
            // NEUTRAL does not affect quantity

            holdingsMap.set(symbol, current);
        }

        // 3. Fetch market data and calculate totals
        let totalValue = 0;
        let totalCostBasis = 0; // Track total cost basis
        let totalDayChange = 0;
        const allocationByType: Record<string, number> = {};
        const allocationByPlatform: Record<string, number> = {};
        const allocationByAccount: Record<string, { value: number, platformName: string }> = {};
        const allocationByAccountType: Record<string, number> = {};
        const allocationByAsset: { name: string; value: number }[] = [];
        const constituents: any[] = [];
        const upcomingDividends: any[] = [];
        let dividendsYTD = 0;
        let totalLifetimeDividends = 0;
        let projectedDividends = 0;

        // Global Cash Flows for Portfolio XIRR
        const portfolioCashFlows: Transaction[] = [];
        let globalFirstBuyDate: Date | null = null;
        const nowGlobal = new Date();
        const date1YGlobal = new Date(nowGlobal); date1YGlobal.setFullYear(nowGlobal.getFullYear() - 1);

        // ... (Market Data Fetching Loop) ...
        // Process Assets (Batched)
        const processHolding = async ([symbol, data]: [string, any]) => {
            try {
                // 1. Fetch Market Data & History in Parallel
                // Note: MarketDataService is now globally throttled, so these calls are safe
                const [marketData, historicalPrices] = await Promise.all([
                    MarketDataService.getPrice(symbol),
                    MarketDataService.getHistoricalPrices(symbol)
                ]);

                const price = marketData?.price || 0;
                let regularMarketChange = marketData?.regularMarketChange || 0;
                let regularMarketChangePercent = marketData?.regularMarketChangePercent || 0;
                const currency = marketData?.currency || 'USD';

                // 24-Hour Rule: If data is older than 24h, show 0 change
                if (marketData?.regularMarketTime) {
                    const dataTime = new Date(marketData.regularMarketTime).getTime();
                    const nowTime = new Date().getTime();
                    const diffHours = (nowTime - dataTime) / (1000 * 60 * 60);

                    if (diffHours > 24) {
                        regularMarketChange = 0;
                        regularMarketChangePercent = 0;
                    }
                }

                // Get exchange rate if needed
                let rateToUSD = 1;
                if (currency !== 'USD') {
                    const r = await MarketDataService.getExchangeRate(currency, 'USD');
                    if (r) rateToUSD = r;
                }

                // 2. Calculate Cost Basis & Cash Flows
                let totalBuyCost = 0;
                let totalSellProceeds = 0;
                let totalBuyQty = 0;
                let localDividendsYTD = 0;
                let localLifetimeDividends = 0;
                const symbolCashFlows: Transaction[] = [];

                const symbolActivities = activities.filter((a: any) => a.investment.symbol === symbol);

                // Process Activities
                for (const activity of symbolActivities) {
                    const absQty = Math.abs(activity.quantity);
                    const amount = absQty * activity.price;
                    const fee = activity.fee || 0;
                    const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';

                    if (behavior === 'ADD') {
                        totalBuyCost += amount;
                        totalBuyQty += absQty;
                        symbolCashFlows.push({ amount: -(amount + fee), date: activity.date });
                    } else if (behavior === 'REMOVE') {
                        symbolCashFlows.push({ amount: (amount - fee), date: activity.date });
                        totalSellProceeds += (amount - fee);
                    } else if (activity.type === 'DIVIDEND') {
                        const netAmount = amount - fee;
                        symbolCashFlows.push({ amount: netAmount, date: activity.date });

                        // Lifetime Dividends (for Total Return)
                        localLifetimeDividends += netAmount;

                        const activityYear = new Date(activity.date).getFullYear();
                        if (activityYear === new Date().getFullYear()) {
                            localDividendsYTD += netAmount;
                        }
                    } else if (behavior === 'SPLIT') {
                        const multiplier = absQty;
                        if (multiplier > 0) {
                            totalBuyQty *= multiplier;
                        }
                    }
                }

                const avgBuyPrice = totalBuyQty > 0 ? totalBuyCost / totalBuyQty : 0;
                const costBasis = avgBuyPrice * data.quantity;
                const value = data.quantity * price;
                const dayChange = data.quantity * regularMarketChange;

                // Calculate Realized Gain (Proceeds - Cost of Sold Shares)
                // Cost of Sold = Total Buy Cost - Remaining Cost Basis
                const costOfSold = totalBuyCost - costBasis;
                const realizedGainNative = totalSellProceeds - costOfSold;

                // Add Current Value as "Inflow" for XIRR
                if (data.quantity > 0) {
                    symbolCashFlows.push({ amount: value, date: new Date() });
                }

                // XIRR Calculation
                let xirr = null;
                // Calculate period start dates
                const now = new Date();
                const date1W = new Date(now); date1W.setDate(now.getDate() - 7);
                const date1M = new Date(now); date1M.setMonth(now.getMonth() - 1);
                const date1Y = new Date(now); date1Y.setFullYear(now.getFullYear() - 1);
                const dateYTD = new Date(now.getFullYear(), 0, 1);

                const firstBuyActivity = symbolActivities
                    .filter((a: any) => behaviorMap.get(a.type) === 'ADD')
                    .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())[0];
                const firstBuyDate = firstBuyActivity ? new Date(firstBuyActivity.date) : new Date();

                if (firstBuyDate <= date1Y) {
                    xirr = calculateXIRR(symbolCashFlows);
                }

                // Historical Changes
                const calculateChange = (oldPrice: number, periodStartDate: Date) => {
                    if (!oldPrice || firstBuyDate > periodStartDate) return null;
                    const change = price - oldPrice;
                    return {
                        absolute: change * data.quantity,
                        percent: (change / oldPrice) * 100
                    };
                };

                const change1W = calculateChange(historicalPrices['1W'], date1W);
                const change1M = calculateChange(historicalPrices['1M'], date1M);
                const change1Y = calculateChange(historicalPrices['1Y'], date1Y);
                const changeYTD = calculateChange(historicalPrices['YTD'], dateYTD);

                const inceptionChange = {
                    absolute: value - costBasis,
                    percent: costBasis > 0 ? ((value - costBasis) / costBasis) * 100 : 0
                };

                // Upcoming Dividends
                let upcomingDividend = null;
                if (data.quantity > 0 && marketData?.exDividendDate) {
                    const exDate = new Date(marketData.exDividendDate);
                    const now = new Date();
                    const cutoff = new Date();
                    cutoff.setDate(now.getDate() + 45); // Next 45 days (~1.5 months)

                    if (exDate >= now && exDate <= cutoff) {
                        // Estimate Amount: Use exact estimate if available, else assume Quarterly (Rate/4) as crude fallback
                        const estimatedAmountPerShare = marketData.estNextDividendAmount || ((marketData.dividendRate || 0) / 4);

                        upcomingDividend = {
                            symbol,
                            exDate: exDate.toISOString(),
                            rate: marketData.dividendRate || 0,
                            quantity: data.quantity,
                            estimatedAmount: estimatedAmountPerShare * data.quantity * rateToUSD
                        };
                    }
                }

                return {
                    success: true,
                    symbol,
                    marketData,
                    data,
                    price,
                    rateToUSD,
                    value,
                    costBasis,
                    dayChange,
                    valueUSD: data.quantity > 0 ? value * rateToUSD : 0,
                    costBasisUSD: data.quantity > 0 ? costBasis * rateToUSD : 0,
                    dayChangeUSD: data.quantity > 0 ? dayChange * rateToUSD : 0,
                    symbolCashFlows,
                    dividendsYTD: localDividendsYTD * rateToUSD,
                    lifetimeDividends: localLifetimeDividends * rateToUSD,
                    projectedDividends: ((data.quantity > 0 && marketData?.dividendRate) ? (marketData.dividendRate * data.quantity) : 0) * rateToUSD,
                    constituent: (data.quantity > 0 || localLifetimeDividends > 0 || Math.abs(realizedGainNative) > 0.01) ? {
                        symbol,
                        name: data.investment.name,
                        type: data.investment.type,
                        quantity: data.quantity,
                        price,
                        avgPrice: avgBuyPrice,
                        bookValue: costBasis,
                        value,
                        rateToUSD,
                        currency,
                        dayChange: {
                            absolute: dayChange,
                            percent: regularMarketChangePercent
                        },
                        change1W,
                        change1M,
                        change1Y,
                        changeYTD,
                        inceptionChange,
                        xirr,
                        dividendYield: marketData?.dividendYield || 0,
                        lifetimeDividends: localLifetimeDividends * rateToUSD,
                        dividendsYTD: localDividendsYTD * rateToUSD,
                        realizedGain: realizedGainNative * rateToUSD,
                        accountTypes: Array.from(new Set(Array.from((data.accounts as Map<string, any>).values()).map((a: any) => a.accountType || 'Unassigned'))),
                        accountNames: Array.from(new Set(Array.from((data.accounts as Map<string, any>).keys()).map((k: string) => k.split(':')[0]))),

                        accountsBreakdown: Object.fromEntries(
                            Array.from((data.accounts as Map<string, any>).entries())
                                .filter(([_, val]: [string, any]) => val.quantity > 0 || val.lifetimeDividends > 0 || Math.abs(val.realizedGain) > 0.01)
                                .map(([key, val]: [string, any]) => {
                                    // Parse name from composite key if needed
                                    const [accName] = key.split(':');

                                    // Calculate Account XIRR
                                    // Add current value as final inflow
                                    const accountValueUSD = val.quantity * price * rateToUSD;
                                    const finalCashFlows = [...val.cashFlows, { amount: val.quantity * price, date: new Date() }];
                                    // Note: val.cashFlows are in native currency. 
                                    // calculateXIRR expects consistent currency.
                                    // Since all history is native, we use native final value for XIRR calc.
                                    const accXirr = calculateXIRR(finalCashFlows);

                                    return [key, {
                                        name: accName, // Explicit Account Name
                                        quantity: val.quantity,
                                        value: accountValueUSD, // USD
                                        costBasis: val.costBasis * rateToUSD, // USD
                                        // Native Values for accurate reconstruction
                                        valueNative: val.quantity * price,
                                        costBasisNative: val.costBasis,
                                        lifetimeDividends: val.lifetimeDividends * rateToUSD,
                                        lifetimeDividendsNative: val.lifetimeDividends,
                                        dividendsYTD: val.dividendsYTD * rateToUSD,
                                        dividendsYTDNative: val.dividendsYTD,
                                        realizedGain: val.realizedGain * rateToUSD,
                                        realizedGainNative: val.realizedGain,
                                        accountType: val.accountType || 'Unassigned',
                                        platformName: val.platformName,
                                        xirr: accXirr,
                                        firstBuyDate: val.firstBuyDate
                                    }];
                                })
                        )
                    } : null,
                    upcomingDividend,
                    firstBuyDate
                };

            } catch (error) {
                console.error(`Error processing asset ${symbol}:`, error);
                return { success: false, symbol };
            }
        };

        const holdingsEntries = Array.from(holdingsMap.entries());
        const results: any[] = [];
        const batchSize = 5;

        // Execute Batches
        for (let i = 0; i < holdingsEntries.length; i += batchSize) {
            const batch = holdingsEntries.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(processHolding));
            results.push(...batchResults);
        }

        let latestDataTimestamp: Date | null = null;

        // Aggregate Results
        for (const result of results) {
            if (!result.success || !result.data) continue;

            const {
                data,
                valueUSD,
                costBasisUSD,
                dayChangeUSD,
                symbolCashFlows,
                dividendsYTD: localDividendsYTD,
                lifetimeDividends: localLifetimeDividends,
                projectedDividends: localProjected,
                constituent,
                upcomingDividend,
                price,
                rateToUSD,
                marketData, // Assuming I can access this if I return it from processHolding
                firstBuyDate
            } = result;

            // Update timestamp tracking
            if (marketData && marketData.regularMarketTime) {
                const ts = new Date(marketData.regularMarketTime);

                if (!latestDataTimestamp || ts > latestDataTimestamp) {
                    latestDataTimestamp = ts;
                }
            } else if (price > 0 && !latestDataTimestamp) {
                // If we have a price but no timestamp (rare?), assume now? No, assume old?
                // Better to skip if no explicit timestamp.
            }

            // Merge Cash Flows
            if (firstBuyDate && firstBuyDate <= date1YGlobal) {
                portfolioCashFlows.push(...symbolCashFlows);
            }
            if (firstBuyDate && (!globalFirstBuyDate || firstBuyDate < globalFirstBuyDate)) {
                globalFirstBuyDate = firstBuyDate;
            }

            // Sum Dividends
            dividendsYTD += localDividendsYTD;
            totalLifetimeDividends += localLifetimeDividends;
            projectedDividends += localProjected;

            if (data.quantity > 0) {
                totalValue += valueUSD;
                totalCostBasis += costBasisUSD;
                totalDayChange += dayChangeUSD;

                // Allocation by Type
                const type = data.investment.type || 'EQUITY';
                allocationByType[type] = (allocationByType[type] || 0) + valueUSD;

                // Allocation by Platform
                for (const [platformName, qty] of data.platforms.entries()) {
                    if (qty > 0) {
                        const platformValue = qty * price;
                        const platformValueUSD = platformValue * rateToUSD;
                        allocationByPlatform[platformName] = (allocationByPlatform[platformName] || 0) + platformValueUSD;
                    }
                }

                // Allocation by Account & Account Type
                for (const [accountKey, accData] of data.accounts.entries()) {
                    if (accData.quantity > 0) {
                        const accountValue = accData.quantity * price;
                        const accountValueUSD = accountValue * rateToUSD;

                        // By Account Name - Platform (Aggregate by Name + Platform)
                        // This ensures accounts with same name on different platforms are split
                        const compositeKey = `${accData.name} - ${accData.platformName}`;
                        const existing = allocationByAccount[compositeKey] || { value: 0, platformName: accData.platformName };
                        allocationByAccount[compositeKey] = {
                            value: existing.value + accountValueUSD,
                            platformName: accData.platformName
                        };

                        // By Account Type
                        const accType = accData.accountType || 'Unassigned';
                        allocationByAccountType[accType] = (allocationByAccountType[accType] || 0) + accountValueUSD;
                    }
                }

                // Allocation by Asset
                allocationByAsset.push({
                    name: result.symbol,
                    value: valueUSD
                });

                // Add to Constituents
                if (constituent) {
                    constituents.push(constituent);
                }
            } else if (constituent && (totalLifetimeDividends > 0 || Math.abs(constituent.realizedGain) > 0.01)) {
                // Include Sold Assets if they have history
                constituents.push(constituent);
            }

            if (upcomingDividend) {
                upcomingDividends.push(upcomingDividend);
            }
        }

        // Calculate Portfolio XIRR
        const portfolioXIRR = calculateXIRR(portfolioCashFlows);
        const isPortfolioYoungerThan1Y = globalFirstBuyDate ? globalFirstBuyDate > date1YGlobal : true;

        // Sort constituents by value (USD) desc
        constituents.sort((a, b) => (b.value * b.rateToUSD) - (a.value * a.rateToUSD));

        const allocationByTypeArray = Object.entries(allocationByType).map(([name, value]) => ({
            name,
            value
        })).sort((a, b) => b.value - a.value);

        const allocationByPlatformArray = Object.entries(allocationByPlatform).map(([name, value]) => ({
            name,
            value
        })).sort((a, b) => b.value - a.value);

        const allocationByAccountArray = Object.entries(allocationByAccount).map(([name, data]) => ({
            name,
            value: data.value,
            platformName: data.platformName
        })).sort((a, b) => b.value - a.value);

        const allocationByAccountTypeArray = Object.entries(allocationByAccountType).map(([name, value]) => ({
            name,
            value
        })).sort((a, b) => b.value - a.value);

        // Calculate Total Growth Percent
        let totalGrowth = (totalValue - totalCostBasis) + totalLifetimeDividends;
        const totalGrowthPercent = totalCostBasis > 0 ? (totalGrowth / totalCostBasis) * 100 : 0;

        // Convert to Target Currency
        let finalRate = 1;
        if (targetCurrency !== 'USD') {
            const r = await MarketDataService.getExchangeRate('USD', targetCurrency);
            if (r) finalRate = r;
        }

        if (finalRate !== 1) {
            totalValue *= finalRate;
            totalCostBasis *= finalRate;
            totalDayChange *= finalRate;
            totalGrowth *= finalRate;
            totalLifetimeDividends *= finalRate;
            dividendsYTD *= finalRate;
            projectedDividends *= finalRate;

            // Update Allocation Arrays
            allocationByTypeArray.forEach(x => x.value *= finalRate);
            allocationByPlatformArray.forEach(x => x.value *= finalRate);
            allocationByAccountArray.forEach(x => x.value *= finalRate);
            allocationByAccountTypeArray.forEach(x => x.value *= finalRate);

            // Update Upcoming Dividends
            upcomingDividends.forEach(x => x.estimatedAmount *= finalRate);

            // Enrich Constituents with Target Values
            constituents.forEach(c => {
                // Calculate Composite Rate: Native -> USD -> Target
                const conversionRate = (c.rateToUSD || 1) * finalRate;
                c.conversionRate = conversionRate; // Pass to frontend for consistent math

                // Pre-calculate Target Values to ensure Sum(Parts) matches Backend Total
                c.valueTarget = c.value * conversionRate;
                c.bookValueTarget = c.bookValue * conversionRate;
                c.realizedGainTarget = (c.realizedGain || 0) * conversionRate;
                c.lifetimeDividendsTarget = (c.lifetimeDividends || 0) * conversionRate;

                const absUSD = c.dayChange.absolute * c.rateToUSD;
                c.dayChange.absoluteTarget = absUSD * finalRate;
            });

            // NOTE: Constituents remain in NATIVE currency structure, but now carry target values
            // for precise display independent of frontend context rates.
        } else {
            // Even if rate is 1 (USD selected), we popuplate target values for consistency
            constituents.forEach(c => {
                c.conversionRate = 1;
                c.valueTarget = c.value;
                c.bookValueTarget = c.bookValue;
                c.realizedGainTarget = c.realizedGain || 0;
                c.lifetimeDividendsTarget = c.lifetimeDividends || 0;
                c.dayChange.absoluteTarget = c.dayChange.absolute;
            });
        }


        // Generate Top Movers (Pre-converted for Dashboard)
        const topMovers = constituents.map(c => {
            // Calculate converted values
            // We need to convert from c.currency -> targetCurrency.
            // We have rateToUSD. And we have finalRate (USD -> Target).
            // So rate = c.rateToUSD * finalRate;
            const rate = (c.rateToUSD || 1) * finalRate;
            const convertedAbsChange = c.dayChange.absolute * rate;
            const convertedPrice = c.price * rate;

            return {
                symbol: c.symbol,
                name: c.name,
                price: convertedPrice,
                avgPrice: c.avgPrice * rate, // New field for Modal
                currency: targetCurrency, // explicitly set to target
                itemRate: rate, // Store rate used for conversion for debugging/reverse math if needed
                rateToUSD: 1, // Mock as 1 since values are already converted
                dayChange: {
                    absolute: convertedAbsChange,
                    percent: c.dayChange.percent
                },
                impact: Math.abs(convertedAbsChange) // for sorting
            };
        }).sort((a, b) => b.impact - a.impact).slice(0, 10); // Take top 10 relevant

        return NextResponse.json({
            totalValue,
            dayChange: totalDayChange,
            dayChangePercent: totalValue > 0 ? (totalDayChange / (totalValue - totalDayChange)) * 100 : 0,
            totalGrowth,
            totalGrowthPercent,
            xirr: portfolioXIRR,
            isPortfolioYoungerThan1Y,
            lastUpdated: latestDataTimestamp,
            allocationByType: allocationByTypeArray,
            allocationByPlatform: allocationByPlatformArray,
            allocationByAccount: allocationByAccountArray,
            allocationByAccountType: allocationByAccountTypeArray,
            constituents,
            topMovers,
            dividendsYTD,
            projectedDividends,
            upcomingDividends: upcomingDividends.sort((a, b) => new Date(a.exDate).getTime() - new Date(b.exDate).getTime())
        });
    } catch (error) {
        console.error('Error calculating portfolio:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}


