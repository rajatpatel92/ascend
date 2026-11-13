'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    ResponsiveContainer,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
    ReferenceLine
} from 'recharts';
import { useCurrency } from '@/context/CurrencyContext';
import styles from './page.module.css';

type PhaseType = 'Accumulation' | 'Retirement';
type CalculationMode = 'FIXED_RATE' | 'FIXED_HORIZON';
type ActiveTab = 'chart' | 'table';
type PhaseFilter = 'ALL' | PhaseType;

interface YearProjection {
    year: number;
    phase: PhaseType;
    principal: number;
    gains: number;
    total: number;
    withdrawal: number;
}

const SWR_PRESETS = [3.5, 4.0, 4.5] as const;

function getDefaultFireDate(): string {
    const d = new Date();
    const y = d.getFullYear() + 10;
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

function formatMonthYear(yearMonth: string): string {
    const [yStr, mStr] = yearMonth.split('-');
    const year = Number(yStr);
    const month = Number(mStr);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
        return yearMonth;
    }
    return new Date(year, month - 1, 15).toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric'
    });
}

export default function FireAnalysisPage() {
    const { currency, convert, format, rates, loading: currencyLoading } = useCurrency();

    // Theme awareness for chart grid/axis strokes
    const [isDark, setIsDark] = useState(false);

    // Raw USD portfolio value from /api/portfolio
    const [rawPortfolioValueUSD, setRawPortfolioValueUSD] = useState<number>(0);
    const [loadingPortfolio, setLoadingPortfolio] = useState<boolean>(true);
    const [fetchError, setFetchError] = useState<string | null>(null);

    // Simulation inputs
    const [fireDate, setFireDate] = useState<string>(getDefaultFireDate);
    const [monthlyContribution, setMonthlyContribution] = useState<number>(2000);
    const [expectedReturn, setExpectedReturn] = useState<number>(7.0);
    const [inflationRate, setInflationRate] = useState<number>(2.5);
    const [currentMonthlyExpense, setCurrentMonthlyExpense] = useState<number>(2000);

    const [calculationMode, setCalculationMode] = useState<CalculationMode>('FIXED_RATE');
    const [withdrawalRate, setWithdrawalRate] = useState<number>(4.0);
    const [withdrawalDuration, setWithdrawalDuration] = useState<number>(30);

    // Tab and table filter states
    const [activeTab, setActiveTab] = useState<ActiveTab>('chart');
    const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>('ALL');

    const chartTabRef = useRef<HTMLButtonElement>(null);
    const tableTabRef = useRef<HTMLButtonElement>(null);
    const prevCurrencyRef = useRef<string>(currency);

    useEffect(() => {
        const updateTheme = () => {
            setIsDark(document.documentElement.getAttribute('data-theme') === 'dark');
        };
        updateTheme();
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
        return () => observer.disconnect();
    }, []);

    // Fetch current portfolio value (API returns USD by default)
    useEffect(() => {
        const controller = new AbortController();

        fetch('/api/portfolio', { signal: controller.signal })
            .then((res) => {
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                return res.json();
            })
            .then((data) => {
                if (typeof data?.totalValue === 'number' && Number.isFinite(data.totalValue)) {
                    setRawPortfolioValueUSD(data.totalValue);
                }
                setFetchError(null);
                setLoadingPortfolio(false);
            })
            .catch((err: unknown) => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to fetch portfolio value for FIRE:', err);
                setFetchError('Unable to load live portfolio balance. Using manual simulation baseline.');
                setLoadingPortfolio(false);
            });

        return () => controller.abort();
    }, []);

    // Convert currency-denominated inputs when active currency changes
    useEffect(() => {
        if (!currencyLoading && rates?.[currency] === 1 && prevCurrencyRef.current !== currency) {
            const oldCurrency = prevCurrencyRef.current;
            setMonthlyContribution((prev) => Math.round(convert(prev, oldCurrency)));
            setCurrentMonthlyExpense((prev) => Math.round(convert(prev, oldCurrency)));
            prevCurrencyRef.current = currency;
        }
    }, [currency, currencyLoading, rates, convert]);

    const currentPortfolioValue = useMemo(
        () => convert(rawPortfolioValueUSD, 'USD'),
        [rawPortfolioValueUSD, convert]
    );

    // Run deterministic FIRE accumulation & depletion projection
    const simulation = useMemo(() => {
        const today = new Date();
        const startYear = today.getFullYear();
        const startMonth = today.getMonth();

        const [yStr, mStr] = fireDate.split('-');
        const parsedYear = Number(yStr);
        const parsedMonth = Number(mStr);

        let fireYear =
            Number.isFinite(parsedYear) && parsedYear >= 1900 && parsedYear <= startYear + 80
                ? parsedYear
                : startYear + 10;
        let fireMonth =
            Number.isFinite(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12
                ? parsedMonth - 1
                : startMonth;

        let isPastDateClamped = false;
        if (fireYear < startYear || (fireYear === startYear && fireMonth < startMonth)) {
            fireYear = startYear;
            fireMonth = startMonth;
            isPastDateClamped = true;
        }
        const effectiveFireDate = `${fireYear}-${String(fireMonth + 1).padStart(2, '0')}`;

        const monthsToAccumulate = Math.max(
            0,
            (fireYear - startYear) * 12 + (fireMonth - startMonth)
        );

        const safeContribution = Math.max(0, Number.isFinite(monthlyContribution) ? monthlyContribution : 0);
        const safeExpense = Math.max(0, Number.isFinite(currentMonthlyExpense) ? currentMonthlyExpense : 0);
        const safeReturn = Math.max(-99, Number.isFinite(expectedReturn) ? expectedReturn : 0);
        const safeInflation = Math.max(-99, Number.isFinite(inflationRate) ? inflationRate : 0);
        const safeSwr = Math.max(0.1, Number.isFinite(withdrawalRate) ? withdrawalRate : 4.0);
        const safeHorizonYears = Math.max(1, Math.min(80, Number.isFinite(withdrawalDuration) ? withdrawalDuration : 30));

        const monthlyReturnRate = safeReturn / 100 / 12;
        const monthlyInflationRate = safeInflation / 100 / 12;

        let currentPrincipal = Math.max(0, currentPortfolioValue);
        let currentInterest = 0;
        let currentTotal = Math.max(0, currentPortfolioValue);

        const yearlyData: YearProjection[] = [];

        // Phase 1: Accumulation
        for (let i = 1; i <= monthsToAccumulate; i++) {
            const simDate = new Date(startYear, startMonth + i, 1);
            currentPrincipal += safeContribution;
            const interestEarned = (currentTotal + safeContribution) * monthlyReturnRate;
            currentInterest += interestEarned;
            currentTotal = Math.max(0, currentTotal + safeContribution + interestEarned);

            if (simDate.getMonth() === 11) {
                yearlyData.push({
                    year: simDate.getFullYear(),
                    phase: 'Accumulation',
                    principal: Math.round(currentPrincipal),
                    gains: Math.round(currentInterest),
                    total: Math.round(currentTotal),
                    withdrawal: 0
                });
            }
        }

        const projectedFireValue = currentTotal;
        const projectedPrincipal = currentPrincipal;
        const projectedGains = currentInterest;

        // Compute initial monthly withdrawal under active strategy (start-of-month / annuity due)
        let initialMonthlyWithdrawal = 0;
        let computedWithdrawalRate = safeSwr;

        if (calculationMode === 'FIXED_HORIZON') {
            const rReal = (1 + monthlyReturnRate) / (1 + monthlyInflationRate) - 1;
            const n = safeHorizonYears * 12;
            const monthlyAnnuityFactor =
                Math.abs(rReal) < 1e-9
                    ? 1 / n
                    : (rReal * Math.pow(1 + rReal, n)) /
                      ((Math.pow(1 + rReal, n) - 1) * (1 + rReal));
            initialMonthlyWithdrawal = projectedFireValue * monthlyAnnuityFactor;
            computedWithdrawalRate = monthlyAnnuityFactor * 12 * 100;
        } else {
            initialMonthlyWithdrawal = (projectedFireValue * (safeSwr / 100)) / 12;
            computedWithdrawalRate = safeSwr;
        }

        // Phase 2: Retirement Depletion (up to 60 years)
        let depletionTotal = projectedFireValue;
        let depletionPrincipal = projectedPrincipal;
        let depletionInterest = projectedGains;
        let currentMonthlyWithdrawal = initialMonthlyWithdrawal;
        let yearWithdrawalAccum = 0;
        let sustainedMonths = 0;
        let depletedAtMonth: number | null = null;
        const maxDepletionMonths = 60 * 12;

        for (let m = 1; m <= maxDepletionMonths; m++) {
            const simDate = new Date(fireYear, fireMonth + m, 1);
            const targetWithdrawal = Math.max(0, currentMonthlyWithdrawal);

            if (depletionTotal > 1e-6) {
                const wasFullyFunded = depletionTotal >= targetWithdrawal - 0.01;
                const actualWithdrawal = Math.min(depletionTotal, targetWithdrawal);
                const principalRatio = Math.min(1, Math.max(0, depletionPrincipal / depletionTotal));
                depletionPrincipal = Math.max(0, depletionPrincipal - actualWithdrawal * principalRatio);
                depletionTotal = Math.max(0, depletionTotal - actualWithdrawal);
                depletionInterest = Math.max(0, depletionTotal - depletionPrincipal);
                yearWithdrawalAccum += actualWithdrawal;

                const interestEarned = depletionTotal * monthlyReturnRate;
                depletionInterest += interestEarned;
                depletionTotal = Math.max(0, depletionTotal + interestEarned);

                if (wasFullyFunded) {
                    sustainedMonths = m;
                } else if (depletedAtMonth === null) {
                    depletedAtMonth = m - 1;
                }
            } else if (depletedAtMonth === null) {
                depletedAtMonth = m - 1;
            }

            currentMonthlyWithdrawal *= 1 + monthlyInflationRate;

            if (simDate.getMonth() === 11) {
                yearlyData.push({
                    year: simDate.getFullYear(),
                    phase: 'Retirement',
                    principal: Math.round(depletionPrincipal),
                    gains: Math.round(depletionInterest),
                    total: Math.round(depletionTotal),
                    withdrawal: Math.round(yearWithdrawalAccum)
                });
                yearWithdrawalAccum = 0;
            }
        }

        // Guarantee fireYear appears in chart data if portfolio started at 0 / fireMonth === 11 edge
        const hasFireYear = yearlyData.some((row) => row.year === fireYear);
        if (!hasFireYear) {
            yearlyData.push({
                year: fireYear,
                phase: 'Retirement',
                principal: Math.round(projectedPrincipal),
                gains: Math.round(projectedGains),
                total: Math.round(projectedFireValue),
                withdrawal: 0
            });
            yearlyData.sort((a, b) => a.year - b.year);
        }

        // Lifestyle Expense Longevity Check (inflation-adjusted required expense at FIRE date)
        const yearsToFire = monthsToAccumulate / 12;
        const futureMonthlyExpense = safeExpense * Math.pow(1 + safeInflation / 100, yearsToFire);

        let lifestyleBalance = projectedFireValue;
        let neededMonthly = futureMonthlyExpense;
        let lifestyleMonths = 0;
        const maxLifestyleMonths = 1200; // 100 years cap

        for (let m = 1; m <= maxLifestyleMonths; m++) {
            if (lifestyleBalance <= 0) break;
            lifestyleBalance = Math.max(0, lifestyleBalance - neededMonthly);
            lifestyleBalance += lifestyleBalance * monthlyReturnRate;
            neededMonthly *= 1 + monthlyInflationRate;
            lifestyleMonths = m;
        }

        const effectiveSwr =
            calculationMode === 'FIXED_HORIZON' ? computedWithdrawalRate : safeSwr;
        const requiredFireNumber =
            effectiveSwr > 0 ? (futureMonthlyExpense * 12) / (effectiveSwr / 100) : 0;

        const currentProgressPct =
            requiredFireNumber > 0
                ? Math.min(100, Math.max(0, (currentPortfolioValue / requiredFireNumber) * 100))
                : 100;
        const projectedProgressPct =
            requiredFireNumber > 0
                ? Math.min(100, Math.max(0, (projectedFireValue / requiredFireNumber) * 100))
                : 100;

        const monthlySurplus = initialMonthlyWithdrawal - futureMonthlyExpense;
        const expenseCoveragePct =
            futureMonthlyExpense > 0
                ? Math.min(999, (initialMonthlyWithdrawal / futureMonthlyExpense) * 100)
                : 100;

        const realReturnPct = ((1 + safeReturn / 100) / (1 + safeInflation / 100) - 1) * 100;
        const strategyYears = Math.floor((depletedAtMonth ?? sustainedMonths) / 12);
        const lifestyleYears = Math.floor(lifestyleMonths / 12);
        const isPerpetual = depletedAtMonth === null && depletionTotal >= projectedFireValue * 0.99;

        return {
            fireYear,
            effectiveFireDate,
            isPastDateClamped,
            safeHorizonYears,
            yearsToFire,
            yearlyData,
            projectedFireValue,
            projectedPrincipal,
            projectedGains,
            initialMonthlyWithdrawal,
            effectiveSwr,
            futureMonthlyExpense,
            requiredFireNumber,
            currentProgressPct,
            projectedProgressPct,
            monthlySurplus,
            expenseCoveragePct,
            realReturnPct,
            strategyYears,
            lifestyleYears,
            isPerpetual,
            depletedAtMonth
        };
    }, [
        fireDate,
        monthlyContribution,
        expectedReturn,
        inflationRate,
        currentMonthlyExpense,
        calculationMode,
        withdrawalRate,
        withdrawalDuration,
        currentPortfolioValue
    ]);

    const filteredTableRows = useMemo(() => {
        if (phaseFilter === 'ALL') return simulation.yearlyData;
        return simulation.yearlyData.filter((row) => row.phase === phaseFilter);
    }, [simulation.yearlyData, phaseFilter]);

    const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const order: ActiveTab[] = ['chart', 'table'];
        const currentIdx = order.indexOf(activeTab);
        let nextTab: ActiveTab | null = null;

        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            nextTab = order[(currentIdx + 1) % order.length];
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            nextTab = order[(currentIdx - 1 + order.length) % order.length];
        } else if (e.key === 'Home') {
            nextTab = order[0];
        } else if (e.key === 'End') {
            nextTab = order[order.length - 1];
        }

        if (nextTab) {
            e.preventDefault();
            setActiveTab(nextTab);
            const targetRef = nextTab === 'chart' ? chartTabRef : tableTabRef;
            targetRef.current?.focus();
        }
    };

    const gridStroke = isDark ? 'rgba(148, 163, 184, 0.14)' : 'rgba(15, 23, 42, 0.08)';
    const axisStroke = isDark ? '#94a3b8' : '#64748b';
    const fireMarkerColor = isDark ? '#fbbf24' : '#b45309';
    const yearsLabel =
        simulation.yearsToFire < 1
            ? 'FIRE Target Window'
            : `${Math.round(simulation.yearsToFire)} Years to FIRE`;
    const horizonMet =
        calculationMode === 'FIXED_HORIZON' && simulation.strategyYears >= simulation.safeHorizonYears;

    const formatCompactCurrency = (value: number): string => {
        const formatted = format(value, { maximumFractionDigits: 0 });
        if (Math.abs(value) >= 1_000_000) {
            return format(value, { notation: 'compact', maximumFractionDigits: 1 });
        }
        return formatted;
    };

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>FIRE Independence Planner</h1>
                    <p className={styles.subtitle}>
                        Simulate your accumulation trajectory, safe withdrawal sustainability, and inflation-adjusted retirement lifestyle.
                    </p>
                </div>
                <div className={styles.headerBadge}>
                    <span>Current Baseline:</span>
                    <span className={styles.headerBadgeStrong}>
                        {loadingPortfolio ? 'Loading...' : format(currentPortfolioValue, { maximumFractionDigits: 0 })}
                    </span>
                </div>
            </header>

            {fetchError && (
                <div className={styles.errorBanner} role="alert">
                    {fetchError}
                </div>
            )}

            <div className={styles.pageGrid}>
                {/* Tier 1: 4-Card FIRE Readiness KPI Strip */}
                <section className={styles.kpiStrip} aria-label="FIRE readiness summary">
                    {/* Hero Card: Projected FIRE Nest Egg */}
                    <article className={styles.heroCard}>
                        <div className={styles.heroTop}>
                            <span className={styles.heroLabel}>
                                Projected FIRE Nest Egg ({formatMonthYear(simulation.effectiveFireDate)})
                            </span>
                            <div className={styles.heroValue}>
                                {format(simulation.projectedFireValue, { maximumFractionDigits: 0 })}
                            </div>
                            <span className={styles.heroPill}>{yearsLabel}</span>
                        </div>
                        <div className={styles.heroFooter}>
                            <span>
                                Principal: <strong>{format(simulation.projectedPrincipal, { maximumFractionDigits: 0 })}</strong>
                            </span>
                            <span>
                                Gains: <strong>{format(simulation.projectedGains, { maximumFractionDigits: 0 })}</strong>
                            </span>
                        </div>
                    </article>

                    {/* Card 2: Monthly Retirement Cash Flow */}
                    <article className={styles.kpiCard}>
                        <div>
                            <div className={styles.kpiHeader}>
                                <span className={styles.kpiLabel}>Monthly Retirement Cash Flow</span>
                                <span
                                    className={`${styles.statusPill} ${
                                        simulation.monthlySurplus >= 0 ? styles.statusPositive : styles.statusWarning
                                    }`}
                                >
                                    {simulation.expenseCoveragePct.toFixed(0)}% covered
                                </span>
                            </div>
                            <div className={styles.kpiMain}>
                                <span className={styles.kpiValue}>
                                    {format(simulation.initialMonthlyWithdrawal, { maximumFractionDigits: 0 })}
                                </span>
                                <span className={styles.kpiUnit}>/ mo</span>
                            </div>
                            <p className={styles.kpiSub}>
                                Safe withdrawal ({simulation.effectiveSwr.toFixed(2)}% SWR) vs.{' '}
                                <span className={styles.kpiStrong}>
                                    {format(simulation.futureMonthlyExpense, { maximumFractionDigits: 0 })}/mo
                                </span>{' '}
                                needed in {simulation.fireYear}.
                            </p>
                        </div>
                        <div className={styles.kpiFooter}>
                            <span>Monthly Margin</span>
                            <span className={styles.kpiStrong}>
                                {simulation.monthlySurplus >= 0 ? '+' : ''}
                                {format(simulation.monthlySurplus, { maximumFractionDigits: 0 })}/mo
                            </span>
                        </div>
                    </article>

                    {/* Card 3: FIRE Number & Coast Progress */}
                    <article className={styles.kpiCard}>
                        <div>
                            <div className={styles.kpiHeader}>
                                <span className={styles.kpiLabel}>FIRE Target &amp; Progress</span>
                                <span
                                    className={`${styles.statusPill} ${
                                        simulation.projectedProgressPct >= 100
                                            ? styles.statusPositive
                                            : styles.statusWarning
                                    }`}
                                >
                                    {simulation.projectedProgressPct.toFixed(0)}% at FIRE
                                </span>
                            </div>
                            <div className={styles.kpiValue}>
                                {format(simulation.requiredFireNumber, { maximumFractionDigits: 0 })}
                            </div>
                            <p className={styles.kpiSub}>
                                Capital needed at {simulation.effectiveSwr.toFixed(1)}% SWR to cover inflated lifestyle.
                            </p>
                        </div>
                        <div className={styles.progressTrack} aria-hidden="true">
                            <div
                                className={styles.progressFillProjected}
                                style={{ width: `${simulation.projectedProgressPct}%` }}
                            />
                            <div
                                className={styles.progressFillCurrent}
                                style={{ width: `${simulation.currentProgressPct}%` }}
                            />
                        </div>
                        <div className={styles.kpiFooter}>
                            <span>
                                Today: <strong className={styles.kpiStrong}>{simulation.currentProgressPct.toFixed(1)}%</strong>
                            </span>
                            <span>
                                In {simulation.fireYear}:{' '}
                                <strong className={styles.kpiStrong}>{simulation.projectedProgressPct.toFixed(0)}%</strong>
                            </span>
                        </div>
                    </article>

                    {/* Card 4: Portfolio Longevity & Sustainability */}
                    <article className={styles.kpiCard}>
                        <div>
                            <div className={styles.kpiHeader}>
                                <span className={styles.kpiLabel}>Portfolio Longevity</span>
                                <span
                                    className={`${styles.statusPill} ${
                                        simulation.depletedAtMonth === null || horizonMet
                                            ? styles.statusPositive
                                            : styles.statusNegative
                                    }`}
                                >
                                    {simulation.isPerpetual
                                        ? 'Perpetual'
                                        : simulation.depletedAtMonth === null
                                          ? '60+ Years'
                                          : horizonMet
                                            ? `${simulation.safeHorizonYears}y Horizon Met`
                                            : `Depletes Yr ${simulation.strategyYears}`}
                                </span>
                            </div>
                            <div className={styles.kpiValue}>
                                {simulation.depletedAtMonth === null ? '60+ Years' : `${simulation.strategyYears} Years`}
                            </div>
                            <p className={styles.kpiSub}>
                                Under {calculationMode === 'FIXED_RATE' ? 'fixed SWR' : `${withdrawalDuration}-year horizon`} plan;
                                lifestyle expenses last{' '}
                                <span className={styles.kpiStrong}>
                                    {simulation.lifestyleYears >= 99 ? '99+ yrs' : `${simulation.lifestyleYears} yrs`}
                                </span>.
                            </p>
                        </div>
                        <div className={styles.kpiFooter}>
                            <span>Real Return (Post-Inflation)</span>
                            <span className={styles.kpiStrong}>{simulation.realReturnPct.toFixed(2)}%</span>
                        </div>
                    </article>
                </section>

                {/* Tier 2: Parameter Form (Left) + Tabbed Chart / Table Workspace (Right) */}
                <div className={styles.workspaceGrid}>
                    <aside className={styles.panelCard}>
                        <h2 id="fire-params-heading" className={styles.panelHeading}>
                            Simulation Parameters
                        </h2>

                        <form
                            className={styles.paramForm}
                            onSubmit={(e) => e.preventDefault()}
                            aria-labelledby="fire-params-heading"
                        >
                            {/* Group 1: Accumulation & Growth */}
                            <fieldset className={styles.fieldset}>
                                <legend className={styles.legend}>Accumulation &amp; Growth</legend>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="fire-target-date">
                                        Target FIRE Date
                                    </label>
                                    <input
                                        id="fire-target-date"
                                        name="fireDate"
                                        type="month"
                                        className={styles.input}
                                        value={fireDate}
                                        aria-describedby={simulation.isPastDateClamped ? 'fire-date-hint' : undefined}
                                        onChange={(e) => setFireDate(e.target.value)}
                                    />
                                    {simulation.isPastDateClamped && (
                                        <p id="fire-date-hint" className={styles.fieldHint}>
                                            Adjusted to {formatMonthYear(simulation.effectiveFireDate)} for forward simulation.
                                        </p>
                                    )}
                                </div>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="fire-monthly-contribution">
                                        Monthly Contribution ({currency})
                                    </label>
                                    <input
                                        id="fire-monthly-contribution"
                                        name="monthlyContribution"
                                        type="number"
                                        min={0}
                                        step={100}
                                        className={styles.input}
                                        value={monthlyContribution}
                                        onChange={(e) => setMonthlyContribution(Number(e.target.value))}
                                    />
                                </div>

                                <div className={styles.fieldRow}>
                                    <div className={styles.field}>
                                        <label className={styles.label} htmlFor="fire-expected-return">
                                            Return (%)
                                        </label>
                                        <input
                                            id="fire-expected-return"
                                            name="expectedReturn"
                                            type="number"
                                            min={0}
                                            max={25}
                                            step={0.1}
                                            className={styles.input}
                                            value={expectedReturn}
                                            onChange={(e) => setExpectedReturn(Number(e.target.value))}
                                        />
                                    </div>

                                    <div className={styles.field}>
                                        <label className={styles.label} htmlFor="fire-inflation-rate">
                                            Inflation (%)
                                        </label>
                                        <input
                                            id="fire-inflation-rate"
                                            name="inflationRate"
                                            type="number"
                                            min={0}
                                            max={15}
                                            step={0.1}
                                            className={styles.input}
                                            value={inflationRate}
                                            onChange={(e) => setInflationRate(Number(e.target.value))}
                                        />
                                    </div>
                                </div>
                            </fieldset>

                            {/* Group 2: Retirement Lifestyle */}
                            <fieldset className={styles.fieldset}>
                                <legend className={styles.legend}>Retirement Lifestyle</legend>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="fire-monthly-expense">
                                        Monthly Expenses Today ({currency})
                                    </label>
                                    <input
                                        id="fire-monthly-expense"
                                        name="currentMonthlyExpense"
                                        type="number"
                                        min={0}
                                        step={100}
                                        className={styles.input}
                                        value={currentMonthlyExpense}
                                        onChange={(e) => setCurrentMonthlyExpense(Number(e.target.value))}
                                        aria-describedby="fire-expense-hint"
                                    />
                                    <p id="fire-expense-hint" className={styles.fieldHint}>
                                        Inflation-adjusted at FIRE ({simulation.fireYear}):{' '}
                                        <strong className={styles.kpiStrong}>
                                            {format(simulation.futureMonthlyExpense, { maximumFractionDigits: 0 })}/mo
                                        </strong>
                                    </p>
                                </div>
                            </fieldset>

                            {/* Group 3: Withdrawal Strategy */}
                            <fieldset className={styles.fieldset}>
                                <legend className={styles.legend}>Withdrawal Strategy</legend>

                                <div className={styles.modeToggle} role="group" aria-label="Withdrawal calculation mode">
                                    <button
                                        type="button"
                                        className={styles.modeBtn}
                                        aria-pressed={calculationMode === 'FIXED_RATE'}
                                        onClick={() => setCalculationMode('FIXED_RATE')}
                                    >
                                        Fixed Rate (SWR)
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.modeBtn}
                                        aria-pressed={calculationMode === 'FIXED_HORIZON'}
                                        onClick={() => setCalculationMode('FIXED_HORIZON')}
                                    >
                                        Fixed Horizon
                                    </button>
                                </div>

                                {calculationMode === 'FIXED_RATE' ? (
                                    <div className={styles.field}>
                                        <label className={styles.label} htmlFor="fire-swr-input">
                                            Safe Withdrawal Rate (%)
                                        </label>
                                        <input
                                            id="fire-swr-input"
                                            name="withdrawalRate"
                                            type="number"
                                            min={0.5}
                                            max={15}
                                            step={0.1}
                                            className={styles.input}
                                            value={withdrawalRate}
                                            onChange={(e) => setWithdrawalRate(Number(e.target.value))}
                                        />
                                        <div className={styles.presetRow} role="group" aria-label="Common safe withdrawal rate presets">
                                            {SWR_PRESETS.map((preset) => (
                                                <button
                                                    key={preset}
                                                    type="button"
                                                    className={styles.presetChip}
                                                    aria-pressed={Math.abs(withdrawalRate - preset) < 0.05}
                                                    onClick={() => setWithdrawalRate(preset)}
                                                >
                                                    {preset.toFixed(1)}%
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <div className={styles.field}>
                                        <label className={styles.label} htmlFor="fire-horizon-input">
                                            Retirement Duration (Years)
                                        </label>
                                        <input
                                            id="fire-horizon-input"
                                            name="withdrawalDuration"
                                            type="number"
                                            min={5}
                                            max={80}
                                            step={1}
                                            className={styles.input}
                                            value={withdrawalDuration}
                                            onChange={(e) => setWithdrawalDuration(Number(e.target.value))}
                                            aria-describedby="fire-horizon-hint"
                                        />
                                        <p id="fire-horizon-hint" className={styles.fieldHint}>
                                            Implied starting SWR:{' '}
                                            <strong className={styles.kpiStrong}>
                                                {simulation.effectiveSwr.toFixed(2)}%
                                            </strong>
                                        </p>
                                    </div>
                                )}
                            </fieldset>
                        </form>
                    </aside>

                    {/* Right Tabbed Projection Chart / Breakdown Table */}
                    <section className={styles.panelCard} aria-label="FIRE projection visualizations">
                        <div className={styles.tabHeaderRow}>
                            <div className={styles.tabListWrap}>
                                <div
                                    role="tablist"
                                    aria-label="FIRE projection views"
                                    className={styles.tabList}
                                    onKeyDown={handleTabKeyDown}
                                >
                                    <button
                                        ref={chartTabRef}
                                        type="button"
                                        role="tab"
                                        id="tab-fire-chart"
                                        aria-selected={activeTab === 'chart'}
                                        tabIndex={activeTab === 'chart' ? 0 : -1}
                                        className={styles.tabBtn}
                                        onClick={() => setActiveTab('chart')}
                                    >
                                        Projection Chart
                                    </button>
                                    <button
                                        ref={tableTabRef}
                                        type="button"
                                        role="tab"
                                        id="tab-fire-table"
                                        aria-selected={activeTab === 'table'}
                                        tabIndex={activeTab === 'table' ? 0 : -1}
                                        className={styles.tabBtn}
                                        onClick={() => setActiveTab('table')}
                                    >
                                        Yearly Breakdown Table
                                    </button>
                                </div>
                            </div>

                            {activeTab === 'chart' && (
                                <div className={styles.legendStrip}>
                                    <span className={styles.legendItem}>
                                        <span className={styles.dotBlue} aria-hidden="true" />
                                        Principal
                                    </span>
                                    <span className={styles.legendItem}>
                                        <span className={styles.dotGreen} aria-hidden="true" />
                                        Compounded Gains
                                    </span>
                                    <span className={styles.legendItem}>
                                        <span className={styles.dotAmber} aria-hidden="true" />
                                        FIRE ({simulation.fireYear})
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Tab Panel 1: Stacked Trajectory BarChart */}
                        <div
                            role="tabpanel"
                            id="panel-fire-chart"
                            aria-labelledby="tab-fire-chart"
                            hidden={activeTab !== 'chart'}
                            tabIndex={activeTab === 'chart' ? 0 : undefined}
                        >
                            {activeTab === 'chart' && (
                                <div className={styles.panelInner}>
                                    <div className={styles.chartWrap}>
                                        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                                            <BarChart
                                                data={simulation.yearlyData}
                                                margin={{ top: 28, right: 20, left: 6, bottom: 8 }}
                                            >
                                                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                                                <XAxis
                                                    dataKey="year"
                                                    stroke={axisStroke}
                                                    fontSize={12}
                                                    tickLine={false}
                                                    axisLine={false}
                                                    minTickGap={24}
                                                />
                                                <YAxis
                                                    stroke={axisStroke}
                                                    fontSize={12}
                                                    tickLine={false}
                                                    axisLine={false}
                                                    width={72}
                                                    tickFormatter={formatCompactCurrency}
                                                />
                                                <Tooltip
                                                    cursor={{ fill: isDark ? 'rgba(148, 163, 184, 0.08)' : 'rgba(15, 23, 42, 0.05)' }}
                                                    content={({ active, payload }) => {
                                                        if (!active || !payload || payload.length === 0) return null;
                                                        const point = payload[0]?.payload as YearProjection | undefined;
                                                        if (!point) return null;

                                                        return (
                                                            <div className={styles.tooltipBox}>
                                                                <div className={styles.tooltipHead}>
                                                                    <span>Year {point.year}</span>
                                                                    <span className={styles.tooltipPhase}>{point.phase}</span>
                                                                </div>
                                                                <div className={styles.tooltipRow}>
                                                                    <span>Principal</span>
                                                                    <span>{format(point.principal, { maximumFractionDigits: 0 })}</span>
                                                                </div>
                                                                <div className={styles.tooltipRow}>
                                                                    <span>Compounded Gains</span>
                                                                    <span>{format(point.gains, { maximumFractionDigits: 0 })}</span>
                                                                </div>
                                                                {point.withdrawal > 0 && (
                                                                    <div className={styles.tooltipRow}>
                                                                        <span>Annual Withdrawal</span>
                                                                        <span>{format(point.withdrawal, { maximumFractionDigits: 0 })}</span>
                                                                    </div>
                                                                )}
                                                                <div className={`${styles.tooltipRow} ${styles.tooltipTotalRow}`}>
                                                                    <span>Total Value</span>
                                                                    <span>{format(point.total, { maximumFractionDigits: 0 })}</span>
                                                                </div>
                                                            </div>
                                                        );
                                                    }}
                                                />
                                                <ReferenceLine
                                                    x={simulation.fireYear}
                                                    stroke={fireMarkerColor}
                                                    strokeWidth={2}
                                                    strokeDasharray="5 5"
                                                    label={{
                                                        value: `FIRE Target (${simulation.fireYear})`,
                                                        position: 'top',
                                                        fill: fireMarkerColor,
                                                        fontSize: 12,
                                                        fontWeight: 700
                                                    }}
                                                />
                                                <Bar
                                                    dataKey="principal"
                                                    name="Principal"
                                                    stackId="wealth"
                                                    fill="#2563eb"
                                                    radius={[0, 0, 0, 0]}
                                                />
                                                <Bar
                                                    dataKey="gains"
                                                    name="Compounded Gains"
                                                    stackId="wealth"
                                                    fill="#10b981"
                                                    radius={[3, 3, 0, 0]}
                                                />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Tab Panel 2: Contained Responsive Yearly Breakdown Table */}
                        <div
                            role="tabpanel"
                            id="panel-fire-table"
                            aria-labelledby="tab-fire-table"
                            hidden={activeTab !== 'table'}
                        >
                            {activeTab === 'table' && (
                                <div className={styles.panelInner}>
                                    <div className={styles.tableToolbar}>
                                        <div className={styles.filterGroup} role="group" aria-label="Filter breakdown by phase">
                                            {(['ALL', 'Accumulation', 'Retirement'] as const).map((option) => (
                                                <button
                                                    key={option}
                                                    type="button"
                                                    className={styles.filterBtn}
                                                    aria-pressed={phaseFilter === option}
                                                    onClick={() => setPhaseFilter(option)}
                                                >
                                                    {option === 'ALL' ? 'All Years' : option}
                                                </button>
                                            ))}
                                        </div>
                                        <span className={styles.rowCount}>
                                            Showing {filteredTableRows.length} simulated years
                                        </span>
                                    </div>

                                    <div className={styles.tableContainer}>
                                        <div
                                            className={styles.tableScroll}
                                            tabIndex={0}
                                            role="region"
                                            aria-labelledby="fire-table-caption"
                                        >
                                            <table className={styles.table}>
                                                <caption id="fire-table-caption" className={styles.srOnly}>
                                                    Yearly FIRE projection breakdown showing principal, compounded gains, total balance, and annual withdrawal by phase
                                                </caption>
                                                <thead>
                                                    <tr>
                                                        <th scope="col">Year</th>
                                                        <th scope="col">Phase</th>
                                                        <th scope="col" className={styles.numCol}>Principal</th>
                                                        <th scope="col" className={styles.numCol}>Compounded Gains</th>
                                                        <th scope="col" className={styles.numCol}>Total Value</th>
                                                        <th scope="col" className={styles.numCol}>Annual Withdrawal</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {filteredTableRows.map((row) => (
                                                        <tr
                                                            key={row.year}
                                                            className={row.year === simulation.fireYear ? styles.rowFireMarker : undefined}
                                                        >
                                                            <th scope="row">
                                                                {row.year}
                                                                {row.year === simulation.fireYear ? ' (FIRE)' : ''}
                                                            </th>
                                                            <td>
                                                                <span
                                                                    className={`${styles.phaseBadge} ${
                                                                        row.phase === 'Accumulation'
                                                                            ? styles.phaseAccum
                                                                            : styles.phaseRetire
                                                                    }`}
                                                                >
                                                                    {row.phase}
                                                                </span>
                                                            </td>
                                                            <td className={styles.numCol}>
                                                                {format(row.principal, { maximumFractionDigits: 0 })}
                                                            </td>
                                                            <td className={styles.numCol}>
                                                                {format(row.gains, { maximumFractionDigits: 0 })}
                                                            </td>
                                                            <td className={`${styles.numCol} ${styles.totalCell}`}>
                                                                {format(row.total, { maximumFractionDigits: 0 })}
                                                            </td>
                                                            <td className={styles.numCol}>
                                                                {row.withdrawal > 0
                                                                    ? format(row.withdrawal, { maximumFractionDigits: 0 })
                                                                    : '—'}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
