'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    ResponsiveContainer,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip
} from 'recharts';
import ReportFilters, { FilterOptions } from '@/components/ReportFilters';
import ContributionChart from '@/components/ContributionChart';
import DividendChart from '@/components/DividendChart';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import { ClientCache } from '@/lib/client-cache';
import { fetchWithStaleWhileRevalidate } from '@/lib/evolution-cache';
import { getBucketEndMs, parseLocalDate } from '@/lib/date-utils';
import usePersistentState from '@/hooks/usePersistentState';

interface EvolutionPoint {
    date: string;
    value: number;
    invested: number;
}

interface ContributionPoint {
    date: string;
    inflow: number;
    outflow: number;
}

interface DividendPoint {
    date: string;
    amount: number;
}

interface EvolutionHistoryResponse {
    evolution?: EvolutionPoint[];
}

interface EvolutionFlowsResponse {
    contributions?: { day?: ContributionPoint[]; week: ContributionPoint[]; month: ContributionPoint[]; year: ContributionPoint[] };
    dividends?: { month: DividendPoint[]; year: DividendPoint[] };
}

type EvolutionTab = 'valueVsInvested' | 'wealthStack';

const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', '5Y', 'ALL'];

const EVOLUTION_TABS: { id: EvolutionTab; label: string }[] = [
    { id: 'valueVsInvested', label: 'Value vs. Invested Principal' },
    { id: 'wealthStack', label: 'Wealth Growth Breakdown' }
];

function getCutoffDate(rangeToUse: string): Date | null {
    if (rangeToUse === 'ALL') return null;

    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);

    switch (rangeToUse) {
        case '1M': cutoff.setMonth(cutoff.getMonth() - 1); break;
        case '3M': cutoff.setMonth(cutoff.getMonth() - 3); break;
        case '6M': cutoff.setMonth(cutoff.getMonth() - 6); break;
        case 'YTD': cutoff.setMonth(0, 1); break;
        case '1Y': cutoff.setFullYear(cutoff.getFullYear() - 1); break;
        case '2Y': cutoff.setFullYear(cutoff.getFullYear() - 2); break;
        case '3Y': cutoff.setFullYear(cutoff.getFullYear() - 3); break;
        case '5Y': cutoff.setFullYear(cutoff.getFullYear() - 5); break;
        default: return null;
    }
    return cutoff;
}

function filterByRange<T extends { date: string }>(
    items: T[] | undefined,
    rangeToUse: string,
    granularity: 'day' | 'week' | 'month' | 'year' = 'day'
): T[] {
    if (!items || items.length === 0) return [];
    const cutoff = getCutoffDate(rangeToUse);
    if (!cutoff) return items;

    const cutoffMs = cutoff.getTime();
    return items.filter(p => getBucketEndMs(p.date, granularity) >= cutoffMs);
}

