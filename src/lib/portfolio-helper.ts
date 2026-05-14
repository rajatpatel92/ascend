import { prisma } from '@/lib/prisma';

/**
 * Calculates the quantity of shares held for a symbol on a specific date, broken down by account.
 * Considers BUY, SELL, and SPLIT activities.
 * 
 * @param symbol The stock symbol
 * @param date The date to check holdings for (inclusive)
 * @returns A map of accountId -> quantity
 */
export async function getHoldingsAtDate(symbol: string, date: Date): Promise<Record<string, number>> {
    const activities = await prisma.activity.findMany({
        where: {
            investment: {
                symbol: symbol
            },
            date: {
                lte: date
            }
        },
        include: {
            account: true
        },
        orderBy: {
            date: 'asc'
        }
    });

    const holdings: Record<string, number> = {};

    for (const activity of activities) {
        const accId = activity.accountId || 'unknown';
        if (!holdings[accId]) holdings[accId] = 0;

        if (activity.type === 'BUY') {
            holdings[accId] += activity.quantity;
        } else if (activity.type === 'SELL') {
            holdings[accId] -= Math.abs(activity.quantity);
        } else if (activity.type === 'SPLIT' || activity.type === 'STOCK_SPLIT') {
            holdings[accId] *= activity.quantity;
        }

        // Negative Holdings Protection
        if (holdings[accId] < 0) holdings[accId] = 0;
    }

    // Filter out zero or negative holdings
    const result: Record<string, number> = {};
    for (const [accId, qty] of Object.entries(holdings)) {
        if (qty > 0) result[accId] = qty;
    }

    return result;
}

/**
 * Calculates holdings from a provided list of activities up to a specific date.
 * Useful for avoiding N+1 queries when activities are already loaded.
 *
 * @param activities List of activities (should be pre-sorted by date asc for correct results)
 * @param date The date to check holdings for (inclusive)
 * @returns A map of accountId -> quantity
 */
export function calculateHoldingsFromActivities(activities: any[], date: Date): Record<string, number> {
    const holdings: Record<string, number> = {};

    for (const activity of activities) {
        const activityDate = new Date(activity.date);
        if (activityDate > date) continue;

        const accId = activity.accountId || 'unknown';
        if (!holdings[accId]) holdings[accId] = 0;

        if (activity.type === 'BUY') {
            holdings[accId] += activity.quantity;
        } else if (activity.type === 'SELL') {
            holdings[accId] -= Math.abs(activity.quantity);
        } else if (activity.type === 'SPLIT' || activity.type === 'STOCK_SPLIT') {
            holdings[accId] *= activity.quantity;
        }
    }

    const result: Record<string, number> = {};
    for (const [accId, qty] of Object.entries(holdings)) {
        if (qty > 0) result[accId] = qty;
    }

    return result;
}

/**
 * Checks if a dividend activity already exists using a fuzzy date match (+/- 10 days).
 * 
 * @param symbol 
 * @param date 
 * @param amount 
 * @returns The matching activity if found, null otherwise
 */
export async function findDividendMatch(symbol: string, date: Date, _amount: number, accountId?: string): Promise<any | null> {
    const start = new Date(date);
    start.setDate(start.getDate() - 10);

    const end = new Date(date);
    end.setDate(end.getDate() + 10);

    const match = await prisma.activity.findFirst({
        where: {
            investment: {
                symbol: symbol
            },
            type: 'DIVIDEND',
            date: {
                gte: start,
                lte: end
            },
            ...(accountId ? { accountId } : {})
        }
    });
    return match;
}
