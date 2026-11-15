import {
    computeRebalancePlan,
    type AccountHoldingBreakdown,
    type PlannedRebalanceRow,
    type RebalanceItem,
    type RebalancePlanOptions,
    type RebalancePlanSummary,
    type TargetConfig
} from './rebalance-planner.ts';

export type TaxStatus = 'TAX_FREE' | 'TAX_DEFERRED' | 'TAXABLE';

export interface AccountTradeAllocation {
    accountName: string;
    accountType: string;
    platformName: string;
    taxStatus: TaxStatus;
    heldShares: number;
    heldValue: number;
    suggestedAction: 'BUY' | 'SELL' | 'HOLD';
    suggestedShares: number;
    suggestedValue: number;
}

export interface AccountTradeGuidance {
    allocations: AccountTradeAllocation[];
    primaryVenueLabel: string | null;
    hasTaxableSellWarning: boolean;
}

export type RebalanceDimension = 'TICKER' | 'CATEGORY';

export interface CategoryTargetConfig {
    investmentType: string;
    targetPercentage: number;
}

export interface ConstituentAllocation {
    symbol: string;
    currentValue: number;
    currentPercentInCategory: number;
    suggestedShares: number;
    suggestedValue: number;
    assetPrice: number;
    assetCurrency: string;
}

export interface PlannedCategoryRow extends PlannedRebalanceRow {
    investmentType: string;
    constituents: ConstituentAllocation[];
}

export interface CategoryRebalanceResult {
    rows: PlannedCategoryRow[];
    summary: RebalancePlanSummary;
}

export interface RebalanceProfile {
    id: string;
    name: string;
    dimension: RebalanceDimension;
    tickerTargets: TargetConfig[];
    categoryTargets: CategoryTargetConfig[];
    accountTypes?: string[];
    investmentTypes?: string[];
    excludeSymbols?: string;
    updatedAt: string;
}

export interface RebalanceProfileStore {
    activeProfileId: string;
    profiles: RebalanceProfile[];
}

export interface GlidePathScheduleReport {
    activeCount: number;
    netAnnualDrift: number;
    hasNetDriftWarning: boolean;
    lastAdjustedDate: string | null;
    nextAdjustmentDate: string | null;
}

const VALUE_EPSILON = 0.01;

const TAX_FREE_TYPES = new Set([
    'TFSA',
    'ROTH IRA',
    'FHSA',
    'PPF',
    'NRE'
]);

const TAX_DEFERRED_TYPES = new Set([
    'RRSP',
    'LIRA',
    'RESP',
    '401(K)',
    'TRADITIONAL IRA',
    'EPF',
    'NPS'
]);

/**
 * Classifies an account type into Tax-Free, Tax-Deferred, or Taxable buckets for sell prioritization.
 */
export function classifyAccountTaxStatus(accountType: string): TaxStatus {
    const normalized = (accountType || '').trim().toUpperCase();
    if (TAX_FREE_TYPES.has(normalized)) return 'TAX_FREE';
    if (TAX_DEFERRED_TYPES.has(normalized)) return 'TAX_DEFERRED';
    return 'TAXABLE';
}

export function getTaxStatusLabel(status: TaxStatus): string {
    if (status === 'TAX_FREE') return 'Tax-Free';
    if (status === 'TAX_DEFERRED') return 'Tax-Deferred';
    return 'Taxable';
}

function getSellPriorityRank(status: TaxStatus): number {
    if (status === 'TAX_FREE') return 0;
    if (status === 'TAX_DEFERRED') return 1;
    return 2;
}

/**
 * Allocates a planned symbol trade across the accounts holding that symbol, prioritizing
 * tax-sheltered accounts for SELLs and highlighting taxable capital-gains warnings.
 */
