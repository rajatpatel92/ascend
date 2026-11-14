'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ClientCache } from '@/lib/client-cache';
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer
} from 'recharts';
import styles from './PortfolioChart.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import DateInput from './DateInput';

interface HistoryPoint {
    date: string;
    value: number;
    invested: number;
    nav?: number;
    marketValue?: number;
    dividend?: number;
}

interface PerformanceChartProps {
    range: string;
    setRange: (range: string) => void;
    customStart: string;
    setCustomStart: (date: string) => void;
    customEnd: string;
    setCustomEnd: (date: string) => void;
    overrideChange?: number;
    overrideChangePercent?: number;
    filterInvestmentTypes?: string[];
    filterAccountTypes?: string[];
}

type ChartMode = 'value' | 'return';

const RANGES = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y', '10Y', 'ALL'];

function parseHistoryTimestamp(dateStr: string): number {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d, 12, 0, 0).getTime();
    }
    return new Date(dateStr).getTime();
}

function getRangeLabel(r: string): string {
    switch (r) {
        case '1D': return '1-day';
        case '1W': return '1-week';
        case '1M': return '1-month';
        case '3M': return '3-months';
        case '6M': return '6-months';
        case 'YTD': return 'YTD';
        case '1Y': return '1-year';
        case '2Y': return '2-years';
        case '3Y': return '3-years';
        case '5Y': return '5-years';
        case '10Y': return '10-years';
        case 'ALL': return 'All-time';
        case 'CUSTOM': return 'Custom';
        default: return '';
    }
}

