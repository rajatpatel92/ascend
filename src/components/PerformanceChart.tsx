'use client';

import { useState, useEffect } from 'react';
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
import styles from './PortfolioChart.module.css'; // Reuse styles
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

const RANGES = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y', '10Y', 'ALL'];

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
    // Local state removed
    const [loading, setLoading] = useState(false);
    const { convert, currency } = useCurrency();
    const { formatDate } = useDate();

    useEffect(() => {
        const fetchData = async () => {
            const filterKey = `${(filterInvestmentTypes || []).sort().join('-')}_${(filterAccountTypes || []).sort().join('-')}`;
            const cacheKey = `portfolio-history-${range}-${currency}-${customStart}-${customEnd}-${filterKey}-v4`;

            // 1. Try cache first for instant load
            const cached = ClientCache.get<any[]>(cacheKey);
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

                const res = await fetch(url);
                const json = await res.json();
                if (Array.isArray(json)) {
                    setData(json);
                    // Update Cache
                    ClientCache.set(cacheKey, json);
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
    }, [range, customStart, customEnd, currency, filterInvestmentTypes, filterAccountTypes]);

    // Calculate Average Invested Capital for the period
    const totalInvested = data.reduce((sum, point) => sum + point.invested, 0);
    const avgInvested = data.length > 0 ? totalInvested / data.length : 0;

    // Calculate Return % for each point based on NAV (Time-Weighted)
    const chartData = data.map(point => {
        // Values are already in the requested currency from the API
        const value = point.value;
        const invested = point.invested;

        let returnPercent = 0;

        if (point.nav !== undefined) {
            // New NAV Logic
            // Return % for the period = ((Current NAV / Start NAV) - 1) * 100
            // Since data is already filtered to the range, start NAV is data[0].nav
            const startNav = data[0].nav || 100;
            if (startNav > 0) {
                returnPercent = ((point.nav / startNav) - 1) * 100;
            }
        } else {
            // Legacy Logic
            const profit = value - invested;
            const avgInv = avgInvested; // Use calculated avgInvested from above
            returnPercent = avgInv !== 0 ? (profit / avgInv) * 100 : 0;
        }

        return {
            date: point.date,
            dateNumber: new Date(point.date).getTime(),
            value: returnPercent,
            invested: invested,
            marketValue: value, // Pass USD Market Value for Tooltip
            dividend: point.dividend || 0
        };
    });

    // Calculate change in return (Last - First)
    let returnChange = 0;
    let valueChange = 0; // PnL Amount

    if (chartData.length > 0) {
        const firstPoint = chartData[0];
        const lastPoint = chartData[chartData.length - 1];

        // Override logic for 1D to match Dashboard summary exactly
        if (range === '1D' && overrideChange !== undefined && overrideChangePercent !== undefined) {
            valueChange = overrideChange;
            returnChange = overrideChangePercent;
        } else {
            // % Return Change based on our TMW/NAV calculation
            returnChange = lastPoint.value - firstPoint.value;

            // PnL Calculation: (Delta Market Value) - (Delta Invested)
            const startVal = firstPoint.marketValue || 0;
            const endVal = lastPoint.marketValue || 0;
            const startInv = firstPoint.invested || 0;
            const endInv = lastPoint.invested || 0;
            const startDiv = firstPoint.dividend || 0;
            const endDiv = lastPoint.dividend || 0;

            valueChange = (endVal - startVal) - (endInv - startInv) + (endDiv - startDiv);
        }
    }

    const isPositive = returnChange >= 0;

    const getRangeLabel = (r: string) => {
        switch (r) {
            case '1D': return '1-day';
            case '1W': return '1-week';
            case '1M': return '1-month';
            case '3M': return '3-months';
            case '6M': return '6-months';
            case '1Y': return '1-year';
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
    };

    // Calculate gradient offset
    const gradientOffset = () => {
        const dataMax = Math.max(...chartData.map((i) => i.value));
        const dataMin = Math.min(...chartData.map((i) => i.value));

        if (dataMax <= 0) {
            return 0;
        }
        if (dataMin >= 0) {
            return 1;
        }

        return dataMax / (dataMax - dataMin);
    };

    const off = gradientOffset();

    const formatYAxisTick = (val: number) => {
        const maxVal = chartData.length > 0 ? Math.max(...chartData.map(d => Math.abs(d.value))) : 0;
        if (maxVal < 0.1) {
            return `${val.toFixed(3)}%`;
        }
        if (maxVal < 1) {
            return `${val.toFixed(2)}%`;
        }
        if (maxVal < 10) {
            return `${val.toFixed(1)}%`;
        }
        return `${val.toFixed(0)}%`;
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div>
                    <h3>Portfolio Returns</h3>
                    {chartData.length > 0 && (
                        <div className={`${styles.change} ${isPositive ? styles.positive : styles.negative}`}>
                            <span style={{ marginRight: '10px', fontSize: '1.1em', color: 'var(--text-primary)' }}>
                                {valueChange > 0 ? '+' : ''}{new Intl.NumberFormat('en-US', { style: 'currency', currency: currency }).format(valueChange)}
                            </span>
                            {returnChange > 0 ? '+' : ''}{returnChange.toFixed(2)}% <span style={{ opacity: 0.8, fontWeight: 'bold' }}>({getRangeLabel(range)})</span>
                        </div>
                    )}
                </div>
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
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                        <defs>
                            <linearGradient id="splitColor" x1="0" y1="0" x2="0" y2="1">
                                <stop offset={off} stopColor="#10b981" stopOpacity={1} />
                                <stop offset={off} stopColor="#ef4444" stopOpacity={1} />
                            </linearGradient>
                            <linearGradient id="splitColorFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset={off} stopColor="#10b981" stopOpacity={0.1} />
                                <stop offset={off} stopColor="#ef4444" stopOpacity={0.1} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" strokeOpacity={0.5} />
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
                            width={45}
                            tickCount={4}
                            tickLine={false}
                            axisLine={false}
                        />
                        <Tooltip
                            formatter={(val: number) => [`${val.toFixed(2)}%`, 'Time-Weighted Return']}
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
                            stroke="url(#splitColor)"
                            strokeWidth={1.5}
                            fillOpacity={1}
                            fill="url(#splitColorFill)"
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
