export const UNASSIGNED_OWNER_KEY = '__unassigned__';

export interface ActivityUser {
    id: string;
    username: string;
    name?: string | null;
}

export interface ActivityAccount {
    id: string;
    name: string;
    type: string;
    platformId?: string;
}

export interface ActivityInvestment {
    symbol: string;
    name: string;
    currencyCode: string;
    type: string;
}

export interface ActivityRecord {
    id: string;
    type: string;
    date: string;
    quantity: number;
    price: number;
    fee?: number | null;
    currency?: string | null;
    investment: ActivityInvestment;
    platform?: {
        id: string;
        name: string;
    } | null;
    account?: ActivityAccount | null;
}

export interface OwnerOption {
    value: string;
    label: string;
}

export interface ActivityFilterCriteria {
    range: string;
    customStart?: string;
    customEnd?: string;
    owner?: string;
    accountType?: string;
    platform?: string;
    symbol?: string;
    type?: string;
}

export interface ActivityFilterOptions {
    owners: OwnerOption[];
    accountTypes: string[];
    platforms: string[];
    symbols: string[];
    activityTypes: string[];
}

export interface ActivitiesSummary {
    totalCount: number;
    uniqueSymbolsCount: number;
    buyCount: number;
    sellCount: number;
    capitalInflows: number;
    capitalOutflows: number;
    netCapitalFlow: number;
    totalFees: number;
}

const PROCEEDS_OR_INCOME_FEE_DEDUCTED = new Set([
    'SELL',
    'REMOVE',
    'WITHDRAWAL',
    'TRANSFER_OUT',
    'DIVIDEND',
    'INTEREST'
]);

const COST_INCLUDING_FEE = new Set([
    'BUY',
    'ADD',
    'DEPOSIT',
    'TRANSFER_IN',
    'FEE'
]);

const CAPITAL_INFLOW_TYPES = new Set(['BUY', 'ADD', 'DEPOSIT', 'TRANSFER_IN']);
const CAPITAL_OUTFLOW_TYPES = new Set(['SELL', 'REMOVE', 'WITHDRAWAL', 'TRANSFER_OUT']);
const BUY_COUNT_TYPES = new Set(['BUY', 'ADD']);
const SELL_COUNT_TYPES = new Set(['SELL', 'REMOVE']);

function toLocalYmd(d: Date): string {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Normalizes a raw date string into a calendar YYYY-MM-DD key so UTC midnight
 * timestamps match local calendar date filters cleanly.
 */
export function normalizeActivityYmd(raw: string): string {
    if (!raw) return '';
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        return trimmed.slice(0, 10);
    }
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? '' : toLocalYmd(parsed);
}

/**
 * Resolves the canonical owner key (username) and human-readable display name
 * for an activity's account against the users list.
 */
export function resolveActivityOwner(
    account: Pick<ActivityAccount, 'name'> | null | undefined,
    users: ActivityUser[]
): { key: string; label: string } {
    const rawName = account?.name?.trim();
    if (!rawName) {
        return { key: UNASSIGNED_OWNER_KEY, label: 'Unassigned' };
    }

    const lowerName = rawName.toLowerCase();
    const matchedUser =
        users.find((u) => u.username === rawName) ||
        users.find((u) => u.username.toLowerCase() === lowerName);

    const displayName = matchedUser?.name?.trim() || rawName;
    return {
        key: rawName,
        label: displayName
    };
}

/**
 * Derives sorted, deduplicated dropdown filter options from the fetched activities
 * and users list, resolving Owner display names from user records.
 */
export function deriveActivityFilterOptions(
    activities: ActivityRecord[],
    users: ActivityUser[]
): ActivityFilterOptions {
    const ownerMap = new Map<string, string>();
    const accountTypesSet = new Set<string>();
    const platformsSet = new Set<string>();
    const symbolsSet = new Set<string>();
    const activityTypesSet = new Set<string>();

    for (const activity of activities) {
        const owner = resolveActivityOwner(activity.account, users);
        if (!ownerMap.has(owner.key)) {
            ownerMap.set(owner.key, owner.label);
        }

        if (activity.account?.type) {
            accountTypesSet.add(activity.account.type);
        }
        if (activity.platform?.name) {
            platformsSet.add(activity.platform.name);
        }
        if (activity.investment?.symbol) {
            symbolsSet.add(activity.investment.symbol);
        }
        if (activity.type) {
            activityTypesSet.add(activity.type);
        }
    }

    const owners: OwnerOption[] = Array.from(ownerMap.entries())
        .map(([value, label]) => ({ value, label }))
        .sort((a, b) => {
            if (a.value === UNASSIGNED_OWNER_KEY) return 1;
            if (b.value === UNASSIGNED_OWNER_KEY) return -1;
            return a.label.localeCompare(b.label);
        });

    return {
        owners,
        accountTypes: Array.from(accountTypesSet).sort((a, b) => a.localeCompare(b)),
        platforms: Array.from(platformsSet).sort((a, b) => a.localeCompare(b)),
        symbols: Array.from(symbolsSet).sort((a, b) => a.localeCompare(b)),
        activityTypes: Array.from(activityTypesSet).sort((a, b) => a.localeCompare(b))
    };
}