export function allocateTradeAcrossAccounts(
    accounts: AccountHoldingBreakdown[] | undefined,
    effectiveAction: 'BUY' | 'SELL' | 'HOLD',
    tradeValue: number,
    tradeShares: number,
    wholeShares: boolean
): AccountTradeGuidance {
    if (!accounts || accounts.length === 0) {
        return {
            allocations: [],
            primaryVenueLabel: null,
            hasTaxableSellWarning: false
        };
    }

    const totalHeldValue = accounts.reduce((s, a) => s + a.value, 0);
    const totalHeldShares = accounts.reduce((s, a) => s + a.quantity, 0);
    const unitValue = totalHeldShares > 0 && totalHeldValue > 0
        ? totalHeldValue / totalHeldShares
        : (tradeShares > 0 ? tradeValue / tradeShares : 0);

    const enriched = accounts.map((a) => ({
        ...a,
        taxStatus: classifyAccountTaxStatus(a.accountType)
    }));

    if (effectiveAction === 'HOLD' || tradeValue <= VALUE_EPSILON) {
        return {
            allocations: enriched.map((a) => ({
                accountName: a.accountName,
                accountType: a.accountType,
                platformName: a.platformName,
                taxStatus: a.taxStatus,
                heldShares: a.quantity,
                heldValue: a.value,
                suggestedAction: 'HOLD',
                suggestedShares: 0,
                suggestedValue: 0
            })),
            primaryVenueLabel: null,
            hasTaxableSellWarning: false
        };
    }

    if (effectiveAction === 'SELL') {
        // Order: TAX_FREE -> TAX_DEFERRED -> TAXABLE, then largest balance first
        const ordered = [...enriched].sort((a, b) => {
            const rankDiff = getSellPriorityRank(a.taxStatus) - getSellPriorityRank(b.taxStatus);
            if (rankDiff !== 0) return rankDiff;
            return b.value - a.value;
        });

        let remainingValue = tradeValue;
        let hasTaxableSellWarning = false;

        const allocations: AccountTradeAllocation[] = ordered.map((a) => {
            if (remainingValue <= VALUE_EPSILON || a.value <= VALUE_EPSILON) {
                return {
                    accountName: a.accountName,
                    accountType: a.accountType,
                    platformName: a.platformName,
                    taxStatus: a.taxStatus,
                    heldShares: a.quantity,
                    heldValue: a.value,
                    suggestedAction: 'HOLD',
                    suggestedShares: 0,
                    suggestedValue: 0
                };
            }

            let assignValue = Math.min(remainingValue, a.value);
            let assignShares = unitValue > 0 ? Math.min(a.quantity, assignValue / unitValue) : 0;

            if (wholeShares && unitValue > 0) {
                assignShares = Math.min(Math.floor(a.quantity), Math.round(assignShares));
                assignValue = assignShares * unitValue;
            }

            if (assignValue > VALUE_EPSILON && (assignShares > 0.0001 || !wholeShares)) {
                remainingValue = Math.max(0, remainingValue - assignValue);
                if (a.taxStatus === 'TAXABLE') {
                    hasTaxableSellWarning = true;
                }
                return {
                    accountName: a.accountName,
                    accountType: a.accountType,
                    platformName: a.platformName,
                    taxStatus: a.taxStatus,
                    heldShares: a.quantity,
                    heldValue: a.value,
                    suggestedAction: 'SELL',
                    suggestedShares: assignShares,
                    suggestedValue: assignValue
                };
            }

            return {
                accountName: a.accountName,
                accountType: a.accountType,
                platformName: a.platformName,
                taxStatus: a.taxStatus,
                heldShares: a.quantity,
                heldValue: a.value,
                suggestedAction: 'HOLD',
                suggestedShares: 0,
                suggestedValue: 0
            };
        });

        const activeSells = allocations.filter((a) => a.suggestedAction === 'SELL');
        let primaryVenueLabel: string | null = null;
        if (activeSells.length === 1) {
            primaryVenueLabel = `Sell in ${activeSells[0].accountName} (${getTaxStatusLabel(activeSells[0].taxStatus)})`;
        } else if (activeSells.length > 1) {
            primaryVenueLabel = `Sell across ${activeSells.length} accounts (${activeSells[0].accountName} first)`;
        }

        return {
            allocations,
            primaryVenueLabel,
            hasTaxableSellWarning
        };
    }

    // BUY: Prefer highest tax-sheltered account already holding the position
    const orderedBuy = [...enriched].sort((a, b) => {
        const rankDiff = getSellPriorityRank(a.taxStatus) - getSellPriorityRank(b.taxStatus);
        if (rankDiff !== 0) return rankDiff;
        return b.value - a.value;
    });
    const preferred = orderedBuy[0];

    const allocations: AccountTradeAllocation[] = orderedBuy.map((a, idx) => ({
        accountName: a.accountName,
        accountType: a.accountType,
        platformName: a.platformName,
        taxStatus: a.taxStatus,
        heldShares: a.quantity,
        heldValue: a.value,
        suggestedAction: idx === 0 ? 'BUY' : 'HOLD',
        suggestedShares: idx === 0 ? tradeShares : 0,
        suggestedValue: idx === 0 ? tradeValue : 0
    }));

    const primaryVenueLabel = preferred
        ? `Buy in ${preferred.accountName} (${getTaxStatusLabel(preferred.taxStatus)})`
        : null;

    return {
        allocations,
        primaryVenueLabel,
        hasTaxableSellWarning: false
    };
}

/**
 * Aggregates ticker holdings by Asset Type (investmentType) and computes category-level rebalance actions
 * plus pro-rata constituent share allocations.
 */
