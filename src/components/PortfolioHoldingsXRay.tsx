'use client';

import React, { useMemo, useState } from 'react';
import { Building2, Search, X } from 'lucide-react';
import type {
    PortfolioHoldingStock,
    PortfolioHoldingsLookThroughResult,
} from '@/lib/holdings-look-through';
import styles from './PortfolioHoldingsXRay.module.css';
import breakdownStyles from './SectorBreakdownCard.module.css';

interface PortfolioHoldingsXRayProps {
    result: PortfolioHoldingsLookThroughResult;
    selectedStockKey: string | null;
    onSelectStock: (stock: PortfolioHoldingStock | null, e?: React.MouseEvent) => void;
    format: (val: number) => string;
}

type SourceFilter = 'all' | 'overlap' | 'direct' | 'etf';

const DEFAULT_VISIBLE_LIMIT = 50;

export default function PortfolioHoldingsXRay({
    result,
    selectedStockKey,
    onSelectStock,
    format,
}: PortfolioHoldingsXRayProps) {
    const [searchQuery, setSearchQuery] = useState('');
    const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
    const [showAll, setShowAll] = useState(false);

    const { holdings, summary } = result;

    const counts = useMemo(() => {
        let overlap = 0;
        let direct = 0;
        let etf = 0;
        for (const h of holdings) {
            if (h.directValue >= 0.01 && h.lookThroughValue >= 0.01) overlap++;
            if (h.directValue >= 0.01) direct++;
            if (h.lookThroughValue >= 0.01) etf++;
        }
        return { all: holdings.length, overlap, direct, etf };
    }, [holdings]);

    const portfolioRankByKey = useMemo(() => {
        const map = new Map<string, number>();
        holdings.forEach((h, i) => map.set(h.key, i + 1));
        return map;
    }, [holdings]);

    const filteredHoldings = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return holdings.filter((h) => {
            if (sourceFilter === 'overlap' && !(h.directValue >= 0.01 && h.lookThroughValue >= 0.01)) {
                return false;
            }
            if (sourceFilter === 'direct' && h.directValue < 0.01) {
                return false;
            }
            if (sourceFilter === 'etf' && h.lookThroughValue < 0.01) {
                return false;
            }
            if (!q) return true;
            const hay = `${h.name} ${h.ticker || ''} ${h.sector || ''} ${h.country || ''} ${h.contributors
                .map((c) => c.symbol)
                .join(' ')}`.toLowerCase();
            return hay.includes(q);
        });
    }, [holdings, searchQuery, sourceFilter]);

    const isSearchingOrFiltering = Boolean(searchQuery.trim()) || sourceFilter !== 'all';
    const displayedHoldings = useMemo(() => {
        if (showAll || isSearchingOrFiltering) return filteredHoldings;
        return filteredHoldings.slice(0, DEFAULT_VISIBLE_LIMIT);
    }, [filteredHoldings, showAll, isSearchingOrFiltering]);

    const maxPercentage = holdings[0]?.percentage || 1;
    const total = summary.totalPortfolioValue;
    const pctOfTotal = (val: number) => (total > 0 ? (val / total) * 100 : 0);

    const directPct = pctOfTotal(summary.directStocksValue);
    const lookThroughPct = pctOfTotal(summary.etfLookThroughStocksValue);
    const fixedPct = pctOfTotal(summary.fixedIncomeAndCashValue);
    const residualPct = pctOfTotal(summary.unattributedFundValue);

    const filterPills: ReadonlyArray<{ id: SourceFilter; label: string; count: number }> = [
        { id: 'all', label: 'All Stocks', count: counts.all },
        { id: 'overlap', label: 'Direct + ETF Overlap', count: counts.overlap },
        { id: 'direct', label: 'Direct Stocks', count: counts.direct },
        { id: 'etf', label: 'Via ETFs', count: counts.etf },
    ];

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.titleBlock}>
                    <div className={styles.titleRow}>
                        <h2 className={styles.title}>By Underlying Holdings</h2>
                        <span className={styles.xrayBadge}>
                            <Building2 size={12} aria-hidden="true" />
                            Look-Through X-Ray
                        </span>
                    </div>
                    <p className={styles.subtitle}>
                        Cumulative dollar and percentage exposure to individual stocks across direct equities and full ETF look-through weights (dual-class shares kept separate).
                    </p>
                </div>

                <div className={styles.headerMeta}>
                    <div className={styles.totalSummary}>
                        <span className={styles.totalLabel}>Tracked Stock Exposure</span>
                        <div className={styles.totalValueRow}>
                            <span className={styles.totalValue}>
                                {format(summary.totalEquityLookThroughValue)}
                            </span>
                            <span className={styles.totalCount}>
                                ({pctOfTotal(summary.totalEquityLookThroughValue).toFixed(1)}% &bull;{' '}
                                {summary.uniqueStockCount} stocks)
                            </span>
                        </div>
                    </div>
                    {selectedStockKey && (
                        <button
                            type="button"
                            className={styles.clearBtn}
                            onClick={() => onSelectStock(null)}
                        >
                            <X size={13} aria-hidden="true" />
                            <span>Clear Selection</span>
                        </button>
                    )}
                </div>
            </div>

            {total > 0 && (
                <div className={styles.coverageCard}>
                    <div className={styles.coverageBar} aria-hidden="true">
                        {directPct > 0.1 && (
                            <div
                                className={styles.segDirect}
                                style={{ width: `${directPct}%` }}
                                title={`Direct Equities: ${format(summary.directStocksValue)} (${directPct.toFixed(1)}%)`}
                            />
                        )}
                        {lookThroughPct > 0.1 && (
                            <div
                                className={styles.segLookThrough}
                                style={{ width: `${lookThroughPct}%` }}
                                title={`ETF Look-Through Equities: ${format(summary.etfLookThroughStocksValue)} (${lookThroughPct.toFixed(1)}%)`}
                            />
                        )}
                        {fixedPct > 0.1 && (
                            <div
                                className={styles.segFixed}
                                style={{ width: `${fixedPct}%` }}
                                title={`Fixed Income, Cash & Alternatives: ${format(summary.fixedIncomeAndCashValue)} (${fixedPct.toFixed(1)}%)`}
                            />
                        )}
                        {residualPct > 0.1 && (
                            <div
                                className={styles.segResidual}
                                style={{ width: `${residualPct}%` }}
                                title={`Uncovered / Cash & Residual (fund cash, bond sleeves in balanced ETFs, or partial-disclosure funds): ${format(summary.unattributedFundValue)} (${residualPct.toFixed(1)}%)`}
                            />
                        )}
                    </div>

                    <div className={styles.coverageLegend}>
                        <div className={styles.legendItem}>
                            <span className={styles.legendLabel}>
                                <span className={styles.dot} style={{ background: '#3b82f6' }} aria-hidden="true" />
                                Direct Equities
                            </span>
                            <div className={styles.legendValue}>
                                {format(summary.directStocksValue)}
                                <span className={styles.legendPct}>{directPct.toFixed(1)}%</span>
                            </div>
                        </div>

                        <div className={styles.legendItem}>
                            <span className={styles.legendLabel}>
                                <span className={styles.dot} style={{ background: '#06b6d4' }} aria-hidden="true" />
                                ETF Look-Through ({summary.fundsWithHoldingsCount}/{summary.fundsTotalCount} funds)
                            </span>
                            <div className={styles.legendValue}>
                                {format(summary.etfLookThroughStocksValue)}
                                <span className={styles.legendPct}>{lookThroughPct.toFixed(1)}%</span>
                            </div>
                        </div>

                        {summary.fixedIncomeAndCashValue >= 0.01 && (
                            <div className={styles.legendItem}>
                                <span className={styles.legendLabel}>
                                    <span className={styles.dot} style={{ background: '#8b5cf6' }} aria-hidden="true" />
                                    Bonds, Cash &amp; Other
                                </span>
                                <div className={styles.legendValue}>
                                    {format(summary.fixedIncomeAndCashValue)}
                                    <span className={styles.legendPct}>{fixedPct.toFixed(1)}%</span>
                                </div>
                            </div>
                        )}

                        {summary.unattributedFundValue >= 0.01 && (
                            <div
                                className={styles.legendItem}
                                title="Includes fund cash drag, bond sleeves inside balanced FOFs, and funds that only disclose top holdings (e.g. TD Top 10)"
                            >
                                <span className={styles.legendLabel}>
                                    <span className={styles.dot} style={{ background: '#94a3b8' }} aria-hidden="true" />
                                    Uncovered / Cash &amp; Residual
                                </span>
                                <div className={styles.legendValue}>
                                    {format(summary.unattributedFundValue)}
                                    <span className={styles.legendPct}>{residualPct.toFixed(1)}%</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            <div className={styles.toolbar}>
                <div className={styles.searchWrap}>
                    <Search size={15} className={styles.searchIcon} aria-hidden="true" />
                    <input
                        type="search"
                        className={styles.searchInput}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search stock, ticker, sector, country, or ETF..."
                        aria-label="Search underlying stock holdings"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            className={styles.searchClearBtn}
                            onClick={() => setSearchQuery('')}
                            aria-label="Clear search"
                        >
                            <X size={14} aria-hidden="true" />
                        </button>
                    )}
                </div>

                <div className={styles.filterPills} role="group" aria-label="Filter holdings by source">
                    {filterPills.map((pill) => {
                        const isActive = sourceFilter === pill.id;
                        return (
                            <button
                                key={pill.id}
                                type="button"
                                className={`${styles.filterPill} ${isActive ? styles.filterPillActive : ''}`}
                                onClick={() => setSourceFilter(pill.id)}
                                aria-pressed={isActive}
                            >
                                {pill.label} ({pill.count})
                            </button>
                        );
                    })}
                </div>
            </div>

            {displayedHoldings.length === 0 ? (
                <div className={styles.emptyState}>
                    {holdings.length === 0
                        ? 'No individual stock or ETF underlying holdings cached yet. Run a market data sync or issuer push to populate look-through holdings.'
                        : 'No underlying holdings match the current search or source filter.'}
                </div>
            ) : (
                <>
                    <div className={styles.tableWrapper}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th scope="col">#</th>
                                    <th scope="col">Stock</th>
                                    <th scope="col">Held Via</th>
                                    <th scope="col" className={styles.right}>
                                        Dollar Exposure
                                    </th>
                                    <th scope="col" className={styles.right}>
                                        % of Portfolio
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {displayedHoldings.map((stock, idx) => {
                                    const isSelected = selectedStockKey === stock.key;
                                    const metaParts = [stock.sector, stock.country].filter(Boolean);
                                    const directContributors = stock.contributors.filter((c) => c.isDirect);
                                    const etfContributors = stock.contributors.filter((c) => !c.isDirect);
                                    const visibleEtfs = etfContributors.slice(0, 3);
                                    const remainingEtfs = etfContributors.length - visibleEtfs.length;
                                    const barWidth = Math.min(100, (stock.percentage / maxPercentage) * 100);

                                    return (
                                        <tr
                                            key={stock.key}
                                            className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
                                            onClick={(e) => onSelectStock(isSelected ? null : stock, e)}
                                            aria-selected={isSelected}
                                            title="Click to inspect contributors and filter your positions below"
                                        >
                                            <td className={styles.rankCell}>
                                                {portfolioRankByKey.get(stock.key) ?? idx + 1}
                                            </td>
                                            <td className={styles.securityCell}>
                                                <div className={styles.securityTitleRow}>
                                                    <span className={styles.securityName}>{stock.name}</span>
                                                    {stock.ticker && (
                                                        <span className={styles.tickerPill}>{stock.ticker}</span>
                                                    )}
                                                </div>
                                                {metaParts.length > 0 && (
                                                    <div className={styles.securityMeta}>{metaParts.join(' • ')}</div>
                                                )}
                                            </td>
                                            <td className={styles.contributorsCell}>
                                                <div className={styles.chipList}>
                                                    {directContributors.length > 0 && (
                                                        <span className={styles.chipDirect}>Direct</span>
                                                    )}
                                                    {visibleEtfs.map((etf) => (
                                                        <span
                                                            key={etf.symbol}
                                                            className={styles.chipEtf}
                                                            title={`${etf.name}: ${format(etf.value)} (${(etf.weightInFund * 100).toFixed(2)}% of fund)`}
                                                        >
                                                            {etf.symbol}
                                                        </span>
                                                    ))}
                                                    {remainingEtfs > 0 && (
                                                        <span className={styles.chipMore}>+{remainingEtfs} more</span>
                                                    )}
                                                </div>
                                            </td>
                                            <td className={styles.valueCell}>
                                                <div className={styles.dollarPrimary}>{format(stock.value)}</div>
                                                {stock.directValue >= 0.01 && stock.lookThroughValue >= 0.01 && (
                                                    <div className={styles.dollarBreakdown}>
                                                        {format(stock.directValue)} direct + {format(stock.lookThroughValue)} ETF
                                                    </div>
                                                )}
                                            </td>
                                            <td className={styles.pctCell}>
                                                <div className={styles.pctFlex}>
                                                    <div className={styles.miniBarTrack} aria-hidden="true">
                                                        <div
                                                            className={styles.miniBarFill}
                                                            style={{ width: `${barWidth}%` }}
                                                        />
                                                    </div>
                                                    <span className={styles.pctText}>
                                                        {stock.percentage.toFixed(2)}%
                                                    </span>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    <div className={styles.footerRow}>
                        <span>
                            Showing {displayedHoldings.length} of {filteredHoldings.length} underlying stocks
                            {filteredHoldings.length !== holdings.length ? ` (${holdings.length} total)` : ''}. Click any row to filter holdings below.
                        </span>
                        {!isSearchingOrFiltering && filteredHoldings.length > DEFAULT_VISIBLE_LIMIT && (
                            <button
                                type="button"
                                className={styles.showMoreBtn}
                                onClick={() => setShowAll((prev) => !prev)}
                            >
                                {showAll
                                    ? `Show top ${DEFAULT_VISIBLE_LIMIT}`
                                    : `Show all ${filteredHoldings.length} holdings`}
                            </button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

interface StockContributorsBreakdownCardProps {
    stock: PortfolioHoldingStock;
    onClose: () => void;
    format: (val: number) => string;
}

export function StockContributorsBreakdownCard({
    stock,
    onClose,
    format,
}: StockContributorsBreakdownCardProps) {
    const totalValue = stock.value;
    const directPct = totalValue > 0 ? (stock.directValue / totalValue) * 100 : 0;
    const lookThroughPct = totalValue > 0 ? (stock.lookThroughValue / totalValue) * 100 : 0;

    return (
        <section
            className={breakdownStyles.card}
            aria-label={`${stock.name} Holdings X-Ray Decomposition`}
        >
            <div className={breakdownStyles.header}>
                <div className={breakdownStyles.titleGroup}>
                    <span className={breakdownStyles.badge}>
                        <Building2 size={12} aria-hidden="true" />
                        Portfolio X-Ray Decomposition &bull; Underlying Stock
                    </span>
                    <div className={breakdownStyles.titleLine}>
                        <h2 className={breakdownStyles.title}>
                            {stock.name}
                            {stock.ticker ? ` (${stock.ticker})` : ''}
                        </h2>
                        <span className={breakdownStyles.inlineMetric}>
                            {format(stock.value)}
                            <span className={breakdownStyles.inlinePercent}>
                                &bull; {stock.percentage.toFixed(2)}% of Portfolio
                            </span>
                        </span>
                    </div>
                    <p className={breakdownStyles.subtitle}>
                        Aggregate exposure across your direct position and underlying ETF look-through weights.
                    </p>
                </div>

                <button
                    type="button"
                    className={breakdownStyles.closeBtn}
                    onClick={onClose}
                    aria-label="Close stock X-Ray breakdown"
                >
                    <X size={16} aria-hidden="true" />
                    <span>Close</span>
                </button>
            </div>

            <div className={breakdownStyles.summaryStrip}>
                <div className={breakdownStyles.summaryItem}>
                    <span className={breakdownStyles.summaryLabel}>
                        <span className={breakdownStyles.dotDirect} aria-hidden="true" />
                        Direct Holding
                    </span>
                    <span className={breakdownStyles.summaryValue}>
                        {format(stock.directValue)}
                        <span className={breakdownStyles.summaryPct}>({directPct.toFixed(1)}%)</span>
                    </span>
                </div>

                <div className={breakdownStyles.dualBarWrapper} aria-hidden="true">
                    <div className={breakdownStyles.splitProgressBar}>
                        <div className={breakdownStyles.barDirect} style={{ width: `${directPct}%` }} />
                        <div className={breakdownStyles.barLookThrough} style={{ width: `${lookThroughPct}%` }} />
                    </div>
                </div>

                <div className={`${breakdownStyles.summaryItem} ${breakdownStyles.summaryItemRight}`}>
                    <span className={breakdownStyles.summaryLabel}>
                        <span className={breakdownStyles.dotLookThrough} aria-hidden="true" />
                        ETF Look-Through
                    </span>
                    <span className={breakdownStyles.summaryValue}>
                        {format(stock.lookThroughValue)}
                        <span className={breakdownStyles.summaryPct}>({lookThroughPct.toFixed(1)}%)</span>
                    </span>
                </div>
            </div>

            <div
                tabIndex={0}
                role="region"
                aria-label={`${stock.name} contributors`}
                className={breakdownStyles.desktopTableWrapper}
            >
                <table className={breakdownStyles.table}>
                    <thead>
                        <tr>
                            <th scope="col">Holding</th>
                            <th scope="col">Source</th>
                            <th scope="col" className={breakdownStyles.right}>
                                Weight in Holding
                            </th>
                            <th scope="col" className={breakdownStyles.right}>
                                Stock Exposure ($)
                            </th>
                            <th scope="col">Share of Exposure (%)</th>
                        </tr>
                    </thead>
                    <tbody>
                        {stock.contributors.map((contrib) => (
                            <tr key={`${contrib.isDirect ? 'D' : 'F'}:${contrib.symbol}`}>
                                <td>
                                    <div className={breakdownStyles.holdingSymbol}>{contrib.symbol}</div>
                                    <div className={breakdownStyles.holdingName}>{contrib.name}</div>
                                </td>
                                <td>
                                    {contrib.isDirect ? (
                                        <span className={breakdownStyles.badgeDirect}>Direct Holding</span>
                                    ) : (
                                        <span className={breakdownStyles.badgeETF}>ETF Look-Through</span>
                                    )}
                                </td>
                                <td className={breakdownStyles.right}>
                                    {contrib.isDirect ? '100.00%' : `${(contrib.weightInFund * 100).toFixed(2)}%`}
                                </td>
                                <td className={breakdownStyles.right}>
                                    <strong>{format(contrib.value)}</strong>
                                </td>
                                <td>
                                    <div className={breakdownStyles.shareCell}>
                                        <div className={breakdownStyles.shareBarBg} aria-hidden="true">
                                            <div
                                                className={breakdownStyles.shareBarFill}
                                                style={{ width: `${Math.min(100, contrib.percentageOfStock)}%` }}
                                            />
                                        </div>
                                        <span>{contrib.percentageOfStock.toFixed(1)}%</span>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className={breakdownStyles.mobileCardsList}>
                {stock.contributors.map((contrib) => (
                    <div
                        key={`${contrib.isDirect ? 'D' : 'F'}:${contrib.symbol}`}
                        className={breakdownStyles.mobileCard}
                    >
                        <div className={breakdownStyles.mobileCardHeader}>
                            <div className={breakdownStyles.mobileCardTitle}>
                                <span className={breakdownStyles.mobileCardSymbol}>{contrib.symbol}</span>
                                <span className={breakdownStyles.mobileCardName}>{contrib.name}</span>
                            </div>
                            {contrib.isDirect ? (
                                <span className={breakdownStyles.badgeDirect}>Direct Holding</span>
                            ) : (
                                <span className={breakdownStyles.badgeETF}>ETF Look-Through</span>
                            )}
                        </div>

                        <div className={breakdownStyles.mobileCardStats}>
                            <div>
                                <div className={breakdownStyles.mobileExposureLabel}>Stock Exposure</div>
                                <div className={breakdownStyles.mobileExposureValue}>{format(contrib.value)}</div>
                            </div>
                            <span className={breakdownStyles.mobileShareTag}>
                                {contrib.percentageOfStock.toFixed(1)}% of Total
                            </span>
                        </div>

                        <div className={breakdownStyles.shareBarBg} aria-hidden="true">
                            <div
                                className={breakdownStyles.shareBarFill}
                                style={{ width: `${Math.min(100, contrib.percentageOfStock)}%` }}
                            />
                        </div>

                        <div className={breakdownStyles.mobileCardMeta}>
                            <span>
                                Weight in {contrib.symbol}:{' '}
                                {contrib.isDirect ? '100.00%' : `${(contrib.weightInFund * 100).toFixed(2)}%`}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
