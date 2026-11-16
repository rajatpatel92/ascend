'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import {
    ResponsiveContainer,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ReferenceLine
} from 'recharts';
import { ClientCache } from '@/lib/client-cache';
import { parseLocalDate } from '@/lib/date-utils';
import ReportFilters, { FilterOptions } from '@/components/ReportFilters';
import usePersistentState from '@/hooks/usePersistentState';
import { useLiveSync } from '@/hooks/useLiveSync';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import styles from './page.module.css';

interface PortfolioPoint {
    date: string;
    nav: number;
    marketValue?: number;
    netFlow?: number;
}

interface BenchmarkPoint {
    date: string;
    value: number;
    normalized: number;
}

interface PerformerItem {
    symbol: string;
    contribution?: number;
    assetReturn?: number;
    profit?: number;
    isExited?: boolean;
    return: number;
}

interface BenchmarkOption {
    symbol: string;
    name: string;
}

interface ComparisonApiResponse {
    portfolio?: PortfolioPoint[];
    benchmark?: BenchmarkPoint[];
    summary?: { portfolioReturn: number; benchmarkReturn: number };
    performers?: { top: PerformerItem[]; bottom: PerformerItem[] };
}

type ChartMode = 'cumulative' | 'growth10k' | 'spread';
type AttributionTab = 'top' | 'bottom';

const RANGES = ['1M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y', 'ALL'];
const ANALYTICS_CACHE_TTL_MS = 60 * 60 * 1000;

const CHART_TABS: { id: ChartMode; label: string }[] = [
    { id: 'cumulative', label: 'Cumulative Return (%)' },
    { id: 'growth10k', label: 'Growth of 10,000' },
    { id: 'spread', label: 'Alpha Spread (%)' }
];

const ATTRIBUTION_TABS: { id: AttributionTab; label: string }[] = [
    { id: 'top', label: 'Top Leaders' },
    { id: 'bottom', label: 'Bottom Laggards' }
];

function parseDateLocalNoon(dateStr: string): number {
    return parseLocalDate(dateStr).getTime();
}

function computeMaxDrawdown(values: number[]): number {
    let peak = -Infinity;
    let maxDd = 0;
    for (const val of values) {
        if (!Number.isFinite(val) || val < 0) continue;
        if (val === 0 && peak <= 0) continue;
        if (val > peak) peak = val;
        if (peak > 0) {
            const dd = ((val - peak) / peak) * 100;
            if (dd < maxDd) maxDd = dd;
        }
    }
    return maxDd;
}

