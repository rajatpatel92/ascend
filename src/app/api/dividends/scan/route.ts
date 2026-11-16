
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { apiThrottler, yahooFinance } from '@/lib/market-data';
import { calculateHoldingsFromActivities } from '@/lib/portfolio-helper';
import { buildBehaviorMap } from '@/lib/activity-helpers';

export const dynamic = 'force-dynamic';

import { auth } from "@/auth";
import { checkRateLimit } from "@/lib/rate-limit";

export async function POST(request: Request) {
    const session = await auth();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userRole = (session.user as any)?.role;
    if (userRole !== 'ADMIN' && userRole !== 'EDITOR') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Rate Limit: 5 scans per minute per user
    const userId = session.user?.id || 'unknown';
    const isAllowed = await checkRateLimit(`scan-dividends-${userId}`, 5, 60);

    if (!isAllowed) {
        return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
    }

    try {
        const body = await request.json();
        const { symbols: requestedSymbols, startYear } = body;

        let symbolsToScan: string[] = [];

        if (requestedSymbols && Array.isArray(requestedSymbols) && requestedSymbols.length > 0) {
            symbolsToScan = requestedSymbols;
        } else {
            // Default: Get all distinct symbols from Investments
            const investments = await prisma.investment.findMany({
                select: { symbol: true },
                distinct: ['symbol']
            });
            symbolsToScan = investments.map(i => i.symbol);
        }

        // Fetch hidden dividends for these symbols
        const hiddenDividends = await prisma.hiddenDividend.findMany({
            where: {
                symbol: { in: symbolsToScan }
            }
        });

        // Create a map for quick lookup: symbol-date -> boolean
        const hiddenMap = new Map<string, boolean>();
        hiddenDividends.forEach(h => {
            const key = `${h.symbol}-${h.date.toISOString().split('T')[0]}`;
            hiddenMap.set(key, true);
        });

        // Fetch all accounts for lookup
        const allAccounts = await prisma.account.findMany({
            include: { platform: true }
        });
        const accountMap = new Map(allAccounts.map(a => [a.id, a]));

        // Fetch all users for Display Name lookup
        const allUsers = await prisma.user.findMany();
        const userMap = new Map(allUsers.map(u => [u.username, u.name]));

        // Calculate date range for scanning
        const endDate = new Date();
        const startDate = new Date();

        if (startYear) {
            startDate.setFullYear(parseInt(startYear), 0, 1);
            endDate.setFullYear(parseInt(startYear), 11, 31); // Dec 31st
            endDate.setHours(23, 59, 59, 999);
        } else {
            // Default to current year if no year selected (though frontend sends one)
            startDate.setFullYear(new Date().getFullYear(), 0, 1);
        }

        // Safety check: Period 1 must be before Period 2
        if (startDate > endDate) {
            // Should not happen with above logic, but fallback
            startDate.setFullYear(endDate.getFullYear() - 1);
        }

        const activityTypes = await prisma.activityType.findMany();
        const behaviorMap = buildBehaviorMap(activityTypes);
        const holdingAffectingTypes = Array.from(new Set([
            'BUY',
            'DRIP',
            'ADD',
            'DEPOSIT',
            'SELL',
            'REMOVE',
            'WITHDRAWAL',
            'SPLIT',
            'STOCK_SPLIT',
            'TRANSFER_IN',
            'TRANSFER_OUT',
            ...activityTypes
                .filter(t => t.behavior === 'ADD' || t.behavior === 'REMOVE' || t.behavior === 'SPLIT')
                .map(t => t.name)
        ]));

        // Pre-fetch all activities for these symbols to avoid N+1 queries
        // 1. Fetch holdings-affecting activities (all time up to end of scan period)
        const holdingsActivities = await prisma.activity.findMany({
            where: {
                investment: { symbol: { in: symbolsToScan } },
                type: { in: holdingAffectingTypes },
                date: { lte: endDate }
            },
            include: { investment: { select: { symbol: true } } },
            orderBy: { date: 'asc' }
        });

        // 2. Fetch existing dividend activities (within fuzzy buffer range)
        const startBuffer = new Date(startDate);
        startBuffer.setDate(startBuffer.getDate() - 10);
        const endBuffer = new Date(endDate);
        endBuffer.setDate(endBuffer.getDate() + 10);

        const existingDividends = await prisma.activity.findMany({
            where: {
                investment: { symbol: { in: symbolsToScan } },
                type: 'DIVIDEND',
                date: { gte: startBuffer, lte: endBuffer }
            },
            include: { investment: { select: { symbol: true } } }
        });

        // Group activities by symbol for efficient lookup
        const holdingsActivitiesMap = new Map<string, typeof holdingsActivities>();
        holdingsActivities.forEach(a => {
            const sym = a.investment.symbol;
            if (!holdingsActivitiesMap.has(sym)) holdingsActivitiesMap.set(sym, []);
            holdingsActivitiesMap.get(sym)!.push(a);
        });

        const existingDividendsMap = new Map<string, typeof existingDividends>();
        existingDividends.forEach(a => {
            const sym = a.investment.symbol;
            if (!existingDividendsMap.has(sym)) existingDividendsMap.set(sym, []);
            existingDividendsMap.get(sym)!.push(a);
        });

        const foundDividends = [];

        // 2. Scan each symbol
        for (const symbol of symbolsToScan) {
            try {
                const chartResult = await apiThrottler.add(() => yahooFinance.chart(symbol, {
                    period1: startDate,
                    period2: endDate,
                    interval: '1d',
                    events: 'div'
                }));

                const symbolHoldingsActivities = holdingsActivitiesMap.get(symbol) || [];
                const symbolExistingDividends = existingDividendsMap.get(symbol) || [];

                if (chartResult.events && chartResult.events.dividends) {
                    for (const div of chartResult.events.dividends) {
                        const divDate = new Date(div.date);

                        // Include all holdings built through end of the day strictly before Ex-Date
                        const checkDate = new Date(divDate);
                        checkDate.setUTCDate(checkDate.getUTCDate() - 1);
                        checkDate.setUTCHours(23, 59, 59, 999);

                        const holdingsByAccount = calculateHoldingsFromActivities(symbolHoldingsActivities, checkDate, behaviorMap);

                        // # Reason: Yahoo Finance chart() returns split-adjusted dividend per-share amounts.
                        // Reverse any post-dividend splits back to the actual historical payout per pre-split share.
                        let postDivSplitFactor = 1;
                        const seenPostSplits = new Set<string>();
                        for (const act of symbolHoldingsActivities) {
                            if ((act.type === 'SPLIT' || act.type === 'STOCK_SPLIT') && new Date(act.date) > divDate) {
                                const ratio = Math.abs(act.quantity);
                                if (ratio > 0) {
                                    const splitDayKey = `${new Date(act.date).toISOString().split('T')[0]}:${ratio}`;
                                    if (!seenPostSplits.has(splitDayKey)) {
                                        seenPostSplits.add(splitDayKey);
                                        postDivSplitFactor *= ratio;
                                    }
                                }
                            }
                        }
                        const actualDividendRate = div.amount * postDivSplitFactor;

                        // Find price for the dividend date
                        let price = 0;
                        if (chartResult.quotes) {
                            const quote = chartResult.quotes.find(q => {
                                const qDate = new Date(q.date);
                                return qDate.toISOString().split('T')[0] === divDate.toISOString().split('T')[0];
                            });
                            if (quote) {
                                price = quote.close || 0;
                            }
                        }

                        for (const [accountId, quantity] of Object.entries(holdingsByAccount)) {
                            if (quantity > 0.0001) {
                                const match = symbolExistingDividends.find(d => {
                                    if (accountId !== 'unknown' && d.accountId !== accountId) return false;
                                    if (accountId === 'unknown' && d.accountId !== null) return false;

                                    const dDate = new Date(d.date);
                                    const diffDays = Math.abs(dDate.getTime() - divDate.getTime()) / (1000 * 60 * 60 * 24);
                                    return diffDays <= 10;
                                });

                                const account = accountMap.get(accountId);
                                let displayName = account?.name;
                                if (account && userMap.has(account.name)) {
                                    displayName = userMap.get(account.name) || account.name;
                                }

                                foundDividends.push({
                                    symbol,
                                    date: divDate.toISOString(),
                                    rate: actualDividendRate,
                                    quantity,
                                    amount: actualDividendRate * quantity,
                                    currency: chartResult.meta.currency || 'USD',
                                    accountId: accountId === 'unknown' ? null : accountId,
                                    price: price,
                                    isDuplicate: !!match,
                                    existingMatch: match ? {
                                        date: match.date,
                                        amount: Math.max(0, match.price * match.quantity - (match.fee || 0))
                                    } : null,
                                    isHidden: hiddenMap.has(`${symbol}-${divDate.toISOString().split('T')[0]}`),
                                    accountName: account?.name,
                                    accountDisplayName: displayName,
                                    accountType: account?.type,
                                    platformName: account?.platform?.name
                                });
                            }
                        }
                    }
                }
            } catch (err) {
                console.error(`Error scanning dividends for ${symbol}:`, err);
                // Continue to next symbol
            }
        }

        return NextResponse.json(foundDividends);

    } catch (error) {
        console.error('Error scanning dividends:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
