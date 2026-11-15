'use client';

import React, { useMemo, useRef, useState } from 'react';
import {
    ResponsiveContainer,
    BarChart,
    Bar,
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ReferenceLine,
    Cell
} from 'recharts';
import styles from '../page.module.css';
import {
    buildGlidePathSeries,
    type PlannedRebalanceRow,
    type TargetConfig
} from '@/lib/rebalance-planner';

type ChartTab = 'allocation' | 'drift' | 'glidePath';

const CHART_TABS: ReadonlyArray<{ id: ChartTab; label: string }> = [
    { id: 'allocation', label: 'Current vs. Target' },
    { id: 'drift', label: 'Drift & Band' },
    { id: 'glidePath', label: 'Glide Path Preview' }
];

const GLIDE_PALETTE = [
    '#2563eb',
    '#10b981',
    '#f59e0b',
    '#8b5cf6',
    '#ec4899',
    '#06b6d4',
    '#84cc16',
    '#f97316'
];

interface RebalancerChartsProps {
    rows: PlannedRebalanceRow[];
    targets: TargetConfig[];
    tolerancePercent: number;
    formatCurrency: (val: number, options?: Intl.NumberFormatOptions) => string;
}

export default function RebalancerCharts({
    rows,
    targets,
    tolerancePercent,
    formatCurrency
}: RebalancerChartsProps) {
    const [activeTab, setActiveTab] = useState<ChartTab>('allocation');
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = CHART_TABS.findIndex((t) => t.id === activeTab);
        if (currentIndex === -1) return;

        let nextIndex: number | null = null;
        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % CHART_TABS.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + CHART_TABS.length) % CHART_TABS.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = CHART_TABS.length - 1;

        if (nextIndex !== null) {
            e.preventDefault();
            setActiveTab(CHART_TABS[nextIndex].id);
            tabRefs.current[nextIndex]?.focus();
        }
    };

    // Keep top 12 largest weights/drifts on bar charts so mobile and desktop stay readable
    const allocationChartData = useMemo(() => {
        return [...rows]
            .sort((a, b) => Math.max(b.currentPercent, b.targetPercent) - Math.max(a.currentPercent, a.targetPercent))
            .slice(0, 12)
            .map((r) => ({
                symbol: r.symbol,
                currentPercent: Number(r.currentPercent.toFixed(2)),
                targetPercent: Number(r.targetPercent.toFixed(2)),
                postTradePercent: Number(r.postTradePercent.toFixed(2)),
                currentValue: r.currentValue,
                targetValue: r.targetValue,
                driftPercent: Number(r.driftPercent.toFixed(2)),
                effectiveAction: r.effectiveAction
            }));
    }, [rows]);

    const driftChartData = useMemo(() => {
        return [...rows]
            .sort((a, b) => Math.abs(b.driftPercent) - Math.abs(a.driftPercent))
            .slice(0, 12)
            .map((r) => ({
                symbol: r.symbol,
                driftPercent: Number(r.driftPercent.toFixed(2)),
                driftValue: r.driftValue,
                isOutOfBand: r.isOutOfBand,
                effectiveAction: r.effectiveAction
            }));
    }, [rows]);

    const glideSymbols = useMemo(() => {
        return targets
            .filter((t) => t.symbol.trim() !== '' && (t.targetPercentage > 0 || (t.yearlyDriftAdjustment ?? 0) !== 0))
            .slice(0, 8)
            .map((t) => t.symbol);
    }, [targets]);

    const glideSeries = useMemo(() => {
        return buildGlidePathSeries(targets, [0, 1, 2, 3, 5]);
    }, [targets]);

    const hasGlideAdjustments = useMemo(
        () => targets.some((t) => t.yearlyDriftAdjustment !== null && t.yearlyDriftAdjustment !== 0),
        [targets]
    );

    const stripSegments = useMemo(() => {
        return rows.filter((d) => d.targetPercent > 0 || d.currentPercent > 0);
    }, [rows]);

    const getSegmentStyle = (item: PlannedRebalanceRow): React.CSSProperties => {
        const absDrift = Math.abs(item.driftPercent);
        const ratio = Math.min(absDrift / 15, 1);
        const opacity = 0.28 + ratio * 0.62;

        let background = 'var(--hover-bg)';
        let color = 'var(--text-primary)';

        if (item.driftPercent > tolerancePercent + 1e-9) {
            background = `rgba(239, 68, 68, ${opacity.toFixed(2)})`;
            color = ratio > 0.35 ? '#ffffff' : 'var(--text-primary)';
        } else if (item.driftPercent < -(tolerancePercent + 1e-9)) {
            background = `rgba(16, 185, 129, ${opacity.toFixed(2)})`;
            color = ratio > 0.35 ? '#ffffff' : 'var(--text-primary)';
        }

        const weight = Math.max(item.targetPercent || item.currentPercent || 1, 1);
        return {
            backgroundColor: background,
            color,
            flex: weight
        };
    };

    return (
        <section className={styles.panelCard} aria-label="Rebalance visual analysis">
            <div className={styles.tabHeaderRow}>
                <div className={styles.tabListWrap}>
                    <div
                        role="tablist"
                        aria-label="Rebalance visualization views"
                        className={styles.tabList}
                        onKeyDown={handleTabKeyDown}
                    >
                        {CHART_TABS.map((tab, idx) => {
                            const selected = activeTab === tab.id;
                            return (
                                <button
                                    key={tab.id}
                                    ref={(el) => { tabRefs.current[idx] = el; }}
                                    type="button"
                                    role="tab"
                                    id={`reb-tab-${tab.id}`}
                                    aria-selected={selected}
                                    tabIndex={selected ? 0 : -1}
                                    className={styles.tabBtn}
                                    onClick={() => setActiveTab(tab.id)}
                                >
                                    {tab.label}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            <div className={styles.legendStrip}>
                {activeTab === 'allocation' && (
                    <>
                        <span className={styles.legendItem}>
                            <span className={styles.legendSwatchBlue} aria-hidden="true" />
                            Current Weight (%)
                        </span>
                        <span className={styles.legendItem}>
                            <span className={styles.legendSwatchEmerald} aria-hidden="true" />
                            Target Weight (%)
                        </span>
                        <span className={styles.legendItem}>
                            <span className={styles.legendSwatchAmber} aria-hidden="true" />
                            Projected Post-Trade (%)
                        </span>
                    </>
                )}
                {activeTab === 'drift' && (
                    <>
                        <span className={styles.legendItem}>
                            <span className={styles.legendSwatchEmerald} aria-hidden="true" />
                            Underweight (Buy)
                        </span>
                        <span className={styles.legendItem}>
                            <span className={styles.legendSwatchRed} aria-hidden="true" />
                            Overweight (Sell)
                        </span>
                        <span className={styles.legendItem}>
                            Tolerance Band: <strong>&plusmn;{tolerancePercent}%</strong>
                        </span>
                    </>
                )}
                {activeTab === 'glidePath' && (
                    <span className={styles.legendItem}>
                        Projected target shifts from configured annual glide path rules (Today &rarr; +5 Years)
                    </span>
                )}
            </div>

            <div
                role="tabpanel"
                aria-labelledby={`reb-tab-${activeTab}`}
                tabIndex={0}
                className={styles.chartWrapper}
            >
                {activeTab === 'allocation' && (
                    allocationChartData.length === 0 ? (
                        <div className={styles.emptyChart}>No asset allocations available for the current filters.</div>
                    ) : (
                        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                            <BarChart data={allocationChartData} margin={{ top: 10, right: 12, bottom: 4, left: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                                <XAxis
                                    dataKey="symbol"
                                    stroke="var(--text-secondary)"
                                    fontSize={11}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <YAxis
                                    tickFormatter={(v) => `${v}%`}
                                    stroke="var(--text-secondary)"
                                    fontSize={11}
                                    width={44}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <Tooltip
                                    cursor={{ fill: 'var(--hover-bg)', opacity: 0.45 }}
                                    content={({ active, payload }) => {
                                        if (!active || !payload || !payload.length) return null;
                                        const pt = payload[0].payload as (typeof allocationChartData)[number];
                                        return (
                                            <div className={styles.tooltipBox}>
                                                <div className={styles.tooltipDate}>{pt.symbol}</div>
                                                <div className={styles.tooltipRow}>
                                                    <span>Current</span>
                                                    <strong>{pt.currentPercent.toFixed(2)}% ({formatCurrency(pt.currentValue)})</strong>
                                                </div>
                                                <div className={styles.tooltipRow}>
                                                    <span>Target</span>
                                                    <strong>{pt.targetPercent.toFixed(2)}% ({formatCurrency(pt.targetValue)})</strong>
                                                </div>
                                                <div className={styles.tooltipRow}>
                                                    <span>Post-Trade</span>
                                                    <strong>{pt.postTradePercent.toFixed(2)}%</strong>
                                                </div>
                                                <div className={`${styles.tooltipRow} ${styles.tooltipDivider}`}>
                                                    <span>Drift</span>
                                                    <strong className={pt.driftPercent > 0 ? styles.negativeText : styles.positiveText}>
                                                        {pt.driftPercent > 0 ? '+' : ''}{pt.driftPercent.toFixed(2)}%
                                                    </strong>
                                                </div>
                                            </div>
                                        );
                                    }}
                                />
                                <Bar dataKey="currentPercent" name="Current %" fill="#2563eb" radius={[4, 4, 0, 0]} maxBarSize={24} />
                                <Bar dataKey="targetPercent" name="Target %" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={24} />
                                <Bar dataKey="postTradePercent" name="Post-Trade %" fill="#f59e0b" radius={[4, 4, 0, 0]} maxBarSize={18} />
                            </BarChart>
                        </ResponsiveContainer>
                    )
                )}

                {activeTab === 'drift' && (
                    driftChartData.length === 0 ? (
                        <div className={styles.emptyChart}>No drift data available for the current filters.</div>
                    ) : (
                        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                            <BarChart data={driftChartData} margin={{ top: 10, right: 12, bottom: 4, left: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                                <XAxis
                                    dataKey="symbol"
                                    stroke="var(--text-secondary)"
                                    fontSize={11}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <YAxis
                                    tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`}
                                    stroke="var(--text-secondary)"
                                    fontSize={11}
                                    width={48}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <ReferenceLine y={0} stroke="var(--text-secondary)" strokeOpacity={0.65} />
                                {tolerancePercent > 0 && (
                                    <>
                                        <ReferenceLine y={tolerancePercent} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.75} />
                                        <ReferenceLine y={-tolerancePercent} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.75} />
                                    </>
                                )}
                                <Tooltip
                                    cursor={{ fill: 'var(--hover-bg)', opacity: 0.45 }}
                                    content={({ active, payload }) => {
                                        if (!active || !payload || !payload.length) return null;
                                        const pt = payload[0].payload as (typeof driftChartData)[number];
                                        return (
                                            <div className={styles.tooltipBox}>
                                                <div className={styles.tooltipDate}>{pt.symbol}</div>
                                                <div className={styles.tooltipRow}>
                                                    <span>Weight Drift</span>
                                                    <strong className={pt.driftPercent > 0 ? styles.negativeText : styles.positiveText}>
                                                        {pt.driftPercent > 0 ? '+' : ''}{pt.driftPercent.toFixed(2)}%
                                                    </strong>
                                                </div>
                                                <div className={styles.tooltipRow}>
                                                    <span>Value Delta</span>
                                                    <strong>{formatCurrency(Math.abs(pt.driftValue))}</strong>
                                                </div>
                                                <div className={`${styles.tooltipRow} ${styles.tooltipDivider}`}>
                                                    <span>Planned Action</span>
                                                    <strong>{pt.effectiveAction}</strong>
                                                </div>
                                            </div>
                                        );
                                    }}
                                />
                                <Bar dataKey="driftPercent" name="Drift %" radius={[4, 4, 4, 4]} maxBarSize={32}>
                                    {driftChartData.map((entry) => {
                                        let fill = '#94a3b8';
                                        if (entry.driftPercent > tolerancePercent + 1e-9) fill = '#ef4444';
                                        else if (entry.driftPercent < -(tolerancePercent + 1e-9)) fill = '#10b981';
                                        return <Cell key={entry.symbol} fill={fill} />;
                                    })}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    )
                )}

                {activeTab === 'glidePath' && (
                    glideSymbols.length === 0 ? (
                        <div className={styles.emptyChart}>
                            Configure target allocations to preview multi-year glide path shifts.
                        </div>
                    ) : !hasGlideAdjustments ? (
                        <div className={styles.emptyChart}>
                            No annual glide path adjustments configured yet. Open <strong>Configure Targets</strong> and enter a yearly % shift (e.g., <code>-1.0</code> for equities, <code>+1.0</code> for bonds).
                        </div>
                    ) : (
                        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                            <LineChart data={glideSeries} margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                                <XAxis
                                    dataKey="yearLabel"
                                    stroke="var(--text-secondary)"
                                    fontSize={11}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <YAxis
                                    tickFormatter={(v) => `${v}%`}
                                    stroke="var(--text-secondary)"
                                    fontSize={11}
                                    width={44}
                                    tickLine={false}
                                    axisLine={false}
                                />
                                <Tooltip
                                    content={({ active, payload, label }) => {
                                        if (!active || !payload || !payload.length) return null;
                                        return (
                                            <div className={styles.tooltipBox}>
                                                <div className={styles.tooltipDate}>Horizon: {label}</div>
                                                {payload.map((entry) => (
                                                    <div key={entry.name} className={styles.tooltipRow}>
                                                        <span>{entry.name}</span>
                                                        <strong>{Number(entry.value ?? 0).toFixed(1)}%</strong>
                                                    </div>
                                                ))}
                                            </div>
                                        );
                                    }}
                                />
                                {glideSymbols.map((sym, index) => (
                                    <Line
                                        key={sym}
                                        type="monotone"
                                        dataKey={sym}
                                        name={sym}
                                        stroke={GLIDE_PALETTE[index % GLIDE_PALETTE.length]}
                                        strokeWidth={2.25}
                                        dot={{ r: 3.5 }}
                                        activeDot={{ r: 5 }}
                                    />
                                ))}
                            </LineChart>
                        </ResponsiveContainer>
                    )
                )}
            </div>

            {stripSegments.length > 0 && (
                <div className={styles.heatmapBlock}>
                    <div className={styles.heatmapHeader}>
                        <span>Portfolio Drift Allocation Strip (Width = Target / Current Weight)</span>
                        <span>Hover segments for exact drift</span>
                    </div>
                    <div className={styles.heatmapContainer}>
                        {stripSegments.map((item) => {
                            const labelWeight = Math.max(item.targetPercent, item.currentPercent);
                            return (
                                <div
                                    key={item.symbol}
                                    className={styles.heatmapSegment}
                                    style={getSegmentStyle(item)}
                                    title={`${item.symbol}: ${item.driftPercent > 0 ? '+' : ''}${item.driftPercent.toFixed(2)}% Drift (${item.effectiveAction})`}
                                >
                                    {labelWeight >= 5.5 ? item.symbol : ''}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </section>
    );
}
