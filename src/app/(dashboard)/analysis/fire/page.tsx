'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { MdClose, MdSettings, MdTune } from 'react-icons/md';
import { useCurrency } from '@/context/CurrencyContext';
import usePersistentState from '@/hooks/usePersistentState';
import { useLiveSync } from '@/hooks/useLiveSync';
import {
    buildFireProfileSlugId,
    hasFireProfileChanges,
    normalizeFireCurrency,
    sanitizeFireParams,
    type FireProfile,
    type FireProfileStore,
    type FireSimulationParams
} from '@/lib/fire-profiles';
import FireConfigPanel from './_components/FireConfigPanel';
import styles from './page.module.css';

type PhaseType = 'Accumulation' | 'Retirement';
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

    // Portfolio value fetched in active target currency from /api/portfolio
    const [currentPortfolioValue, setCurrentPortfolioValue] = useState<number>(0);
    const [loadingPortfolio, setLoadingPortfolio] = useState<boolean>(true);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [syncTick, setSyncTick] = useState<number>(0);

    // Saved FIRE profiles & collapsible simulation studio state
    const [profiles, setProfiles] = useState<FireProfile[]>([]);
    const [activeProfileId, setActiveProfileId] = useState<string>('default');
    const [isParamsOpen, setIsParamsOpen] = usePersistentState<boolean>('fire_params_open', false);
    const [isSavingProfile, setIsSavingProfile] = useState<boolean>(false);
    const [profileError, setProfileError] = useState<string | null>(null);
    const [successBanner, setSuccessBanner] = useState<string | null>(null);

    // Simulation inputs
    const [params, setParams] = useState<FireSimulationParams>(() => sanitizeFireParams(undefined));
    const {
        fireDate,
        monthlyContribution,
        expectedReturn,
        inflationRate,
        currentMonthlyExpense,
        calculationMode,
        withdrawalRate,
        withdrawalDuration
    } = params;

    // Tab and table filter states
    const [activeTab, setActiveTab] = useState<ActiveTab>('chart');
    const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>('ALL');

    const chartTabRef = useRef<HTMLButtonElement>(null);
    const tableTabRef = useRef<HTMLButtonElement>(null);
    const prevCurrencyRef = useRef<string>(currency);
    const hasHydratedProfilesRef = useRef<boolean>(false);
    const loadedPortfolioCurrencyRef = useRef<string | null>(null);

    useLiveSync({
        onSync: () => setSyncTick((t) => t + 1),
    });

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

    // Fetch current portfolio value directly in the selected currency
    useEffect(() => {
        const controller = new AbortController();
        const isBackground = loadedPortfolioCurrencyRef.current === currency;
        if (!isBackground) {
            setLoadingPortfolio(true);
        }

        fetch(`/api/portfolio?currency=${encodeURIComponent(currency)}`, {
            signal: controller.signal,
            cache: 'no-store',
        })
            .then((res) => {
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                return res.json();
            })
            .then((data) => {
                if (controller.signal.aborted) return;
                loadedPortfolioCurrencyRef.current = currency;
                if (typeof data?.totalValue === 'number' && Number.isFinite(data.totalValue)) {
                    setCurrentPortfolioValue(data.totalValue);
                }
                setFetchError(null);
                setLoadingPortfolio(false);
            })
            .catch((err: unknown) => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to fetch portfolio value for FIRE:', err);
                if (!isBackground) {
                    setFetchError('Unable to load live portfolio balance. Using manual simulation baseline.');
                }
                setLoadingPortfolio(false);
            });

        return () => controller.abort();
    }, [currency, syncTick]);

    const convertRef = useRef(convert);
    useEffect(() => {
        convertRef.current = convert;
    }, [convert]);

    const applyProfileToState = useCallback(
        (profile: FireProfile, targetCurrency: string) => {
            const sanitized = sanitizeFireParams(profile.params);
            const sameCurrency =
                normalizeFireCurrency(profile.currency) === normalizeFireCurrency(targetCurrency);

            const convertedContribution = sameCurrency
                ? sanitized.monthlyContribution
                : Math.round(convertRef.current(sanitized.monthlyContribution, profile.currency));
            const convertedExpense = sameCurrency
                ? sanitized.currentMonthlyExpense
                : Math.round(convertRef.current(sanitized.currentMonthlyExpense, profile.currency));

            setActiveProfileId(profile.id);
            setParams({
                ...sanitized,
                monthlyContribution: convertedContribution,
                currentMonthlyExpense: convertedExpense
            });
            prevCurrencyRef.current = targetCurrency;
        },
        []
    );

    // Fetch saved FIRE profiles once exchange rates are ready for currency conversion
    useEffect(() => {
        if (currencyLoading || hasHydratedProfilesRef.current) return;
        if (rates?.[currency] !== 1) return;

        const controller = new AbortController();
        fetch(`/api/fire/profiles?currency=${encodeURIComponent(currency)}`, { signal: controller.signal })
            .then((res) => (res.ok ? res.json() : null))
            .then((store: FireProfileStore | null) => {
                if (!store || !Array.isArray(store.profiles) || store.profiles.length === 0) return;
                hasHydratedProfilesRef.current = true;
                setProfiles(store.profiles);
                const active =
                    store.profiles.find((p) => p.id === store.activeProfileId) || store.profiles[0];
                if (active) {
                    applyProfileToState(active, currency);
                }
            })
            .catch((err: unknown) => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to load FIRE profiles:', err);
            });

        return () => controller.abort();
    }, [currencyLoading, rates, currency, applyProfileToState]);

    // Convert currency-denominated inputs when active currency changes
    useEffect(() => {
        const oldCurrency = prevCurrencyRef.current;
        if (
            !currencyLoading &&
            oldCurrency !== currency &&
            rates?.[currency] === 1 &&
            (rates?.[oldCurrency] ?? 0) > 0
        ) {
            setParams((prev) => ({
                ...prev,
                monthlyContribution: Math.round(convert(prev.monthlyContribution, oldCurrency)),
                currentMonthlyExpense: Math.round(convert(prev.currentMonthlyExpense, oldCurrency))
            }));
            prevCurrencyRef.current = currency;
        }
    }, [currency, currencyLoading, rates, convert]);

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

        // # Reason: Effective monthly compounding ensures 12 monthly steps equal the stated annual rate.
        const monthlyReturnRate = Math.pow(1 + safeReturn / 100, 1 / 12) - 1;
        const monthlyInflationRate = Math.pow(1 + safeInflation / 100, 1 / 12) - 1;

        let currentPrincipal = Math.max(0, currentPortfolioValue);
        let currentTotal = Math.max(0, currentPortfolioValue);

        const yearlyData: YearProjection[] = [];

        // Phase 1: Accumulation
        for (let i = 1; i <= monthsToAccumulate; i++) {
            const simDate = new Date(startYear, startMonth + i, 1);
            currentPrincipal += safeContribution;
            const interestEarned = (currentTotal + safeContribution) * monthlyReturnRate;
            currentTotal = Math.max(0, currentTotal + safeContribution + interestEarned);

            if (simDate.getMonth() === 11) {
                const clampedPrincipal = Math.min(currentPrincipal, currentTotal);
                const clampedGains = Math.max(0, currentTotal - clampedPrincipal);
                yearlyData.push({
                    year: simDate.getFullYear(),
                    phase: 'Accumulation',
                    principal: Math.round(clampedPrincipal),
                    gains: Math.round(clampedGains),
                    total: Math.round(currentTotal),
                    withdrawal: 0
                });
            }
        }

        const projectedFireValue = currentTotal;
        const projectedPrincipal = Math.min(currentPrincipal, currentTotal);
        const projectedGains = Math.max(0, currentTotal - projectedPrincipal);

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
                yearWithdrawalAccum += actualWithdrawal;

                const interestEarned = depletionTotal * monthlyReturnRate;
                depletionTotal = Math.max(0, depletionTotal + interestEarned);
                depletionPrincipal = Math.min(depletionPrincipal, depletionTotal);
                depletionInterest = Math.max(0, depletionTotal - depletionPrincipal);

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
            if (neededMonthly > 0 && lifestyleBalance < neededMonthly - 0.01) break;
            if (lifestyleBalance <= 0) break;
            lifestyleBalance = Math.max(0, lifestyleBalance - neededMonthly);
            lifestyleBalance += lifestyleBalance * monthlyReturnRate;
            neededMonthly *= 1 + monthlyInflationRate;
            lifestyleMonths = m;
        }

        const effectiveSwr =
            calculationMode === 'FIXED_HORIZON' ? computedWithdrawalRate : safeSwr;
        const todayFireNumber =
            effectiveSwr > 0 ? (safeExpense * 12) / (effectiveSwr / 100) : 0;
        const requiredFireNumber =
            effectiveSwr > 0 ? (futureMonthlyExpense * 12) / (effectiveSwr / 100) : 0;

        const currentProgressPct =
            todayFireNumber > 0
                ? Math.min(100, Math.max(0, (currentPortfolioValue / todayFireNumber) * 100))
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
        const inflationFactor60y = Math.pow(1 + safeInflation / 100, 60);
        const isPerpetual =
            depletedAtMonth === null &&
            (depletionTotal / inflationFactor60y) >= projectedFireValue * 0.99;

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

    const handleChangeParam = useCallback(
        <K extends keyof FireSimulationParams>(key: K, value: FireSimulationParams[K]) => {
            setParams((prev) => ({ ...prev, [key]: value }));
        },
        []
    );

    const activeProfile = useMemo(
        () => profiles.find((p) => p.id === activeProfileId),
        [profiles, activeProfileId]
    );

    const hasUnsavedChanges = useMemo(
        () => hasFireProfileChanges(activeProfile, params, currency, convert),
        [activeProfile, params, currency, convert]
    );

    const persistProfile = async (
        profileId: string,
        profileName: string,
        successMessage: string
    ) => {
        setIsSavingProfile(true);
        setProfileError(null);
        setSuccessBanner(null);

        try {
            const payload: FireProfile = {
                id: profileId,
                name: profileName,
                currency: normalizeFireCurrency(currency),
                params: sanitizeFireParams(params),
                updatedAt: new Date().toISOString()
            };

            const res = await fetch('/api/fire/profiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile: payload, currency })
            });

            if (!res.ok) {
                if (res.status === 403) {
                    setProfileError('Only Admin or Editor accounts can modify FIRE profiles.');
                } else {
                    const errBody = await res.json().catch(() => ({}));
                    setProfileError(errBody.error || `Failed to save profile (HTTP ${res.status}).`);
                }
                return;
            }

            const updatedStore = (await res.json()) as FireProfileStore;
            setProfiles(updatedStore.profiles);
            const nextActive =
                updatedStore.profiles.find((p) => p.id === updatedStore.activeProfileId) ||
                updatedStore.profiles[0];
            if (nextActive) {
                applyProfileToState(nextActive, currency);
            }
            setSuccessBanner(successMessage);
        } catch (error) {
            console.error('Failed to save FIRE profile:', error);
            setProfileError('Network error while saving FIRE profile.');
        } finally {
            setIsSavingProfile(false);
        }
    };

    const handleSaveProfile = async () => {
        const name = activeProfile?.name || 'Default FIRE Plan';
        await persistProfile(
            activeProfile?.id || 'default',
            name,
            `Profile "${name}" saved (${currency}).`
        );
    };

    const handleSaveAsNewProfile = async (newName: string) => {
        const newId = buildFireProfileSlugId(newName);
        await persistProfile(
            newId,
            newName,
            `Created and activated profile "${newName}".`
        );
    };

    const handleSelectProfile = async (nextProfileId: string) => {
        const target = profiles.find((p) => p.id === nextProfileId);
        if (!target) return;

        setProfileError(null);
        setSuccessBanner(null);
        applyProfileToState(target, currency);

        try {
            const res = await fetch('/api/fire/profiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ activeProfileId: nextProfileId, activateOnly: true, currency })
            });
            if (res.ok) {
                setSuccessBanner(`Switched to profile "${target.name}".`);
            } else if (res.status === 403) {
                setSuccessBanner(`Viewing profile "${target.name}" locally (read-only session).`);
            }
        } catch (error) {
            console.error('Failed to switch FIRE profile:', error);
        }
    };

    const handleDeleteProfile = async (profileId: string) => {
        setIsSavingProfile(true);
        setProfileError(null);
        setSuccessBanner(null);

        try {
            const res = await fetch(`/api/fire/profiles?id=${encodeURIComponent(profileId)}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                if (res.status === 403) {
                    setProfileError('Only Admin or Editor accounts can delete FIRE profiles.');
                } else {
                    const errBody = await res.json().catch(() => ({}));
                    setProfileError(errBody.error || `Failed to delete profile (HTTP ${res.status}).`);
                }
                return;
            }

            const store = (await res.json()) as FireProfileStore;
            setProfiles(store.profiles);
            const nextActive =
                store.profiles.find((p) => p.id === store.activeProfileId) || store.profiles[0];
            if (nextActive) {
                applyProfileToState(nextActive, currency);
            }
            setSuccessBanner('Profile deleted.');
        } catch (error) {
            console.error('Failed to delete FIRE profile:', error);
            setProfileError('Network error while deleting FIRE profile.');
        } finally {
            setIsSavingProfile(false);
        }
    };

    const handleResetToProfile = () => {
        if (!activeProfile) return;
        setProfileError(null);
        applyProfileToState(activeProfile, currency);
        setSuccessBanner(`Restored saved parameters for "${activeProfile.name}".`);
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

                <div className={styles.headerControls}>
                    {profiles.length > 0 && (
                        <select
                            aria-label="Active FIRE profile"
                            className={styles.headerProfileSelect}
                            value={activeProfileId}
                            onChange={(e) => handleSelectProfile(e.target.value)}
                        >
                            {profiles.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                    )}

                    <div className={styles.headerBadge}>
                        <span>Current Baseline:</span>
                        <span className={styles.headerBadgeStrong}>
                            {loadingPortfolio ? 'Loading...' : format(currentPortfolioValue, { maximumFractionDigits: 0 })}
                        </span>
                    </div>

                    <button
                        type="button"
                        className={`${styles.secondaryBtn} ${isParamsOpen ? styles.secondaryBtnActive : ''}`}
                        onClick={() => setIsParamsOpen((prev) => !prev)}
                        aria-expanded={isParamsOpen}
                    >
                        <MdSettings size={18} aria-hidden="true" />
                        <span>{isParamsOpen ? 'Hide Parameters' : 'Simulation Parameters'}</span>
                    </button>
                </div>
            </header>

            {fetchError && (
                <div className={styles.errorBanner} role="alert">
                    <span>{fetchError}</span>
                </div>
            )}

            {profileError && (
                <div className={styles.errorBanner} role="alert">
                    <span>{profileError}</span>
                    <button
                        type="button"
                        className={styles.iconDeleteBtn}
                        onClick={() => setProfileError(null)}
                        aria-label="Dismiss error"
                    >
                        <MdClose size={18} aria-hidden="true" />
                    </button>
                </div>
            )}

            {successBanner && (
                <div className={styles.successBanner} role="status">
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
                {/* Collapsible Simulation Parameters & Profile Studio */}
                <FireConfigPanel
                    isOpen={isParamsOpen}
                    currency={currency}
                    params={params}
                    profiles={profiles}
                    activeProfileId={activeProfileId}
                    hasUnsavedChanges={hasUnsavedChanges}
                    isSaving={isSavingProfile}
                    effectiveFireDate={simulation.effectiveFireDate}
                    isPastDateClamped={simulation.isPastDateClamped}
                    formattedEffectiveFireDate={formatMonthYear(simulation.effectiveFireDate)}
                    formattedFutureMonthlyExpense={format(simulation.futureMonthlyExpense, { maximumFractionDigits: 0 })}
                    formattedRequiredFireNumber={format(simulation.requiredFireNumber, { maximumFractionDigits: 0 })}
                    fireYear={simulation.fireYear}
                    effectiveSwr={simulation.effectiveSwr}
                    realReturnPct={simulation.realReturnPct}
                    onChangeParam={handleChangeParam}
                    onSelectProfile={handleSelectProfile}
                    onSaveProfile={handleSaveProfile}
                    onSaveAsNewProfile={handleSaveAsNewProfile}
                    onDeleteProfile={handleDeleteProfile}
                    onResetToProfile={handleResetToProfile}
                />

                {!isParamsOpen && (
                    <div className={styles.scenarioSummaryBar}>
                        <div className={styles.scenarioSummaryPills}>
                            <span className={styles.scenarioPillStrong}>
                                {activeProfile?.name || 'Default FIRE Plan'}
                                {hasUnsavedChanges ? ' *' : ''}
                            </span>
                            <span className={styles.scenarioPill}>
                                Target: <strong>{formatMonthYear(simulation.effectiveFireDate)}</strong>
                            </span>
                            <span className={styles.scenarioPill}>
                                Contribution: <strong>{format(monthlyContribution, { maximumFractionDigits: 0 })}/mo</strong>
                            </span>
                            <span className={styles.scenarioPill}>
                                Return / Inflation: <strong>{expectedReturn.toFixed(1)}% / {inflationRate.toFixed(1)}%</strong>
                            </span>
                            <span className={styles.scenarioPill}>
                                Expenses: <strong>{format(currentMonthlyExpense, { maximumFractionDigits: 0 })}/mo</strong>
                            </span>
                            <span className={styles.scenarioPill}>
                                Strategy:{' '}
                                <strong>
                                    {calculationMode === 'FIXED_RATE'
                                        ? `${withdrawalRate.toFixed(1)}% SWR`
                                        : `${withdrawalDuration}y Horizon`}
                                </strong>
                            </span>
                        </div>
                        <button
                            type="button"
                            className={styles.scenarioEditBtn}
                            onClick={() => setIsParamsOpen(true)}
                        >
                            <MdTune size={15} aria-hidden="true" />
                            <span>Edit Parameters</span>
                        </button>
                    </div>
                )}

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

                {/* Tier 2: Full-Width Tabbed Projection Chart / Breakdown Table */}
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
    );
}
