/* eslint-disable @typescript-eslint/no-explicit-any */
import { prisma } from './prisma.ts';
import YahooFinance from 'yahoo-finance2';

const yahooFinance = new YahooFinance({
    suppressNotices: ['yahooSurvey']
});

export class SplitService {
    /**
     * Detects and applies missing stock splits for a given symbol (or all if not provided).
     * @param targetSymbol Optional symbol to check. If null, checks all investments.
     */
    static async detectAndApply(targetSymbol?: string) {
        console.log(`[SplitService] Starting detection... Target: ${targetSymbol || 'ALL'}`);

        // 1. Get Investments
        const whereClause = targetSymbol ? { symbol: targetSymbol } : {};
        const investments = await prisma.investment.findMany({
            where: whereClause,
            include: {
                activities: {
                    orderBy: { date: 'asc' }
                }
            }
        });

        // Ensure STOCK_SPLIT type exists
        const splitType = await prisma.activityType.findUnique({ where: { name: 'STOCK_SPLIT' } });
        if (!splitType) {
            console.error('[SplitService] STOCK_SPLIT activity type not found.');
            return;
        }

        for (const inv of investments) {
            if (inv.activities.length === 0) continue;

            const symbol = inv.symbol;
            // Use date of first activity to bound the history check
            const firstActivityDate = inv.activities[0].date;

            // Fetch splits from Yahoo Finance
            const queryOptions = {
                period1: firstActivityDate,
                events: 'split' as const
            };

            let splits: any[] = [];
            try {
                // Typings for yahooFinance can be loose, cast to any
                const result = await yahooFinance.chart(symbol, queryOptions) as any;
                if (result.events && result.events.splits) {
                    const rawSplits = result.events.splits;
                    if (Array.isArray(rawSplits)) {
                        splits = rawSplits;
                    } else {
                        splits = Object.values(rawSplits);
                    }
                }
            } catch (err: any) {
                console.warn(`[SplitService] Failed to fetch splits for ${symbol}: ${err.message}`);
                continue;
            }

            if (splits.length === 0) continue;

            for (const split of splits) {
                const splitDate = new Date(split.date);
                const ratio = split.numerator / split.denominator;
                const now = new Date();

                // 1. Ignore Future Splits
                if (splitDate > now) {
                    console.warn(`[SplitService] Warning: Found future split for ${symbol} on ${splitDate.toISOString()}. Ignoring.`);
                    continue;
                }

                // 2. Ignore Noise/Phantom Splits (ratios very close to 1.0, e.g. 0.99 or 1.01)
                // Real splits are usually significant (at least 3:2 or 2:3). We use a safe range of 0.90-1.10 to filter noise.
                if (ratio > 0.90 && ratio < 1.10) {
                    console.warn(`[SplitService] Warning: Found phantom split (ratio ${ratio}) for ${symbol} on ${splitDate.toISOString()}. Ignoring.`);
                    continue;
                }

                // Check if already exists in DB (approximate match on date)
                const existing = inv.activities.find(a =>
                    a.type === 'STOCK_SPLIT' &&
                    Math.abs(new Date(a.date).getTime() - splitDate.getTime()) < 24 * 60 * 60 * 1000
                );

                if (existing) continue;

                console.log(`[SplitService] Found Missing Split for ${symbol}: ${splitDate.toISOString().split('T')[0]} (Ratio ${ratio})`);

                // Identify affected accounts (those with activity BEFORE split)
                const relevantAccounts = new Set<string>();
                let hasUnassigned = false; // "Unassigned" account

                inv.activities.forEach(a => {
                    if (new Date(a.date) < splitDate) {
                        if (a.accountId) relevantAccounts.add(a.accountId);
                        else hasUnassigned = true;
                    }
                });

                if (relevantAccounts.size === 0 && !hasUnassigned) {
                    continue;
                }

                // Prepare activities for batch insertion
                const activitiesToCreate = SplitService.prepareSplitActivities(
                    inv.id,
                    inv.currencyCode,
                    splitDate,
                    ratio,
                    relevantAccounts,
                    hasUnassigned
                );

                if (activitiesToCreate.length > 0) {
                    await prisma.activity.createMany({
                        data: activitiesToCreate
                    });

                    // Restore granular logging
                    relevantAccounts.forEach(accountId => {
                        console.log(`[SplitService] Applied split to Account ${accountId}`);
                    });
                    if (hasUnassigned) {
                        console.log(`[SplitService] Applied split to Unassigned Account`);
                    }
                    console.log(`[SplitService] Batched ${activitiesToCreate.length} split activities for ${symbol}`);
                }
            }
        }
        console.log('[SplitService] Detection complete.');
    }

    /**
     * Prepares activity data for STOCK_SPLIT across multiple accounts.
     * Extracted for testability and to avoid N+1 queries.
     */
    static prepareSplitActivities(
        investmentId: string,
        currencyCode: string,
        date: Date,
        ratio: number,
        relevantAccounts: Set<string>,
        hasUnassigned: boolean
    ) {
        const activities: any[] = Array.from(relevantAccounts).map(accountId => ({
            investmentId,
            type: 'STOCK_SPLIT',
            date,
            quantity: ratio,
            price: 0,
            currency: currencyCode,
            accountId
        }));

        if (hasUnassigned) {
            activities.push({
                investmentId,
                type: 'STOCK_SPLIT',
                date,
                quantity: ratio,
                price: 0,
                currency: currencyCode,
                accountId: null
            });
        }

        return activities;
    }
}
