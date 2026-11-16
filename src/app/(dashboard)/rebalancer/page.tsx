'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import ReportFilters, { type FilterOptions } from '@/components/ReportFilters';
import usePersistentState from '@/hooks/usePersistentState';
import { useLiveSync } from '@/hooks/useLiveSync';
import { emitLiveSyncEvent } from '@/lib/live-sync';
import { MdClose, MdExpandLess, MdExpandMore, MdSettings, MdWarningAmber } from 'react-icons/md';
import {
    computeRebalancePlan,
    formatShareCount,
    normalizeTargetsTo100,
    seedTargetsFromHoldings,
    type RebalanceItem,
    type RebalanceMode,
    type TargetConfig
} from '@/lib/rebalance-planner';
import {
    allocateTradeAcrossAccounts,
    buildEqualWeightTargets,
    computeCategoryRebalancePlan,
    getTaxStatusLabel,
    normalizeCategoryTargetsTo100,
    seedCategoryTargetsFromHoldings,
    simulateGlideStep,
    type CategoryTargetConfig,
    type PlannedCategoryRow,
    type RebalanceDimension,
    type RebalanceProfile,
    type RebalanceProfileStore,
    type TaxStatus
} from '@/lib/rebalance-extensions';
import RebalancerCharts from './_components/RebalancerCharts';
import RebalancerConfigPanel from './_components/RebalancerConfigPanel';

type ChecklistFilter = 'ALL' | 'ACTIONABLE' | 'BUY' | 'SELL' | 'HOLD';

const TOLERANCE_PRESETS = [0, 0.5, 1, 2, 5];
const CASH_PRESETS = [500, 1000, 2500, 5000];

function getTaxTierClassName(status: TaxStatus): string {
    if (status === 'TAX_FREE') return styles.taxTierFree;
    if (status === 'TAX_DEFERRED') return styles.taxTierDeferred;
    return styles.taxTierTaxable;
}

function enrichTargetTimestamps(
    targetList: TargetConfig[],
    items: RebalanceItem[],
    profileUpdatedAt?: string
): TargetConfig[] {
    const itemMap = new Map(items.map((item) => [item.symbol.toUpperCase(), item]));
    const profileTime = profileUpdatedAt ? new Date(profileUpdatedAt).getTime() : 0;

    return targetList.map((t) => {
        const match = itemMap.get(t.symbol.trim().toUpperCase());
        const matchAdjTime = match?.lastAdjustmentDate ? new Date(match.lastAdjustmentDate).getTime() : 0;
        const targetAdjTime = t.lastAdjustmentDate ? new Date(t.lastAdjustmentDate).getTime() : 0;
        const dbAdjustedAfterProfile = Boolean(
            match &&
            matchAdjTime > 0 &&
            (matchAdjTime > targetAdjTime || (profileTime > 0 && matchAdjTime > profileTime))
        );

        return {
            ...t,
            targetPercentage: dbAdjustedAfterProfile && match ? match.targetPercent : t.targetPercentage,
            lastAdjustmentDate: match?.lastAdjustmentDate ?? t.lastAdjustmentDate ?? null,
            createdAt: match?.createdAt ?? t.createdAt ?? null
        };
    });
}

