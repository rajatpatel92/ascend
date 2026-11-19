import type { CountryBreakdown, SectorBreakdown } from './look-through.ts';
import type { PortfolioHoldingStock } from './holdings-look-through.ts';

export type AllocationScopeDimension =
    | 'sector'
    | 'country'
    | 'holdings'
    | 'type'
    | 'accountType'
    | 'account';

export type ScopeFilterKey =
    | 'sector'
    | 'country'
    | 'stockKey'
    | 'investmentType'
    | 'accountType'
    | 'accountName';

export interface ScopeInteractiveFilters {
    investmentType: string | null;
    accountType: string | null;
    accountName: string | null;
    sector: string | null;
    country: string | null;
    stockKey: string | null;
}

export interface ScopeConstituentInput {
    symbol: string;
    quantity: number;
    value: number;
    valueTarget?: number;
    conversionRate?: number;
}

export interface HoldingsScopeRowMetrics {
    symbol: string;
    /** Weight (0..100) of this X-Ray focus inside the constituent holding. Null in slice mode. */
    weightPct: number | null;
    /** Exposure value (xray) or position value (slice) in target currency. */
    exposureValue: number;
    /** Percentage share (0..100) of the scoped total represented by this constituent. */
    sharePct: number;
    /** True for direct holdings, false for ETF look-through contributors. Undefined in slice mode. */
    isDirect?: boolean;
    /** Pill label shown next to symbol in X-Ray mode. */
    sourceLabel?: 'Direct Holding' | 'ETF Look-Through';
}

export interface HoldingsScopeInfo {
    mode: 'xray' | 'slice';
    dimension: ScopeFilterKey;
    kind: string;
    title: string;
    subtitle: string;
    totalValue: number;
    portfolioPct: number;
    directValue: number;
    etfValue: number;
    bySymbol: Record<string, HoldingsScopeRowMetrics>;
}

export interface BuildHoldingsScopeParams {
    activeDimension: AllocationScopeDimension;
    filters: ScopeInteractiveFilters;
    filteredConstituents: ScopeConstituentInput[];
    totalPortfolioValue: number;
    activeSectorBreakdown: SectorBreakdown | null;
    activeCountryBreakdown: CountryBreakdown | null;
    selectedStock: PortfolioHoldingStock | null;
}

const QUANTITY_EPSILON = 0.00001;
const VALUE_EPSILON = 0.01;

function getTargetValue(item: ScopeConstituentInput): number {
    return item.valueTarget ?? item.value * (item.conversionRate || 1);
}

function pickActiveXrayKey(
    activeDimension: AllocationScopeDimension,
    filters: ScopeInteractiveFilters
): 'stockKey' | 'country' | 'sector' | null {
    if (activeDimension === 'holdings' && filters.stockKey) return 'stockKey';
    if (activeDimension === 'country' && filters.country) return 'country';
    if (activeDimension === 'sector' && filters.sector) return 'sector';

    if (filters.stockKey) return 'stockKey';
    if (filters.country) return 'country';
    if (filters.sector) return 'sector';
    return null;
}

function pickActiveSliceKey(
    activeDimension: AllocationScopeDimension,
    filters: ScopeInteractiveFilters
): 'investmentType' | 'accountType' | 'accountName' | null {
    if (activeDimension === 'account' && filters.accountName) return 'accountName';
    if (activeDimension === 'accountType' && filters.accountType) return 'accountType';
    if (activeDimension === 'type' && filters.investmentType) return 'investmentType';

    if (filters.accountName) return 'accountName';
    if (filters.accountType) return 'accountType';
    if (filters.investmentType) return 'investmentType';
    return null;
}

