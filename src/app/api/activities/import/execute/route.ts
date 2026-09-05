/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { MarketDataService } from '@/lib/market-data';

import { auth } from "@/auth";

export async function POST(req: NextRequest) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
        const body = await req.json();
        const { activities } = body;

        if (!Array.isArray(activities) || activities.length === 0) {
            return NextResponse.json({ error: 'No activities provided' }, { status: 400 });
        }

        // 1. Identify unique symbols and ensure Investments exist
        const uniqueSymbols = new Set<string>();
        activities.forEach((a: any) => uniqueSymbols.add(a.Symbol));

        const existingInvestments = await prisma.investment.findMany({
            where: {
                symbol: { in: Array.from(uniqueSymbols) }
            }
        });

        const existingSymbolMap = new Map(existingInvestments.map(i => [i.symbol, i]));

        // Prepare new investments in parallel
        const newInvestments = await Promise.all(Array.from(uniqueSymbols)
            .filter(symbol => !existingSymbolMap.has(symbol))
            .map(async (symbol) => {
                // Find the first activity with this symbol to get metadata
                const activity = activities.find((a: any) => a.Symbol === symbol);

                let name = activity.Name;
                let type = activity['Investment Type'];
                let currency = activity.Currency;

                // Fetch metadata if missing OR to verify native currency
                // We always try to get the native currency to ensure we set up the Investment correctly
                // even if the user imported it with a different transaction currency (e.g. CAD for a US stock)
                try {
                    // 1. Get basic metadata (Name, Type)
                    if (!name) {
                        const searchResults = await MarketDataService.searchSymbols(symbol);
                        const match = searchResults.find(r => r.symbol === symbol) || searchResults[0];
                        if (match) {
                            name = match.name;
                            type = type || (match.type === 'ETF' || match.type === 'MUTUALFUND' ? 'EQUITY' : (match.type === 'CRYPTOCURRENCY' ? 'CRYPTO' : 'EQUITY'));
                        }
                    }

                    // 2. Get Native Currency (Crucial for conversion logic)
                    const priceData = await MarketDataService.getPrice(symbol);
                    if (priceData && priceData.currency) {
                        // If we found a native currency, use it!
                        // This overrides the activity currency for the Investment definition
                        currency = priceData.currency;
                    }
                } catch (err) {
                    console.error(`Failed to fetch metadata for ${symbol}`, err);
                }

                return {
                    symbol: symbol,
                    name: name || symbol, // Fallback to symbol
                    type: type || 'EQUITY', // Default
                    currencyCode: currency || 'USD' // Default
                };
            })
        );

        // Ensure currencies exist and bulk create missing investments
        if (newInvestments.length > 0) {
            const uniqueCurrencies = Array.from(new Set(newInvestments.map(inv => inv.currencyCode)));
            await prisma.currency.createMany({
                data: uniqueCurrencies.map(code => ({
                    code,
                    rateToBase: 1.0
                })),
                skipDuplicates: true
            });

            await prisma.investment.createMany({
                data: newInvestments.map(inv => ({
                    symbol: inv.symbol,
                    name: inv.name,
                    type: inv.type,
                    currencyCode: inv.currencyCode
                })),
                skipDuplicates: true
            });
        }

        // Re-fetch all investments to get IDs
        const allInvestments = await prisma.investment.findMany({
            where: {
                symbol: { in: Array.from(uniqueSymbols) }
            }
        });
        const investmentMap = new Map(allInvestments.map(i => [i.symbol, i]));

        // 2. Pre-process Activities (Currency Conversion)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const processedActivities: any[] = [];

        // We handle this outside the transaction because we make external API calls
        console.log('Pre-processing activities for currency conversion...');

        // Group by Date+CurrencyPair to batch requests if we were smarter, but sequential/parallel per activity is fine for now
        // Or parallelize execution

        await Promise.all(activities.map(async (activity: any) => {
            const investment = investmentMap.get(activity.Symbol);
            if (!investment) throw new Error(`Investment not found for ${activity.Symbol}`); // Should not happen

            let finalCurrency = activity.Currency || investment.currencyCode;
            let finalPrice = activity.parsedPrice;
            let finalFee = activity.parsedFee;
            const finalQuantity = activity.parsedQuantity; // Quantity doesn't change with currency, but good to preserve

            // CHECK CURRENCY MISMATCH
            if (finalCurrency !== investment.currencyCode) {
                console.log(`Currency mismatch for ${activity.Symbol}: Inv ${investment.currencyCode} vs Act ${finalCurrency}. Converting...`);
                try {
                    const rate = await MarketDataService.getHistoricalExchangeRate(finalCurrency, investment.currencyCode, new Date(activity.parsedDate));

                    if (rate) {
                        console.log(`Conversion Rate (${finalCurrency}->${investment.currencyCode}) on ${activity.parsedDate}: ${rate}`);
                        finalPrice = finalPrice * rate;
                        finalFee = finalFee * rate;
                        finalCurrency = investment.currencyCode; // Update to native currency
                    } else {
                        console.warn(`Could not find exchange rate for ${finalCurrency}->${investment.currencyCode} on ${activity.parsedDate}. Keeping original currency.`);
                        // We keep original currency, causing potentially mixed currency data which relies on the downstream display logic to handle (or show mixed).
                        // Ideally we failed? No, better to import as-is than fail.
                    }
                } catch (e) {
                    console.error('Error converting currency:', e);
                }
            }

            processedActivities.push({
                date: new Date(activity.parsedDate),
                type: activity.Type,
                quantity: finalQuantity,
                price: finalPrice,
                fee: finalFee,
                currency: finalCurrency,
                investmentId: investment.id,
                accountId: activity.accountId,
                platformId: activity.platformId
            });
        }));

        // 3. Create Activities
        const createdActivities = await prisma.$transaction(
            processedActivities.map((data: any) => {
                return prisma.activity.create({ data });
            })
        );
        // 3. Trigger Market Data Refresh
        // Prefetch data so the UI is snappy when the user navigates away
        try {
            console.log(`Prefetching market data for ${uniqueSymbols.size} symbols...`);
            await Promise.all(Array.from(uniqueSymbols).map(symbol =>
                MarketDataService.refreshMarketData(symbol)
            ));

            // 4. Auto-Detect Splits
            // We check only the imported symbols to save time
            console.log(`Checking for missing splits for ${uniqueSymbols.size} symbols...`);
            // We can run this in background or await it. 
            // Better to await so user knows it's done, but parallelize per symbol.
            // SplitService.detectAndApply checks history, so it's a bit heavy.
            // But for a few symbols it's fine.
            const { SplitService } = await import('@/lib/split-detector');
            await Promise.all(Array.from(uniqueSymbols).map(symbol =>
                SplitService.detectAndApply(symbol)
            ));

        } catch (error) {
            console.error('Error post-processing import:', error);
            // Don't fail the import if refresh/split check fails
        }

        return NextResponse.json({
            success: true,
            count: createdActivities.length
        });

    } catch (error) {
        console.error('Import execution error:', error);
        return NextResponse.json({ error: 'Internal Server Error', details: String(error) }, { status: 500 });
    }
}
