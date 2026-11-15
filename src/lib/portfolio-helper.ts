import { prisma } from '@/lib/prisma';

const ACTIVE_QUANTITY_EPSILON = 0.00001;

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
        const absQty = Math.abs(Number(activity.quantity) || 0);

        if (activity.type === 'BUY' || activity.type === 'TRANSFER_IN') {
            holdings[accId] = (holdings[accId] || 0) + absQty;
        } else if (activity.type === 'SELL' || activity.type === 'TRANSFER_OUT') {
            holdings[accId] = (holdings[accId] || 0) - absQty;
            if (holdings[accId] < 1e-9) holdings[accId] = 0;
        } else if ((activity.type === 'SPLIT' || activity.type === 'STOCK_SPLIT') && absQty > 0) {
            if (activity.accountId) {
                if (holdings[activity.accountId]) {
                    holdings[activity.accountId] *= absQty;
                }
            } else if (holdings['unknown']) {
                holdings['unknown'] *= absQty;
            } else {
                for (const key of Object.keys(holdings)) {
                    holdings[key] *= absQty;
                }
            }
        }

        if (holdings[accId] !== undefined && holdings[accId] < 1e-9) holdings[accId] = 0;
    }

    // Filter out zero, negative, or floating-point dust holdings
    const result: Record<string, number> = {};
    for (const [accId, qty] of Object.entries(holdings)) {
        if (qty > ACTIVE_QUANTITY_EPSILON) result[accId] = qty;
    }

    return result;
}

export interface HoldingActivityRecord {
    date: Date | string;
    type: string;
    quantity: number | string;
    accountId?: string | null;
}

/**
 * Calculates holdings from a provided list of activities up to a specific date.
 * Useful for avoiding N+1 queries when activities are already loaded.
 *
 * @param activities List of activities (should be pre-sorted by date asc for correct results)
 * @param date The date to check holdings for (inclusive)
 * @param behaviorMap Optional activity behavior map for custom activity types
 * @returns A map of accountId -> quantity
 */
export function calculateHoldingsFromActivities(
    activities: HoldingActivityRecord[],
    date: Date,
    behaviorMap?: Map<string, string>
): Record<string, number> {
    const holdings: Record<string, number> = {};

    for (const activity of activities) {
        const activityDate = new Date(activity.date);
        if (activityDate > date) continue;

        const accId = activity.accountId || 'unknown';
        const absQty = Math.abs(Number(activity.quantity) || 0);
        const behavior = behaviorMap?.get(activity.type);

        if (behavior === 'ADD' || activity.type === 'BUY' || activity.type === 'TRANSFER_IN') {
            holdings[accId] = (holdings[accId] || 0) + absQty;
        } else if (behavior === 'REMOVE' || activity.type === 'SELL' || activity.type === 'TRANSFER_OUT') {
            holdings[accId] = (holdings[accId] || 0) - absQty;
            if (holdings[accId] < 1e-9) holdings[accId] = 0;
        } else if ((behavior === 'SPLIT' || activity.type === 'SPLIT' || activity.type === 'STOCK_SPLIT') && absQty > 0) {
            if (activity.accountId) {
                if (holdings[activity.accountId]) {
                    holdings[activity.accountId] *= absQty;
                }
            } else if (holdings['unknown']) {
                holdings['unknown'] *= absQty;
            } else {
                for (const key of Object.keys(holdings)) {
                    holdings[key] *= absQty;
                }
            }
        }

        if (holdings[accId] !== undefined && holdings[accId] < 1e-9) holdings[accId] = 0;
    }

    const result: Record<string, number> = {};
    for (const [accId, qty] of Object.entries(holdings)) {
        if (qty > ACTIVE_QUANTITY_EPSILON) result[accId] = qty;
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
export async function findDividendMatch(symbol: string, date: Date, _amount: number, accountId?: string): Promise<unknown | null> {
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
