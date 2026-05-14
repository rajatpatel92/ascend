import { NextResponse, NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';
import { PortfolioAnalytics } from '@/lib/portfolio-analytics';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const targetCurrency = searchParams.get('currency') || 'USD';
        const investmentTypes = searchParams.get('investmentTypes')?.split(',') || [];
        const accountTypes = searchParams.get('accountTypes')?.split(',') || [];

        // 1. Fetch Targets
        const targets = await prisma.targetAllocation.findMany();
        const targetMap = new Map(targets.map(t => [t.symbol, t]));

        // 2. Fetch Holdings
        let activities = await prisma.activity.findMany({
            include: { investment: true, account: true }
        });

        if (investmentTypes.length > 0) {
            activities = activities.filter(a => investmentTypes.includes(a.investment.type));
        }
        if (accountTypes.length > 0) {
            activities = activities.filter(a => a.account && accountTypes.includes(a.account.type));
        }

        const holdings = PortfolioAnalytics.computeHoldingsState(activities);

        // 3. Fetch Prices & Evaluate Portfolio
        let totalValueUSD = 0;
        const holdingDetails = [];

        // Identify all unique symbols from holdings and targets
        const allSymbolsSet = new Set<string>();
        Object.keys(holdings).forEach(s => holdings[s] > 0 && allSymbolsSet.add(s));
        targets.forEach(t => allSymbolsSet.add(t.symbol));
        const allSymbols = Array.from(allSymbolsSet);

        // Fetch prices concurrently
        const prices = await Promise.all(allSymbols.map(async sym => {
            try {
                const marketData = await MarketDataService.getPrice(sym);
                return { symbol: sym, price: marketData?.price || 0, currency: marketData?.currency || 'USD' };
            } catch (e) {
                return { symbol: sym, price: 0, currency: 'USD' };
            }
        }));

        // Pre-fetch unique exchange rates to USD in parallel
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

        // Convert Total Value to Target Currency
        let finalRate = 1;
        if (targetCurrency !== 'USD') {
            const r = await MarketDataService.getExchangeRate('USD', targetCurrency);
            if (r) finalRate = r;
        }

        const totalValue = totalValueUSD * finalRate;

        // 4. Calculate Drift
        const rebalanceData = holdingDetails.map(h => {
            const currentValue = h.valueUSD * finalRate;
            const currentPercent = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
            const target = targetMap.get(h.symbol);
            const targetPercent = target ? target.targetPercentage : 0;
            const glidePathPercent = target ? target.yearlyDriftAdjustment : null;

            const driftPercent = currentPercent - targetPercent;
            
            // Value difference: How much currency needs to be moved to reach target
            const targetValue = (targetPercent / 100) * totalValue;
            const driftValue = currentValue - targetValue;

            // Recommended action
            // driftValue > 0 -> Overweight -> SELL
            // driftValue < 0 -> Underweight -> BUY
            let actionText = 'HOLD';
            let actionShares = 0;
            let expectedPriceObj = h.price; 
            
            // Convert price to target currency to determine shares reliably?
            // Usually trades are executed in asset's native currency. 
            // So we calculate native value drift.
            const nativeRateContext = h.rateToUSD * finalRate; // Price native * this = target currency
            const priceInTargetCurrency = h.price * nativeRateContext;
            
            if (Math.abs(driftValue) > 0.01 && priceInTargetCurrency > 0) {
                actionShares = Math.abs(driftValue) / priceInTargetCurrency;
                if (driftValue > 0) actionText = 'SELL';
                if (driftValue < 0) actionText = 'BUY';
            }

            return {
                symbol: h.symbol,
                currentPercent,
                targetPercent,
                glidePathPercent,
                driftPercent,
                currentValue,
                targetValue,
                driftValue,
                action: actionText,
                actionShares,
                assetPrice: h.price,
                assetCurrency: h.assetCurrency
            };
        });

        // Sort: Underweight (most negative drift) first, then Overweight (positive drift)
        rebalanceData.sort((a, b) => a.driftPercent - b.driftPercent);

        return NextResponse.json({
            totalValue,
            currency: targetCurrency,
            data: rebalanceData
        });

    } catch (error: any) {
        console.error('Rebalancer API Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
