'use client';

import React, { useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { useCurrency } from '@/context/CurrencyContext';
import styles from './AllocationChart.module.css';

interface DataPoint {
    name: string;
    value: number;
}

interface AllocationChartProps {
    title: string;
    subtitle?: string;
    badgeText?: string;
    itemLabel?: {
        singular: string;
        plural: string;
    };
    embedded?: boolean;
    data: DataPoint[];
    onSelect?: (name: string | null, event?: React.MouseEvent) => void;
    selectedName?: string | null;
    isPreConverted?: boolean;
}

const COLORS = [
    '#3b82f6', // Blue
    '#10b981', // Emerald
    '#f59e0b', // Amber
    '#8b5cf6', // Violet
    '#ec4899', // Pink
    '#06b6d4', // Cyan
    '#f97316', // Orange
    '#84cc16', // Lime
    '#a855f7', // Purple
    '#14b8a6', // Teal
    '#64748b', // Slate
    '#ef4444', // Red
    '#eab308', // Yellow
    '#6366f1', // Indigo
    '#d946ef', // Fuchsia
    '#0ea5e9'  // Sky Blue
];

const MAX_VISIBLE_CATEGORIES = 7;

export default function AllocationChart(props: AllocationChartProps) {
    const {
        title,
        subtitle,
        badgeText,
        itemLabel = { singular: 'Category', plural: 'Categories' },
        embedded = false,
        data,
        onSelect,
        selectedName,
        isPreConverted
    } = props;
    const { format, convert } = useCurrency();
    const [showAllCategories, setShowAllCategories] = useState(false);

    const chartData = data
        .map(item => ({
            ...item,
            value: isPreConverted ? item.value : convert(item.value, 'USD')
        }))
        .filter(item => item.value >= 0.01)
        .sort((a, b) => b.value - a.value);

    const totalValue = chartData.reduce((sum, item) => sum + item.value, 0);
    const selectedIndex = selectedName ? chartData.findIndex(item => item.name === selectedName) : -1;
    const selectedEntry = selectedIndex >= 0 ? chartData[selectedIndex] : null;
    const hasActiveSelection = Boolean(selectedEntry);
    const selectedPercent = selectedEntry && totalValue > 0 ? (selectedEntry.value / totalValue) * 100 : 0;

    const isAutoExpanded = selectedIndex >= MAX_VISIBLE_CATEGORIES;
    const isExpanded = showAllCategories || isAutoExpanded;
    const visibleItems = isExpanded || chartData.length <= MAX_VISIBLE_CATEGORIES
        ? chartData
        : chartData.slice(0, MAX_VISIBLE_CATEGORIES);

    const handleSelect = (name: string, e?: React.MouseEvent) => {
        if (onSelect) {
            onSelect(name === selectedName ? null : name, e);
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handlePieClick = (entry: any, _index: number, e: React.MouseEvent) => {
        if (entry?.name) {
            handleSelect(entry.name, e);
        }
    };

    return (
        <section
            className={`${styles.container} ${embedded ? styles.embedded : ''}`}
            aria-label={title}
        >
            <div className={styles.cardHeader}>
                <div className={styles.titleBlock}>
                    <div className={styles.titleRow}>
                        <h2 className={styles.title}>{title}</h2>
                        {badgeText && (
                            <span className={styles.xrayBadge}>
                                <Sparkles size={12} aria-hidden="true" />
                                {badgeText}
                            </span>
                        )}
                    </div>
                    {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
                </div>

                {selectedEntry && onSelect && (
                    <button
                        type="button"
                        className={styles.clearSelectionBtn}
                        onClick={(e) => onSelect(null, e)}
                    >
                        Reset selection
                    </button>
                )}
            </div>

            {chartData.length === 0 ? (
                <div className={styles.empty}>No allocation data available for current filters.</div>
            ) : (
                <div className={styles.masterDetail}>
                    {/* Left Pane: Donut Chart + Center Summary */}
                    <div className={styles.chartPane}>
                        <div className={styles.chartArea}>
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie
                                        data={chartData}
                                        cx="50%"
                                        cy="50%"
                                        innerRadius={72}
                                        outerRadius={104}
                                        paddingAngle={chartData.length > 1 ? 2 : 0}
                                        dataKey="value"
                                        onClick={handlePieClick}
                                        cursor="pointer"
                                        stroke="none"
                                    >
                                        {chartData.map((entry, index) => {
                                            const isSelected = selectedName === entry.name;
                                            return (
                                                <Cell
                                                    key={`cell-${entry.name}`}
                                                    fill={COLORS[index % COLORS.length]}
                                                    opacity={hasActiveSelection && !isSelected ? 0.28 : 1}
                                                    stroke={isSelected ? 'var(--text-primary)' : 'none'}
                                                    strokeWidth={isSelected ? 2 : 0}
                                                />
                                            );
                                        })}
                                    </Pie>
                                    <Tooltip
                                        formatter={(value: number) => format(value)}
                                        wrapperStyle={{ zIndex: 20 }}
                                        contentStyle={{
                                            backgroundColor: 'var(--card-bg)',
                                            border: '1px solid var(--card-border)',
                                            borderRadius: '0.5rem',
                                            color: 'var(--text-primary)',
                                            boxShadow: '0 8px 20px rgba(0, 0, 0, 0.25)'
                                        }}
                                        itemStyle={{ color: 'var(--text-primary)' }}
                                    />
                                </PieChart>
                            </ResponsiveContainer>

                            <div className={styles.centerOverlay}>
                                <span className={styles.centerLabel}>
                                    {selectedEntry ? selectedEntry.name : 'Total Allocation'}
                                </span>
                                <span className={styles.centerValue}>
                                    {format(selectedEntry ? selectedEntry.value : totalValue)}
                                </span>
                                <span className={styles.centerSublabel}>
                                    {selectedEntry
                                        ? `${selectedPercent.toFixed(1)}% of Portfolio`
                                        : `${chartData.length} ${chartData.length === 1 ? itemLabel.singular : itemLabel.plural}`}
                                </span>
                            </div>
                        </div>

                        <p className={styles.interactionHint}>
                            Click any slice or {itemLabel.singular.toLowerCase()} row to filter holdings
                            {badgeText ? ' & inspect X-Ray decomposition' : ''}.
                        </p>
                    </div>

                    {/* Right Pane: Ranked Breakdown List (Zero Scrollbars) */}
                    <div className={styles.breakdownPane}>
                        <ul className={styles.breakdownList} aria-label={`${title} ${itemLabel.plural.toLowerCase()}`}>
                            {visibleItems.map((entry, index) => {
                                const isSelected = selectedName === entry.name;
                                const isDimmed = hasActiveSelection && !isSelected;
                                const percent = totalValue > 0 ? (entry.value / totalValue) * 100 : 0;
                                const color = COLORS[index % COLORS.length];

                                return (
                                    <li key={entry.name} className={styles.breakdownListItem}>
                                        <button
                                            type="button"
                                            aria-pressed={isSelected}
                                            className={`${styles.breakdownRow} ${isSelected ? styles.rowSelected : ''} ${isDimmed ? styles.rowDimmed : ''}`}
                                            onClick={(e) => handleSelect(entry.name, e)}
                                        >
                                            <span className={styles.rowIdentity}>
                                                <span
                                                    className={styles.legendColor}
                                                    style={{ backgroundColor: color }}
                                                    aria-hidden="true"
                                                />
                                                <span className={styles.categoryName}>
                                                    <span>{entry.name}</span>
                                                </span>
                                            </span>

                                            <span className={styles.barTrack} aria-hidden="true">
                                                <span
                                                    className={styles.barFill}
                                                    style={{
                                                        width: `${Math.max(percent, 1.5)}%`,
                                                        backgroundColor: color
                                                    }}
                                                />
                                            </span>

                                            <span className={styles.rowMetrics}>
                                                <span className={styles.rowValue}>{format(entry.value)}</span>
                                                <span className={styles.rowPercent}>{percent.toFixed(1)}%</span>
                                            </span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>

                        {chartData.length > MAX_VISIBLE_CATEGORIES && !isAutoExpanded && (
                            <button
                                type="button"
                                className={styles.showMoreBtn}
                                onClick={() => setShowAllCategories(prev => !prev)}
                                aria-expanded={showAllCategories}
                            >
                                {showAllCategories ? (
                                    <>
                                        Show fewer
                                        <ChevronUp size={15} aria-hidden="true" />
                                    </>
                                ) : (
                                    <>
                                        Show all {chartData.length} {itemLabel.plural.toLowerCase()} (+{chartData.length - MAX_VISIBLE_CATEGORIES} more)
                                        <ChevronDown size={15} aria-hidden="true" />
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}