export function computeCategoryRebalancePlan(
    items: RebalanceItem[],
    categoryTargets: CategoryTargetConfig[],
    options: RebalancePlanOptions
): CategoryRebalanceResult {
    const targetByType = new Map<string, number>();
    for (const ct of categoryTargets) {
        const key = ct.investmentType.trim();
        if (key) targetByType.set(key, Math.max(0, ct.targetPercentage));
    }

    const totalValue = items.reduce((s, item) => s + item.currentValue, 0);
    const groupMap = new Map<string, RebalanceItem[]>();

    for (const item of items) {
        const typeName = (item.investmentType || 'Uncategorized').trim() || 'Uncategorized';
        const list = groupMap.get(typeName) || [];
        list.push(item);
        groupMap.set(typeName, list);
    }

    for (const ct of categoryTargets) {
        const typeName = ct.investmentType.trim();
        if (typeName && !groupMap.has(typeName)) {
            groupMap.set(typeName, []);
        }
    }

    const categoryItems: RebalanceItem[] = Array.from(groupMap.entries()).map(([typeName, members]) => {
        const currentValue = members.reduce((s, m) => s + m.currentValue, 0);
        const currentPercent = totalValue > 0 ? (currentValue / totalValue) * 100 : 0;
        const targetPercent = targetByType.get(typeName) ?? 0;
        const targetValue = (targetPercent / 100) * totalValue;
        const driftValue = currentValue - targetValue;
        const driftPercent = currentPercent - targetPercent;

        return {
            symbol: typeName,
            investmentType: typeName,
            currentPercent,
            targetPercent,
            glidePathPercent: null,
            driftPercent,
            currentValue,
            targetValue,
            driftValue,
            action: Math.abs(driftValue) > VALUE_EPSILON ? (driftValue > 0 ? 'SELL' : 'BUY') : 'HOLD',
            actionShares: Math.abs(driftValue),
            assetPrice: 1, // Category rows price trades in currency units ($1/unit)
            assetCurrency: members[0]?.assetCurrency || 'USD'
        };
    });

    const planned = computeRebalancePlan(categoryItems, {
        ...options,
        wholeShares: false // Currency-denominated category trade totals
    });

    const rows: PlannedCategoryRow[] = planned.rows
        .map((row) => {
            const members = groupMap.get(row.symbol) || [];
            const memberTotalValue = members.reduce((s, m) => s + m.currentValue, 0);
            const equalShare = members.length > 0 ? 1 / members.length : 0;

            const constituents: ConstituentAllocation[] = members.map((m) => {
                const weight = memberTotalValue > VALUE_EPSILON ? m.currentValue / memberTotalValue : equalShare;
                const suggestedValue = row.effectiveAction === 'HOLD' ? 0 : row.tradeValue * weight;
                const unitPrice = m.actionShares > 0.000001 && Math.abs(m.driftValue) > VALUE_EPSILON
                    ? Math.abs(m.driftValue) / m.actionShares
                    : m.assetPrice;
                const rawShares = unitPrice > 0 ? suggestedValue / unitPrice : 0;
                const suggestedShares = options.wholeShares
                    ? (options.mode === 'BUY_ONLY' ? Math.floor(rawShares) : Math.round(rawShares))
                    : rawShares;

                return {
                    symbol: m.symbol,
                    currentValue: m.currentValue,
                    currentPercentInCategory: weight * 100,
                    suggestedShares,
                    suggestedValue: options.wholeShares && unitPrice > 0 ? suggestedShares * unitPrice : suggestedValue,
                    assetPrice: m.assetPrice,
                    assetCurrency: m.assetCurrency
                };
            });

            return {
                ...row,
                investmentType: row.symbol,
                constituents
            };
        })
        .sort((a, b) => a.driftPercent - b.driftPercent);

    return {
        rows,
        summary: planned.summary
    };
}

/**
 * Proportionally normalizes CategoryTargetConfig entries to sum to 100.0%.
 */
export function normalizeCategoryTargetsTo100(targets: CategoryTargetConfig[]): CategoryTargetConfig[] {
    const positive = targets.filter((t) => t.targetPercentage > 0 && t.investmentType.trim() !== '');
    const total = positive.reduce((sum, t) => sum + t.targetPercentage, 0);
    if (total <= 0) return targets;

    const scaled = targets.map((t) => {
        if (t.targetPercentage <= 0 || t.investmentType.trim() === '') {
            return { ...t, targetPercentage: 0 };
        }
        return {
            ...t,
            targetPercentage: Math.round(((t.targetPercentage / total) * 100) * 10) / 10
        };
    });

    const roundedTotal = scaled.reduce((sum, t) => sum + t.targetPercentage, 0);
    const diff = Math.round((100 - roundedTotal) * 10) / 10;
    if (Math.abs(diff) > 0) {
        let maxIdx = -1;
        let maxVal = -1;
        scaled.forEach((t, idx) => {
            if (t.targetPercentage > maxVal) {
                maxVal = t.targetPercentage;
                maxIdx = idx;
            }
        });
        if (maxIdx !== -1) {
            scaled[maxIdx] = {
                ...scaled[maxIdx],
                targetPercentage: Math.max(0, Math.round((scaled[maxIdx].targetPercentage + diff) * 10) / 10)
            };
        }
    }

    return scaled;
}

