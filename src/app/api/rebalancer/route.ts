import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';

const QUANTITY_EPSILON = 0.00001;

interface ActivityWithRelations {
    type: string;
    quantity: number;
    date: Date;
    accountId: string | null;
    investment: { symbol: string; type: string };
    account: { id?: string; name: string; type: string; isActive: boolean } | null;
    platform?: { name: string } | null;
}

export async function GET(request: NextRequest) {
    const authResult = await requireAuth(request, ['ADMIN', 'EDITOR', 'VIEWER'], true);
    if (!authResult.authorized) return authResult.response;

    try {
        const { searchParams } = new URL(request.url);
        const targetCurrency = searchParams.get('currency') || 'USD';
        const investmentTypes = searchParams.get('investmentTypes')?.split(',').map(s => s.trim()).filter(Boolean) || [];
        const accountTypes = searchParams.get('accountTypes')?.split(',').map(s => s.trim()).filter(Boolean) || [];
        const excludeSymbols = searchParams.get('excludeSymbols')?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) || [];

        // 1. Fetch Targets & Configured Account Types
        const [rawTargets, configuredAccountTypes] = await Promise.all([
            prisma.targetAllocation.findMany(),
            prisma.accountType ? prisma.accountType.findMany({ select: { name: true } }) : Promise.resolve([] as Array<{ name: string }>)
        ]);

        let targets = rawTargets;
        if (excludeSymbols.length > 0) {
            targets = targets.filter(t => !excludeSymbols.includes(t.symbol.toUpperCase()));
        }
        const targetMap = new Map(targets.map(t => [t.symbol, t]));

        // 2. Fetch Holdings Chronologically
        const allActivities = (await prisma.activity.findMany({
            where: {
                OR: [
                    { accountId: null },
                    { account: { isActive: true } }
                ]
            },
            include: { investment: true, account: true, platform: true },
            orderBy: { date: 'asc' }
        })) as unknown as ActivityWithRelations[];

        let activities = allActivities;
        if (investmentTypes.length > 0) {
            activities = activities.filter(a => investmentTypes.includes(a.investment.type));
        }

        // Preserve unassigned (accountId: null) activities when all configured account types are selected
        // or when 'Unassigned' is explicitly requested.
        const allConfiguredAccTypes = new Set(configuredAccountTypes.map(a => a.name));
        const isAllAccountTypesSelected =
            allConfiguredAccTypes.size > 0 &&
            Array.from(allConfiguredAccTypes).every(name => accountTypes.includes(name));
        const includeUnassigned =
            accountTypes.length === 0 ||
            isAllAccountTypesSelected ||
            accountTypes.includes('Unassigned');

        if (accountTypes.length > 0) {
            activities = activities.filter(a =>
                a.account ? accountTypes.includes(a.account.type) : includeUnassigned
            );
        }
        if (excludeSymbols.length > 0) {
            activities = activities.filter(a => !excludeSymbols.includes(a.investment.symbol.toUpperCase()));
        }

        const holdings = PortfolioAnalytics.computeHoldingsState(activities as never);

        // Compute per-account holdings breakdown & symbol -> investmentType map chronologically
        const symbolTypeMap = new Map<string, string>();
        const perAccountMap = new Map<string, Map<string, {
            accountId: string | null;
            accountName: string;
            accountType: string;
            platformName: string;
            quantity: number;
        }>>();

        for (const a of activities) {
            const sym = a.investment.symbol;
            if (a.investment.type && !symbolTypeMap.has(sym)) {
                symbolTypeMap.set(sym, a.investment.type);
            }

            let symAccounts = perAccountMap.get(sym);
            if (!symAccounts) {
                symAccounts = new Map();
                perAccountMap.set(sym, symAccounts);
            }

            const accountName = a.account?.name || 'Unassigned';
            const accountType = a.account?.type || 'Unassigned';
            const platformName = a.platform?.name || 'Direct';
            const accKey = `${a.accountId || 'unassigned'}:${accountName}:${accountType}:${platformName}`;

            let accEntry = symAccounts.get(accKey);
            if (!accEntry) {
                accEntry = {
                    accountId: a.accountId ?? null,
                    accountName,
                    accountType,
                    platformName,
                    quantity: 0
                };
                symAccounts.set(accKey, accEntry);
            }

            if (a.type === 'BUY' || a.type === 'DEPOSIT' || a.type === 'TRANSFER_IN') {
                accEntry.quantity += a.quantity;
            } else if (a.type === 'SELL' || a.type === 'WITHDRAWAL' || a.type === 'TRANSFER_OUT') {
                accEntry.quantity = Math.max(0, accEntry.quantity - Math.abs(a.quantity));
            } else if (a.type === 'STOCK_SPLIT' || a.type === 'SPLIT') {
                accEntry.quantity = Math.max(0, accEntry.quantity * a.quantity);
            }
        }

        // Fill investment types for target-only symbols not currently in filtered activities
        const missingTypeSymbols = targets.map(t => t.symbol).filter(s => !symbolTypeMap.has(s));
        if (missingTypeSymbols.length > 0 && prisma.investment?.findMany) {
            const invRecords = await prisma.investment.findMany({
                where: { symbol: { in: missingTypeSymbols } },
                select: { symbol: true, type: true }
            });
            invRecords.forEach(inv => symbolTypeMap.set(inv.symbol, inv.type));
        }

        // 3. Fetch Prices & Evaluate Portfolio
        let totalValueUSD = 0;
        const holdingDetails = [];

        const allSymbolsSet = new Set<string>();
        Object.keys(holdings).forEach(s => holdings[s] > QUANTITY_EPSILON && allSymbolsSet.add(s));
        targets.forEach(t => allSymbolsSet.add(t.symbol));
        const allSymbols = Array.from(allSymbolsSet);

        const prices = await Promise.all(allSymbols.map(async sym => {
            try {
                const marketData = await MarketDataService.getPrice(sym);
                return { symbol: sym, price: marketData?.price || 0, currency: marketData?.currency || 'USD' };
            } catch {
                return { symbol: sym, price: 0, currency: 'USD' };
            }
        }));

        const uniqueCurrencies = Array.from(new Set(prices.map(p => p.currency).filter(c => c !== 'USD')));
        const exchangeRates = await Promise.all(uniqueCurrencies.map(async (currency) => {
            const r = await MarketDataService.getExchangeRate(currency, 'USD');
            return { currency, rate: r || 1 };
        }));
        const rateMap = new Map(exchangeRates.map(er => [er.currency, er.rate]));

        for (const pd of prices) {
            const qty = holdings[pd.symbol] || 0;
            const rateToUSD = pd.currency === 'USD' ? 1 : (rateMap.get(pd.currency) || 1);

            const valueUSD = qty * pd.price * rateToUSD;
            totalValueUSD += valueUSD;

            holdingDetails.push({
                symbol: pd.symbol,
                quantity: qty,
                price: pd.price,
                assetCurrency: pd.currency,
                valueUSD,
                rateToUSD
            });
        }

        let finalRate = 1;
        if (targetCurrency !== 'USD') {
            const r = await MarketDataService.getExchangeRate('USD', targetCurrency);
            if (r) finalRate = r;
        }

        const totalValue = totalValueUSD * finalRate;

        // 4. Calculate Drift & Account Breakdown
        const rebalanceData = holdingDetails.map(h => {
            const currentValue = h.valueUSD * finalRate;
            const currentPercent = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
            const target = targetMap.get(h.symbol);
            const targetPercent = target ? target.targetPercentage : 0;
            const glidePathPercent = target ? target.yearlyDriftAdjustment : null;
            const lastAdjustmentDate = target?.lastAdjustmentDate
                ? new Date(target.lastAdjustmentDate).toISOString()
                : null;
            const createdAt = target?.createdAt
                ? new Date(target.createdAt).toISOString()
                : null;

            const driftPercent = currentPercent - targetPercent;
            const targetValue = (targetPercent / 100) * totalValue;
            const driftValue = currentValue - targetValue;

            let actionText = 'HOLD';
            let actionShares = 0;

            const nativeRateContext = h.rateToUSD * finalRate;
            const priceInTargetCurrency = h.price * nativeRateContext;

            if (Math.abs(driftValue) > 0.01 && priceInTargetCurrency > 0) {
                actionShares = Math.abs(driftValue) / priceInTargetCurrency;
                if (driftValue > 0) actionText = 'SELL';
                if (driftValue < 0) actionText = 'BUY';
            }

            const symAccounts = perAccountMap.get(h.symbol);
            const accounts = symAccounts
                ? Array.from(symAccounts.values())
                    .filter(a => a.quantity > QUANTITY_EPSILON)
                    .map(a => ({
                        accountId: a.accountId,
                        accountName: a.accountName,
                        accountType: a.accountType,
                        platformName: a.platformName,
                        quantity: a.quantity,
                        value: a.quantity * priceInTargetCurrency
                    }))
                    .sort((a, b) => b.value - a.value)
                : [];

            return {
                symbol: h.symbol,
                investmentType: symbolTypeMap.get(h.symbol) || 'Uncategorized',
                currentPercent,
                targetPercent,
                glidePathPercent,
                lastAdjustmentDate,
                createdAt,
                driftPercent,
                currentValue,
                targetValue,
                driftValue,
                action: actionText,
                actionShares,
                assetPrice: h.price,
                assetCurrency: h.assetCurrency,
                accounts
            };
        });

        rebalanceData.sort((a, b) => a.driftPercent - b.driftPercent);

        return NextResponse.json({
            totalValue,
            currency: targetCurrency,
            data: rebalanceData
        });
    } catch (error: unknown) {
        console.error('Rebalancer API Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
