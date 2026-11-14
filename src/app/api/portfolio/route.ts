import { NextResponse, NextRequest } from 'next/server';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';
import { calculateXIRR, Transaction } from '@/lib/xirr';
import { calculateLookThrough } from '@/lib/look-through';
import {
    analyzeDividendHistory,
    buildPerShareDividendEventsFromActivities,
    type PortfolioActivityLike
} from '@/lib/dividend-estimator';
import { auth } from '@/auth';

export const dynamic = 'force-dynamic';

const ACTIVE_QUANTITY_EPSILON = 0.00001;

export async function GET(request: NextRequest) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
            accounts: Map<string, { name: string, quantity: number, platformName: string, accountType: string, costBasis: number, lifetimeDividends: number, dividendsYTD: number, realizedGain: number, cashFlows: Transaction[], firstBuyDate: Date | null }>,
            rawActivities: PortfolioActivityLike[]
        }>();

        const currentUtcYear = new Date().getUTCFullYear();

        for (const activity of activities) {
            const symbol = activity.investment.symbol;
            if (!holdingsMap.has(symbol)) {
                holdingsMap.set(symbol, {
                    quantity: 0,
                    investment: activity.investment,
                    platforms: new Map(),
                    accounts: new Map(),
                    rawActivities: []
                });
            }

            const current = holdingsMap.get(symbol)!;
            current.rawActivities.push({
                type: activity.type,
                date: activity.date,
                quantity: activity.quantity,
                price: activity.price,
                fee: activity.fee
            });
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
            // AND same Name/Type across different Platforms. Must include Platform to separate.
            const accountKey = `${accountName}:${accountType}:${platformName}`;

            // Get account data or init
            let acc = current.accounts.get(accountKey);
            if (!acc) {
                acc = { name: accountName, quantity: 0, platformName, accountType, costBasis: 0, lifetimeDividends: 0, dividendsYTD: 0, realizedGain: 0, cashFlows: [], firstBuyDate: null };
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
                current.quantity -= absQty;
                if (Math.abs(current.quantity) < 1e-9) current.quantity = 0;

                const nextPlatformQty = Math.max(0, (current.platforms.get(platformName) || 0) - absQty);
                current.platforms.set(platformName, nextPlatformQty < 1e-9 ? 0 : nextPlatformQty);

                const proportion = acc.quantity > 0 ? Math.min(1, absQty / acc.quantity) : 0;
                const costToRemove = acc.costBasis * proportion;

                // Realized ID: (Proceeds) - (Cost of these specific shares)
                const realized = (amount - fee) - costToRemove;
                acc.realizedGain += realized;

                acc.quantity = Math.max(0, acc.quantity - absQty);
                if (acc.quantity < 1e-9) acc.quantity = 0;
                acc.costBasis = Math.max(0, acc.costBasis - costToRemove);
                acc.cashFlows.push({ amount: (amount - fee), date: activity.date });

            } else if (activity.type === 'DIVIDEND') {
                // Dividends are cash inflows for the account
                acc.cashFlows.push({ amount: (amount - fee), date: activity.date });
                acc.lifetimeDividends += (amount - fee);

                if (new Date(activity.date).getUTCFullYear() === currentUtcYear) {
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

        // Clamp residual float-dust positions cleanly so sold symbols never leak into active calculations
        for (const holding of holdingsMap.values()) {
            if (holding.quantity <= ACTIVE_QUANTITY_EPSILON) {
                holding.quantity = 0;
            }
            for (const [pName, pQty] of holding.platforms.entries()) {
                if (pQty <= ACTIVE_QUANTITY_EPSILON) holding.platforms.set(pName, 0);
            }
            for (const acc of holding.accounts.values()) {
                if (acc.quantity <= ACTIVE_QUANTITY_EPSILON) {
                    acc.quantity = 0;
                    acc.costBasis = 0;
                }
            }
        }

        // 3. Fetch market data and calculate totals
        let totalValue = 0;
        let totalCostBasis = 0; // Track total cost basis
        let totalDayChange = 0;
        let totalRealizedGain = 0;
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
                const currency = marketData?.currency || data.investment?.currencyCode || 'USD';

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
                const symbolCashFlows: Transaction[] = [];

                const symbolActivities = activities.filter((a: any) => a.investment.symbol === symbol);

                // Process Activities for Cash Flows
                for (const activity of symbolActivities) {
                    const absQty = Math.abs(activity.quantity);
                    const amount = absQty * activity.price;
                    const fee = activity.fee || 0;
                    const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';

                    if (behavior === 'ADD') {
                        symbolCashFlows.push({ amount: -(amount + fee), date: activity.date });
                    } else if (behavior === 'REMOVE') {
                        symbolCashFlows.push({ amount: (amount - fee), date: activity.date });
                    } else if (activity.type === 'DIVIDEND') {
                        const netAmount = amount - fee;
                        symbolCashFlows.push({ amount: netAmount, date: activity.date });
                    }
                }

                // Calculate accurate Cost Basis, Realized Gains, and Dividends from Accounts map
                let costBasis = 0;
                let realizedGainNative = 0;
                let localDividendsYTD = 0;
                let localLifetimeDividends = 0;

                for (const acc of data.accounts.values()) {
                    costBasis += acc.costBasis;
                    realizedGainNative += acc.realizedGain;
                    localDividendsYTD += acc.dividendsYTD;
                    localLifetimeDividends += acc.lifetimeDividends;
                }

                const hasActiveHolding = data.quantity > ACTIVE_QUANTITY_EPSILON;
                const avgBuyPrice = hasActiveHolding ? costBasis / data.quantity : 0;
                const value = hasActiveHolding ? data.quantity * price : 0;
                const dayChange = hasActiveHolding ? data.quantity * regularMarketChange : 0;

                // Add Current Value as "Inflow" for XIRR
                if (hasActiveHolding) {
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

                // Upcoming Dividends (only for currently held positions with a positive estimated payout)
                let upcomingDividend = null;
                const startOfToday = new Date(now);
                startOfToday.setUTCHours(0, 0, 0, 0);
                const cutoff = new Date(startOfToday);
                cutoff.setUTCDate(cutoff.getUTCDate() + 45); // Next 45 days (~1.5 months)

                const marketExDate = marketData?.exDividendDate ? new Date(marketData.exDividendDate) : null;
                const hasDeclaredFutureExDate = Boolean(marketExDate && !Number.isNaN(marketExDate.getTime()) && marketExDate >= startOfToday);
                const hasMarketFutureExDateInWindow = Boolean(hasDeclaredFutureExDate && marketExDate! <= cutoff);
                const hasMarketDividendRate = Boolean(marketData?.dividendRate && marketData.dividendRate > 0);
                const hasMarketNextAmount = Boolean(marketData?.estNextDividendAmount && marketData.estNextDividendAmount > 0);

                // # Reason: If Yahoo Finance omits dividend data or lags behind (common for Canadian money-market
                // ETFs like ZMMK.TO), infer cadence, annual run-rate, and next payout from recorded DIVIDEND activities.
                const needsActivityFallback = hasActiveHolding && (!hasMarketDividendRate || !hasDeclaredFutureExDate || !hasMarketNextAmount);
                const activityDivEvents = needsActivityFallback
                    ? buildPerShareDividendEventsFromActivities(data.rawActivities, behaviorMap)
                    : [];
                const localDivEstimate = activityDivEvents.length > 0
                    ? analyzeDividendHistory(activityDivEvents, {
                        now: startOfToday,
                        filterLastYearFromNow: true,
                        rollForward: true,
                        annualizeShortHistory: true
                    })
                    : undefined;

                const effectiveDividendRate = hasMarketDividendRate
                    ? marketData!.dividendRate!
                    : (localDivEstimate?.annualizedRate || localDivEstimate?.trailingAnnualRate || 0);
                const effectiveDividendYield = (marketData?.dividendYield && marketData.dividendYield > 0)
                    ? marketData.dividendYield
                    : (effectiveDividendRate > 0 && price > 0 ? effectiveDividendRate / price : 0);

                if (hasActiveHolding) {
                    if (hasMarketFutureExDateInWindow && marketExDate) {
                        const estimatedAmountPerShare = hasMarketNextAmount
                            ? marketData!.estNextDividendAmount!
                            : (localDivEstimate?.nextAmount && localDivEstimate.nextAmount > 0
                                ? localDivEstimate.nextAmount
                                : effectiveDividendRate / 4);
                        const estimatedAmountUSD = estimatedAmountPerShare * data.quantity * rateToUSD;

                        if (estimatedAmountUSD > 0) {
                            upcomingDividend = {
                                symbol,
                                exDate: marketExDate.toISOString(),
                                rate: effectiveDividendRate,
                                quantity: data.quantity,
                                estimatedAmount: estimatedAmountUSD,
                                isEstimated: false
                            };
                        }
                    } else if (!hasDeclaredFutureExDate && localDivEstimate?.nextDate) {
                        const estExDate = localDivEstimate.nextDate;
                        if (estExDate >= startOfToday && estExDate <= cutoff) {
                            const estimatedAmountPerShare =
                                (localDivEstimate.nextAmount && localDivEstimate.nextAmount > 0)
                                    ? localDivEstimate.nextAmount
                                    : effectiveDividendRate / 4;
                            const estimatedAmountUSD = estimatedAmountPerShare * data.quantity * rateToUSD;

                            if (estimatedAmountUSD > 0) {
                                upcomingDividend = {
                                    symbol,
                                    exDate: estExDate.toISOString(),
                                    rate: effectiveDividendRate,
                                    quantity: data.quantity,
                                    estimatedAmount: estimatedAmountUSD,
                                    isEstimated: true
                                };
                            }
                        }
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
                    valueUSD: hasActiveHolding ? value * rateToUSD : 0,
                    costBasisUSD: hasActiveHolding ? costBasis * rateToUSD : 0,
                    dayChangeUSD: hasActiveHolding ? dayChange * rateToUSD : 0,
                    symbolCashFlows,
                    dividendsYTD: localDividendsYTD * rateToUSD,
                    lifetimeDividends: localLifetimeDividends * rateToUSD,
                    projectedDividends: ((hasActiveHolding && effectiveDividendRate > 0) ? (effectiveDividendRate * data.quantity) : 0) * rateToUSD,
                    constituent: (hasActiveHolding || localLifetimeDividends > 0 || Math.abs(realizedGainNative) > 0.01) ? {
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
                        sector: marketData?.sector || null,
                        country: marketData?.country || null,
                        sectorAllocations: marketData?.sectorAllocations || null,
                        countryAllocations: marketData?.countryAllocations || null,
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
                        dividendYield: effectiveDividendYield,
                        lifetimeDividends: localLifetimeDividends * rateToUSD,
                        lifetimeDividendsNative: localLifetimeDividends,
                        dividendsYTD: localDividendsYTD * rateToUSD,
                        dividendsYTDNative: localDividendsYTD,
                        realizedGain: realizedGainNative * rateToUSD,
                        accountTypes: Array.from(new Set(Array.from((data.accounts as Map<string, any>).values()).map((a: any) => a.accountType || 'Unassigned'))),
                        accountNames: Array.from(new Set(Array.from((data.accounts as Map<string, any>).entries()).map(([k, a]: [string, any]) => a.name || k.split(':')[0] || 'Unassigned'))),

                        accountsBreakdown: Object.fromEntries(
                            Array.from((data.accounts as Map<string, any>).entries())
                                .filter(([, val]: [string, any]) => val.quantity > ACTIVE_QUANTITY_EPSILON || val.lifetimeDividends > 0 || Math.abs(val.realizedGain) > 0.01)
                                .map(([key, val]: [string, any]) => {
                                    // Prefer explicit name stored on account entry, fallback to composite key prefix
                                    const accName = val.name || key.split(':')[0] || 'Unassigned';

                                    // Calculate Account XIRR
                                    // Add current value as final inflow
                                    const isAccountActive = val.quantity > ACTIVE_QUANTITY_EPSILON;
                                    const accountValueUSD = isAccountActive ? val.quantity * price * rateToUSD : 0;
                                    const finalCashFlows = isAccountActive
                                        ? [...val.cashFlows, { amount: val.quantity * price, date: new Date() }]
                                        : [...val.cashFlows];
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
                                        valueNative: isAccountActive ? val.quantity * price : 0,
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
            totalRealizedGain += (constituent?.realizedGain || 0);

            if (data.quantity > ACTIVE_QUANTITY_EPSILON) {
                totalValue += valueUSD;
                totalCostBasis += costBasisUSD;
                totalDayChange += dayChangeUSD;

                // Allocation by Type
                const type = data.investment.type || 'EQUITY';
                allocationByType[type] = (allocationByType[type] || 0) + valueUSD;

                // Allocation by Platform
                for (const [platformName, qty] of data.platforms.entries()) {
                    if (qty > ACTIVE_QUANTITY_EPSILON) {
                        const platformValue = qty * price;
                        const platformValueUSD = platformValue * rateToUSD;
                        allocationByPlatform[platformName] = (allocationByPlatform[platformName] || 0) + platformValueUSD;
                    }
                }

                // Allocation by Account & Account Type
                for (const [accountKey, accData] of data.accounts.entries()) {
                    if (accData.quantity > ACTIVE_QUANTITY_EPSILON) {
                        const accountValue = accData.quantity * price;
                        const accountValueUSD = accountValue * rateToUSD;

                        // By Account Name - Platform (Aggregate by Name + Platform)
                        // This ensures accounts with same name on different platforms are split
                        const accountName = accData.name || accountKey.split(':')[0] || 'Unassigned';
                        const compositeKey = `${accountName} - ${accData.platformName}`;
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
            } else if (constituent && (constituent.lifetimeDividends > 0 || Math.abs(constituent.realizedGain) > 0.01)) {
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
        let totalGrowth = (totalValue - totalCostBasis) + totalLifetimeDividends + totalRealizedGain;
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
            totalRealizedGain *= finalRate;
            dividendsYTD *= finalRate;
            projectedDividends *= finalRate;

            // Update Allocation Arrays
            allocationByTypeArray.forEach(x => x.value *= finalRate);
            allocationByPlatformArray.forEach(x => x.value *= finalRate);
            allocationByAccountArray.forEach(x => x.value *= finalRate);
            allocationByAccountTypeArray.forEach(x => x.value *= finalRate);

            // Update Upcoming Dividends
            upcomingDividends.forEach(x => x.estimatedAmount *= finalRate);
        }

        // Enrich Constituents with Target Values (c.value, bookValue, dayChange.absolute are native;
        // realizedGain, lifetimeDividends, and dividendsYTD are already stored in USD).
        constituents.forEach(c => {
            const conversionRate = (c.rateToUSD || 1) * finalRate;
            c.conversionRate = conversionRate;

            c.valueTarget = c.value * conversionRate;
            c.bookValueTarget = c.bookValue * conversionRate;
            c.realizedGainTarget = (c.realizedGain || 0) * finalRate;
            c.lifetimeDividendsTarget = (c.lifetimeDividends || 0) * finalRate;
            c.dividendsYTDTarget = (c.dividendsYTD || 0) * finalRate;

            const absUSD = c.dayChange.absolute * (c.rateToUSD || 1);
            c.dayChange.absoluteTarget = absUSD * finalRate;
        });


        // Calculate Look-Through (Portfolio X-Ray: Sector & Geographic Exposure)
        const lookThroughConstituents = constituents
            .filter(c => c.quantity > ACTIVE_QUANTITY_EPSILON)
            .map(c => ({
                symbol: c.symbol,
                name: c.name,
                type: c.type,
                value: c.valueTarget ?? (c.value * (c.rateToUSD || 1) * finalRate),
                currency: targetCurrency,
                sector: c.sector,
                country: c.country,
                sectorAllocations: c.sectorAllocations,
                countryAllocations: c.countryAllocations
            }));
        const lookThrough = calculateLookThrough(lookThroughConstituents);

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

        const prevTotalValue = totalValue - totalDayChange;

        return NextResponse.json({
            totalValue,
            totalCostBasis,
            dayChange: totalDayChange,
            dayChangePercent: totalValue > 0 && prevTotalValue > 0 ? (totalDayChange / prevTotalValue) * 100 : 0,
            totalGrowth,
            totalGrowthPercent,
            totalLifetimeDividends,
            totalRealizedGain,
            xirr: portfolioXIRR,
            isPortfolioYoungerThan1Y,
            lastUpdated: latestDataTimestamp,
            allocationByType: allocationByTypeArray,
            allocationByPlatform: allocationByPlatformArray,
            allocationByAccount: allocationByAccountArray,
            allocationByAccountType: allocationByAccountTypeArray,
            allocationBySector: lookThrough.bySector,
            allocationByCountry: lookThrough.byCountry,
            sectorLookThrough: lookThrough.sectorDetails,
            countryLookThrough: lookThrough.countryDetails,
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