export default function PerformanceChart({
    range,
    setRange,
    customStart,
    setCustomStart,
    customEnd,
    setCustomEnd,
    overrideChange,
    overrideChangePercent,
    filterInvestmentTypes,
    filterAccountTypes
}: PerformanceChartProps) {
    const [data, setData] = useState<HistoryPoint[]>([]);
    const [loading, setLoading] = useState(false);
    const [chartMode, setChartMode] = useState<ChartMode>('value');
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const { format, currency } = useCurrency();
    const { formatDate } = useDate();

    const modeTabs = useMemo<{ id: ChartMode; label: string }[]>(() => [
        { id: 'value', label: `Value vs. Invested (${currency})` },
        { id: 'return', label: 'Time-Weighted Return (%)' }
    ], [currency]);

    useEffect(() => {
        if (range === 'CUSTOM' && (!customStart || !customEnd)) {
            setData([]);
            setLoading(false);
            return;
        }

        const controller = new AbortController();

        const fetchData = async () => {
            const filterKey = `${(filterInvestmentTypes || []).slice().sort().join('-')}_${(filterAccountTypes || []).slice().sort().join('-')}`;
            const cacheKey = `portfolio-history-${range}-${currency}-${customStart}-${customEnd}-${filterKey}-v5`;

            const cached = ClientCache.get<HistoryPoint[]>(cacheKey);
            if (cached && Array.isArray(cached) && cached.length > 0) {
                setData(cached);
            }

            setLoading(true);
            try {
                let url = `/api/portfolio/history?range=${range}&currency=${currency}`;
                if (range === 'CUSTOM' && customStart && customEnd) {
                    url += `&startDate=${customStart}&endDate=${customEnd}`;
                }
                if (filterInvestmentTypes && filterInvestmentTypes.length > 0) {
                    url += `&investmentTypes=${filterInvestmentTypes.join(',')}`;
                }
                if (filterAccountTypes && filterAccountTypes.length > 0) {
                    url += `&accountTypes=${filterAccountTypes.join(',')}`;
                }

                const res = await fetch(url, { signal: controller.signal });
                if (!res.ok) return;
                const json = await res.json();
                if (!controller.signal.aborted && Array.isArray(json)) {
                    setData(json);
                    ClientCache.set(cacheKey, json);
                }
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to fetch history', error);
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                }
            }
        };

        fetchData();
        return () => controller.abort();
    }, [range, customStart, customEnd, currency, filterInvestmentTypes, filterAccountTypes]);

    const {
        chartData,
        returnChange,
        valueChange,
        totalContribution,
        avgContribution,
        periodMonths,
        minMarketValue,
        maxMarketValue,
        maxAbsReturn
    } = useMemo(() => {
        const totalInvested = data.reduce((sum, point) => sum + point.invested, 0);
        const avgInv = data.length > 0 ? totalInvested / data.length : 0;

        const points = data.map(point => {
            const value = point.value;
            const invested = point.invested;
            let returnPercent = 0;

            if (point.nav !== undefined) {
                const startNav = data[0]?.nav || 100;
                if (startNav > 0) {
                    returnPercent = ((point.nav / startNav) - 1) * 100;
                }
            } else {
                const profit = value - invested;
                returnPercent = avgInv !== 0 ? (profit / avgInv) * 100 : 0;
            }

            return {
                date: point.date,
                dateNumber: parseHistoryTimestamp(point.date),
                value: returnPercent,
                invested,
                marketValue: value,
                dividend: point.dividend || 0
            };
        });

        let retChange = 0;
        let valChange = 0;
        let contrib = 0;
        let avgContrib = 0;
        let months = 0;
        let minVal = 0;
        let maxVal = 0;
        let maxRet = 0;

        if (points.length > 0) {
            const firstPoint = points[0];
            const lastPoint = points[points.length - 1];

            if (
                range === '1D' &&
                typeof overrideChange === 'number' &&
                Number.isFinite(overrideChange) &&
                typeof overrideChangePercent === 'number' &&
                Number.isFinite(overrideChangePercent)
            ) {
                valChange = overrideChange;
                retChange = overrideChangePercent;
            } else if (range === 'ALL' || range === 'MAX') {
                retChange = lastPoint.value;
                valChange = (lastPoint.marketValue || 0) - (lastPoint.invested || 0) + (lastPoint.dividend || 0);
            } else {
                retChange = lastPoint.value - firstPoint.value;
                const startVal = firstPoint.marketValue || 0;
                const endVal = lastPoint.marketValue || 0;
                const startInv = firstPoint.invested || 0;
                const endInv = lastPoint.invested || 0;
                const startDiv = firstPoint.dividend || 0;
                const endDiv = lastPoint.dividend || 0;
                valChange = (endVal - startVal) - (endInv - startInv) + (endDiv - startDiv);
            }

            if (range === 'ALL' || range === 'MAX') {
                contrib = lastPoint.invested;
            } else {
                contrib = lastPoint.invested - firstPoint.invested;
            }

            const diffDays = Math.ceil(Math.abs(lastPoint.dateNumber - firstPoint.dateNumber) / (1000 * 60 * 60 * 24));
            months = diffDays / 30.44;
            if (months >= 1) {
                avgContrib = contrib / months;
            }

            const mvArr = points.map(p => p.marketValue);
            minVal = Math.min(...mvArr);
            maxVal = Math.max(...mvArr);
            maxRet = Math.max(...points.map(p => Math.abs(p.value)));
        }

        return {
            chartData: points,
            returnChange: retChange,
            valueChange: valChange,
            totalContribution: contrib,
            avgContribution: avgContrib,
            periodMonths: months,
            minMarketValue: minVal,
            maxMarketValue: maxVal,
            maxAbsReturn: maxRet
        };
    }, [data, range, overrideChange, overrideChangePercent]);

    const isPositive = returnChange >= 0;
    const marketRangeSpan = maxMarketValue - minMarketValue;

    const gradientOffset = () => {
        if (chartData.length === 0) return 0.5;
        const dataMax = Math.max(...chartData.map(i => i.value));
        const dataMin = Math.min(...chartData.map(i => i.value));
        if (dataMax <= 0) return 0;
        if (dataMin >= 0) return 1;
        return dataMax / (dataMax - dataMin);
    };

    const off = gradientOffset();

    const formatReturnTick = (val: number) => {
        if (maxAbsReturn < 0.1) return `${val.toFixed(3)}%`;
        if (maxAbsReturn < 1) return `${val.toFixed(2)}%`;
        if (maxAbsReturn < 10) return `${val.toFixed(1)}%`;
        return `${val.toFixed(0)}%`;
    };

    const formatValueTick = (value: number) => {
        if (marketRangeSpan < 10) {
            if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(4)}M`;
            if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(3)}K`;
            return value.toFixed(2);
        }
        if (marketRangeSpan < 100) {
            if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(3)}M`;
            if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)}K`;
            return value.toFixed(1);
        }
        if (marketRangeSpan < 1000) {
            if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
            if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)}K`;
            return value.toFixed(0);
        }
        if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
        if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(0)}K`;
        return String(Math.round(value));
    };

    const formatReturnTooltip = (val: number) => {
        if (maxAbsReturn < 0.01) return [`${val.toFixed(4)}%`, 'Time-Weighted Return'];
        if (maxAbsReturn < 0.1) return [`${val.toFixed(3)}%`, 'Time-Weighted Return'];
        return [`${val.toFixed(2)}%`, 'Time-Weighted Return'];
    };

    const formatValueTooltip = (val: number, name: string) => {
        const label = name === 'invested' ? 'Invested Principal' : 'Portfolio Value';
        return [format(val), label];
    };

    const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = modeTabs.findIndex(t => t.id === chartMode);
        if (currentIndex === -1) return;

        let nextIndex: number | null = null;
        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % modeTabs.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + modeTabs.length) % modeTabs.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = modeTabs.length - 1;

        if (nextIndex !== null) {
            e.preventDefault();
            setChartMode(modeTabs[nextIndex].id);
            tabRefs.current[nextIndex]?.focus();
        }
    };

    return (
        <div className={styles.unifiedContainer}>
            <div className={styles.unifiedHeader}>
                <div className={styles.headerTopRow}>
                    <div className={styles.headerTitleArea}>
                        <div
                            role="tablist"
                            aria-label="Portfolio chart view"
                            className={styles.modeTablist}
                            onKeyDown={handleTabKeyDown}
                        >
                            {modeTabs.map((tab, idx) => {
                                const selected = chartMode === tab.id;
                                return (
                                    <button
                                        key={tab.id}
                                        ref={el => { tabRefs.current[idx] = el; }}
                                        type="button"
                                        role="tab"
                                        id={`perf-tab-${tab.id}`}
                                        aria-selected={selected}
                                        tabIndex={selected ? 0 : -1}
                                        className={styles.modeTab}
                                        onClick={() => setChartMode(tab.id)}
                                    >
                                        {tab.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className={styles.controls}>
                        <div className={styles.desktopControls}>
                            <div className={styles.ranges}>
                                {RANGES.map(r => (
                                    <button
                                        key={r}
                                        type="button"
                                        aria-pressed={range === r}
                                        className={`${styles.rangeButton} ${range === r ? styles.active : ''}`}
                                        onClick={() => setRange(r)}
                                    >
                                        {r}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    aria-pressed={range === 'CUSTOM'}
                                    className={`${styles.rangeButton} ${range === 'CUSTOM' ? styles.active : ''}`}
                                    onClick={() => setRange('CUSTOM')}
                                >
                                    Custom
                                </button>
                            </div>
                        </div>

                        <div className={styles.mobileControls}>
                            <select
                                aria-label="Chart timeframe"
                                className={styles.mobileSelect}
                                value={range}
                                onChange={(e) => setRange(e.target.value)}
                            >
                                {RANGES.map(r => (
                                    <option key={r} value={r}>{r === 'ALL' ? 'All Time' : r}</option>
                                ))}
                                <option value="CUSTOM">Custom Range</option>
                            </select>
                        </div>

                        {range === 'CUSTOM' && (
                            <div className={styles.dateInputs}>
                                <DateInput
                                    value={customStart}
                                    onChange={setCustomStart}
                                    ariaLabel="Custom start date"
                                    className={styles.dateInput}
                                />
                                <span className={styles.separator}>to</span>
                                <DateInput
                                    value={customEnd}
                                    onChange={setCustomEnd}
                                    ariaLabel="Custom end date"
                                    className={styles.dateInput}
                                />
                            </div>
                        )}
                    </div>
                </div>

                {chartData.length > 0 && (
                    <div className={styles.periodMetricsStrip}>
                        <div className={styles.metricGroup}>
                            <div className={styles.metricChip}>
                                <span className={styles.metricChipLabel}>Period P&amp;L</span>
                                <span className={styles.metricChipValue}>
                                    {valueChange > 0 ? '+' : ''}{format(valueChange)}
                                </span>
                                <span className={`${styles.metricPill} ${isPositive ? styles.metricPillPos : styles.metricPillNeg}`}>
                                    {returnChange > 0 ? '+' : ''}{returnChange.toFixed(2)}% ({getRangeLabel(range)})
                                </span>
                            </div>

                            {range !== '1D' && (
                                <div className={styles.metricChip}>
                                    <span className={styles.metricChipLabel}>Net Contributions</span>
                                    <span className={styles.metricChipValue}>
                                        {totalContribution > 0 ? '+' : ''}{format(totalContribution)}
                                    </span>
                                    {periodMonths >= 1 && (
                                        <span className={styles.metricChipSub}>
                                            ({format(avgContribution)}/mo)
                                        </span>
                                    )}
                                </div>
                            )}

                            <div className={styles.metricChip}>
                                <span className={styles.metricChipLabel}>Range Low / High</span>
                                <span className={styles.metricChipValue}>
                                    {format(minMarketValue)} – {format(maxMarketValue)}
                                </span>
                            </div>
                        </div>

                        {chartMode === 'value' && (
                            <div className={styles.chartLegend}>
                                <span className={styles.legendItem}>
                                    <span className={styles.legendLinePrimary} />
                                    Portfolio Value
                                </span>
                                {range !== '1D' && (
                                    <span className={styles.legendItem}>
                                        <span className={styles.legendLineDashed} />
                                        Invested Principal
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div
                role="tabpanel"
                aria-labelledby={`perf-tab-${chartMode}`}
                tabIndex={0}
                className={styles.chartWrapper}
                style={{ position: 'relative' }}
            >
                {loading && <div className={styles.loading}>Loading...</div>}
                {!loading && chartData.length === 0 && (
                    <div className={styles.emptyOverlay}>
                        Please add activity to see performance history
                    </div>
                )}
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                        <defs>
                            <linearGradient id="colorValueUnified" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.22} />
                                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="splitColor" x1="0" y1="0" x2="0" y2="1">
                                <stop offset={off} stopColor="#10b981" stopOpacity={1} />
                                <stop offset={off} stopColor="#ef4444" stopOpacity={1} />
                            </linearGradient>
                            <linearGradient id="splitColorFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset={off} stopColor="#10b981" stopOpacity={0.14} />
                                <stop offset={off} stopColor="#ef4444" stopOpacity={0.14} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                        <XAxis
                            dataKey="dateNumber"
                            type="number"
                            domain={['dataMin', 'dataMax']}
                            tickFormatter={(unixTime) => {
                                const date = new Date(unixTime);
                                if (range === '1D') {
                                    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                }
                                return range === '1W' || range === '1M'
                                    ? formatDate(date).split(',')[0]
                                    : formatDate(date);
                            }}
                            stroke="var(--text-secondary)"
                            fontSize={11}
                            tickMargin={6}
                            minTickGap={34}
                            tickLine={false}
                            axisLine={false}
                        />
                        <YAxis
                            tickFormatter={chartMode === 'value' ? formatValueTick : formatReturnTick}
                            stroke="var(--text-secondary)"
                            fontSize={11}
                            tickMargin={6}
                            domain={['auto', 'auto']}
                            width={52}
                            tickCount={5}
                            tickLine={false}
                            axisLine={false}
                        />
                        <Tooltip
                            formatter={chartMode === 'value' ? formatValueTooltip : formatReturnTooltip}
                            labelFormatter={(label) => {
                                if (range === '1D') {
                                    return new Date(label).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
                                }
                                return formatDate(label);
                            }}
                            contentStyle={{
                                backgroundColor: 'var(--card-bg)',
                                border: '1px solid var(--card-border)',
                                borderRadius: '0.5rem',
                                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.12)',
                                color: 'var(--text-primary)',
                                fontSize: '0.8125rem',
                                padding: '0.55rem 0.75rem'
                            }}
                            itemStyle={{ color: 'var(--text-primary)' }}
                            labelStyle={{ color: 'var(--text-secondary)', marginBottom: '0.25rem' }}
                        />
                        {chartMode === 'value' ? (
                            <>
                                <Area
                                    type="monotone"
                                    dataKey="marketValue"
                                    name="marketValue"
                                    stroke="#3b82f6"
                                    strokeWidth={2}
                                    fillOpacity={1}
                                    fill="url(#colorValueUnified)"
                                />
                                {range !== '1D' && (
                                    <Area
                                        type="monotone"
                                        dataKey="invested"
                                        name="invested"
                                        stroke="#94a3b8"
                                        strokeWidth={1.5}
                                        strokeDasharray="5 5"
                                        fill="none"
                                    />
                                )}
                            </>
                        ) : (
                            <Area
                                type="monotone"
                                dataKey="value"
                                name="Time-Weighted Return"
                                stroke="url(#splitColor)"
                                strokeWidth={2}
                                fillOpacity={1}
                                fill="url(#splitColorFill)"
                            />
                        )}
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
