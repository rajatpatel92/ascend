/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useState, useMemo, useRef } from 'react';
import styles from './DividendSummary.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import Link from 'next/link';

interface DividendSummaryProps {
    dividendsYTD: number;
    upcomingDividends: any[];
    totalValue: number;
    projectedDividends: number;
    lifetimeDividends?: number;
    constituents?: any[];
}

type PulseTab = 'holdings' | 'dividends';

export default function DividendSummary({
    dividendsYTD,
    upcomingDividends = [],
    totalValue,
    projectedDividends,
    lifetimeDividends = 0,
    constituents = []
}: DividendSummaryProps) {
    const { format, convert } = useCurrency();
    const { formatDate } = useDate();
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const topHoldings = useMemo(() => {
        return (constituents || [])
            .filter(c => c.quantity > 0.00001)
            .map(c => {
                const hasStaleUsdRate = c.conversionRate === 1 && c.currency && c.currency !== 'USD' && typeof c.rateToUSD === 'number' && c.rateToUSD !== 1;
                const effectiveRate = hasStaleUsdRate ? c.rateToUSD : c.conversionRate;
                const valueTarget = !hasStaleUsdRate && c.valueTarget !== undefined
                    ? c.valueTarget
                    : (effectiveRate !== undefined ? c.value * effectiveRate : convert(c.value, c.currency));
                return { ...c, valueTarget };
            })
            .sort((a, b) => b.valueTarget - a.valueTarget)
            .slice(0, 5);
    }, [constituents, convert]);

    const activeSymbolSet = useMemo(() => {
        if (!constituents || constituents.length === 0) return null;
        return new Set(
            constituents
                .filter(c => c.quantity > 0.00001)
                .map(c => c.symbol)
        );
    }, [constituents]);

    const activeUpcomingDividends = useMemo(() => {
        return (upcomingDividends || []).filter(div => {
            if (typeof div.quantity === 'number' && div.quantity <= 0.00001) return false;
            if (activeSymbolSet && !activeSymbolSet.has(div.symbol)) return false;
            if (typeof div.estimatedAmount === 'number' && div.estimatedAmount <= 0) return false;
            return true;
        });
    }, [upcomingDividends, activeSymbolSet]);

    const [userSelectedTab, setUserSelectedTab] = useState<PulseTab | null>(null);
    const [showAllUpcoming, setShowAllUpcoming] = useState(false);
    const activeTab: PulseTab = userSelectedTab ?? (topHoldings.length > 0 ? 'holdings' : 'dividends');

    const tabs: { id: PulseTab; label: string; count?: number }[] = [
        { id: 'holdings', label: 'Top Holdings' },
        { id: 'dividends', label: 'Dividends', count: activeUpcomingDividends.length }
    ];

    const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = tabs.findIndex(t => t.id === activeTab);
        if (currentIndex === -1) return;

        let nextIndex: number | null = null;
        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = tabs.length - 1;

        if (nextIndex !== null) {
            e.preventDefault();
            setUserSelectedTab(tabs[nextIndex].id);
            tabRefs.current[nextIndex]?.focus();
        }
    };

    if (
        totalValue === 0 &&
        dividendsYTD === 0 &&
        projectedDividends === 0 &&
        lifetimeDividends === 0 &&
        activeUpcomingDividends.length === 0 &&
        topHoldings.length === 0
    ) {
        return (
            <div className={styles.card}>
                <h2 className={styles.title}>Top Holdings &amp; Dividends</h2>
                <div className={styles.emptyState}>
                    Please add activity to see holdings and dividends
                </div>
            </div>
        );
    }

    const projectedYield = totalValue > 0 ? ((projectedDividends / totalValue) * 100).toFixed(2) : '0.00';
    const hasMoreUpcoming = activeUpcomingDividends.length > 4;
    const visibleUpcomingDividends = showAllUpcoming
        ? activeUpcomingDividends
        : activeUpcomingDividends.slice(0, 4);

    return (
        <div className={styles.card}>
            <h2 className={styles.srOnly}>Top Holdings and Dividends</h2>
            <div className={styles.headerRow}>
                <div
                    role="tablist"
                    aria-label="Holdings and dividends view"
                    className={styles.tablist}
                    onKeyDown={handleTabKeyDown}
                >
                    {tabs.map((tab, idx) => {
                        const selected = activeTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                ref={el => { tabRefs.current[idx] = el; }}
                                type="button"
                                role="tab"
                                id={`radar-tab-${tab.id}`}
                                aria-selected={selected}
                                tabIndex={selected ? 0 : -1}
                                className={styles.tabBtn}
                                onClick={() => setUserSelectedTab(tab.id)}
                            >
                                <span>{tab.label}</span>
                                {tab.count !== undefined && tab.count > 0 && (
                                    <span className={styles.tabBadge}>{tab.count}</span>
                                )}
                            </button>
                        );
                    })}
                </div>
                {activeTab === 'holdings' && (
                    <Link href="/analysis/allocation" className={styles.headerLink}>
                        View All &rarr;
                    </Link>
                )}
            </div>

            {activeTab === 'holdings' ? (
                <div
                    role="tabpanel"
                    aria-labelledby="radar-tab-holdings"
                    tabIndex={0}
                    className={styles.panel}
                >
                    {topHoldings.length > 0 ? (
                        <ul className={styles.holdingsList}>
                            {topHoldings.map(item => {
                                const weightPct = totalValue > 0 ? (item.valueTarget / totalValue) * 100 : 0;
                                const retPct = item.inceptionChange?.percent ?? 0;
                                const isPos = retPct >= 0;

                                return (
                                    <li key={item.symbol} className={styles.holdingItem}>
                                        <Link
                                            href={{
                                                pathname: `/analysis/${item.symbol}`,
                                                query: { from: 'dashboard' }
                                            }}
                                            onClick={() => sessionStorage.setItem('navContext', 'dashboard')}
                                            className={styles.holdingLink}
                                        >
                                            <div className={styles.holdingTop}>
                                                <div className={styles.holdingIdentity}>
                                                    <span className={styles.symbol}>{item.symbol}</span>
                                                    {item.name && (
                                                        <span className={styles.holdingName}>{item.name}</span>
                                                    )}
                                                </div>
                                                <div className={styles.holdingMetrics}>
                                                    <span className={styles.holdingValue}>{format(item.valueTarget)}</span>
                                                    <span className={styles.holdingWeight}>{weightPct.toFixed(1)}%</span>
                                                    <span className={`${styles.returnPill} ${isPos ? styles.returnPos : styles.returnNeg}`}>
                                                        {isPos ? '+' : ''}{retPct.toFixed(1)}%
                                                    </span>
                                                </div>
                                            </div>
                                            <div className={styles.weightBarTrack} aria-hidden="true">
                                                <div
                                                    className={styles.weightBarFill}
                                                    style={{ width: `${Math.min(100, Math.max(weightPct, 1.5))}%` }}
                                                />
                                            </div>
                                        </Link>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <div className={styles.emptyState}>No active holdings match current filters</div>
                    )}
                </div>
            ) : (
                <div
                    role="tabpanel"
                    aria-labelledby="radar-tab-dividends"
                    tabIndex={0}
                    className={styles.panel}
                >
                    <div className={styles.statsGrid}>
                        <div className={styles.statItem}>
                            <div className={styles.label}>Received YTD</div>
                            <div className={styles.valueRow}>
                                <span className={styles.value}>{format(dividendsYTD)}</span>
                            </div>
                        </div>

                        <div className={styles.statItem}>
                            <div className={styles.label}>Projected Annual</div>
                            <div className={styles.valueRow}>
                                <span className={styles.value}>{format(projectedDividends)}</span>
                                <span className={styles.yieldPill}>{projectedYield}%</span>
                            </div>
                        </div>

                        <div className={styles.statItem}>
                            <div className={styles.label}>Lifetime Total</div>
                            <div className={styles.valueRow}>
                                <span className={styles.valueNeutral}>{format(lifetimeDividends)}</span>
                            </div>
                        </div>
                    </div>

                    <div className={styles.upcomingSection}>
                        <div className={styles.upcomingHeader}>
                            <h3 className={styles.subtitle}>Upcoming (Ex-Date) — Est. Payout</h3>
                            {hasMoreUpcoming && (
                                <button
                                    type="button"
                                    className={styles.showMoreBtn}
                                    onClick={() => setShowAllUpcoming(prev => !prev)}
                                    aria-expanded={showAllUpcoming}
                                >
                                    {showAllUpcoming ? 'Show less' : `Show all (${activeUpcomingDividends.length})`}
                                </button>
                            )}
                        </div>
                        {activeUpcomingDividends.length > 0 ? (
                            <ul className={styles.list}>
                                {visibleUpcomingDividends.map((div, i) => (
                                    <li key={`${div.symbol}-${div.exDate}-${i}`} className={styles.item}>
                                        <Link
                                            href={{
                                                pathname: `/analysis/${div.symbol}`,
                                                query: { from: 'dashboard' }
                                            }}
                                            onClick={() => sessionStorage.setItem('navContext', 'dashboard')}
                                            className={styles.divLink}
                                        >
                                            <div className={styles.symbolRow}>
                                                <span className={styles.symbol}>{div.symbol}</span>
                                                <span className={styles.date}>
                                                    {formatDate(div.exDate)}
                                                    {div.isEstimated && ' · Est.'}
                                                </span>
                                            </div>
                                            <div className={styles.amount}>
                                                {format(div.estimatedAmount)}
                                            </div>
                                        </Link>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <div className={styles.empty}>No upcoming dividends in the next 45 days</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
