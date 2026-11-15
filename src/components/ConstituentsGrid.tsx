'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './ConstituentsGrid.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import { formatQuantity } from '@/lib/format';

interface ChangeData {
    absolute: number;
    percent: number;
    absoluteTarget?: number;
}

interface Constituent {
    symbol: string;
    name: string;
    type: string;
    quantity: number;
    price: number;
    avgPrice: number;
    bookValue: number;
    bookValueTarget?: number;
    value: number;
    valueTarget?: number;
    currency: string;
    dayChange: ChangeData;
    change1W: ChangeData | null;
    change1M: ChangeData | null;
    change1Y: ChangeData | null;
    changeYTD: ChangeData | null;
    inceptionChange: ChangeData;

    xirr?: number | null;
    dividendYield?: number;
    lifetimeDividends?: number;
    lifetimeDividendsNative?: number;
    lifetimeDividendsTarget?: number;
    realizedGain?: number;
    realizedGainTarget?: number;
    dividendsYTD?: number;
    dividendsYTDNative?: number;
    dividendsYTDTarget?: number;
}

interface ConstituentsGridProps {
    data: Constituent[];
}

type ReturnPeriod = '1W' | '1M' | 'YTD' | '1Y' | 'ALL_COLS';

const PERIOD_COLUMNS = [
    { id: '1W', label: '1W', sortKey: 'change1W.absolute', field: 'change1W' },
    { id: '1M', label: '1M', sortKey: 'change1M.absolute', field: 'change1M' },
    { id: 'YTD', label: 'YTD', sortKey: 'changeYTD.absolute', field: 'changeYTD' },
    { id: '1Y', label: '1Y', sortKey: 'change1Y.absolute', field: 'change1Y' }
] as const;

const PERIOD_OPTIONS: ReadonlyArray<{ id: ReturnPeriod; label: string }> = [
    { id: '1W', label: '1W' },
    { id: '1M', label: '1M' },
    { id: 'YTD', label: 'YTD' },
    { id: '1Y', label: '1Y' },
    { id: 'ALL_COLS', label: 'All' }
];

const EPSILON = 0.00001;

function getEffectiveDividendYield(item: Constituent): number {
    if (item.dividendYield && item.dividendYield > 0) return item.dividendYield;
    if (item.quantity < EPSILON) return 0;
    if (item.dividendsYTDTarget !== undefined && item.valueTarget && item.valueTarget > 0) {
        return item.dividendsYTDTarget / item.valueTarget;
    }
    if (item.dividendsYTDNative !== undefined && item.value > 0) {
        return item.dividendsYTDNative / item.value;
    }
    return item.value > 0 ? (item.dividendsYTD || 0) / item.value : 0;
}

