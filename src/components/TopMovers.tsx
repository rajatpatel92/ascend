/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useMemo } from 'react';
import styles from './TopMovers.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import TopMoversModal, { MoverPeriod } from './TopMoversModal';

interface TopMoversProps {
    constituents: any[];
    portfolioTotalValue: number; // Already in target display currency
    portfolioDayChange?: number; // Already in target display currency
}

const PERIOD_OPTIONS: MoverPeriod[] = ['1D', '1W', '1M', 'YTD'];

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

export default function TopMovers({ constituents, portfolioTotalValue, portfolioDayChange }: TopMoversProps) {
    const { format, convert } = useCurrency();
    const [showModal, setShowModal] = useState(false);
    const [period, setPeriod] = useState<MoverPeriod>('1D');

    const heldConstituents = useMemo(
        () => (constituents || []).filter(c => c.quantity > 0.00001),
        [constituents]
    );

    const { gainers, losers } = useMemo(() => {
        const baseVal = portfolioTotalValue > 0 ? portfolioTotalValue : 1;

        const activeMovers = heldConstituents
            .map(c => {
                const changeObj = getPeriodChange(c, period);
                if (!changeObj || Math.abs(changeObj.percent) <= 0.001) {
                    return null;
                }

                const hasStaleUsdRate = c.conversionRate === 1 && c.currency && c.currency !== 'USD' && typeof c.rateToUSD === 'number' && c.rateToUSD !== 1;
                const hasConversionRate = c.conversionRate !== undefined;
                const effectiveRate = hasStaleUsdRate ? c.rateToUSD : (c.conversionRate ?? 1);
                const priceTarget = hasConversionRate ? c.price * effectiveRate : convert(c.price, c.currency);
                const impactAbsTarget =
                    period === '1D' && changeObj.absoluteTarget !== undefined && !hasStaleUsdRate
                        ? changeObj.absoluteTarget
                        : hasConversionRate
                            ? changeObj.absolute * effectiveRate
                            : convert(changeObj.absolute, c.currency);

                const impactPercent = portfolioTotalValue > 0 ? (impactAbsTarget / baseVal) * 100 : 0;

                return {
                    ...c,
                    priceTarget,
                    changePercent: changeObj.percent,
                    impactAbsTarget,
                    impactPercent
                };
            })
            .filter(Boolean) as any[];

        const sortedDesc = [...activeMovers].sort((a, b) => b.impactPercent - a.impactPercent);
        const topGainers = sortedDesc.filter(c => c.impactPercent > 0).slice(0, 3);
        const topLosers = [...activeMovers]
            .filter(c => c.impactPercent < 0)
            .sort((a, b) => a.impactPercent - b.impactPercent)
            .slice(0, 3);

        return { gainers: topGainers, losers: topLosers };
    }, [heldConstituents, period, portfolioTotalValue, convert]);

    if (heldConstituents.length === 0) {
        return (
            <div className={styles.card}>
                <div className={styles.header}>
                    <h2 className={styles.title}>Top Movers</h2>
                </div>
                <div className={styles.emptyCard}>
                    Please add activity to see top movers
                </div>
            </div>
        );
    }

    const renderMoverRow = (c: any, isGain: boolean) => {
        const badgeClass = isGain ? styles.positive : styles.negative;
        const absSign = c.impactAbsTarget > 0 ? '+' : '';
        const pctSign = c.changePercent > 0 ? '+' : '';
        const impactSign = c.impactPercent > 0 ? '+' : '';

        return (
            <motion.li
                key={c.symbol}
                className={styles.item}
                layout
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.05 } }}
                transition={{ duration: 0.18 }}
            >
                <Link
                    href={{
                        pathname: `/analysis/${c.symbol}`,
                        query: { from: 'dashboard' }
                    }}
                    onClick={() => sessionStorage.setItem('navContext', 'dashboard')}
                    className={styles.itemLink}
                >
                    <div className={styles.symbolCol}>
                        <span className={styles.symbol}>{c.symbol}</span>
                        <span className={styles.price}>
                            {format(c.priceTarget)}
                            {c.name ? ` · ${c.name}` : ''}
                        </span>
                    </div>
                    <div className={styles.metricsCol}>
                        <div className={styles.changeContainer}>
                            <span className={styles.absChange}>
                                {absSign}{format(c.impactAbsTarget)}
                            </span>
                            <span className={`${styles.badge} ${badgeClass}`}>
                                {pctSign}{c.changePercent.toFixed(2)}%
                            </span>
                        </div>
                        <span className={styles.impactText}>
                            Impact: {impactSign}{c.impactPercent.toFixed(2)}%
                        </span>
                    </div>
                </Link>
            </motion.li>
        );
    };

    return (
        <>
            <div className={styles.card}>
                <div className={styles.header}>
                    <div className={styles.titleWrap}>
                        <h2 className={styles.title}>Top Movers</h2>
                        <div className={styles.periodControls} role="group" aria-label="Top movers period">
                            {PERIOD_OPTIONS.map(opt => {
                                const isActive = period === opt;
                                return (
                                    <button
                                        key={opt}
                                        type="button"
                                        aria-pressed={isActive}
                                        className={`${styles.periodBtn} ${isActive ? styles.periodBtnActive : ''}`}
                                        onClick={() => setPeriod(opt)}
                                    >
                                        {opt}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowModal(true)}
                        className={styles.viewAllBtn}
                    >
                        View All
                    </button>
                </div>

                <div className={styles.grid}>
                    <div className={styles.column}>
                        <h3 className={styles.subtitle}>Top Gainers ({period})</h3>
                        {gainers.length > 0 ? (
                            <ul className={styles.list}>
                                <AnimatePresence mode="popLayout">
                                    {gainers.map(c => renderMoverRow(c, true))}
                                </AnimatePresence>
                            </ul>
                        ) : (
                            <div className={styles.empty}>No gainers for {period}</div>
                        )}
                    </div>
                    <div className={styles.column}>
                        <h3 className={styles.subtitle}>Top Losers ({period})</h3>
                        {losers.length > 0 ? (
                            <ul className={styles.list}>
                                <AnimatePresence mode="popLayout">
                                    {losers.map(c => renderMoverRow(c, false))}
                                </AnimatePresence>
                            </ul>
                        ) : (
                            <div className={styles.empty}>No losers for {period}</div>
                        )}
                    </div>
                </div>
            </div>

            <TopMoversModal
                isOpen={showModal}
                onClose={() => setShowModal(false)}
                constituents={heldConstituents}
                portfolioTotalValue={portfolioTotalValue}
                portfolioDayChange={portfolioDayChange}
                period={period}
            />
        </>
    );
}