/**
 * Seeds category target weights from current holdings' InvestmentType breakdown.
 */
export function seedCategoryTargetsFromHoldings(items: RebalanceItem[]): CategoryTargetConfig[] {
    const totalValue = items.reduce((s, item) => s + item.currentValue, 0);
    if (totalValue <= VALUE_EPSILON) return [];

    const byType = new Map<string, number>();
    for (const item of items) {
        if (item.currentValue <= VALUE_EPSILON) continue;
        const typeName = (item.investmentType || 'Uncategorized').trim() || 'Uncategorized';
        byType.set(typeName, (byType.get(typeName) || 0) + item.currentValue);
    }

    const raw: CategoryTargetConfig[] = Array.from(byType.entries()).map(([investmentType, val]) => ({
        investmentType,
        targetPercentage: Math.round(((val / totalValue) * 100) * 10) / 10
    }));

    return normalizeCategoryTargetsTo100(raw).sort((a, b) => b.targetPercentage - a.targetPercentage);
}

/**
 * Generates an equal-weight target allocation across currently held or configured symbols.
 */
export function buildEqualWeightTargets(
    symbols: string[],
    existingTargets: TargetConfig[]
): TargetConfig[] {
    const unique = Array.from(new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean)));
    if (unique.length === 0) return [];

    const existingMap = new Map(existingTargets.map((t) => [t.symbol.trim().toUpperCase(), t]));
    const baseWeight = Math.round((100 / unique.length) * 10) / 10;

    const list: TargetConfig[] = unique.map((symbol, index) => ({
        symbol,
        targetPercentage: index === 0
            ? Math.round((100 - baseWeight * (unique.length - 1)) * 10) / 10
            : baseWeight,
        yearlyDriftAdjustment: existingMap.get(symbol)?.yearlyDriftAdjustment ?? null
    }));

    return list;
}

/**
 * Validates glide path annual drift rules, checks whether net annual shift is 0.0%/yr,
 * and computes the next scheduled annual adjustment date.
 */
export function validateGlidePathSchedule(targets: TargetConfig[]): GlidePathScheduleReport {
    const active = targets.filter(
        (t) => t.symbol.trim() !== '' && t.yearlyDriftAdjustment !== null && t.yearlyDriftAdjustment !== 0
    );

    const netAnnualDrift = Math.round(
        active.reduce((sum, t) => sum + (t.yearlyDriftAdjustment || 0), 0) * 100
    ) / 100;

    let latestAdjustedMs = -Infinity;
    let earliestNextMs = Infinity;

    for (const t of active) {
        const refStr = t.lastAdjustmentDate || t.createdAt;
        if (!refStr) continue;
        const refDate = new Date(refStr);
        if (Number.isNaN(refDate.getTime())) continue;

        if (refDate.getTime() > latestAdjustedMs) {
            latestAdjustedMs = refDate.getTime();
        }
        const next = new Date(refDate);
        next.setFullYear(next.getFullYear() + 1);
        if (next.getTime() < earliestNextMs) {
            earliestNextMs = next.getTime();
        }
    }

    return {
        activeCount: active.length,
        netAnnualDrift,
        hasNetDriftWarning: active.length > 0 && Math.abs(netAnnualDrift) >= 0.05,
        lastAdjustedDate: latestAdjustedMs > -Infinity ? new Date(latestAdjustedMs).toISOString().split('T')[0] : null,
        nextAdjustmentDate: earliestNextMs < Infinity ? new Date(earliestNextMs).toISOString().split('T')[0] : null
    };
}

/**
 * Simulates applying N annual glide-path steps in-memory so the user can preview changes before saving.
 */
export function simulateGlideStep(
    targets: TargetConfig[],
    years: number = 1
): { simulatedTargets: TargetConfig[]; postStepTotal: number } {
    const simulatedTargets = targets.map((t) => {
        const adj = t.yearlyDriftAdjustment ?? 0;
        const nextPct = Math.max(0, Math.round((t.targetPercentage + adj * years) * 10) / 10);
        return {
            ...t,
            targetPercentage: nextPct
        };
    });

    const postStepTotal = Math.round(
        simulatedTargets.reduce((sum, t) => sum + t.targetPercentage, 0) * 10
    ) / 10;

    return { simulatedTargets, postStepTotal };
}