function formatSecondaryFilterContext(
    filters: ScopeInteractiveFilters,
    primaryKey: ScopeFilterKey
): string | null {
    const parts: string[] = [];
    if (primaryKey !== 'sector' && filters.sector) parts.push(`Sector: ${filters.sector}`);
    if (primaryKey !== 'country' && filters.country) parts.push(`Geography: ${filters.country}`);
    if (primaryKey !== 'investmentType' && filters.investmentType) parts.push(`Asset Type: ${filters.investmentType}`);
    if (primaryKey !== 'accountType' && filters.accountType) parts.push(`Account Type: ${filters.accountType}`);
    if (primaryKey !== 'accountName' && filters.accountName) parts.push(`Account: ${filters.accountName}`);
    return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Builds the unified Portfolio X-Ray or Scope descriptor consumed by ConstituentsGrid
 * so all six allocation tabs share a single consolidated holdings card.
 */
export function buildHoldingsScope({
    activeDimension,
    filters,
    filteredConstituents,
    totalPortfolioValue,
    activeSectorBreakdown,
    activeCountryBreakdown,
    selectedStock,
}: BuildHoldingsScopeParams): HoldingsScopeInfo | null {
    const activeConstituents = filteredConstituents.filter(
        (c) => c && c.quantity >= QUANTITY_EPSILON && getTargetValue(c) >= VALUE_EPSILON
    );

    const hasAccountOrTypeNarrowing = Boolean(
        filters.investmentType || filters.accountType || filters.accountName
    );

    const xrayKey = pickActiveXrayKey(activeDimension, filters);

    if (xrayKey) {
        let kind = 'Sector';
        let title = '';
        let baseSubtitle = '';

        const rawRows: Array<{
            symbol: string;
            weightPct: number;
            exposureValue: number;
            isDirect: boolean;
        }> = [];

        if (xrayKey === 'stockKey') {
            if (!selectedStock) return null;
            kind = 'Underlying Stock';
            title = selectedStock.ticker
                ? `${selectedStock.name} (${selectedStock.ticker})`
                : selectedStock.name;
            baseSubtitle =
                'Aggregate exposure across direct equity positions and underlying ETF look-through weights.';

            for (const item of activeConstituents) {
                const itemVal = getTargetValue(item);
                const matching = selectedStock.contributors.filter((c) => c.symbol === item.symbol);
                if (matching.length === 0) continue;

                let exposureValue = 0;
                let weightFraction = 0;
                let isDirect = false;

                for (const contrib of matching) {
                    if (contrib.isDirect) isDirect = true;
                    weightFraction += contrib.weightInFund;
                    exposureValue += hasAccountOrTypeNarrowing
                        ? itemVal * contrib.weightInFund
                        : contrib.value;
                }

                if (exposureValue < VALUE_EPSILON) continue;
                rawRows.push({
                    symbol: item.symbol,
                    weightPct: Math.min(100, weightFraction * 100),
                    exposureValue,
                    isDirect,
                });
            }
        } else {
            const breakdown = xrayKey === 'country' ? activeCountryBreakdown : activeSectorBreakdown;
            if (!breakdown) return null;

            kind = xrayKey === 'country' ? 'Geography' : 'Sector';
            title = breakdown.name;
            baseSubtitle =
                xrayKey === 'country'
                    ? 'Geographic exposure combining direct holdings and underlying ETF country weights.'
                    : 'Sector exposure combining direct holdings and underlying ETF sector weights.';

            for (const item of activeConstituents) {
                const itemVal = getTargetValue(item);
                const contrib = breakdown.contributors.find((c) => c.symbol === item.symbol);
                if (!contrib) continue;

                const isScaled = Math.abs(itemVal - contrib.holdingValue) > VALUE_EPSILON;
                const exposureValue = isScaled
                    ? itemVal * contrib.weightInHolding
                    : contrib.allocatedValue;

                if (exposureValue < VALUE_EPSILON) continue;
                rawRows.push({
                    symbol: item.symbol,
                    weightPct: Math.min(100, contrib.weightInHolding * 100),
                    exposureValue,
                    isDirect: !contrib.isLookThrough,
                });
            }
        }

        const totalValue = rawRows.reduce((sum, r) => sum + r.exposureValue, 0);
        const directValue = rawRows
            .filter((r) => r.isDirect)
            .reduce((sum, r) => sum + r.exposureValue, 0);
        const etfValue = rawRows
            .filter((r) => !r.isDirect)
            .reduce((sum, r) => sum + r.exposureValue, 0);

        const bySymbol: Record<string, HoldingsScopeRowMetrics> = {};
        for (const r of rawRows) {
            bySymbol[r.symbol] = {
                symbol: r.symbol,
                weightPct: r.weightPct,
                exposureValue: r.exposureValue,
                sharePct: totalValue > 0 ? (r.exposureValue / totalValue) * 100 : 0,
                isDirect: r.isDirect,
                sourceLabel: r.isDirect ? 'Direct Holding' : 'ETF Look-Through',
            };
        }

        const extraContext = formatSecondaryFilterContext(filters, xrayKey);
        const subtitle = extraContext ? `${baseSubtitle} Scoped to ${extraContext}.` : baseSubtitle;

        return {
            mode: 'xray',
            dimension: xrayKey,
            kind,
            title,
            subtitle,
            totalValue,
            portfolioPct: totalPortfolioValue > 0 ? (totalValue / totalPortfolioValue) * 100 : 0,
            directValue,
            etfValue,
            bySymbol,
        };
    }

    const sliceKey = pickActiveSliceKey(activeDimension, filters);
    if (!sliceKey) return null;

    const sliceTitle = filters[sliceKey];
    if (!sliceTitle) return null;

    let kind = 'Asset Type';
    let baseSubtitle = `Holdings filtered to ${sliceTitle} positions across your selected accounts.`;
    if (sliceKey === 'accountType') {
        kind = 'Account Type';
        baseSubtitle = `Share counts, book value, and returns scoped specifically to ${sliceTitle} accounts.`;
    } else if (sliceKey === 'accountName') {
        kind = 'Account';
        baseSubtitle = `Holdings held inside ${sliceTitle} with account-scoped cost basis and returns.`;
    }

    const totalValue = activeConstituents.reduce((sum, c) => sum + getTargetValue(c), 0);
    const bySymbol: Record<string, HoldingsScopeRowMetrics> = {};
    for (const c of activeConstituents) {
        const val = getTargetValue(c);
        bySymbol[c.symbol] = {
            symbol: c.symbol,
            weightPct: null,
            exposureValue: val,
            sharePct: totalValue > 0 ? (val / totalValue) * 100 : 0,
        };
    }

    const extraContext = formatSecondaryFilterContext(filters, sliceKey);
    const subtitle = extraContext ? `${baseSubtitle} Combined with ${extraContext}.` : baseSubtitle;

    return {
        mode: 'slice',
        dimension: sliceKey,
        kind,
        title: sliceTitle,
        subtitle,
        totalValue,
        portfolioPct: totalPortfolioValue > 0 ? (totalValue / totalPortfolioValue) * 100 : 0,
        directValue: 0,
        etfValue: 0,
        bySymbol,
    };
}