/**
 * Filters activities by time range, owner, account type, platform, symbol, and activity type.
 */
export function filterActivities<T extends ActivityRecord>(
    activities: T[],
    criteria: ActivityFilterCriteria,
    now: Date = new Date()
): T[] {
    let filtered = activities;

    if (criteria.range && criteria.range !== 'ALL') {
        if (criteria.range === 'CUSTOM') {
            const start = criteria.customStart?.trim();
            const end = criteria.customEnd?.trim();
            if (start || end) {
                filtered = filtered.filter((a) => {
                    const ymd = normalizeActivityYmd(a.date);
                    if (!ymd) return false;
                    if (start && ymd < start) return false;
                    if (end && ymd > end) return false;
                    return true;
                });
            }
        } else {
            const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            switch (criteria.range) {
                case '1W':
                    startDate.setDate(startDate.getDate() - 7);
                    break;
                case '1M':
                    startDate.setMonth(startDate.getMonth() - 1);
                    break;
                case '3M':
                    startDate.setMonth(startDate.getMonth() - 3);
                    break;
                case '6M':
                    startDate.setMonth(startDate.getMonth() - 6);
                    break;
                case 'YTD':
                    startDate.setMonth(0, 1);
                    break;
                case '1Y':
                    startDate.setFullYear(startDate.getFullYear() - 1);
                    break;
                case '2Y':
                    startDate.setFullYear(startDate.getFullYear() - 2);
                    break;
                case '3Y':
                    startDate.setFullYear(startDate.getFullYear() - 3);
                    break;
            }
            const startYmd = toLocalYmd(startDate);
            filtered = filtered.filter((a) => normalizeActivityYmd(a.date) >= startYmd);
        }
    }

    if (criteria.owner) {
        filtered = filtered.filter((a) => {
            const key = a.account?.name?.trim() || UNASSIGNED_OWNER_KEY;
            return key === criteria.owner;
        });
    }

    if (criteria.accountType) {
        filtered = filtered.filter((a) => a.account?.type === criteria.accountType);
    }

    if (criteria.platform) {
        filtered = filtered.filter((a) => a.platform?.name === criteria.platform);
    }

    if (criteria.symbol) {
        filtered = filtered.filter((a) => a.investment?.symbol === criteria.symbol);
    }

    if (criteria.type) {
        filtered = filtered.filter((a) => a.type === criteria.type);
    }

    return filtered;
}

/**
 * Calculates the net cash transaction value of an activity in its native currency.
 * Returns 0 for stock split events since splits represent ratio adjustments, not cash flow.
 */
export function computeActivityNetAmount(
    activity: Pick<ActivityRecord, 'type' | 'quantity' | 'price' | 'fee'>
): number {
    if (activity.type === 'STOCK_SPLIT' || activity.type === 'SPLIT') {
        return 0;
    }

    const gross = activity.quantity * activity.price;
    const fee = activity.fee || 0;

    if (PROCEEDS_OR_INCOME_FEE_DEDUCTED.has(activity.type)) {
        return gross - fee;
    }
    if (COST_INCLUDING_FEE.has(activity.type)) {
        return gross + fee;
    }
    return gross;
}

/**
 * Computes summary metrics across filtered activities in the selected display currency.
 */
export function computeActivitiesSummary(
    activities: ActivityRecord[],
    convertFn: (amount: number, fromCurrency: string) => number
): ActivitiesSummary {
    const symbols = new Set<string>();
    let buyCount = 0;
    let sellCount = 0;
    let capitalInflows = 0;
    let capitalOutflows = 0;
    let totalFees = 0;

    for (const activity of activities) {
        if (activity.investment?.symbol) {
            symbols.add(activity.investment.symbol);
        }

        if (BUY_COUNT_TYPES.has(activity.type)) {
            buyCount++;
        } else if (SELL_COUNT_TYPES.has(activity.type)) {
            sellCount++;
        }

        const fromCurrency = activity.currency || activity.investment?.currencyCode || 'USD';
        const netNative = computeActivityNetAmount(activity);
        const converted = convertFn(netNative, fromCurrency);

        if (CAPITAL_INFLOW_TYPES.has(activity.type)) {
            capitalInflows += converted;
        } else if (CAPITAL_OUTFLOW_TYPES.has(activity.type)) {
            capitalOutflows += converted;
        }

        const feeNative =
            activity.type === 'FEE'
                ? Math.abs(activity.quantity) * activity.price + (activity.fee || 0)
                : activity.fee || 0;
        if (feeNative > 0) {
            totalFees += convertFn(feeNative, fromCurrency);
        }
    }

    return {
        totalCount: activities.length,
        uniqueSymbolsCount: symbols.size,
        buyCount,
        sellCount,
        capitalInflows,
        capitalOutflows,
        netCapitalFlow: capitalInflows - capitalOutflows,
        totalFees
    };
}