export default function EvolutionPage() {
    const [filters, setFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('evolution_filters', null);
    const [range, setRange] = usePersistentState('evolution_range', 'ALL');

    const [data, setData] = useState<{
        evolution?: EvolutionPoint[];
        contributions?: { day?: ContributionPoint[]; week: ContributionPoint[]; month: ContributionPoint[]; year: ContributionPoint[] };
        dividends?: { month: DividendPoint[]; year: DividendPoint[] };
    }>({});

    const [loadingHistory, setLoadingHistory] = useState(true);
    const [loadingFlows, setLoadingFlows] = useState(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    const [evolutionTab, setEvolutionTab] = useState<EvolutionTab>('valueVsInvested');
    const [contributionPeriod, setContributionPeriod] = useState<'week' | 'month' | 'year'>('month');
    const [dividendPeriod, setDividendPeriod] = useState<'month' | 'year'>('year');
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    const { currency, format } = useCurrency();
    const { formatDate } = useDate();

    useEffect(() => {
        if (!isFiltersLoaded) return;

        const controller = new AbortController();
        const safeFilters: FilterOptions = filters || { accountTypes: [], investmentTypes: [] };
        const normalizedFilters = {
            accountTypes: [...(safeFilters.accountTypes || [])].sort(),
            investmentTypes: [...(safeFilters.investmentTypes || [])].sort()
        };
        const backendFilters = { ...normalizedFilters, assetClasses: normalizedFilters.investmentTypes };

        const fetchHistory = () => {
            const cacheKey = ClientCache.generateKey('evolution_history_v3', { filters: normalizedFilters, currency });
            return fetchWithStaleWhileRevalidate<EvolutionHistoryResponse>({
                cache: ClientCache,
                cacheKey,
                isValid: (val): val is EvolutionHistoryResponse =>
                    Boolean(val && typeof val === 'object' && Array.isArray((val as EvolutionHistoryResponse).evolution)),
                signal: controller.signal,
                fetcher: async (signal) => {
                    const res = await fetch('/api/analytics/evolution', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filters: backendFilters, currency, mode: 'evolution' }),
                        signal
                    });
                    if (!res.ok) {
                        throw new Error(`HTTP ${res.status}`);
                    }
                    return res.json();
                },
                onCached: (cached) => {
                    setData(prev => ({ ...prev, evolution: cached.evolution }));
                    setFetchError(null);
                },
                onFresh: (json) => {
                    setData(prev => ({ ...prev, evolution: json.evolution }));
                    setFetchError(null);
                },
                onLoadingChange: setLoadingHistory,
                onError: (err, hasCached) => {
                    console.error('Failed to fetch evolution history:', err);
                    if (!hasCached) {
                        setFetchError('Unable to load portfolio evolution history for the selected filters.');
                    }
                }
            });
        };

        const fetchFlows = () => {
            const cacheKey = ClientCache.generateKey('evolution_flows_v3', { filters: normalizedFilters, currency });
            return fetchWithStaleWhileRevalidate<EvolutionFlowsResponse>({
                cache: ClientCache,
                cacheKey,
                isValid: (val): val is EvolutionFlowsResponse =>
                    Boolean(
                        val &&
                        typeof val === 'object' &&
                        Array.isArray((val as EvolutionFlowsResponse).contributions?.day) &&
                        Array.isArray((val as EvolutionFlowsResponse).contributions?.month)
                    ),
                signal: controller.signal,
                fetcher: async (signal) => {
                    const res = await fetch('/api/analytics/evolution', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filters: backendFilters, currency, mode: 'flows' }),
                        signal
                    });
                    if (!res.ok) {
                        throw new Error(`HTTP ${res.status}`);
                    }
                    return res.json();
                },
                onCached: (cached) => {
                    setData(prev => ({ ...prev, contributions: cached.contributions, dividends: cached.dividends }));
                },
                onFresh: (json) => {
                    setData(prev => ({ ...prev, contributions: json.contributions, dividends: json.dividends }));
                },
                onLoadingChange: setLoadingFlows,
                onError: (err, hasCached) => {
                    console.error('Failed to fetch cash flows:', err);
                    if (!hasCached) {
                        setFetchError(prev => prev || 'Unable to load cash flows and dividend schedules.');
                    }
                }
            });
        };

        const timeout = setTimeout(() => {
            fetchHistory();
            fetchFlows();
        }, 120);

        return () => {
            clearTimeout(timeout);
            controller.abort();
        };
    }, [filters, currency, isFiltersLoaded]);

    const filteredEvolution = useMemo(
        () => filterByRange(data.evolution, range, 'day'),
        [data.evolution, range]
    );

    const filteredContributions = useMemo(
        () => filterByRange(data.contributions?.[contributionPeriod], range, contributionPeriod),
        [data.contributions, contributionPeriod, range]
    );

    const filteredDividends = useMemo(
        () => filterByRange(data.dividends?.[dividendPeriod], range, dividendPeriod),
        [data.dividends, dividendPeriod, range]
    );

    const evolutionChartData = useMemo(() => {
        return filteredEvolution.map(p => {
            const clampedInvested = Math.max(0, p.invested);
            const investedBase = Math.max(0, Math.min(p.value, clampedInvested));
            const marketGain = Math.max(0, p.value - investedBase);
            return {
                date: p.date,
                dateNumber: parseLocalDate(p.date).getTime(),
                value: p.value,
                invested: p.invested,
                investedBase,
                marketGain,
                netGain: p.value - p.invested
            };
        });
    }, [filteredEvolution]);

    const kpis = useMemo(() => {
        const len = filteredEvolution.length;
        const firstEv = len > 0 ? filteredEvolution[0] : null;
        const lastEv = len > 0 ? filteredEvolution[len - 1] : null;

        const endingValue = lastEv ? lastEv.value : 0;
        const startingValue = firstEv ? firstEv.value : 0;
        const endInvested = lastEv ? lastEv.invested : 0;

        const periodDelta = endingValue - startingValue;
        const periodDeltaPct = startingValue > 0.01 ? (periodDelta / startingValue) * 100 : 0;

        // # Reason: Use exact daily buckets for Card 2 totals so non-ALL ranges (e.g. 1M, YTD)
        // don't pull in pre-cutoff flows from the start of the opening calendar month.
        const dayFlows = filterByRange(data.contributions?.day, range, 'day');
        const monthlyFlows = filterByRange(data.contributions?.month, range, 'month');
        const flowSource = data.contributions?.day ? dayFlows : monthlyFlows;
        const totalInflows = flowSource.reduce((s, d) => s + d.inflow, 0);
        const totalOutflows = flowSource.reduce((s, d) => s + Math.abs(d.outflow), 0);
        const netFlowFromSchedule = totalInflows - totalOutflows;
        const avgMonthlyContribution = monthlyFlows.length > 0 ? netFlowFromSchedule / monthlyFlows.length : 0;

        const isAllRange = range === 'ALL';
        const baselineEv = !isAllRange && firstEv && data.evolution
            ? (() => {
                const firstIdx = data.evolution.findIndex(p => p.date === firstEv.date);
                return firstIdx > 0 ? data.evolution[firstIdx - 1] : null;
            })()
            : null;

        const compoundedGain = (isAllRange || !baselineEv)
            ? (endingValue - endInvested)
            : (endingValue - baselineEv.value) - (endInvested - baselineEv.invested);
        const gainDenominator = (isAllRange || !baselineEv)
            ? (endInvested > 0.01 ? endInvested : endingValue)
            : baselineEv.value + Math.max(0, endInvested - baselineEv.invested);
        const compoundedGainPct = gainDenominator > 0.01 ? (compoundedGain / gainDenominator) * 100 : 0;

        const monthlyDivs = filterByRange(data.dividends?.month, range, 'month');
        const totalDividends = monthlyDivs.reduce((s, d) => s + d.amount, 0);
        const avgMonthlyDividend = monthlyDivs.length > 0 ? totalDividends / monthlyDivs.length : 0;
        const peakDivMonth = monthlyDivs.reduce(
            (best, cur) => (cur.amount > best.amount ? cur : best),
            { date: '', amount: 0 }
        );

        const totalWealthCreated = Math.max(0, compoundedGain) + Math.max(0, totalDividends);
        const gainSharePct = totalWealthCreated > 0 ? (Math.max(0, compoundedGain) / totalWealthCreated) * 100 : 0;
        const divSharePct = totalWealthCreated > 0 ? (Math.max(0, totalDividends) / totalWealthCreated) * 100 : 0;

        return {
            endingValue,
            startingValue,
            endInvested,
            periodDelta,
            periodDeltaPct,
            totalInflows,
            totalOutflows,
            netFlowFromSchedule,
            avgMonthlyContribution,
            compoundedGain,
            compoundedGainPct,
            gainSharePct,
            totalDividends,
            avgMonthlyDividend,
            peakDivMonth,
            divSharePct,
            startDate: firstEv?.date || null,
            endDate: lastEv?.date || null
        };
    }, [filteredEvolution, data.evolution, data.contributions, data.dividends, range]);

    const flowStats = useMemo(() => {
        const inflows = filteredContributions.reduce((s, d) => s + d.inflow, 0);
        const outflows = filteredContributions.reduce((s, d) => s + Math.abs(d.outflow), 0);
        return { inflows, outflows, net: inflows - outflows };
    }, [filteredContributions]);

    const divStats = useMemo(() => {
        const total = filteredDividends.reduce((s, d) => s + d.amount, 0);
        const avg = filteredDividends.length > 0 ? total / filteredDividends.length : 0;
        const peak = filteredDividends.reduce(
            (best, cur) => (cur.amount > best.amount ? cur : best),
            { date: '', amount: 0 }
        );
        return { total, avg, peak };
    }, [filteredDividends]);

    const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = EVOLUTION_TABS.findIndex(t => t.id === evolutionTab);
        if (currentIndex === -1) return;

        let nextIndex: number | null = null;
        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % EVOLUTION_TABS.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + EVOLUTION_TABS.length) % EVOLUTION_TABS.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = EVOLUTION_TABS.length - 1;

        if (nextIndex !== null) {
            e.preventDefault();
            setEvolutionTab(EVOLUTION_TABS[nextIndex].id);
            tabRefs.current[nextIndex]?.focus();
        }
    };

    return (
        <div className={styles.container}>
            {/* Header & Master Timeframe Controls */}
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Portfolio Evolution &amp; Cash Flows</h1>
                    <p className={styles.subtitle}>
                        Track long-term wealth compounding, net capital contributions, and dividend income velocity.
                    </p>
                </div>

                <div className={styles.headerControls}>
                    <div className={styles.masterRanges} role="group" aria-label="Master evolution timeframe">
                        {RANGES.map(r => (
                            <button
                                key={r}
                                type="button"
                                aria-pressed={range === r}
                                className={`${styles.rangeBtn} ${range === r ? styles.rangeBtnActive : ''}`}
                                onClick={() => setRange(r)}
                            >
                                {r}
                            </button>
                        ))}
                    </div>

                    <div className={styles.mobileRangeWrap}>
                        <select
                            aria-label="Master evolution timeframe"
                            className={styles.mobileSelect}
                            value={range}
                            onChange={(e) => setRange(e.target.value)}
                        >
                            {RANGES.map(r => (
                                <option key={r} value={r}>{r === 'ALL' ? 'All Time' : r}</option>
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
                {/* Tier 1: 4-Card Wealth Evolution KPI Strip */}
                <section className={styles.kpiStrip} aria-label="Portfolio evolution metrics">
                    {/* Card 1: Ending Portfolio Value Hero */}
                    <div className={styles.heroCard}>
                        <div className={styles.heroTop}>
                            <span className={styles.heroLabel}>Ending Portfolio Value</span>
                            <div className={styles.heroValue}>{format(kpis.endingValue)}</div>
                            <span className={styles.heroPill}>
                                <span aria-hidden="true">{kpis.periodDelta >= 0 ? '▲' : '▼'}</span>
                                <span>
                                    {kpis.periodDelta > 0 ? '+' : ''}
                                    {format(kpis.periodDelta, { maximumFractionDigits: 0 })}
                                    {kpis.startingValue > 0.01 ? ` (${kpis.periodDeltaPct > 0 ? '+' : ''}${kpis.periodDeltaPct.toFixed(1)}%)` : ` (${range})`}
                                </span>
                            </span>
                        </div>
                        <div className={styles.heroFooter}>
                            <span>Start: <strong>{format(kpis.startingValue, { maximumFractionDigits: 0 })}</strong></span>
                            {kpis.startDate && kpis.endDate && (
                                <span>{formatDate(kpis.startDate)} &ndash; {formatDate(kpis.endDate)}</span>
                            )}
                        </div>
                    </div>

                    {/* Card 2: Net Capital Contributions */}
                    <div className={styles.kpiCard}>
                        <div className={styles.kpiHeader}>
                            <span className={styles.kpiLabel}>Net Capital Contributions</span>
                            <span className={styles.kpiTag} title="External inflows minus outflows, excluding reinvested dividends">
                                Out-of-Pocket
                            </span>
                        </div>
                        <div className={styles.kpiValue}>{format(kpis.netFlowFromSchedule, { maximumFractionDigits: 0 })}</div>
                        <div className={styles.kpiFooter}>
                            <div className={styles.kpiFootRow}>
                                <span className={styles.positiveText}>In: {format(kpis.totalInflows, { notation: 'compact' })}</span>
                                <span className={styles.negativeText}>Out: {format(kpis.totalOutflows, { notation: 'compact' })}</span>
                            </div>
                            <span className={styles.kpiSubtext}>
                                Avg <strong>{format(kpis.avgMonthlyContribution, { maximumFractionDigits: 0 })}/mo</strong> net contribution
                            </span>
                        </div>
                    </div>

                    {/* Card 3: Compounded Market Gains */}
                    <div className={styles.kpiCard}>
                        <div className={styles.kpiHeader}>
                            <span className={styles.kpiLabel}>Compounded Market Gains</span>
                            <span className={`${styles.kpiBadge} ${kpis.compoundedGain >= 0 ? styles.badgeEmerald : styles.badgeRed}`}>
                                {kpis.compoundedGainPct >= 0 ? '+' : ''}{kpis.compoundedGainPct.toFixed(1)}%
                            </span>
                        </div>
                        <div className={`${styles.kpiValue} ${kpis.compoundedGain >= 0 ? styles.positiveText : styles.negativeText}`}>
                            {kpis.compoundedGain >= 0 ? '+' : ''}{format(kpis.compoundedGain, { maximumFractionDigits: 0 })}
                        </div>
                        <div className={styles.kpiFooter}>
                            <span className={styles.kpiSubtext}>
                                <strong>{kpis.gainSharePct.toFixed(0)}%</strong> of period wealth creation from appreciation
                            </span>
                        </div>
                    </div>

                    {/* Card 4: Cumulative Dividend Income */}
                    <div className={styles.kpiCard}>
                        <div className={styles.kpiHeader}>
                            <span className={styles.kpiLabel}>Cumulative Dividend Income</span>
                            <span className={styles.badgeViolet}>
                                {kpis.compoundedGain > 0 ? `${kpis.divSharePct.toFixed(1)}% of Profit` : 'Income Earned'}
                            </span>
                        </div>
                        <div className={`${styles.kpiValue} ${styles.violetText}`}>
                            {format(kpis.totalDividends)}
                        </div>
                        <div className={styles.kpiFooter}>
                            <span className={styles.kpiSubtext}>
                                Avg <strong>{format(kpis.avgMonthlyDividend, { maximumFractionDigits: 0 })}/mo</strong> &bull; Peak {format(kpis.peakDivMonth.amount, { maximumFractionDigits: 0 })}
                            </span>
                        </div>
                    </div>
                </section>

                {/* Tier 2: Master Wealth Evolution Chart Card */}
                <section className={styles.evolutionCard} aria-label="Wealth evolution over time">
                    <div className={styles.evolutionHeader}>
                        <div className={styles.tablistWrap}>
                            <div
                                role="tablist"
                                aria-label="Evolution chart view"
                                className={styles.tablist}
                                onKeyDown={handleTabKeyDown}
                            >
                                {EVOLUTION_TABS.map((tab, idx) => {
                                    const selected = evolutionTab === tab.id;
                                    return (
                                        <button
                                            key={tab.id}
                                            ref={el => { tabRefs.current[idx] = el; }}
                                            type="button"
                                            role="tab"
                                            id={`evo-tab-${tab.id}`}
                                            aria-selected={selected}
                                            tabIndex={selected ? 0 : -1}
                                            className={styles.tabBtn}
                                            onClick={() => setEvolutionTab(tab.id)}
                                        >
                                            {tab.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className={styles.evolutionMetaStrip}>
                            <span>
                                Invested Principal: <strong>{format(kpis.endInvested, { maximumFractionDigits: 0 })}</strong>
                            </span>
                            <span>
                                Gain Wedge: <strong className={kpis.endingValue - kpis.endInvested >= 0 ? styles.positiveText : styles.negativeText}>
                                    {kpis.endingValue - kpis.endInvested >= 0 ? '+' : ''}
                                    {format(kpis.endingValue - kpis.endInvested, { maximumFractionDigits: 0 })}
                                </strong>
                            </span>
                        </div>
                    </div>

                    <div
                        role="tabpanel"
                        aria-labelledby={`evo-tab-${evolutionTab}`}
                        tabIndex={0}
                        className={styles.evolutionChartWrapper}
                    >
                        {loadingHistory && !data.evolution && (
                            <div className={styles.loadingOverlay}>Loading portfolio evolution...</div>
                        )}
                        {!loadingHistory && evolutionChartData.length === 0 && (
                            <div className={styles.emptyChart}>No evolution history available for the selected filters</div>
                        )}

                        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                            {evolutionTab === 'valueVsInvested' ? (
                                <AreaChart data={evolutionChartData} margin={{ top: 10, right: 12, bottom: 0, left: 6 }}>
                                    <defs>
                                        <linearGradient id="evoValueFill" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.28} />
                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
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
                                        tickFormatter={(val) => format(val, { notation: 'compact' })}
                                        stroke="var(--text-secondary)"
                                        fontSize={11}
                                        width={68}
                                        tickLine={false}
                                        axisLine={false}
                                        domain={['auto', 'auto']}
                                    />
                                    <Tooltip
                                        content={({ active, payload }) => {
                                            if (!active || !payload || !payload.length) return null;
                                            const pt = payload[0].payload;
                                            return (
                                                <div className={styles.tooltipBox}>
                                                    <div className={styles.tooltipDate}>{formatDate(pt.date)}</div>
                                                    <div className={styles.tooltipRow}>
                                                        <span>Portfolio Value</span>
                                                        <strong>{format(pt.value)}</strong>
                                                    </div>
                                                    <div className={styles.tooltipRow}>
                                                        <span>Invested Principal</span>
                                                        <strong>{format(pt.invested)}</strong>
                                                    </div>
                                                    <div className={`${styles.tooltipRow} ${styles.tooltipDivider}`}>
                                                        <span>Net Gain</span>
                                                        <strong className={pt.netGain >= 0 ? styles.positiveText : styles.negativeText}>
                                                            {pt.netGain >= 0 ? '+' : ''}{format(pt.netGain)}
                                                        </strong>
                                                    </div>
                                                </div>
                                            );
                                        }}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="value"
                                        name="Portfolio Value"
                                        stroke="#3b82f6"
                                        strokeWidth={2.5}
                                        fill="url(#evoValueFill)"
                                        dot={false}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="invested"
                                        name="Invested Principal"
                                        stroke="#94a3b8"
                                        strokeWidth={2}
                                        strokeDasharray="5 4"
                                        fill="transparent"
                                        dot={false}
                                    />
                                </AreaChart>
                            ) : (
                                <AreaChart data={evolutionChartData} margin={{ top: 10, right: 12, bottom: 0, left: 6 }}>
                                    <defs>
                                        <linearGradient id="evoPrincipalFill" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.22} />
                                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.04} />
                                        </linearGradient>
                                        <linearGradient id="evoGainFill" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#10b981" stopOpacity={0.35} />
                                            <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
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
                                        tickFormatter={(val) => format(val, { notation: 'compact' })}
                                        stroke="var(--text-secondary)"
                                        fontSize={11}
                                        width={68}
                                        tickLine={false}
                                        axisLine={false}
                                    />
                                    <Tooltip
                                        content={({ active, payload }) => {
                                            if (!active || !payload || !payload.length) return null;
                                            const pt = payload[0].payload;
                                            return (
                                                <div className={styles.tooltipBox}>
                                                    <div className={styles.tooltipDate}>{formatDate(pt.date)}</div>
                                                    <div className={styles.tooltipRow}>
                                                        <span>Invested Principal</span>
                                                        <strong>{format(pt.invested)}</strong>
                                                    </div>
                                                    <div className={styles.tooltipRow}>
                                                        <span>Market Appreciation</span>
                                                        <strong className={pt.netGain >= 0 ? styles.positiveText : styles.negativeText}>
                                                            {pt.netGain >= 0 ? '+' : ''}{format(pt.netGain)}
                                                        </strong>
                                                    </div>
                                                    <div className={`${styles.tooltipRow} ${styles.tooltipDivider}`}>
                                                        <span>Total Portfolio</span>
                                                        <strong>{format(pt.value)}</strong>
                                                    </div>
                                                </div>
                                            );
                                        }}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="investedBase"
                                        stackId="wealth"
                                        name="Invested Principal"
                                        stroke="#3b82f6"
                                        strokeWidth={2}
                                        fill="url(#evoPrincipalFill)"
                                        dot={false}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="marketGain"
                                        stackId="wealth"
                                        name="Market Appreciation"
                                        stroke="#10b981"
                                        strokeWidth={2}
                                        fill="url(#evoGainFill)"
                                        dot={false}
                                    />
                                </AreaChart>
                            )}
                        </ResponsiveContainer>
                    </div>
                </section>

                {/* Tier 3: 2-Column Cash Flow & Dividend Velocity Grid */}
                <section className={styles.velocityGrid} aria-label="Cash flows and dividend income velocity">
                    {/* Left Card: Capital Contributions & Cash Flows */}
                    <div className={styles.chartCard}>
                        <div className={styles.cardHeader}>
                            <div className={styles.cardTitleGroup}>
                                <h2 className={styles.cardTitle}>Capital Contributions &amp; Cash Flows</h2>
                                <div className={styles.flowSummaryRow}>
                                    <span>In: <strong className={styles.positiveText}>{format(flowStats.inflows, { notation: 'compact' })}</strong></span>
                                    <span>Out: <strong className={styles.negativeText}>{format(flowStats.outflows, { notation: 'compact' })}</strong></span>
                                    <span>Net: <strong>{format(flowStats.net, { notation: 'compact' })}</strong></span>
                                </div>
                            </div>

                            <div className={styles.filterGroup} role="group" aria-label="Contribution granularity">
                                {(['week', 'month', 'year'] as const).map(p => (
                                    <button
                                        key={p}
                                        type="button"
                                        aria-pressed={contributionPeriod === p}
                                        className={`${styles.filterButton} ${contributionPeriod === p ? styles.filterButtonActive : ''}`}
                                        onClick={() => setContributionPeriod(p)}
                                    >
                                        {p.charAt(0).toUpperCase() + p.slice(1)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className={styles.subChartBody}>
                            {loadingFlows && !data.contributions ? (
                                <div className={styles.loading}>Loading cash flows...</div>
                            ) : filteredContributions.length > 0 ? (
                                <ContributionChart data={filteredContributions} period={contributionPeriod} />
                            ) : (
                                <div className={styles.loading}>No contribution data for this period</div>
                            )}
                        </div>
                    </div>

                    {/* Right Card: Dividend Income Velocity */}
                    <div className={styles.chartCard}>
                        <div className={styles.cardHeader}>
                            <div className={styles.cardTitleGroup}>
                                <h2 className={styles.cardTitle}>Dividend Income Velocity</h2>
                                <div className={styles.flowSummaryRow}>
                                    <span>Total: <strong className={styles.violetText}>{format(divStats.total, { maximumFractionDigits: 0 })}</strong></span>
                                    <span>Avg/{dividendPeriod}: <strong>{format(divStats.avg, { maximumFractionDigits: 0 })}</strong></span>
                                    <span>Peak: <strong>{format(divStats.peak.amount, { maximumFractionDigits: 0 })}</strong></span>
                                </div>
                            </div>

                            <div className={styles.filterGroup} role="group" aria-label="Dividend granularity">
                                {(['month', 'year'] as const).map(p => (
                                    <button
                                        key={p}
                                        type="button"
                                        aria-pressed={dividendPeriod === p}
                                        className={`${styles.filterButton} ${dividendPeriod === p ? styles.filterButtonActive : ''}`}
                                        onClick={() => setDividendPeriod(p)}
                                    >
                                        {p.charAt(0).toUpperCase() + p.slice(1)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className={styles.subChartBody}>
                            {loadingFlows && !data.dividends ? (
                                <div className={styles.loading}>Loading dividend history...</div>
                            ) : filteredDividends.length > 0 ? (
                                <DividendChart data={filteredDividends} period={dividendPeriod} />
                            ) : (
                                <div className={styles.loading}>No dividend data for this period</div>
                            )}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