export default function ComparePage() {
    const [isLoading, setIsLoading] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [portfolioData, setPortfolioData] = useState<PortfolioPoint[]>([]);
    const [benchmarkData, setBenchmarkData] = useState<BenchmarkPoint[]>([]);

    const [summary, setSummary] = useState({ portfolioReturn: 0, benchmarkReturn: 0 });
    const [performers, setPerformers] = useState<{ top: PerformerItem[]; bottom: PerformerItem[] }>({
        top: [],
        bottom: []
    });
    const [availableBenchmarks, setAvailableBenchmarks] = useState<BenchmarkOption[]>([]);

    const [timeRange, setTimeRange] = usePersistentState('comparison_range', '1Y');
    const [benchmark, setBenchmark] = usePersistentState('comparison_benchmark', '^GSPC');
    const [filters, setFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('comparison_filters', null);
    const [syncTick, setSyncTick] = useState(0);
    const loadedViewKeyRef = useRef<string | null>(null);

    const [chartMode, setChartMode] = useState<ChartMode>('cumulative');
    const [attributionTab, setAttributionTab] = useState<AttributionTab>('top');
    const chartTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const attrTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const { currency, format } = useCurrency();
    const { formatDate } = useDate();

    useLiveSync({
        enabled: isFiltersLoaded,
        onSync: () => setSyncTick((t) => t + 1),
    });

    useEffect(() => {
        const controller = new AbortController();
        fetch('/api/benchmarks', { signal: controller.signal, cache: 'no-store' })
            .then(res => (res.ok ? res.json() : []))
            .then(data => {
                if (!controller.signal.aborted && Array.isArray(data)) {
                    setAvailableBenchmarks(data);
                }
            })
            .catch(err => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to load benchmarks', err);
            });
        return () => controller.abort();
    }, [syncTick]);

    useEffect(() => {
        if (!isFiltersLoaded) return;

        const controller = new AbortController();
        const safeFilters: FilterOptions = filters || { accountTypes: [], investmentTypes: [] };

        const fetchData = async () => {
            const filterHash = JSON.stringify({
                accountTypes: [...(safeFilters.accountTypes || [])].sort(),
                investmentTypes: [...(safeFilters.investmentTypes || [])].sort()
            });
            const cacheKey = `comparison-${timeRange}-${benchmark}-${currency}-${filterHash}-v3`;
            const isBackground = loadedViewKeyRef.current === cacheKey;

            const cached = ClientCache.get<ComparisonApiResponse>(cacheKey, { ttlMs: ANALYTICS_CACHE_TTL_MS });
            if (cached && cached.portfolio) {
                setPortfolioData(cached.portfolio);
                setBenchmarkData(cached.benchmark || []);
                if (cached.summary) setSummary(cached.summary);
                if (cached.performers) setPerformers(cached.performers);
            }

            if (!isBackground) {
                setIsLoading(true);
            }
            setFetchError(null);
            try {
                const res = await fetch('/api/analytics/benchmark', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        timeRange,
                        benchmarkSymbol: benchmark,
                        currency,
                        filters: safeFilters
                    }),
                    signal: controller.signal,
                    cache: 'no-store',
                });

                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }

                const data = await res.json();
                if (controller.signal.aborted) return;

                if (data.portfolio) {
                    loadedViewKeyRef.current = cacheKey;
                    setPortfolioData(data.portfolio);
                    setBenchmarkData(data.benchmark || []);
                    if (data.summary) setSummary(data.summary);
                    if (data.performers) setPerformers(data.performers);
                    ClientCache.set(cacheKey, data);
                }
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to fetch comparison analytics:', err);
                if (!isBackground) {
                    setFetchError('Unable to load comparison data for the selected criteria.');
                }
            } finally {
                if (!controller.signal.aborted) {
                    setIsLoading(false);
                }
            }
        };

        void fetchData();
        return () => controller.abort();
    }, [timeRange, benchmark, currency, filters, isFiltersLoaded, syncTick]);

    const benchmarkName = useMemo(() => {
        return availableBenchmarks.find(b => b.symbol === benchmark)?.name || benchmark;
    }, [availableBenchmarks, benchmark]);

    const {
        chartData,
        netAlpha,
        alphaBps,
        winRatePct,
        portfolioMaxDrawdown,
        benchmarkMaxDrawdown,
        portfolioEnd10k,
        benchmarkEnd10k,
        spreadGradientOffset
    } = useMemo(() => {
        const startNav = portfolioData.length > 0 && portfolioData[0].nav > 0 ? portfolioData[0].nav : 1;
        const startBench = benchmarkData.length > 0 && benchmarkData[0].normalized > 0 ? benchmarkData[0].normalized : 1;

        const benchByDate = new Map<string, BenchmarkPoint>();
        benchmarkData.forEach(b => benchByDate.set(b.date, b));

        let lastBenchNorm = startBench;
        const aligned = portfolioData.map(d => {
            const match = benchByDate.get(d.date);
            if (match && Number.isFinite(match.normalized) && match.normalized > 0) {
                lastBenchNorm = match.normalized;
            }
            const portfolioPct = ((d.nav - startNav) / startNav) * 100;
            const benchmarkPct = ((lastBenchNorm - startBench) / startBench) * 100;
            const alphaSpread = portfolioPct - benchmarkPct;

            return {
                date: d.date,
                dateNumber: parseDateLocalNoon(d.date),
                portfolioPct,
                benchmarkPct,
                alphaSpread,
                portfolio10k: 10000 * (1 + portfolioPct / 100),
                benchmark10k: 10000 * (1 + benchmarkPct / 100)
            };
        });

        const portRet = Number.isFinite(summary.portfolioReturn) ? summary.portfolioReturn : 0;
        const benchRet = Number.isFinite(summary.benchmarkReturn) ? summary.benchmarkReturn : 0;
        const alpha = portRet - benchRet;
        const bps = Math.round(alpha * 100);

        const trailingPoints = aligned.slice(1);
        const leadingCount = trailingPoints.filter(p => p.portfolioPct >= p.benchmarkPct).length;
        const winRate = trailingPoints.length > 0 ? (leadingCount / trailingPoints.length) * 100 : 0;

        const portDd = computeMaxDrawdown(portfolioData.map(p => p.nav));
        const benchDd = computeMaxDrawdown(benchmarkData.map(b => b.normalized));

        const end10kPort = 10000 * (1 + portRet / 100);
        const end10kBench = 10000 * (1 + benchRet / 100);

        let spreadOff = 0.5;
        if (aligned.length > 0) {
            const spreads = aligned.map(p => p.alphaSpread);
            const maxS = Math.max(...spreads);
            const minS = Math.min(...spreads);
            if (minS >= 0) spreadOff = 1;
            else if (maxS <= 0) spreadOff = 0;
            else spreadOff = maxS / (maxS - minS);
        }

        return {
            chartData: aligned,
            netAlpha: alpha,
            alphaBps: bps,
            winRatePct: winRate,
            portfolioMaxDrawdown: portDd,
            benchmarkMaxDrawdown: benchDd,
            portfolioEnd10k: end10kPort,
            benchmarkEnd10k: end10kBench,
            spreadGradientOffset: spreadOff
        };
    }, [portfolioData, benchmarkData, summary]);

    const formatPct = (val: number) => {
        if (!Number.isFinite(val)) return '0.00%';
        return `${val > 0 ? '+' : ''}${val.toFixed(2)}%`;
    };
    const safePortfolioReturn = Number.isFinite(summary.portfolioReturn) ? summary.portfolioReturn : 0;
    const safeBenchmarkReturn = Number.isFinite(summary.benchmarkReturn) ? summary.benchmarkReturn : 0;

    const handleTabKeyDown = <T extends string>(
        e: React.KeyboardEvent<HTMLDivElement>,
        tabs: { id: T }[],
        current: T,
        setTab: (val: T) => void,
        refs: React.MutableRefObject<Array<HTMLButtonElement | null>>
    ) => {
        const currentIndex = tabs.findIndex(t => t.id === current);
        if (currentIndex === -1) return;

        let nextIndex: number | null = null;
        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = tabs.length - 1;

        if (nextIndex !== null) {
            e.preventDefault();
            setTab(tabs[nextIndex].id);
            refs.current[nextIndex]?.focus();
        }
    };

    const resilienceDelta = Math.abs(benchmarkMaxDrawdown) - Math.abs(portfolioMaxDrawdown);
    const maxDrawdownScale = Math.max(Math.abs(portfolioMaxDrawdown), Math.abs(benchmarkMaxDrawdown), 1);
    const activePerformers = attributionTab === 'top' ? performers.top : performers.bottom;
    const maxAbsPerformer = Math.max(...activePerformers.map(p => Math.abs(p.contribution ?? p.return)), 0.01);

    const formatProfit = (val: number) => {
        if (!Number.isFinite(val)) return format(0, { maximumFractionDigits: 0 });
        const absFormatted = format(Math.abs(val), { maximumFractionDigits: 0 });
        if (val > 0.5) return `+${absFormatted}`;
        if (val < -0.5) return `-${absFormatted}`;
        return absFormatted;
    };

    const isOutperforming = netAlpha >= 0;

    return (
        <div className={styles.container}>
            {/* Header */}
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Benchmark Comparison</h1>
                    <p className={styles.subtitle}>
                        Evaluate time-weighted portfolio performance, alpha generation, and drawdown resilience against market indices.
                    </p>
                </div>

                <div className={styles.controls}>
                    <div className={styles.selectWrap}>
                        <label htmlFor="benchmark-select" className={styles.srOnly}>
                            Select benchmark index
                        </label>
                        <select
                            id="benchmark-select"
                            className={styles.select}
                            value={benchmark}
                            onChange={(e) => setBenchmark(e.target.value)}
                        >
                            {availableBenchmarks.length === 0 && (
                                <option value={benchmark}>{benchmark}</option>
                            )}
                            {availableBenchmarks.map(b => (
                                <option key={b.symbol} value={b.symbol}>{b.name}</option>
                            ))}
                        </select>
                    </div>

                    {isFiltersLoaded && (
                        <ReportFilters onChange={setFilters} initialFilters={filters || undefined} />
                    )}
                </div>
            </header>

            {fetchError && (
                <div role="alert" className={styles.errorBanner}>
                    {fetchError}
                </div>
            )}

            <div className={styles.pageGrid}>
                {/* Tier 1: Executive Alpha & Benchmark KPI Strip */}
                <section className={styles.kpiStrip} aria-label="Benchmark performance summary">
                    {/* Card 1: Hero Net Alpha Card */}
                    <div className={styles.heroCard}>
                        <div className={styles.heroTop}>
                            <span className={styles.heroLabel}>Net Alpha vs. {benchmarkName}</span>
                            <div className={styles.heroValue}>{formatPct(netAlpha)}</div>
                            <span className={styles.heroPill}>
                                <span aria-hidden="true">{isOutperforming ? '▲' : '▼'}</span>
                                <span>{isOutperforming ? 'Outperforming Index' : 'Trailing Index'}</span>
                            </span>
                        </div>
                        <div className={styles.heroFooter}>
                            <span>{timeRange} Spread: <strong>{alphaBps >= 0 ? '+' : ''}{alphaBps} bps</strong></span>
                            <span>Leading Index: <strong>{winRatePct.toFixed(0)}%</strong> of days</span>
                        </div>
                    </div>

                    {/* Card 2: Portfolio Return TWR */}
                    <div className={styles.kpiCard}>
                        <div className={styles.kpiHeader}>
                            <span className={styles.kpiLabel}>Portfolio Return (TWR)</span>
                            <span className={styles.kpiTag}>My Portfolio</span>
                        </div>
                        <div className={`${styles.kpiValue} ${safePortfolioReturn >= 0 ? styles.positiveText : styles.negativeText}`}>
                            {formatPct(safePortfolioReturn)}
                        </div>
                        <div className={styles.kpiFooter}>
                            <span className={styles.kpiSubtext}>
                                Growth of {format(10000, { maximumFractionDigits: 0 })} &rarr; <strong>{format(portfolioEnd10k, { maximumFractionDigits: 0 })}</strong>
                            </span>
                        </div>
                    </div>

                    {/* Card 3: Benchmark Return */}
                    <div className={styles.kpiCard}>
                        <div className={styles.kpiHeader}>
                            <span className={styles.kpiLabel}>Benchmark Return</span>
                            <span className={styles.benchmarkBadge}>{benchmark}</span>
                        </div>
                        <div className={`${styles.kpiValue} ${styles.amberText}`}>
                            {formatPct(safeBenchmarkReturn)}
                        </div>
                        <div className={styles.kpiFooter}>
                            <span className={styles.kpiSubtext}>
                                Growth of {format(10000, { maximumFractionDigits: 0 })} &rarr; <strong>{format(benchmarkEnd10k, { maximumFractionDigits: 0 })}</strong>
                            </span>
                        </div>
                    </div>

                    {/* Card 4: Max Drawdown & Risk Resilience */}
                    <div className={styles.kpiCard}>
                        <div className={styles.kpiHeader}>
                            <span className={styles.kpiLabel}>Max Drawdown</span>
                            <span className={`${styles.statusBadge} ${resilienceDelta >= 0 ? styles.statusPos : styles.statusNeg}`}>
                                {resilienceDelta >= 0 ? 'Lower Risk' : 'Higher Volatility'}
                            </span>
                        </div>
                        <div className={styles.drawdownReadout}>
                            <span className={styles.drawdownPort}>{portfolioMaxDrawdown.toFixed(1)}%</span>
                            <span className={styles.drawdownVs}>vs</span>
                            <span className={styles.drawdownBench}>{benchmarkMaxDrawdown.toFixed(1)}%</span>
                        </div>
                        <div className={styles.drawdownBars} aria-hidden="true">
                            <div className={styles.ddBarRow}>
                                <span className={styles.ddBarLabel}>Port</span>
                                <div className={styles.ddTrack}>
                                    <div
                                        className={styles.ddFillPort}
                                        style={{ width: `${Math.min(100, (Math.abs(portfolioMaxDrawdown) / maxDrawdownScale) * 100)}%` }}
                                    />
                                </div>
                            </div>
                            <div className={styles.ddBarRow}>
                                <span className={styles.ddBarLabel}>Idx</span>
                                <div className={styles.ddTrack}>
                                    <div
                                        className={styles.ddFillBench}
                                        style={{ width: `${Math.min(100, (Math.abs(benchmarkMaxDrawdown) / maxDrawdownScale) * 100)}%` }}
                                    />
                                </div>
                            </div>
                        </div>
                        <div className={styles.kpiFooter}>
                            <span className={styles.kpiSubtext}>
                                {resilienceDelta >= 0
                                    ? `${resilienceDelta.toFixed(1)}% smaller peak-to-trough drop`
                                    : `${Math.abs(resilienceDelta).toFixed(1)}% deeper peak-to-trough drop`}
                            </span>
                        </div>
                    </div>
                </section>

                {/* Tier 2: Main Comparison Workspace */}
                <section className={styles.workspaceGrid} aria-label="Comparison chart and asset attribution">
                    {/* Left: Interactive 3-Tab Recharts Comparison Card */}
                    <div className={styles.chartCard}>
                        <div className={styles.chartHeader}>
                            <div className={styles.tablistWrap}>
                                <div
                                    role="tablist"
                                    aria-label="Comparison chart view"
                                    className={styles.tablist}
                                    onKeyDown={(e) => handleTabKeyDown(e, CHART_TABS, chartMode, setChartMode, chartTabRefs)}
                                >
                                    {CHART_TABS.map((tab, idx) => {
                                        const selected = chartMode === tab.id;
                                        return (
                                            <button
                                                key={tab.id}
                                                ref={el => { chartTabRefs.current[idx] = el; }}
                                                type="button"
                                                role="tab"
                                                id={`cmp-tab-${tab.id}`}
                                                aria-selected={selected}
                                                tabIndex={selected ? 0 : -1}
                                                className={styles.tabBtn}
                                                onClick={() => setChartMode(tab.id)}
                                            >
                                                {tab.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className={styles.rangeControls}>
                                <div className={styles.desktopRanges} role="group" aria-label="Comparison timeframe">
                                    {RANGES.map(r => (
                                        <button
                                            key={r}
                                            type="button"
                                            aria-pressed={timeRange === r}
                                            className={`${styles.rangeBtn} ${timeRange === r ? styles.rangeBtnActive : ''}`}
                                            onClick={() => setTimeRange(r)}
                                        >
                                            {r}
                                        </button>
                                    ))}
                                </div>
                                <div className={styles.mobileRanges}>
                                    <select
                                        aria-label="Comparison timeframe"
                                        className={styles.mobileSelect}
                                        value={timeRange}
                                        onChange={(e) => setTimeRange(e.target.value)}
                                    >
                                        {RANGES.map(r => (
                                            <option key={r} value={r}>{r === 'ALL' ? 'All Time' : r}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div className={styles.legendStrip}>
                            {chartMode === 'spread' ? (
                                <span className={styles.legendItem}>
                                    <span className={styles.legendSwatchEmerald} aria-hidden="true" />
                                    Alpha Spread (Portfolio &minus; {benchmarkName}): <strong>{formatPct(netAlpha)}</strong>
                                </span>
                            ) : (
                                <>
                                    <span className={styles.legendItem}>
                                        <span className={styles.legendSwatchEmerald} aria-hidden="true" />
                                        My Portfolio ({formatPct(safePortfolioReturn)})
                                    </span>
                                    <span className={styles.legendItem}>
                                        <span className={styles.legendSwatchAmber} aria-hidden="true" />
                                        {benchmarkName} ({formatPct(safeBenchmarkReturn)})
                                    </span>
                                </>
                            )}
                        </div>

                        <div
                            role="tabpanel"
                            aria-labelledby={`cmp-tab-${chartMode}`}
                            tabIndex={0}
                            className={styles.chartWrapper}
                        >
                            {isLoading && <div className={styles.loadingOverlay}>Calculating performance...</div>}
                            {!isLoading && chartData.length === 0 && (
                                <div className={styles.emptyChart}>No comparison data available for the selected range</div>
                            )}

                            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                                {chartMode === 'spread' ? (
                                    <AreaChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: 4 }}>
                                        <defs>
                                            <linearGradient id="alphaSpreadStroke" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset={spreadGradientOffset} stopColor="#10b981" stopOpacity={1} />
                                                <stop offset={spreadGradientOffset} stopColor="#ef4444" stopOpacity={1} />
                                            </linearGradient>
                                            <linearGradient id="alphaSpreadFill" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset={spreadGradientOffset} stopColor="#10b981" stopOpacity={0.22} />
                                                <stop offset={spreadGradientOffset} stopColor="#ef4444" stopOpacity={0.22} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                                        <XAxis
                                            dataKey="dateNumber"
                                            type="number"
                                            domain={['dataMin', 'dataMax']}
                                            tickFormatter={(ts) => formatDate(new Date(ts))}
                                            stroke="var(--text-secondary)"
                                            fontSize={11}
                                            minTickGap={38}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            tickFormatter={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                                            stroke="var(--text-secondary)"
                                            fontSize={11}
                                            width={58}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <ReferenceLine y={0} stroke="var(--text-secondary)" strokeDasharray="4 4" strokeOpacity={0.6} />
                                        <Tooltip
                                            content={({ active, payload }) => {
                                                if (!active || !payload || !payload.length) return null;
                                                const pt = payload[0].payload;
                                                return (
                                                    <div className={styles.tooltipBox}>
                                                        <div className={styles.tooltipDate}>{formatDate(pt.date)}</div>
                                                        <div className={styles.tooltipRow}>
                                                            <span>My Portfolio</span>
                                                            <strong className={styles.positiveText}>{formatPct(pt.portfolioPct)}</strong>
                                                        </div>
                                                        <div className={styles.tooltipRow}>
                                                            <span>{benchmarkName}</span>
                                                            <strong className={styles.amberText}>{formatPct(pt.benchmarkPct)}</strong>
                                                        </div>
                                                        <div className={`${styles.tooltipRow} ${styles.tooltipDivider}`}>
                                                            <span>Alpha Spread</span>
                                                            <strong className={pt.alphaSpread >= 0 ? styles.positiveText : styles.negativeText}>
                                                                {formatPct(pt.alphaSpread)}
                                                            </strong>
                                                        </div>
                                                    </div>
                                                );
                                            }}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="alphaSpread"
                                            name="Alpha Spread"
                                            stroke="url(#alphaSpreadStroke)"
                                            strokeWidth={2.25}
                                            fill="url(#alphaSpreadFill)"
                                            dot={false}
                                        />
                                    </AreaChart>
                                ) : (
                                    <AreaChart data={chartData} margin={{ top: 10, right: 12, bottom: 0, left: 4 }}>
                                        <defs>
                                            <linearGradient id="portfolioCompareFill" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#10b981" stopOpacity={0.22} />
                                                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--card-border)" strokeOpacity={0.7} />
                                        <XAxis
                                            dataKey="dateNumber"
                                            type="number"
                                            domain={['dataMin', 'dataMax']}
                                            tickFormatter={(ts) => formatDate(new Date(ts))}
                                            stroke="var(--text-secondary)"
                                            fontSize={11}
                                            minTickGap={38}
                                            tickLine={false}
                                            axisLine={false}
                                        />
                                        <YAxis
                                            tickFormatter={(v) =>
                                                chartMode === 'growth10k'
                                                    ? format(v, { notation: 'compact', maximumFractionDigits: 1 })
                                                    : `${v > 0 ? '+' : ''}${v.toFixed(0)}%`
                                            }
                                            stroke="var(--text-secondary)"
                                            fontSize={11}
                                            width={62}
                                            tickLine={false}
                                            axisLine={false}
                                            domain={['auto', 'auto']}
                                        />
                                        {chartMode === 'cumulative' && (
                                            <ReferenceLine y={0} stroke="var(--text-secondary)" strokeDasharray="3 3" strokeOpacity={0.5} />
                                        )}
                                        <Tooltip
                                            content={({ active, payload }) => {
                                                if (!active || !payload || !payload.length) return null;
                                                const pt = payload[0].payload;
                                                return (
                                                    <div className={styles.tooltipBox}>
                                                        <div className={styles.tooltipDate}>{formatDate(pt.date)}</div>
                                                        <div className={styles.tooltipRow}>
                                                            <span>My Portfolio</span>
                                                            <strong className={styles.positiveText}>
                                                                {chartMode === 'growth10k'
                                                                    ? format(pt.portfolio10k, { maximumFractionDigits: 0 })
                                                                    : formatPct(pt.portfolioPct)}
                                                            </strong>
                                                        </div>
                                                        <div className={styles.tooltipRow}>
                                                            <span>{benchmarkName}</span>
                                                            <strong className={styles.amberText}>
                                                                {chartMode === 'growth10k'
                                                                    ? format(pt.benchmark10k, { maximumFractionDigits: 0 })
                                                                    : formatPct(pt.benchmarkPct)}
                                                            </strong>
                                                        </div>
                                                        <div className={`${styles.tooltipRow} ${styles.tooltipDivider}`}>
                                                            <span>Alpha Spread</span>
                                                            <strong className={pt.alphaSpread >= 0 ? styles.positiveText : styles.negativeText}>
                                                                {formatPct(pt.alphaSpread)}
                                                            </strong>
                                                        </div>
                                                    </div>
                                                );
                                            }}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey={chartMode === 'growth10k' ? 'portfolio10k' : 'portfolioPct'}
                                            name="My Portfolio"
                                            stroke="#10b981"
                                            strokeWidth={2.5}
                                            fill="url(#portfolioCompareFill)"
                                            dot={false}
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey={chartMode === 'growth10k' ? 'benchmark10k' : 'benchmarkPct'}
                                            name={benchmarkName}
                                            stroke="#f59e0b"
                                            strokeWidth={2}
                                            fill="transparent"
                                            dot={false}
                                        />
                                    </AreaChart>
                                )}
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Right: Tabbed Performance Attribution Card */}
                    <aside className={styles.attrCard} aria-label="Performance attribution">
                        <div className={styles.attrHeader}>
                            <h2 className={styles.attrTitle}>Performance Attribution</h2>
                            <div
                                role="tablist"
                                aria-label="Attribution ranking"
                                className={styles.attrTablist}
                                onKeyDown={(e) => handleTabKeyDown(e, ATTRIBUTION_TABS, attributionTab, setAttributionTab, attrTabRefs)}
                            >
                                {ATTRIBUTION_TABS.map((tab, idx) => {
                                    const selected = attributionTab === tab.id;
                                    return (
                                        <button
                                            key={tab.id}
                                            ref={el => { attrTabRefs.current[idx] = el; }}
                                            type="button"
                                            role="tab"
                                            id={`attr-tab-${tab.id}`}
                                            aria-selected={selected}
                                            tabIndex={selected ? 0 : -1}
                                            className={styles.tabBtn}
                                            onClick={() => setAttributionTab(tab.id)}
                                        >
                                            {tab.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div
                            role="tabpanel"
                            aria-labelledby={`attr-tab-${attributionTab}`}
                            tabIndex={activePerformers.length === 0 ? 0 : undefined}
                            className={styles.attrPanel}
                        >
                            {activePerformers.length === 0 ? (
                                <div className={styles.emptyAttr}>No holding attribution data for this timeframe</div>
                            ) : (
                                <ul className={styles.performerList}>
                                    {activePerformers.map(p => {
                                        const impact = p.contribution ?? p.return;
                                        const assetRet = p.assetReturn ?? p.return;
                                        const hasProfit = typeof p.profit === 'number' && Number.isFinite(p.profit);
                                        const isPos = impact >= 0;
                                        const barPct = Math.min(100, Math.max(6, (Math.abs(impact) / maxAbsPerformer) * 100));

                                        return (
                                            <li key={p.symbol} className={styles.performerLi}>
                                                <Link
                                                    href={`/analysis/${encodeURIComponent(p.symbol)}?from=comparison`}
                                                    className={styles.performerItem}
                                                >
                                                    <div className={styles.performerTop}>
                                                        <span className={styles.performerTitleGroup}>
                                                            <span className={styles.performerSymbol}>{p.symbol}</span>
                                                            {p.isExited && (
                                                                <span className={styles.exitedBadge}>Exited</span>
                                                            )}
                                                        </span>
                                                        <span
                                                            className={`${styles.returnPill} ${isPos ? styles.pillPos : styles.pillNeg}`}
                                                            title="Portfolio Return Impact"
                                                        >
                                                            {formatPct(impact)}
                                                        </span>
                                                    </div>
                                                    <div className={styles.perfBarTrack} aria-hidden="true">
                                                        <div
                                                            className={`${styles.perfBarFill} ${isPos ? styles.barPos : styles.barNeg}`}
                                                            style={{ width: `${barPct}%` }}
                                                        />
                                                    </div>
                                                    <div className={styles.performerMeta}>
                                                        <span>
                                                            Asset{' '}
                                                            <span className={assetRet >= 0 ? styles.positiveText : styles.negativeText}>
                                                                {formatPct(assetRet)}
                                                            </span>
                                                        </span>
                                                        {hasProfit ? (
                                                            <span className={(p.profit ?? 0) >= 0 ? styles.positiveText : styles.negativeText}>
                                                                {formatProfit(p.profit ?? 0)}
                                                            </span>
                                                        ) : (
                                                            <span className={assetRet - safeBenchmarkReturn >= 0 ? styles.positiveText : styles.negativeText}>
                                                                {formatPct(assetRet - safeBenchmarkReturn)}
                                                            </span>
                                                        )}
                                                    </div>
                                                </Link>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </aside>
                </section>
            </div>
        </div>
    );
}
