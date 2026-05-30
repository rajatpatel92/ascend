'use client';

import { useState, useEffect } from 'react';
import {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    AreaChart,
    Area
} from 'recharts';
import styles from './PortfolioChart.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import DateInput from './DateInput';

interface HistoryPoint {
    date: string;
    value: number;
    invested: number;
}

interface PortfolioChartProps {
    range: string;
    setRange: (range: string) => void;
    customStart: string;
    setCustomStart: (date: string) => void;
    customEnd: string;
    setCustomEnd: (date: string) => void;
    externalData?: HistoryPoint[]; // New prop for controlled mode
    filterInvestmentTypes?: string[];
    filterAccountTypes?: string[];
}

export const RANGES = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y', '10Y', 'ALL'];

export default function PortfolioChart({
    range,
    setRange,
    customStart,
    setCustomStart,
    customEnd,
    setCustomEnd,
    externalData,
    hideControls,
    filterInvestmentTypes,
    filterAccountTypes
}: PortfolioChartProps & { hideControls?: boolean }) {
    const [data, setData] = useState<HistoryPoint[]>([]);
    // Local state removed
    const [loading, setLoading] = useState(false);
    const { format, convert, currency } = useCurrency();
    const { formatDate } = useDate();

    // Use external data if provided, otherwise local state
    const displayData = externalData || data;

    useEffect(() => {
        // Skip fetch if external data is provided
        if (externalData) return;

        const fetchData = async () => {
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

                const res = await fetch(url);
                const json = await res.json();
                if (Array.isArray(json)) {
                    setData(json);
                }
            } catch (error) {
                console.error('Failed to fetch history', error);
            } finally {
                setLoading(false);
            }
        };

        if (range !== 'CUSTOM' || (customStart && customEnd)) {
            fetchData();
        }
    }, [range, customStart, customEnd, externalData, currency, filterInvestmentTypes, filterAccountTypes]);

    // Convert data to selected currency (only if not external, as external data is already converted)
    const chartData = displayData.map(point => ({
        ...point,
        // API returns data in the requested currency, so NO conversion needed.
        // We only use convert if we suspect the data is raw USD, but we fixed the API call.
        // To be safe: If externalData is passed, assume it's correct. 
        // If data comes from our API, it's already in 'currency'.
        value: point.value,
        invested: point.invested
    }));

    // Calculate Average Contribution
    let totalContribution = 0;
    let avgContribution = 0;
    let periodMonths = 0;

    if (chartData.length > 0) {
        const startPoint = chartData[0];
        const endPoint = chartData[chartData.length - 1];

        // Invested represents Cumulative Net Flow
        // For 'ALL', we want the total accumulated invested amount (End Value).
        // For specific ranges (e.g. 1Y), we want the delta (End - Start).
        if (range === 'ALL' || range === 'MAX') {
            totalContribution = endPoint.invested;
        } else {
            totalContribution = endPoint.invested - startPoint.invested;
        }

        const startDate = new Date(startPoint.date);
        const endDate = new Date(endPoint.date);

        // Calculate months difference
        const diffTime = Math.abs(endDate.getTime() - startDate.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        periodMonths = diffDays / 30.44; // Average days in month

        if (periodMonths >= 1) {
            avgContribution = totalContribution / periodMonths;
        }
    }

    const vals = chartData.map(d => d.value);
    const maxVal = vals.length > 0 ? Math.max(...vals) : 0;
    const minVal = vals.length > 0 ? Math.min(...vals) : 0;
    const rangeVal = maxVal - minVal;

    const formatYAxisTick = (value: number) => {
        // If range of movement is very small, increase precision
        if (rangeVal < 10) {
            if (value >= 1000000) return `${(value / 1000000).toFixed(4)}M`;
            if (value >= 1000) return `${(value / 1000).toFixed(3)}K`;
            return value.toFixed(2);
        }
        if (rangeVal < 100) {
            if (value >= 1000000) return `${(value / 1000000).toFixed(3)}M`;
            if (value >= 1000) return `${(value / 1000).toFixed(2)}K`;
            return value.toFixed(1);
        }
        if (rangeVal < 1000) {
            if (value >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
            if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
            return value.toFixed(0);
        }
        // Default compact formatting
        if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
        if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
        return String(value);
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h3>{range === 'ALL' ? 'Portfolio Evolution' : 'Portfolio Evolution'}</h3>
                    {chartData.length > 0 && (
                        <div className={styles.change} style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', fontWeight: 'normal' }}>
                            {periodMonths >= 1
                                ? `Contribution: ${format(totalContribution)} (${format(avgContribution)}/mo)`
                                : `Contribution: ${format(totalContribution)}`
                            }
                        </div>
                    )}
                </div>
                {!hideControls && (
                    <div className={styles.controls}>
                        <div className={styles.desktopControls}>
                            <div className={styles.ranges}>
                                {RANGES.map(r => (
                                    <button
                                        key={r}
                                        className={`${styles.rangeButton} ${range === r ? styles.active : ''}`}
                                        onClick={() => setRange(r)}
                                    >
                                        {r}
                                    </button>
                                ))}
                                <button
                                    className={`${styles.rangeButton} ${range === 'CUSTOM' ? styles.active : ''}`}
                                    onClick={() => setRange('CUSTOM')}
                                >
                                    Custom
                                </button>
                            </div>
                        </div>

                        <div className={styles.mobileControls}>
                            <select
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
                                    className={styles.dateInput}
                                />
                                <span className={styles.separator}>to</span>
                                <DateInput
                                    value={customEnd}
                                    onChange={setCustomEnd}
                                    className={styles.dateInput}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div className={styles.chartWrapper} style={{ position: 'relative' }}>
                {loading && <div className={styles.loading}>Loading...</div>}
                {!loading && chartData.length === 0 && (
                    <div style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: 'var(--text-secondary)',
                        zIndex: 10
                    }}>
                        Please add activity to see this list
                    </div>
                )}
                <ResponsiveContainer width="100%" height="100%" minHeight={300}>
                    <AreaChart data={chartData}>
                        <defs>
                            <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#2563eb" stopOpacity={0.1} />
                                <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" strokeOpacity={0.5} />
                        <XAxis
                            dataKey="date"
                            tickFormatter={(str) => {
                                const date = new Date(str);
                                return range === '1W' || range === '1M'
                                    ? formatDate(date).split(',')[0]
                                    : formatDate(date);
                            }}
                            stroke="#9ca3af"
                            fontSize={10}
                            tickMargin={5}
                            minTickGap={30}
                            tickLine={false}
                            axisLine={false}
                        />
                        <YAxis
                            tickFormatter={formatYAxisTick}
                            stroke="#9ca3af"
                            fontSize={10}
                            tickMargin={5}
                            domain={['auto', 'auto']}
                            axisLine={false}
                            width={45}
                        />
                        <Tooltip
                            formatter={(val: number) => [format(val), 'Value']}
                            labelFormatter={(label) => formatDate(label)}
                            contentStyle={{
                                backgroundColor: 'var(--card-bg)',
                                border: '1px solid var(--card-border)',
                                borderRadius: '0.5rem',
                                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                                color: 'var(--text-primary)',
                                fontSize: '0.8rem',
                                padding: '0.5rem'
                            }}
                            itemStyle={{ color: 'var(--text-primary)' }}
                            labelStyle={{ color: 'var(--text-secondary)' }}
                        />
                        <Area
                            type="monotone"
                            dataKey="value"
                            stroke="#2563eb"
                            strokeWidth={1.5}
                            fillOpacity={1}
                            fill="url(#colorValue)"
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
