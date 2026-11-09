'use client';

import React from 'react';
import styles from './SectorBreakdownCard.module.css';
import { SectorBreakdown } from '@/lib/look-through';
import { PieChart } from 'lucide-react';

interface SectorBreakdownCardProps {
    breakdown: SectorBreakdown;
    sectors: { name: string; value: number }[];
    selectedSector: string | null;
    onSelectSector: (sectorName: string | null) => void;
    format: (val: number) => string;
}

export default function SectorBreakdownCard({
    breakdown,
    sectors,
    selectedSector,
    onSelectSector,
    format
}: SectorBreakdownCardProps) {
    const directValue = breakdown.contributors
        .filter(c => !c.isLookThrough)
        .reduce((sum, c) => sum + c.allocatedValue, 0);

    const lookThroughValue = breakdown.contributors
        .filter(c => c.isLookThrough)
        .reduce((sum, c) => sum + c.allocatedValue, 0);

    const totalValue = breakdown.value;
    const directPercent = totalValue > 0 ? (directValue / totalValue) * 100 : 0;
    const lookThroughPercent = totalValue > 0 ? (lookThroughValue / totalValue) * 100 : 0;

    return (
        <div className={styles.card}>
            <div className={styles.header}>
                <div className={styles.titleGroup}>
                    <span className={styles.badge}>
                        <PieChart size={12} />
                        Portfolio X-Ray Decomposition
                    </span>
                    <h2 className={styles.title}>{breakdown.name}</h2>
                    <p className={styles.subtitle}>
                        Aggregate exposure across direct equities and underlying ETF holdings.
                    </p>
                </div>
                <div className={styles.metric}>
                    <div className={styles.metricValue}>{format(breakdown.value)}</div>
                    <div className={styles.metricPercent}>
                        {breakdown.percentage.toFixed(1)}% of Portfolio
                    </div>
                </div>
            </div>

            {/* Quick Sector Selector Pills */}
            <div className={styles.sectorPills}>
                {sectors.map(s => {
                    const isActive = s.name === breakdown.name;
                    return (
                        <button
                            key={s.name}
                            type="button"
                            className={`${styles.sectorPill} ${isActive ? styles.sectorPillActive : ''}`}
                            onClick={() => onSelectSector(isActive && selectedSector ? null : s.name)}
                        >
                            {s.name} ({format(s.value)})
                        </button>
                    );
                })}
            </div>

            {/* Direct Stock vs ETF Decomposition Split */}
            <div className={styles.splitOverview}>
                <div className={styles.splitCard}>
                    <span className={styles.splitLabel}>
                        <span className={styles.dotDirect} />
                        Direct Stock Holdings
                    </span>
                    <span className={styles.splitValue}>{format(directValue)}</span>
                    <span className={styles.splitSubtext}>{directPercent.toFixed(1)}% of {breakdown.name}</span>
                </div>

                <div className={styles.splitCard}>
                    <span className={styles.splitLabel}>
                        <span className={styles.dotLookThrough} />
                        ETF Look-Through Decomposition
                    </span>
                    <span className={styles.splitValue}>{format(lookThroughValue)}</span>
                    <span className={styles.splitSubtext}>{lookThroughPercent.toFixed(1)}% of {breakdown.name}</span>
                </div>
            </div>

            {/* Dual Progress Bar */}
            <div className={styles.splitProgressContainer}>
                <div className={styles.splitProgressBar}>
                    <div className={styles.barDirect} style={{ width: `${directPercent}%` }} />
                    <div className={styles.barLookThrough} style={{ width: `${lookThroughPercent}%` }} />
                </div>
                <div className={styles.splitLegend}>
                    <div className={styles.splitLegendItem}>
                        <span className={styles.dotDirect} /> Direct Equities ({directPercent.toFixed(1)}%)
                    </div>
                    <div className={styles.splitLegendItem}>
                        <span className={styles.dotLookThrough} /> ETF Look-Through ({lookThroughPercent.toFixed(1)}%)
                    </div>
                </div>
            </div>

            {/* Desktop Table View */}
            <div className={styles.desktopTableWrapper}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Holding</th>
                            <th>Source Type</th>
                            <th>Holding Value</th>
                            <th>Weight In Holding</th>
                            <th>Sector Exposure</th>
                            <th>Share of Sector</th>
                        </tr>
                    </thead>
                    <tbody>
                        {breakdown.contributors.map(contrib => (
                            <tr key={contrib.symbol}>
                                <td>
                                    <div className={styles.holdingSymbol}>{contrib.symbol}</div>
                                    <div className={styles.holdingName}>{contrib.name}</div>
                                </td>
                                <td>
                                    {contrib.isLookThrough ? (
                                        <span className={styles.badgeETF}>ETF Decomposition</span>
                                    ) : (
                                        <span className={styles.badgeDirect}>Direct Equity</span>
                                    )}
                                </td>
                                <td>{format(contrib.holdingValue)}</td>
                                <td>{(contrib.weightInHolding * 100).toFixed(1)}%</td>
                                <td><strong>{format(contrib.allocatedValue)}</strong></td>
                                <td>
                                    <div className={styles.shareCell}>
                                        <div className={styles.shareBarBg}>
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

            {/* Mobile Card List View (No Horizontal Table Overflow on Phones) */}
            <div className={styles.mobileCardsList}>
                {breakdown.contributors.map(contrib => (
                    <div key={contrib.symbol} className={styles.mobileCard}>
                        <div className={styles.mobileCardHeader}>
                            <div className={styles.mobileCardTitle}>
                                <span className={styles.mobileCardSymbol}>{contrib.symbol}</span>
                                <span className={styles.mobileCardName}>{contrib.name}</span>
                            </div>
                            {contrib.isLookThrough ? (
                                <span className={styles.badgeETF}>ETF Look-Through</span>
                            ) : (
                                <span className={styles.badgeDirect}>Direct Stock</span>
                            )}
                        </div>

                        <div className={styles.mobileCardStats}>
                            <div>
                                <div className={styles.mobileExposureLabel}>Effective Exposure</div>
                                <div className={styles.mobileExposureValue}>{format(contrib.allocatedValue)}</div>
                            </div>
                            <span className={styles.mobileShareTag}>
                                {contrib.weightInSector.toFixed(1)}% of Sector
                            </span>
                        </div>

                        <div className={styles.shareBarBg}>
                            <div
                                className={styles.shareBarFill}
                                style={{ width: `${Math.min(100, contrib.weightInSector)}%` }}
                            />
                        </div>

                        <div className={styles.mobileCardMeta}>
                            <span>Position: {format(contrib.holdingValue)}</span>
                            <span>Weight in Fund: {(contrib.weightInHolding * 100).toFixed(1)}%</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
