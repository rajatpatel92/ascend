'use client';

import { useState, useMemo, useEffect } from 'react';
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Line
} from 'recharts';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import DateInput from './DateInput';
import styles from './PortfolioChart.module.css';

interface StockChartProps {
    data: Record<string, number>;
    currency: string;
    avgPriceHistory: Record<string, number>;
    symbol?: string;
}

const RANGES = ['1D', '1W', '1M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y', '10Y', 'ALL'];

function getRangeLabel(r: string): string {
    switch (r) {
        case '1D': return '1-day';
        case '1W': return '1-week';
        case '1M': return '1-month';
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

export default function StockChart({ data, currency: assetCurrency, avgPriceHistory, symbol }: StockChartProps) {
    const { format, convert } = useCurrency();
    const { formatDate } = useDate();
    const [range, setRange] = useState('1M');
    const [customStart, setCustomStart] = useState('');
    const [customEnd, setCustomEnd] = useState('');
    const [intradayData, setIntradayData] = useState<{ date: string; value: number }[]>([]);
    const [loadingIntraday, setLoadingIntraday] = useState(false);

    useEffect(() => {
        if (range === '1D' && symbol) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setLoadingIntraday(true);
            fetch(`/api/market-data/intraday?symbol=${encodeURIComponent(symbol)}`)
                .then(res => res.json())
                .then(resData => {
                    if (Array.isArray(resData)) {
                        setIntradayData(resData);
                    }
                })
                .catch(err => console.error('Failed to fetch intraday', err))
                .finally(() => setLoadingIntraday(false));
        }
    }, [range, symbol]);

    const allData = useMemo(() => {
        return Object.entries(data || {})
            .filter(([key, val]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && typeof val === 'number' && Number.isFinite(val))
            .map(([date, price]) => ({
                date,
                value: convert(price, assetCurrency),
                originalValue: price,
                avgPrice: avgPriceHistory && avgPriceHistory[date]
                    ? convert(avgPriceHistory[date], assetCurrency)
                    : null,
            }))
            .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }, [data, assetCurrency, convert, avgPriceHistory]);

    const chartData = useMemo(() => {
        if (allData.length === 0 && intradayData.length === 0) return [];

        const now = new Date();
        let startDate = new Date();

        if (range === 'CUSTOM') {
            if (!customStart || !customEnd) return allData;
            const start = new Date(customStart);
            const end = new Date(customEnd);
            return allData.filter(d => {
                const date = new Date(d.date);
                return date >= start && date <= end;
            });
        }

        switch (range) {
            case '1D':
                if (intradayData.length > 0) {
                    const sorted = [...intradayData].sort(
                        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
                    );
                    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
                    let sessionStartIdx = 0;
                    for (let i = 1; i < sorted.length; i++) {
                        const prevTs = new Date(sorted[i - 1].date).getTime();
                        const currTs = new Date(sorted[i].date).getTime();
                        if (currTs - prevTs > FOUR_HOURS_MS) {
                            sessionStartIdx = i;
                        }
                    }
                    const latestTs = new Date(sorted[sorted.length - 1].date).getTime();
                    const rollingCutoff = latestTs - (24 * 60 * 60 * 1000);
                    const sessionPoints = sorted
                        .slice(sessionStartIdx)
                        .filter(d => new Date(d.date).getTime() >= rollingCutoff);

                    return sessionPoints.map(d => ({
                        date: d.date,
                        value: convert(d.value, assetCurrency),
                        originalValue: d.value,
                        avgPrice: null as number | null,
                    }));
                }
                if (allData.length >= 2) {
                    return allData.slice(-2);
                }
                return allData.slice(-1);
            case '1W': startDate.setDate(now.getDate() - 7); break;
            case '1M': startDate.setMonth(now.getMonth() - 1); break;
            case '6M': startDate.setMonth(now.getMonth() - 6); break;
            case 'YTD': startDate = new Date(now.getFullYear(), 0, 1); break;
            case '1Y': startDate.setFullYear(now.getFullYear() - 1); break;
            case '2Y': startDate.setFullYear(now.getFullYear() - 2); break;
            case '3Y': startDate.setFullYear(now.getFullYear() - 3); break;
            case '5Y': startDate.setFullYear(now.getFullYear() - 5); break;
            case '10Y': startDate.setFullYear(now.getFullYear() - 10); break;
            case 'ALL': return allData;
            default: return allData;
        }

        return allData.filter(d => new Date(d.date) >= startDate);
    }, [allData, range, customStart, customEnd, intradayData, convert, assetCurrency]);

    const { change, changePercent, minPrice, maxPrice, hasAvgCost, latestAvgPrice } = useMemo(() => {
        if (chartData.length === 0) {
            return {
                change: 0,
                changePercent: 0,
                minPrice: 0,
                maxPrice: 0,
                hasAvgCost: false,
                latestAvgPrice: null as number | null,
            };
        }
        const first = chartData[0].value;
        const last = chartData[chartData.length - 1].value;
        const diff = last - first;
        const pct = first !== 0 ? (diff / first) * 100 : 0;

        let minV = Infinity;
        let maxV = -Infinity;
        let avgFound = false;
        let lastAvg: number | null = null;

        for (const pt of chartData) {
            if (pt.value < minV) minV = pt.value;
            if (pt.value > maxV) maxV = pt.value;
            if (pt.avgPrice !== null && pt.avgPrice > 0) {
                avgFound = true;
                lastAvg = pt.avgPrice;
            }
        }

        return {
            change: diff,
            changePercent: pct,
            minPrice: Number.isFinite(minV) ? minV : 0,
            maxPrice: Number.isFinite(maxV) ? maxV : 0,
            hasAvgCost: avgFound,
            latestAvgPrice: lastAvg,
        };
    }, [chartData]);

    const isPositive = change >= 0;

    return (
        <div className={styles.unifiedContainer}>
            <div className={styles.unifiedHeader}>
                <div className={styles.headerTopRow}>
                    <div className={styles.headerTitleArea}>
                        <div className={styles.modeTablist}>
                            <span
                                className={styles.modeTab}
                                aria-selected="true"
                                style={{ cursor: 'default' }}
                            >
                                Price &amp; Cost Basis History
                            </span>
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
                                value={range}
                                onChange={(e) => setRange(e.target.value)}
                                className={styles.mobileSelect}
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
                                <span className={styles.metricChipLabel}>Period Change</span>
                                <span className={styles.metricChipValue}>
                                    {change > 0 ? '+' : ''}{format(change)}
                                </span>
                                <span className={`${styles.metricPill} ${isPositive ? styles.metricPillPos : styles.metricPillNeg}`}>
                                    {changePercent > 0 ? '+' : ''}{changePercent.toFixed(2)}% ({getRangeLabel(range)})
                                </span>
                            </div>

                            <div className={styles.metricChip}>
                                <span className={styles.metricChipLabel}>Range Low / High</span>
                                <span className={styles.metricChipValue}>
                                    {format(minPrice)} – {format(maxPrice)}
                                </span>
                            </div>

                            {hasAvgCost && latestAvgPrice !== null && (
                                <div className={styles.metricChip}>
                                    <span className={styles.metricChipLabel}>Avg Cost</span>
                                    <span className={styles.metricChipValue}>
                                        {format(latestAvgPrice)}
                                    </span>
                                </div>
                            )}
                        </div>

                        <div className={styles.chartLegend}>
                            <span className={styles.legendItem}>
                                <span className={styles.legendLinePrimary} />
                                Market Price
                            </span>
                            {hasAvgCost && (
                                <span className={styles.legendItem}>
                                    <span
                                        style={{
                                            width: '14px',
                                            height: '2.5px',
                                            background: '#f59e0b',
                                            borderRadius: '9999px',
                                            display: 'inline-block',
                                        }}
                                    />
                                    Avg Cost Basis
                                </span>
                            )}
                        </div>
                    </div>
                )}
            </div>

            <div className={styles.chartWrapper} style={{ position: 'relative' }}>
                {loadingIntraday && <div className={styles.loading}>Loading intraday data...</div>}
                {!loadingIntraday && chartData.length === 0 && (
                    <div className={styles.emptyOverlay}>
                        No historical price data available for this range
                    </div>
                )}
                {chartData.length > 0 && (
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                            <defs>
                                <linearGradient id="stockPriceGradient" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.22} />
                                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                            <XAxis
                                dataKey="date"
                                tickFormatter={(str) => {
                                    const date = new Date(str);
                                    if (range === '1D') {
                                        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
                                tickFormatter={(val) => format(val)}
                                stroke="var(--text-secondary)"
                                fontSize={11}
                                tickMargin={6}
                                domain={['auto', 'auto']}
                                width={76}
                                tickLine={false}
                                axisLine={false}
                            />
                            <Tooltip
                                formatter={(val: number, name: string) => {
                                    if (name === 'avgPrice') return [format(val), 'Avg Cost Basis'];
                                    return [format(val), 'Market Price'];
                                }}
                                labelFormatter={(label) => {
                                    const d = new Date(label);
                                    if (range === '1D') {
                                        return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
                                    }
                                    return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                                }}
                                contentStyle={{
                                    backgroundColor: 'var(--card-bg)',
                                    border: '1px solid var(--card-border)',
                                    borderRadius: '0.625rem',
                                    boxShadow: '0 8px 16px -4px rgba(0, 0, 0, 0.14)',
                                    color: 'var(--text-primary)',
                                    fontSize: '0.8125rem',
                                }}
                                itemStyle={{ color: 'var(--text-primary)', fontWeight: 600 }}
                                labelStyle={{ color: 'var(--text-secondary)', marginBottom: '0.25rem' }}
                            />

                            <Area
                                type="monotone"
                                dataKey="value"
                                stroke="#3b82f6"
                                strokeWidth={2.25}
                                fillOpacity={1}
                                fill="url(#stockPriceGradient)"
                                name="Price"
                            />

                            {hasAvgCost && (
                                <Line
                                    type="stepAfter"
                                    dataKey="avgPrice"
                                    stroke="#f59e0b"
                                    strokeWidth={2}
                                    dot={false}
                                    name="avgPrice"
                                />
                            )}
                        </AreaChart>
                    </ResponsiveContainer>
                )}
            </div>
        </div>
    );
}