export default function ConstituentsGrid({ data }: ConstituentsGridProps) {
    const [selectedPeriod, setSelectedPeriod] = useState<ReturnPeriod>('YTD');
    const [sortConfig, setSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
    const { format, convert } = useCurrency();
    const router = useRouter();

    const getBookValueTarget = (item: Constituent) =>
        item.bookValueTarget ?? convert(item.bookValue, item.currency || 'USD');

    const getValueTarget = (item: Constituent) =>
        item.valueTarget ?? convert(item.value, item.currency || 'USD');

    const getAvgUnitPriceTarget = (item: Constituent) =>
        item.quantity >= EPSILON && item.bookValueTarget !== undefined
            ? item.bookValueTarget / item.quantity
            : convert(item.avgPrice, item.currency || 'USD');

    const getUnitPriceTarget = (item: Constituent) =>
        item.quantity >= EPSILON && item.valueTarget !== undefined
            ? item.valueTarget / item.quantity
            : convert(item.price, item.currency || 'USD');

    const getChangeTarget = (change: ChangeData | null, baseCurrency: string): number | null => {
        if (!change) return null;
        return change.absoluteTarget ?? convert(change.absolute, baseCurrency || 'USD');
    };

    const getInceptionChange = (item: Constituent): ChangeData => {
        if (item.inceptionChange?.absoluteTarget !== undefined) {
            return item.inceptionChange;
        }
        if (item.valueTarget !== undefined && item.bookValueTarget !== undefined) {
            return {
                ...item.inceptionChange,
                absoluteTarget: item.valueTarget - item.bookValueTarget
            };
        }
        return item.inceptionChange;
    };

    const getLifetimeDividendsTarget = (item: Constituent) =>
        item.lifetimeDividendsTarget ??
        (typeof item.lifetimeDividendsNative === 'number'
            ? convert(item.lifetimeDividendsNative, item.currency || 'USD')
            : convert(item.lifetimeDividends || 0, 'USD'));

    const getRealizedGainTarget = (item: Constituent) =>
        item.realizedGainTarget ?? convert(item.realizedGain || 0, 'USD');

    const handleSort = (key: string) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig && sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const getAriaSort = (key: string): 'ascending' | 'descending' | 'none' => {
        if (!sortConfig || sortConfig.key !== key) return 'none';
        return sortConfig.direction === 'asc' ? 'ascending' : 'descending';
    };

    // Filter active assets for the main table body
    const activeAssets = data.filter(d => d.quantity >= EPSILON);
    const soldAssets = data.filter(d => d.quantity < EPSILON);

    const visiblePeriods = selectedPeriod === 'ALL_COLS'
        ? PERIOD_COLUMNS
        : PERIOD_COLUMNS.filter(p => p.id === selectedPeriod);

    const getSortValue = (item: Constituent, key: string): string | number | null => {
        switch (key) {
            case 'symbol':
                return item.symbol;
            case 'bookValue':
                return getBookValueTarget(item);
            case 'value':
                return getValueTarget(item);
            case 'dayChange.absolute':
                return getChangeTarget(item.dayChange, item.currency);
            case 'change1W.absolute':
                return getChangeTarget(item.change1W, item.currency);
            case 'change1M.absolute':
                return getChangeTarget(item.change1M, item.currency);
            case 'changeYTD.absolute':
                return getChangeTarget(item.changeYTD, item.currency);
            case 'change1Y.absolute':
                return getChangeTarget(item.change1Y, item.currency);
            case 'inceptionChange.absolute':
                return getChangeTarget(getInceptionChange(item), item.currency);
            case 'lifetimeDividends':
                return getLifetimeDividendsTarget(item);
            case 'xirr':
                return typeof item.xirr === 'number' && Number.isFinite(item.xirr) ? item.xirr : null;
            default:
                return null;
        }
    };

    const sortedData = [...activeAssets].sort((a, b) => {
        if (!sortConfig) return 0;

        const aValue = getSortValue(a, sortConfig.key);
        const bValue = getSortValue(b, sortConfig.key);

        if (aValue == null && bValue == null) return 0;
        if (aValue == null) return 1;
        if (bValue == null) return -1;

        if (typeof aValue === 'string' && typeof bValue === 'string') {
            return sortConfig.direction === 'asc'
                ? aValue.localeCompare(bValue)
                : bValue.localeCompare(aValue);
        }

        if (aValue < bValue) {
            return sortConfig.direction === 'asc' ? -1 : 1;
        }
        if (aValue > bValue) {
            return sortConfig.direction === 'asc' ? 1 : -1;
        }
        return 0;
    });

    const getColorClass = (value: number) => {
        if (value > 0) return styles.positive;
        if (value < 0) return styles.negative;
        return '';
    };

    const renderChange = (change: ChangeData | null, baseCurrency: string) => {
        if (!change) {
            return <span className={styles.neutral}>-</span>;
        }

        const val = change.absoluteTarget ?? convert(change.absolute, baseCurrency || 'USD');
        const isPositive = val >= 0;
        const className = isPositive ? styles.positive : styles.negative;

        return (
            <div className={className}>
                <div>{format(val)}</div>
                <div className={styles.percent}>({change.percent.toFixed(2)}%)</div>
            </div>
        );
    };

    const renderSortHeader = (label: string, sortKey: string, alignRight = true) => {
        const isSorted = sortConfig?.key === sortKey;
        const indicator = isSorted ? (sortConfig.direction === 'asc' ? '↑' : '↓') : null;

        return (
            <th
                scope="col"
                aria-sort={getAriaSort(sortKey)}
                className={`${styles.th} ${alignRight ? styles.right : ''}`}
            >
                <button
                    type="button"
                    className={`${styles.sortBtn} ${alignRight ? styles.sortBtnRight : ''}`}
                    onClick={() => handleSort(sortKey)}
                >
                    <span>{label}</span>
                    {indicator && <span className={styles.sortArrow} aria-hidden="true">{indicator}</span>}
                </button>
            </th>
        );
    };

    const handleRowClick = (symbol: string) => {
        router.push(`/analysis/${symbol}?from=allocation`);
    };

    return (
        <section className={styles.container} aria-label="Portfolio Holdings">
            <div className={styles.header}>
                <div className={styles.headerTitleGroup}>
                    <h2>Holdings</h2>
                    <span className={styles.countPill}>{activeAssets.length} Active</span>
                </div>

                <div className={styles.periodSwitcher}>
                    <span className={styles.periodLabel}>Return Column:</span>
                    <div className={styles.periodControls} role="group" aria-label="Return column selector">
                        {PERIOD_OPTIONS.map(option => {
                            const isActive = selectedPeriod === option.id;
                            return (
                                <button
                                    key={option.id}
                                    type="button"
                                    aria-pressed={isActive}
                                    className={`${styles.periodBtn} ${isActive ? styles.periodBtnActive : ''}`}
                                    onClick={() => setSelectedPeriod(option.id)}
                                >
                                    {option.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div
                tabIndex={0}
                role="region"
                aria-label="Portfolio holdings table"
                className={styles.tableWrapper}
            >
                <table className={styles.table}>
                    <thead>
                        <tr>
                            {renderSortHeader('Asset', 'symbol', false)}
                            {renderSortHeader('Book Value', 'bookValue')}
                            {renderSortHeader('Current Value', 'value')}
                            {renderSortHeader('Day', 'dayChange.absolute')}
                            {visiblePeriods.map(period => (
                                <React.Fragment key={period.id}>
                                    {renderSortHeader(period.label, period.sortKey)}
                                </React.Fragment>
                            ))}
                            {renderSortHeader('ALL', 'inceptionChange.absolute')}
                            {renderSortHeader('Dividend', 'lifetimeDividends')}
                            {renderSortHeader('XIRR', 'xirr')}
                        </tr>
                    </thead>
                    <tbody>
                        <AnimatePresence mode="popLayout">
                            {sortedData.map((item) => (
                                <motion.tr
                                    layout
                                    initial={{ opacity: 0, scale: 0.98 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, transition: { duration: 0.05 } }}
                                    transition={{ duration: 0.2 }}
                                    key={item.symbol}
                                    tabIndex={0}
                                    aria-label={`View ${item.symbol} analysis`}
                                    className={styles.tr}
                                    onClick={() => handleRowClick(item.symbol)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            handleRowClick(item.symbol);
                                        }
                                    }}
                                    style={{ cursor: 'pointer' }}
                                >
                                    <td className={styles.td}>
                                        <div className={styles.symbolRow}>
                                            <span className={styles.symbolText}>{item.symbol}</span>
                                        </div>
                                        <div className={styles.sharesText}>{formatQuantity(item.quantity)} Shares</div>
                                    </td>
                                    <td className={`${styles.td} ${styles.right}`}>
                                        <div>{format(getBookValueTarget(item))}</div>
                                        <div className={styles.subtext}>
                                            {format(getAvgUnitPriceTarget(item))} / unit
                                        </div>
                                    </td>
                                    <td className={`${styles.td} ${styles.right}`}>
                                        <div>{format(getValueTarget(item))}</div>
                                        <div className={styles.subtext}>
                                            {format(getUnitPriceTarget(item))} / unit
                                        </div>
                                    </td>
                                    <td className={`${styles.td} ${styles.right}`}>
                                        {renderChange(item.dayChange, item.currency)}
                                    </td>
                                    {visiblePeriods.map(period => (
                                        <td key={period.id} className={`${styles.td} ${styles.right}`}>
                                            {renderChange(item[period.field], item.currency)}
                                        </td>
                                    ))}
                                    <td className={`${styles.td} ${styles.right}`}>
                                        {renderChange(getInceptionChange(item), item.currency)}
                                    </td>
                                    <td className={`${styles.td} ${styles.right}`}>
                                        <div>{format(getLifetimeDividendsTarget(item))}</div>
                                        <div className={styles.subtext}>
                                            {(() => {
                                                const yieldVal = getEffectiveDividendYield(item);
                                                return yieldVal > 0 ? `(${(yieldVal * 100).toFixed(2)}%)` : '-';
                                            })()}
                                        </div>
                                    </td>
                                    <td className={`${styles.td} ${styles.right} ${getColorClass(item.xirr || 0)}`}>
                                        {typeof item.xirr === 'number' && Number.isFinite(item.xirr) ? `${(item.xirr * 100).toFixed(2)}%` : '-'}
                                    </td>
                                </motion.tr>
                            ))}
                        </AnimatePresence>
                        {/* Empty State when no holdings match active filters */}
                        {sortedData.length === 0 && soldAssets.length === 0 && (
                            <tr>
                                <td colSpan={7 + visiblePeriods.length} className={styles.emptyRow}>
                                    No holdings match the active filters.
                                </td>
                            </tr>
                        )}
                        {/* Sold Assets Row - Rendered at bottom of body */}
                        {soldAssets.length > 0 && (
                            <tr className={styles.soldRow}>
                                <td className={styles.td}>Realized / Sold Assets</td>
                                <td className={styles.td}></td>
                                <td className={styles.td}></td>
                                <td className={styles.td}></td>
                                {visiblePeriods.map(period => (
                                    <td key={period.id} className={styles.td}></td>
                                ))}
                                <td className={`${styles.td} ${styles.right}`}>
                                    {(() => {
                                        const totalRealized = soldAssets.reduce((sum, item) => sum + getRealizedGainTarget(item), 0);
                                        return (
                                            <div className={getColorClass(totalRealized)}>
                                                <div>{format(totalRealized)}</div>
                                            </div>
                                        );
                                    })()}
                                </td>
                                <td className={`${styles.td} ${styles.right}`}>
                                    {format(soldAssets.reduce((sum, item) => sum + getLifetimeDividendsTarget(item), 0))}
                                </td>
                                <td className={styles.td}></td>
                            </tr>
                        )}
                    </tbody>
                    {data.length > 0 && (
                        <tfoot>
                            <tr className={styles.totalRow}>
                                <td className={styles.td}>TOTAL</td>
                                <td className={`${styles.td} ${styles.right}`}>
                                    {format(data.reduce((sum, item) => sum + getBookValueTarget(item), 0))}
                                </td>
                                <td className={`${styles.td} ${styles.right}`}>
                                    {format(data.reduce((sum, item) => sum + getValueTarget(item), 0))}
                                </td>
                                <td className={`${styles.td} ${styles.right}`}>
                                    {(() => {
                                        const totalAbs = data.reduce((sum, item) => sum + (getChangeTarget(item.dayChange, item.currency) ?? 0), 0);
                                        const totalVal = data.reduce((sum, item) => sum + getValueTarget(item), 0);
                                        const prevVal = totalVal - totalAbs;
                                        const pct = Math.abs(prevVal) > 0.01 ? (totalAbs / prevVal) * 100 : 0;
                                        return (
                                            <div className={getColorClass(totalAbs)}>
                                                <div>{format(totalAbs)}</div>
                                                <div className={styles.percent}>({pct.toFixed(2)}%)</div>
                                            </div>
                                        );
                                    })()}
                                </td>
                                {visiblePeriods.map(period => (
                                    <td key={period.id} className={styles.td}></td>
                                ))}
                                <td className={`${styles.td} ${styles.right}`}>
                                    {(() => {
                                        const totalValue = data.reduce((sum, item) => sum + getValueTarget(item), 0);
                                        const totalCost = data.reduce((sum, item) => sum + getBookValueTarget(item), 0);
                                        const totalRealized = data.reduce((sum, item) => sum + getRealizedGainTarget(item), 0);

                                        const totalPnl = (totalValue - totalCost) + totalRealized;
                                        const pct = totalCost > 0.01 ? (totalPnl / totalCost) * 100 : 0;

                                        return (
                                            <div className={getColorClass(totalPnl)}>
                                                <div>{format(totalPnl)}</div>
                                                <div className={styles.percent}>({pct.toFixed(2)}%)</div>
                                            </div>
                                        );
                                    })()}
                                </td>
                                <td className={`${styles.td} ${styles.right}`}>
                                    <div>{format(data.reduce((sum, item) => sum + getLifetimeDividendsTarget(item), 0))}</div>
                                    <div className={styles.subtext}>
                                        {(() => {
                                            const totalVal = data.reduce((sum, item) => sum + getValueTarget(item), 0);
                                            const weightedYieldSum = data.reduce((sum, item) => {
                                                const itemYield = getEffectiveDividendYield(item);
                                                return sum + (getValueTarget(item) * itemYield);
                                            }, 0);
                                            const avgYield = totalVal > 0 ? (weightedYieldSum / totalVal) : 0;
                                            return `(${(avgYield * 100).toFixed(2)}%)`;
                                        })()}
                                    </div>
                                </td>
                                <td className={styles.td}></td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>

            {/* Mobile Card List */}
            <div className={styles.mobileList}>
                {sortedData.length === 0 && (
                    <div className={styles.emptyMobile}>
                        No active holdings match the active filters.
                    </div>
                )}
                {sortedData.map((item) => (
                    <button
                        type="button"
                        key={item.symbol}
                        className={styles.mobileCard}
                        aria-label={`View ${item.symbol} analysis`}
                        onClick={() => handleRowClick(item.symbol)}
                    >
                        <div className={styles.cardHeader}>
                            <div>
                                <div className={styles.symbolRow}>
                                    <span className={styles.symbolText}>{item.symbol}</span>
                                </div>
                                <div className={styles.sharesText}>{formatQuantity(item.quantity)} Shares</div>
                                {typeof item.xirr === 'number' && Number.isFinite(item.xirr) && (
                                    <div className={styles.sharesText} style={{ marginTop: '0.125rem' }}>
                                        <span className={styles.subtext} style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                                            XIRR: <span className={getColorClass(item.xirr)}>{(item.xirr * 100).toFixed(2)}%</span>
                                        </span>
                                    </div>
                                )}
                            </div>
                            <div style={{ textAlign: 'right' }}>
                                <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{format(getValueTarget(item))}</div>
                                {renderChange(item.dayChange, item.currency)}
                            </div>
                        </div>
                        <div className={styles.cardBody}>
                            <div className={styles.statItem}>
                                <span className={styles.statLabel}>Avg Cost</span>
                                <span className={styles.statValue}>{format(getAvgUnitPriceTarget(item))}</span>
                            </div>
                            <div className={styles.statItem}>
                                <span className={styles.statLabel}>Total Return</span>
                                {renderChange(getInceptionChange(item), item.currency)}
                            </div>
                            <div className={styles.statItem}>
                                <span className={styles.statLabel}>1D Change</span>
                                {renderChange(item.dayChange, item.currency)}
                            </div>
                            <div className={styles.statItem}>
                                <span className={styles.statLabel}>Dividends</span>
                                <span className={styles.statValue}>
                                    {format(getLifetimeDividendsTarget(item))}
                                </span>
                            </div>
                        </div>
                    </button>
                ))}
            </div>
        </section>
    );
}
