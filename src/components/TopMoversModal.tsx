/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import styles from './TopMoversModal.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import Link from 'next/link';

export type MoverPeriod = '1D' | '1W' | '1M' | 'YTD';

interface TopMoversModalProps {
    isOpen: boolean;
    onClose: () => void;
    constituents: any[];
    portfolioTotalValue: number; // Already in target display currency
    portfolioDayChange?: number; // Already in target display currency
    period?: MoverPeriod;
}

type SortField = 'symbol' | 'price' | 'changePercent' | 'impactAbs' | 'impactPercent';
type SortDirection = 'asc' | 'desc';

function getPeriodChange(constituent: any, period: MoverPeriod) {
    switch (period) {
        case '1W':
            return constituent.change1W;
        case '1M':
            return constituent.change1M;
        case 'YTD':
            return constituent.changeYTD;
        case '1D':
        default:
            return constituent.dayChange;
    }
}

export default function TopMoversModal({
    isOpen,
    onClose,
    constituents,
    portfolioTotalValue,
    period = '1D'
}: TopMoversModalProps) {
    const { format, convert } = useCurrency();
    const dialogRef = useRef<HTMLDialogElement>(null);
    const [sortField, setSortField] = useState<SortField>('impactPercent');
    const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        if (isOpen && !dialog.open) {
            dialog.showModal();
        } else if (!isOpen && dialog.open) {
            dialog.close();
        }
    }, [isOpen]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog || ('closedBy' in HTMLDialogElement.prototype)) return;

        const isOutside = (e: PointerEvent) => {
            const rect = dialog.getBoundingClientRect();
            return (
                e.clientX < rect.left ||
                e.clientX > rect.right ||
                e.clientY < rect.top ||
                e.clientY > rect.bottom
            );
        };

        let pressedOutside = false;
        const onPointerDown = (e: PointerEvent) => {
            pressedOutside = isOutside(e);
        };
        const onPointerUp = (e: PointerEvent) => {
            if (pressedOutside && isOutside(e)) {
                dialog.close();
            }
            pressedOutside = false;
        };

        dialog.addEventListener('pointerdown', onPointerDown);
        dialog.addEventListener('pointerup', onPointerUp);
        return () => {
            dialog.removeEventListener('pointerdown', onPointerDown);
            dialog.removeEventListener('pointerup', onPointerUp);
        };
    }, []);

    const sortedConstituents = useMemo(() => {
        const baseVal = portfolioTotalValue > 0 ? portfolioTotalValue : 1;

        const data = constituents
            .filter(c => {
                const changeObj = getPeriodChange(c, period);
                return changeObj && Math.abs(changeObj.percent) > 0.001;
            })
            .map(c => {
                const changeObj = getPeriodChange(c, period);
                const hasStaleUsdRate = c.conversionRate === 1 && c.currency && c.currency !== 'USD' && typeof c.rateToUSD === 'number' && c.rateToUSD !== 1;
                const hasConversionRate = c.conversionRate !== undefined;
                const effectiveRate = hasStaleUsdRate ? c.rateToUSD : (c.conversionRate ?? 1);

                const priceTarget = hasConversionRate ? c.price * effectiveRate : convert(c.price, c.currency);
                const avgPriceTarget = hasConversionRate ? c.avgPrice * effectiveRate : convert(c.avgPrice, c.currency);
                const impactAbsTarget =
                    period === '1D' && changeObj.absoluteTarget !== undefined && !hasStaleUsdRate
                        ? changeObj.absoluteTarget
                        : hasConversionRate
                            ? changeObj.absolute * effectiveRate
                            : convert(changeObj.absolute, c.currency);

                const impactPercent = portfolioTotalValue > 0 ? (impactAbsTarget / baseVal) * 100 : 0;

                const denom = 1 + (changeObj.percent / 100);
                const prevPriceTarget = denom !== 0 ? priceTarget / denom : priceTarget;
                const priceChangePerShareTarget = priceTarget - prevPriceTarget;

                return {
                    ...c,
                    priceTarget,
                    avgPriceTarget,
                    changePercent: changeObj.percent,
                    impactAbsTarget,
                    impactPercent,
                    priceChangePerShareTarget
                };
            });

        return data.sort((a, b) => {
            let valA: string | number;
            let valB: string | number;

            switch (sortField) {
                case 'symbol':
                    valA = a.symbol;
                    valB = b.symbol;
                    break;
                case 'price':
                    valA = a.priceTarget;
                    valB = b.priceTarget;
                    break;
                case 'changePercent':
                    valA = a.changePercent;
                    valB = b.changePercent;
                    break;
                case 'impactAbs':
                    valA = Math.abs(a.impactAbsTarget);
                    valB = Math.abs(b.impactAbsTarget);
                    break;
                case 'impactPercent':
                default:
                    valA = a.impactPercent;
                    valB = b.impactPercent;
                    break;
            }

            if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }, [constituents, sortField, sortDirection, portfolioTotalValue, period, convert]);

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDirection('desc');
        }
    };

    const getAriaSort = (field: SortField): 'ascending' | 'descending' | 'none' => {
        if (sortField !== field) return 'none';
        return sortDirection === 'asc' ? 'ascending' : 'descending';
    };

    const renderSortIcon = (field: SortField) => {
        if (sortField !== field) return null;
        return <span className={styles.sortArrow} aria-hidden="true">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
    };

    const formatPercent = (val: number) => {
        const sign = val > 0 ? '+' : '';
        return `${sign}${val.toFixed(2)}%`;
    };

    const getColorClass = (val: number) => {
        if (val > 0) return styles.positive;
        if (val < 0) return styles.negative;
        return styles.neutral;
    };

    return (
        <dialog
            ref={dialogRef}
            aria-labelledby="top-movers-dialog-title"
            {...({ closedby: 'any' } as any)}
            className={styles.modal}
            onClose={onClose}
        >
            <div className={styles.header}>
                <h2 id="top-movers-dialog-title" className={styles.title}>
                    Portfolio Movers Details ({period})
                </h2>
                <button
                    type="button"
                    className={styles.closeButton}
                    aria-label="Close modal"
                    onClick={onClose}
                >
                    &times;
                </button>
            </div>

            {isOpen && (
                <div className={styles.content}>
                    <table className={styles.tableContainer}>
                        <thead>
                            <tr>
                                <th scope="col" aria-sort={getAriaSort('symbol')} className={styles.tableHeader}>
                                    <button
                                        type="button"
                                        className={styles.sortBtn}
                                        onClick={() => handleSort('symbol')}
                                    >
                                        <span>Asset</span>
                                        {renderSortIcon('symbol')}
                                    </button>
                                </th>
                                <th scope="col" aria-sort={getAriaSort('price')} className={`${styles.tableHeader} ${styles.alignRight}`}>
                                    <button
                                        type="button"
                                        className={`${styles.sortBtn} ${styles.sortBtnRight}`}
                                        onClick={() => handleSort('price')}
                                    >
                                        <span>Price</span>
                                        {renderSortIcon('price')}
                                    </button>
                                </th>
                                <th scope="col" aria-sort={getAriaSort('changePercent')} className={`${styles.tableHeader} ${styles.alignRight}`}>
                                    <button
                                        type="button"
                                        className={`${styles.sortBtn} ${styles.sortBtnRight}`}
                                        onClick={() => handleSort('changePercent')}
                                    >
                                        <span>Change ({period})</span>
                                        {renderSortIcon('changePercent')}
                                    </button>
                                </th>
                                <th scope="col" aria-sort={getAriaSort('impactPercent')} className={`${styles.tableHeader} ${styles.alignRight}`}>
                                    <button
                                        type="button"
                                        className={`${styles.sortBtn} ${styles.sortBtnRight}`}
                                        onClick={() => handleSort('impactPercent')}
                                    >
                                        <span>Portfolio Impact</span>
                                        {renderSortIcon('impactPercent')}
                                    </button>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedConstituents.length === 0 ? (
                                <tr>
                                    <td colSpan={4} className={styles.emptyCell}>
                                        No price movement recorded for the selected period ({period}).
                                    </td>
                                </tr>
                            ) : (
                                sortedConstituents.map(c => {
                                    const priceDisp = format(c.priceTarget);
                                    const avgPriceDisp = format(c.avgPriceTarget);
                                    const changeAbsDisp = format(c.priceChangePerShareTarget);
                                    const impactAbsDisp = format(c.impactAbsTarget);

                                    return (
                                        <tr key={c.symbol} className={styles.row}>
                                            <td className={styles.cell}>
                                                <Link
                                                    href={{
                                                        pathname: `/analysis/${c.symbol}`,
                                                        query: { from: 'dashboard' }
                                                    }}
                                                    onClick={() => {
                                                        sessionStorage.setItem('navContext', 'dashboard');
                                                        onClose();
                                                    }}
                                                    className={styles.symbolLink}
                                                >
                                                    <span className={styles.symbol}>{c.symbol}</span>
                                                    <span className={styles.name}>{c.name}</span>
                                                </Link>
                                            </td>
                                            <td className={`${styles.cell} ${styles.alignRight}`}>
                                                <div className={styles.value}>
                                                    {priceDisp}
                                                </div>
                                                <div className={`${styles.neutral} ${styles.subMetric}`}>
                                                    Avg: {avgPriceDisp}
                                                </div>
                                            </td>
                                            <td className={`${styles.cell} ${styles.alignRight}`}>
                                                <div className={`${styles.value} ${getColorClass(c.changePercent)}`}>
                                                    {formatPercent(c.changePercent)}
                                                </div>
                                                <div className={`${getColorClass(c.changePercent) || styles.neutral} ${styles.subMetric}`}>
                                                    {c.priceChangePerShareTarget > 0 ? '+' : ''}{changeAbsDisp}
                                                </div>
                                            </td>
                                            <td className={`${styles.cell} ${styles.alignRight}`}>
                                                <div className={`${styles.value} ${getColorClass(c.impactPercent)}`}>
                                                    {formatPercent(c.impactPercent)}
                                                </div>
                                                <div className={`${getColorClass(c.impactPercent) || styles.neutral} ${styles.subMetric}`}>
                                                    {c.impactAbsTarget > 0 ? '+' : ''}{impactAbsDisp}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            )}
        </dialog>
    );
}
