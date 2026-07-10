'use client';

import { useState } from 'react';
import styles from './TopMovers.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import TopMoversModal from './TopMoversModal';

interface TopMoversProps {
    constituents: any[];
    portfolioTotalValue: number;
    portfolioDayChange: number;
}

export default function TopMovers({ constituents, portfolioTotalValue, portfolioDayChange }: TopMoversProps) {
    const { format, convert, currency, rates } = useCurrency();
    const [showModal, setShowModal] = useState(false);

    // Calculate previous portfolio value to determine impact
    const prevValueUSD = portfolioTotalValue - portfolioDayChange;

    // Filter out sold assets (quantity effectively 0)
    const heldConstituents = constituents.filter(c => c.quantity > 0.00001);

    // Enrich constituents with impact data
    const constituentsWithImpact = heldConstituents.map(c => {
        // If coming from API topMovers, value is already converted and rateToUSD might be missing.
        // If rateToUSD is missing, assume 1 (already converted or same currency).
        const rate = c.rateToUSD ?? 1;
        const impactUSD = c.dayChange.absolute * rate; // 'absolute' is already converted in topMovers object
        const impactPercent = prevValueUSD !== 0 ? (impactUSD / prevValueUSD) * 100 : 0;
        return { ...c, impactPercent };
    });

    // Filter out items with 0 impact/change to avoid noise
    const activeConstituents = constituentsWithImpact.filter(c => Math.abs(c.dayChange.percent) > 0.001);

    // Sort by impact percent descending (absolute impact)
    // Wait, "Top Movers" usually separates Gainers (Positive Impact) and Losers (Negative Impact).
    // So we sort simply by impactPercent value. 
    // High positive impact -> Top Gainer.
    // High negative impact -> Top Loser.
    const sorted = [...activeConstituents].sort((a, b) => b.impactPercent - a.impactPercent);

    // Gainers: Positive Impact, sorted desc
    const gainers = sorted.filter(c => c.impactPercent > 0).slice(0, 4);

    // Losers: Negative Impact, sorted asc (biggest losers first)
    // "sorted" is desc, so negatives are at the end.
    // We want the MOST negative at the top of "Losers" list?
    // Usually "Top Losers" means biggest drops. -5% is "bigger" loser than -1%.
    // So distinct slice for losers: sort asc.
    const losers = [...activeConstituents]
        .filter(c => c.impactPercent < 0)
        .sort((a, b) => a.impactPercent - b.impactPercent)
        .slice(0, 4);

    if (gainers.length === 0 && losers.length === 0) {
        return (
            <div className={styles.card}>
                <h3 className={styles.title}>Top Movers (1D)</h3>
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                    Please add activity to see this list
                </div>
            </div>
        );
    }

    return (
        <>
            <div className={styles.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                    <h3 className={styles.title} style={{ marginBottom: 0 }}>Top Movers (1D)</h3>
                    <button
                        onClick={() => setShowModal(true)}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--primary)',
                            cursor: 'pointer',
                            fontSize: '0.875rem',
                            fontWeight: 500
                        }}
                    >
                        View Details
                    </button>
                </div>

                <div className={styles.grid}>
                    <div className={styles.column}>
                        <h4 className={styles.subtitle}>Gainers</h4>
                        {gainers.length > 0 ? (
                            <ul className={styles.list}>
                                <AnimatePresence mode="popLayout">
                                    {gainers.map(c => (
                                        <motion.li
                                            key={c.symbol}
                                            className={styles.item}
                                            layout
                                            initial={{ opacity: 0, scale: 0.95 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, transition: { duration: 0.05 } }}
                                            transition={{ duration: 0.2 }}
                                        >
                                            <Link
                                                href={{
                                                    pathname: `/analysis/${c.symbol}`,
                                                    query: { from: 'dashboard' }
                                                }}
                                                onClick={() => sessionStorage.setItem('navContext', 'dashboard')}
                                                style={{ textDecoration: 'none', color: 'inherit', display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}
                                            >
                                                <div className={styles.symbolRow}>
                                                    <span className={styles.symbol}>{c.symbol}</span>
                                                    <span className={styles.price}>{format(convert(c.price, c.currency))}</span>
                                                </div>
                                                <div className={styles.changeContainer}>
                                                    <span className={`${styles.badge} ${styles.positive}`}>
                                                        +{format(convert(c.dayChange.absolute, c.currency))}
                                                    </span>
                                                    <span className={`${styles.badge} ${styles.positive}`}>
                                                        +{c.dayChange.percent.toFixed(2)}%
                                                    </span>
                                                </div>
                                            </Link>
                                        </motion.li>
                                    ))}
                                </AnimatePresence>
                            </ul>
                        ) : (
                            <div className={styles.empty}>No gainers today</div>
                        )}
                    </div>
                    <div className={styles.column}>
                        <h4 className={styles.subtitle}>Losers</h4>
                        {losers.length > 0 ? (
                            <ul className={styles.list}>
                                <AnimatePresence mode="popLayout">
                                    {losers.map(c => (
                                        <motion.li
                                            key={c.symbol}
                                            className={styles.item}
                                            layout
                                            initial={{ opacity: 0, scale: 0.95 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            exit={{ opacity: 0, transition: { duration: 0.05 } }}
                                            transition={{ duration: 0.2 }}
                                        >
                                            <Link
                                                href={{
                                                    pathname: `/analysis/${c.symbol}`,
                                                    query: { from: 'dashboard' }
                                                }}
                                                onClick={() => sessionStorage.setItem('navContext', 'dashboard')}
                                                style={{ textDecoration: 'none', color: 'inherit', display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}
                                            >
                                                <div className={styles.symbolRow}>
                                                    <span className={styles.symbol}>{c.symbol}</span>
                                                    <span className={styles.price}>{format(convert(c.price, c.currency))}</span>
                                                </div>
                                                <div className={styles.changeContainer}>
                                                    <span className={`${styles.badge} ${styles.negative}`}>
                                                        {format(convert(c.dayChange.absolute, c.currency))}
                                                    </span>
                                                    <span className={`${styles.badge} ${styles.negative}`}>
                                                        {c.dayChange.percent.toFixed(2)}%
                                                    </span>
                                                </div>
                                            </Link>
                                        </motion.li>
                                    ))}
                                </AnimatePresence>
                            </ul>
                        ) : (
                            <div className={styles.empty}>No losers today</div>
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
            />
        </>
    );
}
