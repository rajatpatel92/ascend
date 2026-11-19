import {
    clusterBySecurityIdentity,
    parseSecurityIdentity,
    sanitizeStoredHoldings,
    scoreHoldingDisplayName,
    type ParsedSecurityIdentity,
} from './issuers/holdings.ts';
import type { UnderlyingHoldingEntry } from './issuers/types.ts';

export interface HoldingsLookThroughConstituent {
    symbol: string;
    name?: string | null;
    type?: string | null;
    value: number;
    currency?: string;
    sector?: string | null;
    country?: string | null;
    topHoldings?: UnderlyingHoldingEntry[] | null;
}

export interface PortfolioHoldingContributor {
    symbol: string;
    name: string;
    isDirect: boolean;
    /** Weight inside the ETF (0..1) when `isDirect === false`, or 1 for direct holdings. */
    weightInFund: number;
    /** Dollar amount attributed to this underlying stock from this constituent (in target currency). */
    value: number;
    /** Share of this stock's total portfolio dollar exposure coming from this constituent (0..100). */
    percentageOfStock: number;
    source?: string;
}

export interface PortfolioHoldingStock {
    /** Stable cluster key identifying this security & share class (never merges dual classes). */
    key: string;
    name: string;
    ticker?: string;
    isin?: string;
    sector?: string;
    country?: string;
    /** Combined portfolio dollar value (direct + ETF look-through) in target currency. */
    value: number;
    /** Percentage of total active portfolio value (0..100). */
    percentage: number;
    directValue: number;
    lookThroughValue: number;
    contributorCount: number;
    contributors: PortfolioHoldingContributor[];
}

export interface PortfolioHoldingsSummary {
    totalPortfolioValue: number;
    directStocksValue: number;
    etfLookThroughStocksValue: number;
    totalEquityLookThroughValue: number;
    fixedIncomeAndCashValue: number;
    unattributedFundValue: number;
    uniqueStockCount: number;
    fundsWithHoldingsCount: number;
    fundsTotalCount: number;
}

export interface PortfolioHoldingsLookThroughResult {
    holdings: PortfolioHoldingStock[];
    summary: PortfolioHoldingsSummary;
}

interface RawStockObservation {
    identity: ParsedSecurityIdentity;
    rawTicker?: string;
    sector?: string;
    country?: string;
    sourceSymbol: string;
    sourceName: string;
    isDirect: boolean;
    weightInFund: number;
    value: number;
    source?: string;
}

const NON_EQUITY_DIRECT_TYPES = new Set(['CASH', 'CRYPTO', 'COMMODITY', 'BOND']);
const FUND_LIKE_TYPES = new Set(['ETF', 'MUTUALFUND', 'FUND']);

function isFundLikeConstituent(c: HoldingsLookThroughConstituent): boolean {
    const upperType = (c.type || '').toUpperCase();
    if (FUND_LIKE_TYPES.has(upperType)) return true;
    if (NON_EQUITY_DIRECT_TYPES.has(upperType) || upperType === 'EQUITY') return false;
    return Array.isArray(c.topHoldings) && c.topHoldings.length > 0;
}

function deriveStableStockKey(
    bestIdentity: { isin?: string; tickerKey?: string; nameKey?: string; name: string },
    fallbackIndex: number
): string {
    if (bestIdentity.isin) return `isin:${bestIdentity.isin}`;
    if (bestIdentity.tickerKey) return bestIdentity.tickerKey;
    if (bestIdentity.nameKey) return bestIdentity.nameKey;
    return `stock:${fallbackIndex}:${bestIdentity.name.toLowerCase()}`;
}

/**
 * Aggregates cumulative individual-stock exposure across direct equity positions and
 * underlying ETF look-through holdings while preserving dual-class shares separately.
 */
