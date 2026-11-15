'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import ReportFilters, { type FilterOptions } from '@/components/ReportFilters';
import usePersistentState from '@/hooks/usePersistentState';
import { MdClose, MdSettings } from 'react-icons/md';
import {
    computeRebalancePlan,
    formatShareCount,
    normalizeTargetsTo100,
    seedTargetsFromHoldings,
    type RebalanceItem,
    type RebalanceMode,
    type TargetConfig
} from '@/lib/rebalance-planner';
import RebalancerCharts from './_components/RebalancerCharts';
import RebalancerConfigPanel from './_components/RebalancerConfigPanel';

type ChecklistFilter = 'ALL' | 'ACTIONABLE' | 'BUY' | 'SELL' | 'HOLD';

const TOLERANCE_PRESETS = [0, 0.5, 1, 2, 5];
const CASH_PRESETS = [500, 1000, 2500, 5000];

export default function RebalancerPage() {
    const { format, currency } = useCurrency();

    const [rebalanceData, setRebalanceData] = useState<RebalanceItem[] | null>(null);
    const [knownSymbols, setKnownSymbols] = useState<string[]>([]);
    const [targets, setTargets] = useState<TargetConfig[]>([]);
    const [isSaving, setIsSaving] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isConfigOpen, setIsConfigOpen] = useState(false);
    const [checklistFilter, setChecklistFilter] = useState<ChecklistFilter>('ALL');
    const [errorBanner, setErrorBanner] = useState<string | null>(null);
    const [successBanner, setSuccessBanner] = useState<string | null>(null);

    // Persistent Filters & Strategy Controls
    const [globalFilters, setGlobalFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('rebalancer_filters', null);
    const [excludeSymbols, setExcludeSymbols] = usePersistentState<string>('rebalancer_exclude_symbols', '');
    const [debouncedExclude, setDebouncedExclude] = useState<string>('');

    const [rebalanceMode, setRebalanceMode] = usePersistentState<RebalanceMode>('rebalancer_mode', 'FULL');
    const [newCash, setNewCash] = usePersistentState<number>('rebalancer_new_cash', 1000);
    const [tolerancePercent, setTolerancePercent] = usePersistentState<number>('rebalancer_tolerance', 1);
    const [wholeShares, setWholeShares] = usePersistentState<boolean>('rebalancer_whole_shares', false);
    const [checkedTradeList, setCheckedTradeList] = usePersistentState<string[]>('rebalancer_checked_trades', []);

    // Debounce manual exclude typing so we don't fire API calls on every keystroke
    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedExclude(excludeSymbols);
        }, 300);
        return () => clearTimeout(timer);
    }, [excludeSymbols]);

    const excludedSet = useMemo(() => {
        return new Set(
            excludeSymbols
                .split(',')
                .map((s) => s.trim().toUpperCase())
                .filter(Boolean)
        );
    }, [excludeSymbols]);

    const checkedTrades = useMemo(() => new Set(checkedTradeList), [checkedTradeList]);

    const fetchData = useCallback(async (signal?: AbortSignal) => {
        setIsLoading(true);
        setErrorBanner(null);

        try {
            let url = `/api/rebalancer?currency=${currency}`;
            if (globalFilters) {
                if (globalFilters.investmentTypes.length > 0) {
                    url += `&investmentTypes=${globalFilters.investmentTypes.join(',')}`;
                }
                if (globalFilters.accountTypes.length > 0) {
                    url += `&accountTypes=${globalFilters.accountTypes.join(',')}`;
                }
            }
            if (debouncedExclude.trim()) {
                url += `&excludeSymbols=${encodeURIComponent(debouncedExclude.trim())}`;
            }

            const [dataRes, targetRes] = await Promise.all([
                fetch(url, { signal }),
                fetch('/api/rebalancer/targets', { signal })
            ]);

            if (!dataRes.ok) {
                throw new Error(`Unable to load rebalance analytics (HTTP ${dataRes.status})`);
            }

            const dataJson = await dataRes.json();
            const items: RebalanceItem[] = Array.isArray(dataJson.data) ? dataJson.data : [];
            setRebalanceData(items);

            setKnownSymbols((prev) => {
                const merged = new Set(prev);
                items.forEach((d) => merged.add(d.symbol));
                return Array.from(merged).sort();
            });

            if (targetRes.ok) {
                const targetJson = await targetRes.json();
                if (Array.isArray(targetJson.targets)) {
                    setTargets(
                        targetJson.targets.map((t: { symbol: string; targetPercentage: number; yearlyDriftAdjustment: number | null }) => ({
                            symbol: t.symbol,
                            targetPercentage: t.targetPercentage,
                            yearlyDriftAdjustment: t.yearlyDriftAdjustment
                        }))
                    );
                }
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('Failed to fetch rebalancer data:', error);
            setErrorBanner(error instanceof Error ? error.message : 'Failed to load rebalancer data.');
        } finally {
            setIsLoading(false);
        }
    }, [currency, globalFilters, debouncedExclude]);

    useEffect(() => {
        if (!isFiltersLoaded) return;
        const controller = new AbortController();
        fetchData(controller.signal);
        return () => controller.abort();
    }, [isFiltersLoaded, fetchData]);

    const saveTargets = async () => {
        setIsSaving(true);
        setErrorBanner(null);
        setSuccessBanner(null);
        try {
            const validTargets = targets
                .map((t) => ({
                    ...t,
                    symbol: t.symbol.trim().toUpperCase()
                }))
                .filter((t) => t.symbol !== '');

            const res = await fetch('/api/rebalancer/targets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ targets: validTargets })
            });

            if (!res.ok) {
                if (res.status === 403) {
                    setErrorBanner('Only Admin or Editor accounts can modify target allocations.');
                } else {
                    const errBody = await res.json().catch(() => ({}));
                    setErrorBanner(errBody.error || `Failed to save targets (HTTP ${res.status}).`);
                }
                return;
            }

            setSuccessBanner('Target allocations saved and drift recalculated.');
            await fetchData();
        } catch (error) {
            console.error('Failed to save targets:', error);
            setErrorBanner('Network error while saving target allocations.');
        } finally {
            setIsSaving(false);
        }
    };

    const handleSeedFromHoldings = () => {
        if (!rebalanceData || rebalanceData.length === 0) return;
        setTargets(seedTargetsFromHoldings(rebalanceData, targets));
    };

    const handleNormalizeTargets = () => {
        setTargets((prev) => normalizeTargetsTo100(prev));
    };

    const toggleTradeCheck = (symbol: string) => {
        setCheckedTradeList((prev) =>
            prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]
        );
    };

    const toggleExcludeChip = (symbol: string) => {
        const next = new Set(excludedSet);
        if (next.has(symbol)) {
            next.delete(symbol);
        } else {
            next.add(symbol);
        }
        setExcludeSymbols(Array.from(next).join(', '));
    };

    const plan = useMemo(() => {
        return computeRebalancePlan(rebalanceData || [], {
            mode: rebalanceMode,
            newCash: rebalanceMode === 'BUY_ONLY' ? newCash : 0,
            tolerancePercent,
            wholeShares
        });
    }, [rebalanceData, rebalanceMode, newCash, tolerancePercent, wholeShares]);

    const { rows, summary } = plan;

    const portfolioSymbols = useMemo(() => {
        const set = new Set<string>(knownSymbols);
        excludedSet.forEach((s) => set.add(s));
        return Array.from(set).sort();
    }, [knownSymbols, excludedSet]);

    const filteredRows = useMemo(() => {
        switch (checklistFilter) {
            case 'ACTIONABLE':
                return rows.filter((r) => r.effectiveAction !== 'HOLD');
            case 'BUY':
                return rows.filter((r) => r.effectiveAction === 'BUY');
            case 'SELL':
                return rows.filter((r) => r.effectiveAction === 'SELL');
            case 'HOLD':
                return rows.filter((r) => r.effectiveAction === 'HOLD');
            default:
                return rows;
        }
    }, [rows, checklistFilter]);

    const actionableCount = summary.buyCount + summary.sellCount;
    const completedActionableCount = rows.filter(
        (r) => r.effectiveAction !== 'HOLD' && checkedTrades.has(r.symbol)
    ).length;

    const totalVolumeBar = Math.max(summary.totalBuyValue + summary.totalSellValue, 1);
    const buyBarPct = (summary.totalBuyValue / totalVolumeBar) * 100;
    const sellBarPct = (summary.totalSellValue / totalVolumeBar) * 100;

    const isTargetSumValid = Math.abs(summary.targetSumPercent - 100) < 0.05;
    const maxRowAbsDrift = useMemo(
        () => Math.max(...rows.map((r) => Math.abs(r.driftPercent)), 1),
        [rows]
    );

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Portfolio Rebalancer</h1>
                    <p className={styles.subtitle}>
                        Monitor drift against target allocations, simulate buy-only cash inflows, and track trade execution.
                    </p>
                </div>

                <div className={styles.headerControls}>
                    {isFiltersLoaded && (
                        <ReportFilters onChange={setGlobalFilters} initialFilters={globalFilters || undefined} />
                    )}
                    <button
                        type="button"
                        className={`${styles.secondaryBtn} ${isConfigOpen ? styles.secondaryBtnActive : ''}`}
                        onClick={() => setIsConfigOpen((prev) => !prev)}
                        aria-expanded={isConfigOpen}
                    >
                        <MdSettings size={18} aria-hidden="true" />
                        <span>{isConfigOpen ? 'Hide Target Studio' : 'Configure Targets'}</span>
                    </button>
                </div>
            </header>

            {errorBanner && (
                <div role="alert" className={styles.errorBanner}>
                    <span>{errorBanner}</span>
                    <button
                        type="button"
                        className={styles.iconDeleteBtn}
                        onClick={() => setErrorBanner(null)}
                        aria-label="Dismiss error"
                    >
                        <MdClose size={18} aria-hidden="true" />
                    </button>
                </div>
            )}

            {successBanner && (
                <div role="status" className={styles.successBanner}>
                    <span>{successBanner}</span>
                    <button
                        type="button"
                        className={styles.iconDeleteBtn}
                        onClick={() => setSuccessBanner(null)}
                        aria-label="Dismiss notification"
                    >
                        <MdClose size={18} aria-hidden="true" />
                    </button>
                </div>
            )}

            <div className={styles.pageGrid}>
                {/* Expandable Target & Glide Path Studio */}
                <RebalancerConfigPanel
                    isOpen={isConfigOpen}
                    targets={targets}
                    portfolioSymbols={portfolioSymbols}
                    isSaving={isSaving}
                    onChangeTargets={setTargets}
                    onSeedFromHoldings={handleSeedFromHoldings}
                    onNormalizeTargets={handleNormalizeTargets}
                    onSaveTargets={saveTargets}
                />

                {isLoading && !rebalanceData ? (
                    <>
                        <div className={styles.kpiStrip}>
                            <div className={styles.skeletonCard} />
                            <div className={styles.skeletonCard} />
                            <div className={styles.skeletonCard} />
                            <div className={styles.skeletonCard} />
                        </div>
                        <div className={styles.panelCard} style={{ gap: '0.75rem' }}>
                            <div className={styles.skeletonRow} />
                            <div className={styles.skeletonRow} />
                            <div className={styles.skeletonRow} />
                        </div>
                    </>
                ) : (
                    <>
                        {/* Tier 1: 4-Card KPI Strip */}
                        <section className={styles.kpiStrip} aria-label="Rebalance summary metrics">
                            <article className={styles.heroCard}>
                                <div className={styles.heroTop}>
                                    <span className={styles.heroLabel}>Evaluated Portfolio Value</span>
                                    <div className={styles.heroValue}>{format(summary.totalValue)}</div>
                                    <span className={styles.heroPill}>
                                        {actionableCount === 0
                                            ? `Balanced Within ±${tolerancePercent}%`
                                            : `${actionableCount} Trade${actionableCount === 1 ? '' : 's'} Recommended`}
                                    </span>
                                </div>
                                <div className={styles.heroFooter}>
                                    <span>Assets: <strong>{rows.length}</strong></span>
                                    <span>Excluded: <strong>{excludedSet.size}</strong></span>
                                    {rebalanceMode === 'BUY_ONLY' && newCash > 0 && (
                                        <span>Post-Cash: <strong>{format(summary.postTradeTotalValue, { maximumFractionDigits: 0 })}</strong></span>
                                    )}
                                </div>
                            </article>

                            <article className={styles.kpiCard}>
                                <div>
                                    <div className={styles.kpiHeader}>
                                        <span className={styles.kpiLabel}>Portfolio Drift</span>
                                        <span
                                            className={`${styles.statusPill} ${
                                                summary.outOfBandCount === 0
                                                    ? styles.statusPositive
                                                    : summary.maxAbsDrift > Math.max(tolerancePercent * 2, 5)
                                                        ? styles.statusNegative
                                                        : styles.statusWarning
                                            }`}
                                        >
                                            Max &plusmn;{summary.maxAbsDrift.toFixed(1)}%
                                        </span>
                                    </div>
                                    <div className={styles.kpiValue}>{summary.portfolioTurnoverPercent.toFixed(1)}%</div>
                                </div>
                                <div className={styles.kpiFooter}>
                                    <div className={styles.kpiFootRow}>
                                        <span className={styles.positiveText}>
                                            {rows.filter((r) => r.driftPercent < -tolerancePercent).length} Underweight
                                        </span>
                                        <span className={styles.negativeText}>
                                            {rows.filter((r) => r.driftPercent > tolerancePercent).length} Overweight
                                        </span>
                                    </div>
                                    <span className={styles.kpiSubtext}>
                                        <strong>{summary.outOfBandCount}</strong> asset{summary.outOfBandCount === 1 ? '' : 's'} outside &plusmn;{tolerancePercent}% band
                                    </span>
                                </div>
                            </article>

                            <article className={styles.kpiCard}>
                                <div>
                                    <div className={styles.kpiHeader}>
                                        <span className={styles.kpiLabel}>Trade Volume</span>
                                        <span className={`${styles.statusPill} ${styles.statusNeutral}`}>
                                            {rebalanceMode === 'BUY_ONLY' ? 'Buy-Only' : 'Full'}
                                        </span>
                                    </div>
                                    <div className={styles.kpiValue}>
                                        {format(summary.totalBuyValue + summary.totalSellValue, { maximumFractionDigits: 0 })}
                                    </div>
                                </div>
                                <div className={styles.kpiFooter}>
                                    <div className={styles.progressTrack} aria-hidden="true">
                                        <div className={styles.progressBuy} style={{ width: `${buyBarPct}%` }} />
                                        <div className={styles.progressSell} style={{ width: `${sellBarPct}%` }} />
                                    </div>
                                    <div className={styles.kpiFootRow}>
                                        <span className={styles.positiveText}>Buy: {format(summary.totalBuyValue, { maximumFractionDigits: 0 })}</span>
                                        <span className={styles.negativeText}>Sell: {format(summary.totalSellValue, { maximumFractionDigits: 0 })}</span>
                                    </div>
                                </div>
                            </article>

                            <article className={styles.kpiCard}>
                                <div>
                                    <div className={styles.kpiHeader}>
                                        <span className={styles.kpiLabel}>Target Coverage</span>
                                        <span
                                            className={`${styles.statusPill} ${
                                                isTargetSumValid
                                                    ? styles.statusPositive
                                                    : summary.targetSumPercent === 0
                                                        ? styles.statusNeutral
                                                        : styles.statusWarning
                                            }`}
                                        >
                                            {summary.targetSumPercent.toFixed(1)}% Sum
                                        </span>
                                    </div>
                                    <div className={styles.kpiValue}>
                                        {summary.targetedCount} / {rows.length}
                                    </div>
                                </div>
                                <div className={styles.kpiFooter}>
                                    <span className={styles.kpiSubtext}>
                                        <strong>{summary.untargetedCount}</strong> untargeted &bull; <strong>{summary.glideActiveCount}</strong> glide path
                                    </span>
                                    {summary.unallocatedCash > 0.01 && (
                                        <span className={styles.kpiSubtext}>
                                            Remainder cash: <strong>{format(summary.unallocatedCash)}</strong>
                                        </span>
                                    )}
                                </div>
                            </article>
                        </section>

                        {rows.length === 0 ? (
                            <section className={styles.panelCard}>
                                <div className={styles.emptyState}>
                                    <h3>No Holdings or Targets Found</h3>
                                    <p>
                                        Adjust your Account/Investment filters or configure target allocations to start generating rebalance recommendations.
                                    </p>
                                    <button
                                        type="button"
                                        className={styles.primaryBtn}
                                        onClick={() => setIsConfigOpen(true)}
                                    >
                                        <MdSettings size={18} aria-hidden="true" />
                                        Configure Targets
                                    </button>
                                </div>
                            </section>
                        ) : (
                            <>
                                {/* Tier 2: Strategy Controls + Tabbed Visual Workspace */}
                                <section className={styles.workspaceGrid} aria-label="Rebalance strategy and charts">
                                    <aside className={styles.panelCard} aria-label="Rebalance strategy controls">
                                        <div>
                                            <h2 className={styles.panelHeading}>Rebalance Strategy</h2>
                                            <p className={styles.panelSubheading}>
                                                Simulate trades, cash inflows, and drift bands without saving changes.
                                            </p>
                                        </div>

                                        <form className={styles.paramForm} onSubmit={(e) => e.preventDefault()}>
                                            <fieldset className={styles.fieldset}>
                                                <legend className={styles.legend}>Execution Mode</legend>

                                                <div className={styles.modeToggle} role="group" aria-label="Rebalance execution mode">
                                                    <button
                                                        type="button"
                                                        className={styles.modeBtn}
                                                        aria-pressed={rebalanceMode === 'FULL'}
                                                        onClick={() => setRebalanceMode('FULL')}
                                                    >
                                                        Full (Buy &amp; Sell)
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={styles.modeBtn}
                                                        aria-pressed={rebalanceMode === 'BUY_ONLY'}
                                                        onClick={() => setRebalanceMode('BUY_ONLY')}
                                                    >
                                                        Cash Inflow (Buy-Only)
                                                    </button>
                                                </div>

                                                {rebalanceMode === 'BUY_ONLY' && (
                                                    <div className={styles.field}>
                                                        <label className={styles.label} htmlFor="rebalance-new-cash">
                                                            New Cash Contribution ({currency})
                                                        </label>
                                                        <input
                                                            id="rebalance-new-cash"
                                                            type="number"
                                                            min={0}
                                                            step={100}
                                                            className={styles.input}
                                                            value={newCash}
                                                            onChange={(e) => setNewCash(Math.max(0, Number(e.target.value) || 0))}
                                                        />
                                                        <div className={styles.presetRow} role="group" aria-label="Quick cash presets">
                                                            {CASH_PRESETS.map((amt) => (
                                                                <button
                                                                    key={amt}
                                                                    type="button"
                                                                    className={styles.presetChip}
                                                                    aria-pressed={newCash === amt}
                                                                    onClick={() => setNewCash(amt)}
                                                                >
                                                                    +{format(amt, { maximumFractionDigits: 0 })}
                                                                </button>
                                                            ))}
                                                        </div>
                                                        <p className={styles.fieldHint}>
                                                            Directs new capital exclusively into underweight targets with zero taxable sells.
                                                        </p>
                                                    </div>
                                                )}
                                            </fieldset>

                                            <fieldset className={styles.fieldset}>
                                                <legend className={styles.legend}>Precision &amp; Drift Guard</legend>

                                                <div className={styles.field}>
                                                    <span className={styles.label}>
                                                        Drift Tolerance Band
                                                        <strong>&plusmn;{tolerancePercent}%</strong>
                                                    </span>
                                                    <div className={styles.presetRow} role="group" aria-label="Drift tolerance band">
                                                        {TOLERANCE_PRESETS.map((band) => (
                                                            <button
                                                                key={band}
                                                                type="button"
                                                                className={styles.presetChip}
                                                                aria-pressed={tolerancePercent === band}
                                                                onClick={() => setTolerancePercent(band)}
                                                            >
                                                                {band === 0 ? '0% Exact' : `±${band}%`}
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>

                                                <div className={styles.field}>
                                                    <span className={styles.label}>Share Sizing</span>
                                                    <div className={styles.modeToggle} role="group" aria-label="Share quantity precision">
                                                        <button
                                                            type="button"
                                                            className={styles.modeBtn}
                                                            aria-pressed={!wholeShares}
                                                            onClick={() => setWholeShares(false)}
                                                        >
                                                            Fractional
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className={styles.modeBtn}
                                                            aria-pressed={wholeShares}
                                                            onClick={() => setWholeShares(true)}
                                                        >
                                                            Whole Shares
                                                        </button>
                                                    </div>
                                                </div>
                                            </fieldset>

                                            <fieldset className={styles.fieldset}>
                                                <legend className={styles.legend}>Exclude Symbols</legend>
                                                <div className={styles.field}>
                                                    <label htmlFor="excludeSymbols" className={styles.srOnly}>
                                                        Exclude symbols comma separated
                                                    </label>
                                                    <input
                                                        id="excludeSymbols"
                                                        type="text"
                                                        placeholder="e.g. ZMMK.TO, CASH"
                                                        value={excludeSymbols}
                                                        onChange={(e) => setExcludeSymbols(e.target.value)}
                                                        className={styles.input}
                                                    />
                                                    {portfolioSymbols.length > 0 && (
                                                        <div className={styles.presetRow} aria-label="Quick toggle symbols to exclude">
                                                            {portfolioSymbols.slice(0, 14).map((sym) => {
                                                                const isExcluded = excludedSet.has(sym);
                                                                return (
                                                                    <button
                                                                        key={sym}
                                                                        type="button"
                                                                        className={`${styles.excludeChip} ${isExcluded ? styles.excludeChipActive : ''}`}
                                                                        aria-pressed={isExcluded}
                                                                        onClick={() => toggleExcludeChip(sym)}
                                                                        title={isExcluded ? `Include ${sym}` : `Exclude ${sym}`}
                                                                    >
                                                                        {sym}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            </fieldset>
                                        </form>
                                    </aside>

                                    <RebalancerCharts
                                        rows={rows}
                                        targets={targets}
                                        tolerancePercent={tolerancePercent}
                                        formatCurrency={format}
                                    />
                                </section>

                                {/* Tier 3: Execution Checklist */}
                                <section className={styles.panelCard} aria-label="Trade execution checklist">
                                    <div className={styles.checklistHeader}>
                                        <div>
                                            <h2 className={styles.panelHeading}>Execution Checklist</h2>
                                            <p className={styles.panelSubheading}>
                                                {completedActionableCount} of {actionableCount} recommended trades marked complete
                                            </p>
                                        </div>

                                        <div className={styles.checklistToolbar}>
                                            <div className={styles.filterPillGroup} role="group" aria-label="Filter checklist actions">
                                                {(
                                                    [
                                                        { id: 'ALL', label: `All (${rows.length})` },
                                                        { id: 'ACTIONABLE', label: `Trades (${actionableCount})` },
                                                        { id: 'BUY', label: `Buy (${summary.buyCount})` },
                                                        { id: 'SELL', label: `Sell (${summary.sellCount})` },
                                                        { id: 'HOLD', label: `Hold (${summary.holdCount})` }
                                                    ] as ReadonlyArray<{ id: ChecklistFilter; label: string }>
                                                ).map((tab) => (
                                                    <button
                                                        key={tab.id}
                                                        type="button"
                                                        className={styles.filterPillBtn}
                                                        aria-pressed={checklistFilter === tab.id}
                                                        onClick={() => setChecklistFilter(tab.id)}
                                                    >
                                                        {tab.label}
                                                    </button>
                                                ))}
                                            </div>

                                            {checkedTradeList.length > 0 && (
                                                <button
                                                    type="button"
                                                    className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                                    onClick={() => setCheckedTradeList([])}
                                                >
                                                    Reset Checks
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {!isTargetSumValid && targets.length > 0 && (
                                        <div className={styles.warningBanner}>
                                            <span>
                                                Target allocations sum to <strong>{summary.targetSumPercent.toFixed(1)}%</strong>. Open <strong>Configure Targets</strong> to normalize to 100% for balanced Buy/Sell totals.
                                            </span>
                                            <button
                                                type="button"
                                                className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                                onClick={() => setIsConfigOpen(true)}
                                            >
                                                Review Targets
                                            </button>
                                        </div>
                                    )}

                                    <div className={styles.tableResponsive}>
                                        <table className={styles.table}>
                                            <thead>
                                                <tr>
                                                    <th style={{ width: '48px' }}>Done</th>
                                                    <th>Asset</th>
                                                    <th className={styles.numericCol}>Current</th>
                                                    <th className={styles.numericCol}>Target</th>
                                                    <th className={styles.numericCol}>Drift</th>
                                                    <th>Recommended Action</th>
                                                    <th className={styles.numericCol}>Post-Trade</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {filteredRows.length === 0 ? (
                                                    <tr>
                                                        <td colSpan={7} style={{ textAlign: 'center', padding: '1.75rem 1rem', color: 'var(--text-secondary)' }}>
                                                            No assets match the selected checklist filter.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    filteredRows.map((d) => {
                                                        const isChecked = checkedTrades.has(d.symbol);
                                                        const driftBarWidth = Math.min(100, (Math.abs(d.driftPercent) / maxRowAbsDrift) * 100);
                                                        return (
                                                            <tr key={d.symbol} className={isChecked ? styles.checkedRow : ''}>
                                                                <td>
                                                                    <label className={styles.checkboxLabel}>
                                                                        <input
                                                                            type="checkbox"
                                                                            className={styles.checkboxInput}
                                                                            checked={isChecked}
                                                                            aria-label={`Mark ${d.symbol} trade done`}
                                                                            onChange={() => toggleTradeCheck(d.symbol)}
                                                                        />
                                                                    </label>
                                                                </td>
                                                                <td>
                                                                    <Link href={`/analysis/${encodeURIComponent(d.symbol)}`} className={styles.symbolLink}>
                                                                        <span>{d.symbol}</span>
                                                                        {d.isUntargeted && (
                                                                            <span className={styles.untargetedBadge}>No Target</span>
                                                                        )}
                                                                    </Link>
                                                                    {d.assetPrice > 0 && (
                                                                        <span className={styles.subValue}>
                                                                            {d.assetCurrency} {d.assetPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                                        </span>
                                                                    )}
                                                                </td>
                                                                <td className={styles.numericCol}>
                                                                    <strong>{d.currentPercent.toFixed(2)}%</strong>
                                                                    <span className={styles.subValue}>{format(d.currentValue)}</span>
                                                                </td>
                                                                <td className={styles.numericCol}>
                                                                    <strong>{d.targetPercent.toFixed(2)}%</strong>
                                                                    <span className={styles.subValue}>
                                                                        {format(d.targetValue)}
                                                                        {d.glidePathPercent !== null && d.glidePathPercent !== 0 && (
                                                                            <> &bull; {d.glidePathPercent > 0 ? '+' : ''}{d.glidePathPercent}%/yr</>
                                                                        )}
                                                                    </span>
                                                                </td>
                                                                <td className={styles.numericCol}>
                                                                    <div className={styles.driftCell}>
                                                                        <span
                                                                            className={`${styles.driftTag} ${
                                                                                d.driftPercent > tolerancePercent + 1e-9
                                                                                    ? styles.driftOver
                                                                                    : d.driftPercent < -(tolerancePercent + 1e-9)
                                                                                        ? styles.driftUnder
                                                                                        : styles.driftNeutral
                                                                            }`}
                                                                        >
                                                                            {d.driftPercent > 0 ? '+' : ''}{d.driftPercent.toFixed(2)}%
                                                                        </span>
                                                                        <div className={styles.driftMicroTrack} aria-hidden="true">
                                                                            <div
                                                                                className={d.driftPercent >= 0 ? styles.driftMicroFillOver : styles.driftMicroFillUnder}
                                                                                style={{ width: `${driftBarWidth}%` }}
                                                                            />
                                                                        </div>
                                                                    </div>
                                                                </td>
                                                                <td>
                                                                    {d.effectiveAction === 'HOLD' ? (
                                                                        <span className={`${styles.actionTag} ${styles.actionHOLD}`}>HOLD</span>
                                                                    ) : (
                                                                        <span className={`${styles.actionTag} ${styles[`action${d.effectiveAction}`]}`}>
                                                                            {d.effectiveAction} {formatShareCount(d.tradeShares, wholeShares)} sh ({format(d.tradeValue)})
                                                                        </span>
                                                                    )}
                                                                </td>
                                                                <td className={styles.numericCol}>
                                                                    <strong>{d.postTradePercent.toFixed(2)}%</strong>
                                                                    <span className={styles.subValue}>
                                                                        {d.postTradeDriftPercent > 0 ? '+' : ''}{d.postTradeDriftPercent.toFixed(2)}% drift
                                                                    </span>
                                                                </td>
                                                            </tr>
                                                        );
                                                    })
                                                )}
                                            </tbody>
                                        </table>
                                    </div>
                                </section>
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