export default function RebalancerPage() {
    const { format, currency } = useCurrency();

    const [rebalanceData, setRebalanceData] = useState<RebalanceItem[] | null>(null);
    const [dataCurrency, setDataCurrency] = useState<string>('');
    const [knownSymbols, setKnownSymbols] = useState<string[]>([]);
    const [configuredInvestmentTypes, setConfiguredInvestmentTypes] = useState<string[]>([]);

    const [profiles, setProfiles] = useState<RebalanceProfile[]>([]);
    const [activeProfileId, setActiveProfileId] = useState<string>('default');
    const [dimension, setDimension] = useState<RebalanceDimension>('TICKER');
    const [targets, setTargets] = useState<TargetConfig[]>([]);
    const [categoryTargets, setCategoryTargets] = useState<CategoryTargetConfig[]>([]);
    const [bindFiltersToProfile, setBindFiltersToProfile] = useState(false);

    const [isSaving, setIsSaving] = useState(false);
    const [isApplyingGlide, setIsApplyingGlide] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [isConfigOpen, setIsConfigOpen] = useState(false);
    const [checklistFilter, setChecklistFilter] = useState<ChecklistFilter>('ALL');
    const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
    const [errorBanner, setErrorBanner] = useState<string | null>(null);
    const [successBanner, setSuccessBanner] = useState<string | null>(null);

    const [syncTick, setSyncTick] = useState(0);
    const hasHydratedProfilesRef = useRef(false);
    const loadedViewKeyRef = useRef<string | null>(null);
    const suppressSelfSyncRef = useRef(false);
    const isConfigOpenRef = useRef(isConfigOpen);
    const activeProfileIdRef = useRef(activeProfileId);

    useEffect(() => {
        isConfigOpenRef.current = isConfigOpen;
    }, [isConfigOpen]);

    useEffect(() => {
        activeProfileIdRef.current = activeProfileId;
    }, [activeProfileId]);

    // Persistent Filters & Strategy Controls
    const [globalFilters, setGlobalFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('rebalancer_filters', null);
    const [excludeSymbols, setExcludeSymbols] = usePersistentState<string>('rebalancer_exclude_symbols', '');
    const [debouncedExclude, setDebouncedExclude] = useState<string>('');

    const [rebalanceMode, setRebalanceMode] = usePersistentState<RebalanceMode>('rebalancer_mode', 'FULL');
    const [newCash, setNewCash] = usePersistentState<number>('rebalancer_new_cash', 1000);
    const [tolerancePercent, setTolerancePercent] = usePersistentState<number>('rebalancer_tolerance', 1);
    const [wholeShares, setWholeShares] = usePersistentState<boolean>('rebalancer_whole_shares', false);
    const [checkedTradeList, setCheckedTradeList] = usePersistentState<string[]>('rebalancer_checked_trades', []);

    useLiveSync({
        enabled: isFiltersLoaded,
        onSync: () => {
            if (suppressSelfSyncRef.current) return;
            setSyncTick((t) => t + 1);
        },
    });

    const notifyPortfolioUpdated = useCallback((reason: string) => {
        try {
            suppressSelfSyncRef.current = true;
            emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason });
        } finally {
            suppressSelfSyncRef.current = false;
        }
    }, []);

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

    const applyProfileToState = useCallback(
        (profile: RebalanceProfile, items: RebalanceItem[]) => {
            setActiveProfileId(profile.id);
            setDimension(profile.dimension === 'CATEGORY' ? 'CATEGORY' : 'TICKER');
            setTargets(enrichTargetTimestamps(profile.tickerTargets || [], items, profile.updatedAt));
            setCategoryTargets(profile.categoryTargets || []);
            setBindFiltersToProfile(
                Boolean(
                    (profile.accountTypes && profile.accountTypes.length > 0) ||
                    (profile.investmentTypes && profile.investmentTypes.length > 0)
                )
            );
        },
        []
    );

    const fetchData = useCallback(async (signal?: AbortSignal) => {
        const normalizedInvTypes = [...(globalFilters?.investmentTypes || [])].sort();
        const normalizedAccTypes = [...(globalFilters?.accountTypes || [])].sort();
        const viewKey = JSON.stringify({
            currency,
            investmentTypes: normalizedInvTypes,
            accountTypes: normalizedAccTypes,
            exclude: debouncedExclude.trim(),
        });
        const isBackground = loadedViewKeyRef.current === viewKey;

        if (!isBackground) {
            setIsLoading(true);
            setErrorBanner(null);
        }

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

            const [dataRes, profileRes, invTypeRes] = await Promise.all([
                fetch(url, { signal, cache: 'no-store' }),
                fetch('/api/rebalancer/profiles', { signal, cache: 'no-store' }),
                fetch('/api/settings/investment-types', { signal, cache: 'no-store' }).catch(() => null)
            ]);

            if (signal?.aborted) return;

            if (!dataRes.ok) {
                throw new Error(`Unable to load rebalance analytics (HTTP ${dataRes.status})`);
            }

            const dataJson = await dataRes.json();
            if (signal?.aborted) return;

            const items: RebalanceItem[] = Array.isArray(dataJson.data) ? dataJson.data : [];
            loadedViewKeyRef.current = viewKey;
            setRebalanceData(items);
            setDataCurrency(dataJson.currency || currency);
            setErrorBanner(null);

            setKnownSymbols((prev) => {
                const merged = new Set(prev);
                items.forEach((d) => merged.add(d.symbol));
                return Array.from(merged).sort();
            });

            if (invTypeRes && invTypeRes.ok) {
                const invTypesJson = await invTypeRes.json().catch(() => []);
                if (!signal?.aborted && Array.isArray(invTypesJson)) {
                    setConfiguredInvestmentTypes(invTypesJson.map((it: { name: string }) => it.name));
                }
            }

            if (profileRes.ok) {
                const store = (await profileRes.json()) as RebalanceProfileStore;
                if (!signal?.aborted && Array.isArray(store.profiles) && store.profiles.length > 0) {
                    setProfiles(store.profiles);
                    const shouldApplyActiveProfile =
                        !hasHydratedProfilesRef.current ||
                        (!isConfigOpenRef.current &&
                            (Boolean(store.activeProfileId && store.activeProfileId !== activeProfileIdRef.current) ||
                                isBackground));

                    if (shouldApplyActiveProfile) {
                        hasHydratedProfilesRef.current = true;
                        const active =
                            store.profiles.find((p) => p.id === store.activeProfileId) || store.profiles[0];
                        if (active) {
                            applyProfileToState(active, items);
                        }
                    } else {
                        setTargets((prev) => enrichTargetTimestamps(prev, items));
                    }
                }
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('Failed to fetch rebalancer data:', error);
            if (!isBackground) {
                setErrorBanner(error instanceof Error ? error.message : 'Failed to load rebalancer data.');
            }
        } finally {
            if (!signal?.aborted) {
                setIsLoading(false);
            }
        }
    }, [currency, globalFilters, debouncedExclude, applyProfileToState]);

    useEffect(() => {
        if (!isFiltersLoaded) return;
        const controller = new AbortController();
        void fetchData(controller.signal);
        return () => controller.abort();
    }, [isFiltersLoaded, fetchData, syncTick]);

    const persistProfile = async (
        profileId: string,
        profileName: string,
        successMessage: string
    ) => {
        setIsSaving(true);
        setErrorBanner(null);
        setSuccessBanner(null);

        try {
            const validTickerTargets = targets
                .map((t) => ({
                    ...t,
                    symbol: t.symbol.trim().toUpperCase()
                }))
                .filter((t) => t.symbol !== '');

            const validCategoryTargets = categoryTargets
                .map((c) => ({
                    ...c,
                    investmentType: c.investmentType.trim()
                }))
                .filter((c) => c.investmentType !== '');

            const profilePayload: RebalanceProfile = {
                id: profileId,
                name: profileName,
                dimension,
                tickerTargets: validTickerTargets,
                categoryTargets: validCategoryTargets,
                accountTypes: bindFiltersToProfile && globalFilters ? globalFilters.accountTypes : undefined,
                investmentTypes: bindFiltersToProfile && globalFilters ? globalFilters.investmentTypes : undefined,
                excludeSymbols: bindFiltersToProfile ? excludeSymbols : undefined,
                updatedAt: new Date().toISOString()
            };

            const res = await fetch('/api/rebalancer/profiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile: profilePayload })
            });

            if (!res.ok) {
                if (res.status === 403) {
                    setErrorBanner('Only Admin or Editor accounts can modify target allocations.');
                } else {
                    const errBody = await res.json().catch(() => ({}));
                    setErrorBanner(errBody.error || `Failed to save profile (HTTP ${res.status}).`);
                }
                return;
            }

            const updatedStore = (await res.json()) as RebalanceProfileStore;
            setProfiles(updatedStore.profiles);
            const active =
                updatedStore.profiles.find((p) => p.id === updatedStore.activeProfileId) ||
                updatedStore.profiles[0];
            if (active) {
                applyProfileToState(active, rebalanceData || []);
            }

            setSuccessBanner(successMessage);
            await fetchData();
            notifyPortfolioUpdated('rebalance-profile-saved');
        } catch (error) {
            console.error('Failed to save profile:', error);
            setErrorBanner('Network error while saving target profile.');
        } finally {
            setIsSaving(false);
        }
    };

    const saveTargets = async () => {
        const currentProfile = profiles.find((p) => p.id === activeProfileId);
        const name = currentProfile?.name || 'Default Portfolio';
        await persistProfile(
            activeProfileId || 'default',
            name,
            `Profile "${name}" saved and portfolio drift recalculated.`
        );
    };

    const handleSaveAsNewProfile = async (newName: string) => {
        const slug = newName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'custom';
        const newId = `${slug}-${Date.now().toString(36)}`;
        await persistProfile(
            newId,
            newName,
            `Created and activated profile "${newName}".`
        );
    };

    const handleSelectProfile = async (nextProfileId: string) => {
        const targetProfile = profiles.find((p) => p.id === nextProfileId);
        if (!targetProfile) return;

        setErrorBanner(null);
        setSuccessBanner(null);
        applyProfileToState(targetProfile, rebalanceData || []);
        setExpandedRows(new Set());

        if (
            (targetProfile.accountTypes && targetProfile.accountTypes.length > 0) ||
            (targetProfile.investmentTypes && targetProfile.investmentTypes.length > 0)
        ) {
            setGlobalFilters({
                accountTypes: targetProfile.accountTypes || [],
                investmentTypes: targetProfile.investmentTypes || []
            });
        }
        if (typeof targetProfile.excludeSymbols === 'string') {
            setExcludeSymbols(targetProfile.excludeSymbols);
        }

        try {
            const res = await fetch('/api/rebalancer/profiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ activeProfileId: nextProfileId, activateOnly: true })
            });
            if (res.ok) {
                await fetchData();
                setSuccessBanner(`Switched to profile "${targetProfile.name}".`);
                notifyPortfolioUpdated('rebalance-profile-selected');
            }
        } catch (error) {
            console.error('Failed to switch profile:', error);
        }
    };

    const handleDeleteProfile = async (profileId: string) => {
        setIsSaving(true);
        setErrorBanner(null);
        setSuccessBanner(null);
        try {
            const res = await fetch(`/api/rebalancer/profiles?id=${encodeURIComponent(profileId)}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                setErrorBanner(errBody.error || `Failed to delete profile (HTTP ${res.status}).`);
                return;
            }
            const store = (await res.json()) as RebalanceProfileStore;
            setProfiles(store.profiles);
            const active = store.profiles.find((p) => p.id === store.activeProfileId) || store.profiles[0];
            if (active) {
                applyProfileToState(active, rebalanceData || []);
            }
            setSuccessBanner('Profile deleted.');
            await fetchData();
            notifyPortfolioUpdated('rebalance-profile-deleted');
        } catch (error) {
            console.error('Failed to delete profile:', error);
            setErrorBanner('Network error while deleting profile.');
        } finally {
            setIsSaving(false);
        }
    };

    const availableInvestmentTypes = useMemo(() => {
        const set = new Set<string>(configuredInvestmentTypes);
        (rebalanceData || []).forEach((item) => {
            if (item.investmentType) set.add(item.investmentType);
        });
        return Array.from(set).sort();
    }, [configuredInvestmentTypes, rebalanceData]);

    const handleSeedFromHoldings = () => {
        if (!rebalanceData || rebalanceData.length === 0) return;
        if (dimension === 'CATEGORY') {
            setCategoryTargets(seedCategoryTargetsFromHoldings(rebalanceData));
        } else {
            setTargets(seedTargetsFromHoldings(rebalanceData, targets));
        }
    };

    const handleEqualWeight = () => {
        if (dimension === 'CATEGORY') {
            const activeTypes = categoryTargets
                .map((c) => c.investmentType.trim())
                .filter(Boolean);
            const fallbackTypes = Array.from(
                new Set((rebalanceData || []).map((r) => r.investmentType || 'Uncategorized'))
            );
            const list = Array.from(new Set(activeTypes.length > 0 ? activeTypes : fallbackTypes));
            if (list.length === 0) return;
            const base = Math.round((100 / list.length) * 10) / 10;
            setCategoryTargets(
                list.map((investmentType, idx) => ({
                    investmentType,
                    targetPercentage: idx === 0
                        ? Math.round((100 - base * (list.length - 1)) * 10) / 10
                        : base
                }))
            );
            return;
        }

        const activeSyms = targets.map((t) => t.symbol.trim().toUpperCase()).filter(Boolean);
        const list = activeSyms.length > 0 ? activeSyms : (rebalanceData || []).map((r) => r.symbol);
        setTargets(buildEqualWeightTargets(list, targets));
    };

    const handleApplyCategoryTemplate = (template: '80_20' | '60_40') => {
        const findType = (candidates: string[], fallback: string) =>
            availableInvestmentTypes.find((t) => candidates.includes(t.toUpperCase())) || fallback;

        const equityType = findType(['ETF', 'STOCK', 'EQUITY'], 'ETF');
        const fixedType = findType(['BOND', 'CASH', 'GIC', 'FIXED INCOME'], 'Bond');

        if (equityType === fixedType) {
            setCategoryTargets([{ investmentType: equityType, targetPercentage: 100 }]);
            return;
        }

        const eqWeight = template === '80_20' ? 80 : 60;
        const fiWeight = 100 - eqWeight;
        setCategoryTargets([
            { investmentType: equityType, targetPercentage: eqWeight },
            { investmentType: fixedType, targetPercentage: fiWeight }
        ]);
    };

    const handleNormalizeTargets = () => {
        if (dimension === 'CATEGORY') {
            setCategoryTargets((prev) => normalizeCategoryTargetsTo100(prev));
        } else {
            setTargets((prev) => normalizeTargetsTo100(prev));
        }
    };

    const handleSimulateGlideStep = () => {
        const { simulatedTargets, postStepTotal } = simulateGlideStep(targets, 1);
        setTargets(simulatedTargets);
        setSuccessBanner(
            `Previewing +1 year glide path step in Target Studio & Glide Path Preview (new sum: ${postStepTotal.toFixed(1)}%). Click "Save Profile" to commit.`
        );
    };

    const handleApplyGlideStepNow = async () => {
        setIsApplyingGlide(true);
        setErrorBanner(null);
        setSuccessBanner(null);
        try {
            const res = await fetch('/api/cron/glide-path-adjust', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dryRun: false, forceOneYearStep: true })
            });

            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                setErrorBanner(errBody.error || `Failed to apply glide path step (HTTP ${res.status}).`);
                return;
            }

            const result = await res.json();
            const targetRes = await fetch('/api/rebalancer/targets', { cache: 'no-store' });
            if (targetRes.ok) {
                const targetJson = await targetRes.json();
                if (Array.isArray(targetJson.targets)) {
                    const refreshedTargets: TargetConfig[] = targetJson.targets.map(
                        (t: {
                            symbol: string;
                            targetPercentage: number;
                            yearlyDriftAdjustment: number | null;
                            lastAdjustmentDate?: string | null;
                            createdAt?: string | null;
                        }) => ({
                            symbol: t.symbol,
                            targetPercentage: t.targetPercentage,
                            yearlyDriftAdjustment: t.yearlyDriftAdjustment,
                            lastAdjustmentDate: t.lastAdjustmentDate ?? null,
                            createdAt: t.createdAt ?? null
                        })
                    );
                    setTargets(refreshedTargets);

                    const currentProfile = profiles.find((p) => p.id === activeProfileId);
                    if (currentProfile) {
                        await fetch('/api/rebalancer/profiles', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                profile: {
                                    ...currentProfile,
                                    tickerTargets: refreshedTargets
                                }
                            })
                        });
                    }
                }
            }

            await fetchData();
            setSuccessBanner(
                `Applied +1 year glide path shift to ${result.adjustedCount || 0} asset(s) and updated target baselines.`
            );
            notifyPortfolioUpdated('glide-path-applied');
        } catch (error) {
            console.error('Failed to apply glide path step:', error);
            setErrorBanner('Network error while applying glide path step.');
        } finally {
            setIsApplyingGlide(false);
        }
    };

    const toggleTradeCheck = (key: string) => {
        setCheckedTradeList((prev) =>
            prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]
        );
    };

    const toggleExpandRow = (key: string) => {
        setExpandedRows((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
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

    const tickerPlan = useMemo(() => {
        return computeRebalancePlan(rebalanceData || [], {
            mode: rebalanceMode,
            newCash: rebalanceMode === 'BUY_ONLY' ? newCash : 0,
            tolerancePercent,
            wholeShares
        });
    }, [rebalanceData, rebalanceMode, newCash, tolerancePercent, wholeShares]);

    const categoryPlan = useMemo(() => {
        return computeCategoryRebalancePlan(rebalanceData || [], categoryTargets, {
            mode: rebalanceMode,
            newCash: rebalanceMode === 'BUY_ONLY' ? newCash : 0,
            tolerancePercent,
            wholeShares
        });
    }, [rebalanceData, categoryTargets, rebalanceMode, newCash, tolerancePercent, wholeShares]);

    const rows = dimension === 'CATEGORY' ? categoryPlan.rows : tickerPlan.rows;
    const summary = dimension === 'CATEGORY' ? categoryPlan.summary : tickerPlan.summary;

    const itemBySymbol = useMemo(() => {
        return new Map((rebalanceData || []).map((item) => [item.symbol, item]));
    }, [rebalanceData]);

    const categoryRowByType = useMemo(() => {
        return new Map<string, PlannedCategoryRow>(
            categoryPlan.rows.map((r) => [r.investmentType, r])
        );
    }, [categoryPlan.rows]);

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
                        Monitor drift against target allocations, route trades tax-efficiently across accounts, and simulate buy-only cash inflows.
                    </p>
                </div>

                <div className={styles.headerControls}>
                    {profiles.length > 0 && (
                        <select
                            aria-label="Active rebalance profile"
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
                {/* Expandable Target, Profile & Glide Path Studio */}
                <RebalancerConfigPanel
                    isOpen={isConfigOpen}
                    dimension={dimension}
                    onChangeDimension={setDimension}
                    targets={targets}
                    categoryTargets={categoryTargets}
                    portfolioSymbols={portfolioSymbols}
                    availableInvestmentTypes={availableInvestmentTypes}
                    profiles={profiles}
                    activeProfileId={activeProfileId}
                    bindFiltersToProfile={bindFiltersToProfile}
                    onToggleBindFilters={setBindFiltersToProfile}
                    onSelectProfile={handleSelectProfile}
                    onSaveAsNewProfile={handleSaveAsNewProfile}
                    onDeleteProfile={handleDeleteProfile}
                    isSaving={isSaving}
                    isApplyingGlide={isApplyingGlide}
                    onChangeTargets={setTargets}
                    onChangeCategoryTargets={setCategoryTargets}
                    onSeedFromHoldings={handleSeedFromHoldings}
                    onEqualWeight={handleEqualWeight}
                    onApplyCategoryTemplate={handleApplyCategoryTemplate}
                    onNormalizeTargets={handleNormalizeTargets}
                    onSimulateGlideStep={handleSimulateGlideStep}
                    onApplyGlideStepNow={handleApplyGlideStepNow}
                    onSaveTargets={saveTargets}
                />

                {isLoading && (!rebalanceData || dataCurrency !== currency) ? (
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
                                    <span>
                                        {dimension === 'CATEGORY' ? 'Classes:' : 'Assets:'} <strong>{rows.length}</strong>
                                    </span>
                                    <span>Excluded: <strong>{excludedSet.size}</strong></span>
                                    {rebalanceMode === 'BUY_ONLY' && newCash > 0 && (
                                        <span>Post-Cash: <strong>{format(summary.postTradeTotalValue, { maximumFractionDigits: 0 })}</strong></span>
                                    )}
                                </div>
                            </article>

                            <article className={styles.kpiCard}>
                                <div>
                                    <div className={styles.kpiHeader}>
                                        <span className={styles.kpiLabel}>Est. Turnover</span>
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
                                            {rows.filter((r) => r.driftPercent < -(tolerancePercent + 1e-9)).length} Underweight
                                        </span>
                                        <span className={styles.negativeText}>
                                            {rows.filter((r) => r.driftPercent > tolerancePercent + 1e-9).length} Overweight
                                        </span>
                                    </div>
                                    <span className={styles.kpiSubtext}>
                                        <strong>{summary.outOfBandCount}</strong> {dimension === 'CATEGORY' ? 'class' : 'asset'}{summary.outOfBandCount === 1 ? '' : dimension === 'CATEGORY' ? 'es' : 's'} outside &plusmn;{tolerancePercent}% band
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
                                        <strong>{summary.untargetedCount}</strong> untargeted
                                        {dimension === 'TICKER' && (
                                            <> &bull; <strong>{summary.glideActiveCount}</strong> glide path</>
                                        )}
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
                                                Switch dimension, simulate cash inflows, and set drift tolerance bands.
                                            </p>
                                        </div>

                                        <form className={styles.paramForm} onSubmit={(e) => e.preventDefault()}>
                                            <fieldset className={styles.fieldset}>
                                                <legend className={styles.legend}>Analysis Dimension</legend>
                                                <div className={styles.modeToggle} role="group" aria-label="Rebalance dimension">
                                                    <button
                                                        type="button"
                                                        className={styles.modeBtn}
                                                        aria-pressed={dimension === 'TICKER'}
                                                        onClick={() => setDimension('TICKER')}
                                                    >
                                                        By Ticker
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className={styles.modeBtn}
                                                        aria-pressed={dimension === 'CATEGORY'}
                                                        onClick={() => setDimension('CATEGORY')}
                                                    >
                                                        By Asset Type
                                                    </button>
                                                </div>
                                            </fieldset>

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
                                        dimension={dimension}
                                        formatCurrency={format}
                                    />
                                </section>

                                {/* Tier 3: Execution Checklist */}
                                <section className={styles.panelCard} aria-label="Trade execution checklist">
                                    <div className={styles.checklistHeader}>
                                        <div>
                                            <h2 className={styles.panelHeading}>
                                                {dimension === 'CATEGORY' ? 'Asset Class Execution Checklist' : 'Execution Checklist'}
                                            </h2>
                                            <p className={styles.panelSubheading}>
                                                {completedActionableCount} of {actionableCount} recommended {dimension === 'CATEGORY' ? 'allocations' : 'trades'} marked complete
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

                                    {!isTargetSumValid && (dimension === 'CATEGORY' ? categoryTargets.length > 0 : targets.length > 0) && (
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
                                                    <th>{dimension === 'CATEGORY' ? 'Asset Type' : 'Asset'}</th>
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
                                                            No items match the selected checklist filter.
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    filteredRows.map((d) => {
                                                        const isChecked = checkedTrades.has(d.symbol);
                                                        const driftBarWidth = Math.min(100, (Math.abs(d.driftPercent) / maxRowAbsDrift) * 100);
                                                        const isExpanded = expandedRows.has(d.symbol);

                                                        const sourceItem = dimension === 'TICKER' ? itemBySymbol.get(d.symbol) : undefined;
                                                        const categoryRow = dimension === 'CATEGORY' ? categoryRowByType.get(d.symbol) : undefined;

                                                        const accountGuidance = dimension === 'TICKER'
                                                            ? allocateTradeAcrossAccounts(
                                                                sourceItem?.accounts,
                                                                d.effectiveAction,
                                                                d.tradeValue,
                                                                d.tradeShares,
                                                                wholeShares
                                                            )
                                                            : null;

                                                        const canExpand = dimension === 'CATEGORY'
                                                            ? Boolean(categoryRow && categoryRow.constituents.length > 0)
                                                            : Boolean(sourceItem?.accounts && sourceItem.accounts.length > 0);

                                                        return (
                                                            <React.Fragment key={d.symbol}>
                                                                <tr className={isChecked ? styles.checkedRow : ''}>
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
                                                                        <div className={styles.assetCellInner}>
                                                                            {canExpand && (
                                                                                <button
                                                                                    type="button"
                                                                                    className={styles.expandBtn}
                                                                                    onClick={() => toggleExpandRow(d.symbol)}
                                                                                    aria-expanded={isExpanded}
                                                                                    aria-label={isExpanded ? `Collapse ${d.symbol} breakdown` : `Expand ${d.symbol} breakdown`}
                                                                                >
                                                                                    {isExpanded
                                                                                        ? <MdExpandLess size={18} aria-hidden="true" />
                                                                                        : <MdExpandMore size={18} aria-hidden="true" />}
                                                                                </button>
                                                                            )}
                                                                            <div>
                                                                                {dimension === 'CATEGORY' ? (
                                                                                    <span className={styles.symbolLink} style={{ cursor: 'default', textDecoration: 'none' }}>
                                                                                        <span>{d.symbol}</span>
                                                                                        {d.isUntargeted && (
                                                                                            <span className={styles.untargetedBadge}>No Target</span>
                                                                                        )}
                                                                                    </span>
                                                                                ) : (
                                                                                    <Link href={`/analysis/${encodeURIComponent(d.symbol)}`} className={styles.symbolLink}>
                                                                                        <span>{d.symbol}</span>
                                                                                        {d.isUntargeted && (
                                                                                            <span className={styles.untargetedBadge}>No Target</span>
                                                                                        )}
                                                                                    </Link>
                                                                                )}

                                                                                {dimension === 'CATEGORY' && categoryRow && (
                                                                                    <span className={styles.subValue}>
                                                                                        {categoryRow.constituents.length} holding{categoryRow.constituents.length === 1 ? '' : 's'}
                                                                                    </span>
                                                                                )}

                                                                                {dimension === 'TICKER' && d.assetPrice > 0 && (
                                                                                    <span className={styles.subValue}>
                                                                                        {d.assetCurrency} {d.assetPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                                                        {sourceItem?.investmentType ? ` • ${sourceItem.investmentType}` : ''}
                                                                                    </span>
                                                                                )}
                                                                            </div>
                                                                        </div>
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
                                                                        <div className={styles.actionCellStack}>
                                                                            {d.effectiveAction === 'HOLD' ? (
                                                                                <span className={`${styles.actionTag} ${styles.actionHOLD}`}>HOLD</span>
                                                                            ) : dimension === 'CATEGORY' ? (
                                                                                <span className={`${styles.actionTag} ${styles[`action${d.effectiveAction}`]}`}>
                                                                                    {d.effectiveAction} {format(d.tradeValue)}
                                                                                </span>
                                                                            ) : (
                                                                                <span className={`${styles.actionTag} ${styles[`action${d.effectiveAction}`]}`}>
                                                                                    {d.effectiveAction} {formatShareCount(d.tradeShares, wholeShares)} sh ({format(d.tradeValue)})
                                                                                </span>
                                                                            )}

                                                                            {dimension === 'TICKER' && accountGuidance?.primaryVenueLabel && (
                                                                                <span className={styles.venueTag}>
                                                                                    {accountGuidance.primaryVenueLabel}
                                                                                </span>
                                                                            )}

                                                                            {dimension === 'TICKER' && accountGuidance?.hasTaxableSellWarning && (
                                                                                <span className={styles.taxWarningTag}>
                                                                                    <MdWarningAmber size={13} aria-hidden="true" />
                                                                                    Taxable Sale — Capital Gains May Apply
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    </td>
                                                                    <td className={styles.numericCol}>
                                                                        <strong>{d.postTradePercent.toFixed(2)}%</strong>
                                                                        <span className={styles.subValue}>
                                                                            {d.postTradeDriftPercent > 0 ? '+' : ''}{d.postTradeDriftPercent.toFixed(2)}% drift
                                                                        </span>
                                                                    </td>
                                                                </tr>

                                                                {isExpanded && dimension === 'TICKER' && accountGuidance && accountGuidance.allocations.length > 0 && (
                                                                    <tr className={styles.detailRow}>
                                                                        <td colSpan={7}>
                                                                            <div className={styles.detailBox}>
                                                                                <div className={styles.detailHeader}>
                                                                                    Account-Aware Execution Breakdown ({d.symbol})
                                                                                </div>
                                                                                <table className={styles.detailTable}>
                                                                                    <thead>
                                                                                        <tr>
                                                                                            <th>Account</th>
                                                                                            <th>Platform</th>
                                                                                            <th>Account Type</th>
                                                                                            <th>Tax Tier</th>
                                                                                            <th className={styles.numericCol}>Held</th>
                                                                                            <th>Suggested Route</th>
                                                                                        </tr>
                                                                                    </thead>
                                                                                    <tbody>
                                                                                        {accountGuidance.allocations.map((alloc, idx) => (
                                                                                            <tr key={`${alloc.accountName}-${alloc.platformName}-${idx}`}>
                                                                                                <td><strong>{alloc.accountName}</strong></td>
                                                                                                <td>{alloc.platformName}</td>
                                                                                                <td>{alloc.accountType}</td>
                                                                                                <td>
                                                                                                    <span className={`${styles.taxTierBadge} ${getTaxTierClassName(alloc.taxStatus)}`}>
                                                                                                        {getTaxStatusLabel(alloc.taxStatus)}
                                                                                                    </span>
                                                                                                </td>
                                                                                                <td className={styles.numericCol}>
                                                                                                    {formatShareCount(alloc.heldShares, false)} sh ({format(alloc.heldValue)})
                                                                                                </td>
                                                                                                <td>
                                                                                                    {alloc.suggestedAction === 'HOLD' ? (
                                                                                                        <span className={styles.subValue} style={{ marginTop: 0 }}>Hold</span>
                                                                                                    ) : (
                                                                                                        <strong className={alloc.suggestedAction === 'BUY' ? styles.positiveText : styles.negativeText}>
                                                                                                            {alloc.suggestedAction} {formatShareCount(alloc.suggestedShares, wholeShares)} sh ({format(alloc.suggestedValue)})
                                                                                                        </strong>
                                                                                                    )}
                                                                                                </td>
                                                                                            </tr>
                                                                                        ))}
                                                                                    </tbody>
                                                                                </table>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                )}

                                                                {isExpanded && dimension === 'CATEGORY' && categoryRow && categoryRow.constituents.length > 0 && (
                                                                    <tr className={styles.detailRow}>
                                                                        <td colSpan={7}>
                                                                            <div className={styles.detailBox}>
                                                                                <div className={styles.detailHeader}>
                                                                                    Pro-Rata Constituent Allocation ({categoryRow.investmentType})
                                                                                </div>
                                                                                <table className={styles.detailTable}>
                                                                                    <thead>
                                                                                        <tr>
                                                                                            <th>Symbol</th>
                                                                                            <th className={styles.numericCol}>Share of Class</th>
                                                                                            <th className={styles.numericCol}>Current Value</th>
                                                                                            <th>Pro-Rata Suggested Trade</th>
                                                                                        </tr>
                                                                                    </thead>
                                                                                    <tbody>
                                                                                        {categoryRow.constituents.map((c) => (
                                                                                            <tr key={c.symbol}>
                                                                                                <td>
                                                                                                    <Link href={`/analysis/${encodeURIComponent(c.symbol)}`} className={styles.symbolLink}>
                                                                                                        {c.symbol}
                                                                                                    </Link>
                                                                                                </td>
                                                                                                <td className={styles.numericCol}>{c.currentPercentInCategory.toFixed(1)}%</td>
                                                                                                <td className={styles.numericCol}>{format(c.currentValue)}</td>
                                                                                                <td>
                                                                                                    {d.effectiveAction === 'HOLD' ? (
                                                                                                        <span className={styles.subValue} style={{ marginTop: 0 }}>Hold</span>
                                                                                                    ) : (
                                                                                                        <strong className={d.effectiveAction === 'BUY' ? styles.positiveText : styles.negativeText}>
                                                                                                            {d.effectiveAction} {formatShareCount(c.suggestedShares, wholeShares)} sh ({format(c.suggestedValue)})
                                                                                                        </strong>
                                                                                                    )}
                                                                                                </td>
                                                                                            </tr>
                                                                                        ))}
                                                                                    </tbody>
                                                                                </table>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                )}
                                                            </React.Fragment>
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
