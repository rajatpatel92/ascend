'use client';

import React from 'react';
import { PieChart, X } from 'lucide-react';
import { SectorBreakdown, CountryBreakdown } from '@/lib/look-through';
import styles from './SectorBreakdownCard.module.css';

interface SectorBreakdownCardProps {
    breakdown: SectorBreakdown | CountryBreakdown;
    dimensionLabel?: 'Sector' | 'Country';
    onClose: () => void;
    format: (val: number) => string;
}

export default function SectorBreakdownCard({
    breakdown,
    dimensionLabel = 'Sector',
    onClose,
    format
}: SectorBreakdownCardProps) {
    const visibleContributors = breakdown.contributors.filter(c => c.allocatedValue >= 0.01);

    const directValue = visibleContributors
        .filter(c => !c.isLookThrough)
        .reduce((sum, c) => sum + c.allocatedValue, 0);

    const lookThroughValue = visibleContributors
        .filter(c => c.isLookThrough)
        .reduce((sum, c) => sum + c.allocatedValue, 0);

    const totalValue = breakdown.value;
    const directPercent = totalValue > 0 ? (directValue / totalValue) * 100 : 0;
    const lookThroughPercent = totalValue > 0 ? (lookThroughValue / totalValue) * 100 : 0;

    return (
        <section
            className={styles.card}
            aria-label={`${breakdown.name} ${dimensionLabel} X-Ray Decomposition`}
        >
            <div className={styles.header}>
                <div className={styles.titleGroup}>
                    <span className={styles.badge}>
                        <PieChart size={12} aria-hidden="true" />
                        Portfolio X-Ray Decomposition &bull; {dimensionLabel}
                    </span>
                    <div className={styles.titleLine}>
                        <h2 className={styles.title}>{breakdown.name}</h2>
                        <span className={styles.inlineMetric}>
                            {format(breakdown.value)}
                            <span className={styles.inlinePercent}>
                                &bull; {breakdown.percentage.toFixed(1)}% of Portfolio
                            </span>
                        </span>
                    </div>
                    <p className={styles.subtitle}>
                        Aggregate exposure across direct holdings and underlying ETF look-through weights.
                    </p>
                </div>

                <button
                    type="button"
                    className={styles.closeBtn}
                    onClick={onClose}
                    aria-label="Close X-Ray breakdown"
                >
                    <X size={16} aria-hidden="true" />
                    <span>Close</span>
                </button>
            </div>

            {/* Compact Single-Row Direct vs ETF Look-Through Summary Strip */}
            <div className={styles.summaryStrip}>
                <div className={styles.summaryItem}>
                    <span className={styles.summaryLabel}>
                        <span className={styles.dotDirect} aria-hidden="true" />
                        Direct Holdings
                    </span>
                    <span className={styles.summaryValue}>
                        {format(directValue)}
                        <span className={styles.summaryPct}>({directPercent.toFixed(1)}%)</span>
                    </span>
                </div>

                <div className={styles.dualBarWrapper} aria-hidden="true">
                    <div className={styles.splitProgressBar}>
                        <div className={styles.barDirect} style={{ width: `${directPercent}%` }} />
                        <div className={styles.barLookThrough} style={{ width: `${lookThroughPercent}%` }} />
                    </div>
                </div>

                <div className={`${styles.summaryItem} ${styles.summaryItemRight}`}>
                    <span className={styles.summaryLabel}>
                        <span className={styles.dotLookThrough} aria-hidden="true" />
                        ETF Look-Through
                    </span>
                    <span className={styles.summaryValue}>
                        {format(lookThroughValue)}
                        <span className={styles.summaryPct}>({lookThroughPercent.toFixed(1)}%)</span>
                    </span>
                </div>
            </div>

            {/* Desktop Table View */}
            <div
                tabIndex={0}
                role="region"
                aria-label={`${breakdown.name} contributors`}
                className={styles.desktopTableWrapper}
            >
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th scope="col">Holding</th>
                            <th scope="col">Source</th>
                            <th scope="col" className={styles.right}>Position Value</th>
                            <th scope="col" className={styles.right}>Weight in Holding</th>
                            <th scope="col" className={styles.right}>{dimensionLabel} Exposure</th>
                            <th scope="col">Share of {dimensionLabel}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {visibleContributors.map(contrib => (
                            <tr key={contrib.symbol}>
                                <td>
                                    <div className={styles.holdingSymbol}>{contrib.symbol}</div>
                                    <div className={styles.holdingName}>{contrib.name}</div>
                                </td>
                                <td>
                                    {contrib.isLookThrough ? (
                                        <span className={styles.badgeETF}>ETF Look-Through</span>
                                    ) : (
                                        <span className={styles.badgeDirect}>Direct Holding</span>
                                    )}
                                </td>
                                <td className={styles.right}>{format(contrib.holdingValue)}</td>
                                <td className={styles.right}>{(contrib.weightInHolding * 100).toFixed(1)}%</td>
                                <td className={styles.right}>
                                    <strong>{format(contrib.allocatedValue)}</strong>
                                </td>
                                <td>
                                    <div className={styles.shareCell}>
                                        <div className={styles.shareBarBg} aria-hidden="true">
                                            <div
                                                className={styles.shareBarFill}
                                                style={{ width: `${Math.min(100, contrib.weightInSector)}%` }}
                                            />
                                        </div>
                                        <span>{contrib.weightInSector.toFixed(1)}%</span>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Mobile Card List View */}
            <div className={styles.mobileCardsList}>
                {visibleContributors.map(contrib => (
                    <div key={contrib.symbol} className={styles.mobileCard}>
                        <div className={styles.mobileCardHeader}>
                            <div className={styles.mobileCardTitle}>
                                <span className={styles.mobileCardSymbol}>{contrib.symbol}</span>
                                <span className={styles.mobileCardName}>{contrib.name}</span>
                            </div>
                            {contrib.isLookThrough ? (
                                <span className={styles.badgeETF}>ETF Look-Through</span>
                            ) : (
                                <span className={styles.badgeDirect}>Direct Holding</span>
                            )}
                        </div>

                        <div className={styles.mobileCardStats}>
                            <div>
                                <div className={styles.mobileExposureLabel}>{dimensionLabel} Exposure</div>
                                <div className={styles.mobileExposureValue}>{format(contrib.allocatedValue)}</div>
                            </div>
                            <span className={styles.mobileShareTag}>
                                {contrib.weightInSector.toFixed(1)}% of {dimensionLabel}
                            </span>
                        </div>

                        <div className={styles.shareBarBg} aria-hidden="true">
                            <div
                                className={styles.shareBarFill}
                                style={{ width: `${Math.min(100, contrib.weightInSector)}%` }}
                            />
                        </div>

                        <div className={styles.mobileCardMeta}>
                            <span>Position: {format(contrib.holdingValue)}</span>
                            <span>Weight: {(contrib.weightInHolding * 100).toFixed(1)}%</span>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