export function calculatePortfolioHoldingsLookThrough(
    constituents: HoldingsLookThroughConstituent[]
): PortfolioHoldingsLookThroughResult {
    const active = (Array.isArray(constituents) ? constituents : []).filter(
        (c) => c && typeof c.value === 'number' && Number.isFinite(c.value) && c.value >= 0.01
    );

    const totalPortfolioValue = active.reduce((sum, c) => sum + c.value, 0);
    let directStocksValue = 0;
    let etfLookThroughStocksValue = 0;
    let fixedIncomeAndCashValue = 0;
    let unattributedFundValue = 0;
    let fundsWithHoldingsCount = 0;
    let fundsTotalCount = 0;

    const observations: RawStockObservation[] = [];

    for (const c of active) {
        const upperType = (c.type || '').toUpperCase();

        if (NON_EQUITY_DIRECT_TYPES.has(upperType)) {
            fixedIncomeAndCashValue += c.value;
            continue;
        }

        if (isFundLikeConstituent(c)) {
            fundsTotalCount++;
            const holdings = sanitizeStoredHoldings(c.topHoldings);
            if (holdings.length === 0) {
                unattributedFundValue += c.value;
                continue;
            }

            fundsWithHoldingsCount++;
            const equityRows = holdings.filter((h) => h.assetClass !== 'BOND');
            const bondWeightSum = Math.min(
                1,
                holdings
                    .filter((h) => h.assetClass === 'BOND')
                    .reduce((sum, h) => sum + h.weight, 0)
            );

            let trackedEquityValueInFund = 0;
            // # Reason: Direct-issuer holdings represent Top 250 positions out of potentially thousands;
            // we keep exact fund weights (c.value * h.weight) without renormalizing to 100%, placing the rest in unattributedFundValue.
            const maxEquityScale = Math.max(0, 1 - bondWeightSum);
            const rawEquityWeightSum = equityRows.reduce((sum, h) => sum + h.weight, 0);
            const equityClampFactor =
                rawEquityWeightSum > 1.0001 && rawEquityWeightSum > 0
                    ? maxEquityScale / rawEquityWeightSum
                    : 1;

            for (const h of equityRows) {
                const effectiveWeight = h.weight * equityClampFactor;
                const dollarValue = c.value * effectiveWeight;
                if (dollarValue < 0.001) continue;

                trackedEquityValueInFund += dollarValue;
                const identity = parseSecurityIdentity({
                    name: h.name,
                    ticker: h.ticker,
                    isin: h.isin,
                    country: h.country,
                });

                observations.push({
                    identity,
                    rawTicker: h.ticker,
                    sector: h.sector,
                    country: h.country,
                    sourceSymbol: c.symbol,
                    sourceName: c.name || c.symbol,
                    isDirect: false,
                    weightInFund: effectiveWeight,
                    value: dollarValue,
                    source: h.source,
                });
            }

            const bondDollarValue = Math.min(
                Math.max(0, c.value - trackedEquityValueInFund),
                c.value * bondWeightSum
            );
            etfLookThroughStocksValue += trackedEquityValueInFund;
            fixedIncomeAndCashValue += bondDollarValue;
            unattributedFundValue += Math.max(0, c.value - trackedEquityValueInFund - bondDollarValue);
            continue;
        }

        // Direct Equity holding
        directStocksValue += c.value;
        const identity = parseSecurityIdentity({
            name: c.name || c.symbol,
            ticker: c.symbol,
            country: c.country,
        });
        observations.push({
            identity,
            rawTicker: c.symbol,
            sector: c.sector || undefined,
            country: c.country || undefined,
            sourceSymbol: c.symbol,
            sourceName: c.name || c.symbol,
            isDirect: true,
            weightInFund: 1,
            value: c.value,
            source: 'direct',
        });
    }

    if (observations.length === 0) {
        return {
            holdings: [],
            summary: {
                totalPortfolioValue,
                directStocksValue,
                etfLookThroughStocksValue,
                totalEquityLookThroughValue: directStocksValue + etfLookThroughStocksValue,
                fixedIncomeAndCashValue,
                unattributedFundValue,
                uniqueStockCount: 0,
                fundsWithHoldingsCount,
                fundsTotalCount,
            },
        };
    }

    const roots = clusterBySecurityIdentity(observations.map((o) => o.identity));

    interface ClusterGroup {
        name: string;
        nameScore: number;
        ticker?: string;
        isin?: string;
        tickerKey?: string;
        nameKey?: string;
        sector?: string;
        country?: string;
        directValue: number;
        lookThroughValue: number;
        contributorMap: Map<string, Omit<PortfolioHoldingContributor, 'percentageOfStock'>>;
    }

    const clusters = new Map<number, ClusterGroup>();

    for (let i = 0; i < observations.length; i++) {
        const root = roots[i];
        const obs = observations[i];
        const candidateName = obs.identity.cleanDisplayName;
        // Prefer direct constituent's name/ticker slightly when tied with ETF all-caps strings
        const candidateScore =
            scoreHoldingDisplayName(candidateName) + (obs.isDirect ? 2 : 0);
        const preferredTicker = obs.rawTicker?.trim().toUpperCase() || obs.identity.cleanTicker;

        let group = clusters.get(root);
        if (!group) {
            group = {
                name: candidateName,
                nameScore: candidateScore,
                ticker: preferredTicker,
                isin: obs.identity.isin,
                tickerKey: obs.identity.tickerKey,
                nameKey: obs.identity.nameKey,
                sector: obs.sector,
                country: obs.country,
                directValue: 0,
                lookThroughValue: 0,
                contributorMap: new Map(),
            };
            clusters.set(root, group);
        } else {
            if (candidateScore > group.nameScore) {
                group.name = candidateName;
                group.nameScore = candidateScore;
            }
            if (
                preferredTicker &&
                (!group.ticker || (obs.isDirect && !group.ticker.includes('.')) || (preferredTicker.includes('.') && !group.ticker.includes('.')))
            ) {
                group.ticker = preferredTicker;
            }
            if (!group.isin && obs.identity.isin) group.isin = obs.identity.isin;
            if (!group.tickerKey && obs.identity.tickerKey) group.tickerKey = obs.identity.tickerKey;
            if (!group.nameKey && obs.identity.nameKey) group.nameKey = obs.identity.nameKey;
            if (!group.sector && obs.sector) group.sector = obs.sector;
            if (!group.country && obs.country) group.country = obs.country;
        }

        if (obs.isDirect) {
            group.directValue += obs.value;
        } else {
            group.lookThroughValue += obs.value;
        }

        const contribKey = `${obs.isDirect ? 'D' : 'F'}:${obs.sourceSymbol}`;
        const existingContrib = group.contributorMap.get(contribKey);
        if (existingContrib) {
            existingContrib.value += obs.value;
            existingContrib.weightInFund = Math.max(existingContrib.weightInFund, obs.weightInFund);
        } else {
            group.contributorMap.set(contribKey, {
                symbol: obs.sourceSymbol,
                name: obs.sourceName,
                isDirect: obs.isDirect,
                weightInFund: obs.weightInFund,
                value: obs.value,
                source: obs.source,
            });
        }
    }

    let clusterIndex = 0;
    const holdings: PortfolioHoldingStock[] = Array.from(clusters.values())
        .map((group) => {
            const totalStockValue = group.directValue + group.lookThroughValue;
            const contributors: PortfolioHoldingContributor[] = Array.from(
                group.contributorMap.values()
            )
                .map((c) => ({
                    ...c,
                    percentageOfStock: totalStockValue > 0 ? (c.value / totalStockValue) * 100 : 0,
                }))
                .sort((a, b) => b.value - a.value);

            return {
                key: deriveStableStockKey(group, clusterIndex++),
                name: group.name,
                ticker: group.ticker,
                isin: group.isin,
                sector: group.sector,
                country: group.country,
                value: totalStockValue,
                percentage: totalPortfolioValue > 0 ? (totalStockValue / totalPortfolioValue) * 100 : 0,
                directValue: group.directValue,
                lookThroughValue: group.lookThroughValue,
                contributorCount: contributors.length,
                contributors,
            };
        })
        .filter((h) => h.value >= 0.01)
        .sort((a, b) => b.value - a.value);

    return {
        holdings,
        summary: {
            totalPortfolioValue,
            directStocksValue,
            etfLookThroughStocksValue,
            totalEquityLookThroughValue: directStocksValue + etfLookThroughStocksValue,
            fixedIncomeAndCashValue,
            unattributedFundValue,
            uniqueStockCount: holdings.length,
            fundsWithHoldingsCount,
            fundsTotalCount,
        },
    };
}

/**
 * Returns true if the given constituent directly is, or holds via look-through, the selected stock.
 */
export function constituentHoldsUnderlyingStock(
    constituent: { symbol?: string },
    stock: PortfolioHoldingStock | null | undefined
): boolean {
    if (!constituent?.symbol || !stock) return false;
    return stock.contributors.some((c) => c.symbol === constituent.symbol);
}
