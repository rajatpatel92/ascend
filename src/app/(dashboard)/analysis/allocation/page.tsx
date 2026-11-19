'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import ConstituentsGrid from '@/components/ConstituentsGrid';
import AllocationChart from '@/components/AllocationChart';
import WorldAllocationMap from '@/components/WorldAllocationMap';
import SectorBreakdownCard from '@/components/SectorBreakdownCard';
import AnalysisSkeleton from '@/components/AnalysisSkeleton';
import ReportFilters, { FilterOptions } from '@/components/ReportFilters';
import usePersistentState from '@/hooks/usePersistentState';
import { useLiveSync } from '@/hooks/useLiveSync';
import { ClientCache } from '@/lib/client-cache';
import { ensureMarketSyncConvergence } from '@/lib/live-sync';
import {
    calculateLookThrough,
    constituentHasSectorExposure,
    constituentHasCountryExposure,
    SectorBreakdown,
    CountryBreakdown
} from '@/lib/look-through';
import PortfolioHoldingsXRay, { StockContributorsBreakdownCard } from '@/components/PortfolioHoldingsXRay';
import {
    calculatePortfolioHoldingsLookThrough,
    constituentHoldsUnderlyingStock,
    PortfolioHoldingStock
} from '@/lib/holdings-look-through';
import { PieChart, Globe, Layers, Landmark, Wallet, Building2 } from 'lucide-react';

interface SyncStatusInfo {
    syncedAt: string | null;
    marketTime: string | null;
    isRefreshing: boolean;
    staleCount: number;
    marketDataVersion: number;
    throttledUntil: string | null;
}

interface PortfolioSummary {
    allocationByType: { name: string; value: number }[];
    allocationByAsset: { name: string; value: number }[];
    allocationByAccountType: { name: string; value: number }[];
    allocationByAccount: { name: string; value: number }[];
    allocationBySector?: { name: string; value: number }[];
    allocationByCountry?: { name: string; value: number }[];
    sectorLookThrough?: SectorBreakdown[];
    countryLookThrough?: CountryBreakdown[];
    constituents: any[];
    syncStatus?: SyncStatusInfo;
}

type ActiveDimension = 'sector' | 'country' | 'holdings' | 'type' | 'accountType' | 'account';

interface InteractiveFilters {
    investmentType: string | null;
    accountType: string | null;
    accountName: string | null;
    sector: string | null;
    country: string | null;
    stockKey: string | null;
}

const EMPTY_INTERACTIVE_FILTERS: InteractiveFilters = {
    investmentType: null,
    accountType: null,
    accountName: null,
    sector: null,
    country: null,
    stockKey: null
};

const QUANTITY_EPSILON = 0.00001;
const VALUE_EPSILON = 0.01;

const DIMENSIONS: ReadonlyArray<{
    id: ActiveDimension;
    label: string;
    title: string;
    subtitle: string;
    badgeText?: string;
    itemLabel: { singular: string; plural: string };
    filterKey: keyof InteractiveFilters;
    icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}> = [
    {
        id: 'sector',
        label: 'Sector',
        title: 'By Sector',
        subtitle: 'Look-through sector exposure combining direct holdings and underlying ETF weights.',
        badgeText: 'Look-Through X-Ray',
        itemLabel: { singular: 'Sector', plural: 'Sectors' },
        filterKey: 'sector',
        icon: PieChart
    },
    {
        id: 'country',
        label: 'Geography',
        title: 'By Geography',
        subtitle: 'Country exposure combining direct holdings and underlying ETF geographic weights.',
        badgeText: 'Look-Through X-Ray',
        itemLabel: { singular: 'Country', plural: 'Countries' },
        filterKey: 'country',
        icon: Globe
    },
    {
        id: 'holdings',
        label: 'Holdings',
        title: 'By Underlying Holdings',
        subtitle: 'Cumulative individual stock exposure combining direct equities and Top 250 ETF look-through weights.',
        badgeText: 'Look-Through X-Ray',
        itemLabel: { singular: 'Holding', plural: 'Holdings' },
        filterKey: 'stockKey',
        icon: Building2
    },
    {
        id: 'type',
        label: 'Asset Type',
        title: 'By Investment Type',
        subtitle: 'Distribution across asset classes such as ETFs, equities, cash, and crypto.',
        itemLabel: { singular: 'Asset Type', plural: 'Asset Types' },
        filterKey: 'investmentType',
        icon: Layers
    },
    {
        id: 'accountType',
        label: 'Account Type',
        title: 'By Account Type',
        subtitle: 'Allocation grouped by tax-advantaged and taxable account categories.',
        itemLabel: { singular: 'Account Type', plural: 'Account Types' },
        filterKey: 'accountType',
        icon: Landmark
    },
    {
        id: 'account',
        label: 'Account',
        title: 'By Account & Platform',
        subtitle: 'Portfolio distribution across your individual brokerage accounts.',
        itemLabel: { singular: 'Account', plural: 'Accounts' },
        filterKey: 'accountName',
        icon: Wallet
    }
];

const FILTER_BADGE_LABELS: ReadonlyArray<{ key: keyof InteractiveFilters; label: string }> = [
    { key: 'sector', label: 'Sector' },
    { key: 'country', label: 'Geography' },
    { key: 'stockKey', label: 'Holding' },
    { key: 'investmentType', label: 'Asset Type' },
    { key: 'accountType', label: 'Account Type' },
    { key: 'accountName', label: 'Account' }
];

export default function AnalysisPage() {
    const { currency, format } = useCurrency();
    const [summaryState, setSummaryState] = useState<{ currency: string; data: PortfolioSummary } | null>(null);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [activeDimension, setActiveDimension] = useState<ActiveDimension>('sector');
    const [syncTick, setSyncTick] = useState(0);
    const loadedCurrencyRef = useRef<string | null>(null);
    const tabRefs = useRef<Partial<Record<ActiveDimension, HTMLButtonElement | null>>>({});

    // Global Filters (Layer 1)
    const [globalFilters, setGlobalFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('allocation_filters', null);

    // Interactive Chart Filters (Layer 2)
    const [interactiveFilters, setInteractiveFilters] = useState<InteractiveFilters>(EMPTY_INTERACTIVE_FILTERS);

    useLiveSync({
        onSync: () => setSyncTick((t) => t + 1),
    });

    useEffect(() => {
        const controller = new AbortController();
        const cacheKey = ClientCache.generateKey('portfolio_summary', {
            currency,
            investmentTypes: [],
            accountTypes: [],
        });

        const fetchData = async () => {
            let hasCachedForCurrency = loadedCurrencyRef.current === currency;
            try {
                const cached = ClientCache.get<PortfolioSummary>(cacheKey);
                if (cached && typeof cached === 'object' && !('error' in cached) && Array.isArray(cached.constituents)) {
                    hasCachedForCurrency = true;
                    loadedCurrencyRef.current = currency;
                    setSummaryState({ currency, data: cached });
                    setFetchError(null);
                }

                const res = await fetch(`/api/portfolio?currency=${encodeURIComponent(currency)}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                const data = await res.json().catch(() => ({}));
                if (controller.signal.aborted) return;
                if (!res.ok || !data || typeof data !== 'object' || 'error' in data || !Array.isArray(data.constituents)) {
                    if (!hasCachedForCurrency) {
                        setFetchError(
                            typeof data?.error === 'string' ? data.error : `Failed to load portfolio data (HTTP ${res.status})`
                        );
                    }
                    return;
                }

                loadedCurrencyRef.current = currency;
                setSummaryState({ currency, data });
                setFetchError(null);
                ClientCache.set(cacheKey, data);

                if (data.syncStatus) {
                    ensureMarketSyncConvergence({
                        currentVersion: data.syncStatus.marketDataVersion,
                        isRefreshing: data.syncStatus.isRefreshing,
                        staleCount: data.syncStatus.staleCount,
                        throttledUntil: data.syncStatus.throttledUntil,
                    });
                }
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to fetch portfolio', err);
                if (!hasCachedForCurrency) {
                    setFetchError('Network error while loading portfolio allocation.');
                }
            }
        };

        void fetchData();
        return () => controller.abort();
    }, [currency, syncTick]);

    const summary = summaryState?.currency === currency ? summaryState.data : null;

    const handleDimensionSelect = (filterKey: keyof InteractiveFilters, value: string | null, e?: React.MouseEvent) => {
        if (value === null) {
            setInteractiveFilters(prev => ({ ...prev, [filterKey]: null }));
            return;
        }
        const isMulti = e?.ctrlKey || e?.metaKey;
        setInteractiveFilters(prev => {
            const next = isMulti ? { ...prev } : { ...EMPTY_INTERACTIVE_FILTERS };
            next[filterKey] = value === prev[filterKey] ? null : value;
            return next;
        });
    };

    const selectDimensionTab = (dimId: ActiveDimension, focusTab = false) => {
        setActiveDimension(dimId);
        const tabEl = tabRefs.current[dimId];
        if (tabEl) {
            if (focusTab) tabEl.focus();
            tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    };

    const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const currentIndex = DIMENSIONS.findIndex(d => d.id === activeDimension);
        if (currentIndex === -1) return;

        let nextIndex: number | null = null;
        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % DIMENSIONS.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + DIMENSIONS.length) % DIMENSIONS.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = DIMENSIONS.length - 1;

        if (nextIndex !== null) {
            e.preventDefault();
            selectDimensionTab(DIMENSIONS[nextIndex].id, true);
        }
    };

    // --- Layer 1: Global Filter Processing ---
    const globalConstituents = useMemo(() => {
        if (!summary || !globalFilters) return [];

        return summary.constituents
            .map(item => {
                if (!globalFilters.investmentTypes.includes(item.type)) return null;

                let newQuantity = 0;
                let newValue = 0;
                let newCostBasis = 0;
                let newLifetimeDividends = 0;
                let newDividendsYTD = 0;
                let newRealizedGain = 0;
                let weightedXirrSum = 0;
                let totalWeight = 0;

                const newBreakdown: any = {};
                let hasValidAccount = false;

                if (item.accountsBreakdown) {
                    Object.entries(item.accountsBreakdown).forEach(([key, acc]: [string, any]) => {
                        if (globalFilters.accountTypes.includes(acc.accountType)) {
                            hasValidAccount = true;
                            newQuantity += acc.quantity;
                            newValue += (acc.valueNative ?? (acc.quantity * item.price));
                            newCostBasis += (acc.costBasisNative ?? acc.costBasis);
                            newLifetimeDividends += (acc.lifetimeDividendsNative ?? 0);
                            newDividendsYTD += (acc.dividendsYTDNative ?? 0);
                            newRealizedGain += (acc.realizedGainNative ?? 0);
                            newBreakdown[key] = acc;

                            if (acc.xirr !== null && acc.value > 0) {
                                weightedXirrSum += (acc.xirr * acc.value);
                                totalWeight += acc.value;
                            }
                        }
                    });
                }

                if (newQuantity <= QUANTITY_EPSILON) {
                    newQuantity = 0;
                    newValue = 0;
                    newCostBasis = 0;
                }

                if (!hasValidAccount || (newQuantity === 0 && newLifetimeDividends === 0 && newDividendsYTD === 0 && Math.abs(newRealizedGain) < 0.01)) return null;

                const aggregatedXirr = totalWeight > 0 ? weightedXirrSum / totalWeight : null;
                const quantityRatio = item.quantity > 0 ? (newQuantity / item.quantity) : 0;

                const scaleMetric = (metric: any) => {
                    if (!metric) return metric;
                    return {
                        ...metric,
                        absolute: metric.absolute * quantityRatio,
                        absoluteTarget: metric.absoluteTarget !== undefined ? metric.absoluteTarget * quantityRatio : undefined
                    };
                };

                const conversionRate = item.conversionRate || 1;
                const newAvgPrice = newQuantity > QUANTITY_EPSILON ? newCostBasis / newQuantity : 0;

                return {
                    ...item,
                    quantity: newQuantity,
                    avgPrice: newAvgPrice,
                    value: newValue,
                    valueTarget: newValue * conversionRate,
                    bookValue: newCostBasis,
                    bookValueTarget: newCostBasis * conversionRate,
                    lifetimeDividends: newLifetimeDividends,
                    lifetimeDividendsNative: newLifetimeDividends,
                    lifetimeDividendsTarget: newLifetimeDividends * conversionRate,
                    dividendsYTD: newDividendsYTD,
                    dividendsYTDNative: newDividendsYTD,
                    dividendsYTDTarget: newDividendsYTD * conversionRate,
                    realizedGain: newRealizedGain,
                    realizedGainTarget: newRealizedGain * conversionRate,
                    accountsBreakdown: newBreakdown,
                    dayChange: scaleMetric(item.dayChange),
                    change1W: scaleMetric(item.change1W),
                    change1M: scaleMetric(item.change1M),
                    change1Y: scaleMetric(item.change1Y),
                    changeYTD: scaleMetric(item.changeYTD),
                    inceptionChange: {
                        absolute: newValue - newCostBasis,
                        absoluteTarget: (newValue - newCostBasis) * conversionRate,
                        percent: newCostBasis > 0 ? ((newValue - newCostBasis) / newCostBasis) * 100 : 0
                    },
                    xirr: aggregatedXirr
                };
            })
            .filter(Boolean);
    }, [summary, globalFilters]);

    // --- Dynamic Allocations for Charts (Based on Layer 1 Active Holdings) ---
    const chartAllocations = useMemo(() => {
        const byType = new Map<string, number>();
        const byAccountType = new Map<string, number>();
        const byAccount = new Map<string, number>();

        const activeChartConstituents = globalConstituents.filter((item: any) => {
            const targetValue = item.valueTarget ?? (item.value * (item.conversionRate || 1));
            return item.quantity >= QUANTITY_EPSILON && targetValue >= VALUE_EPSILON;
        });

        activeChartConstituents.forEach((item: any) => {
            const itemTargetValue = item.valueTarget ?? (item.value * (item.conversionRate || 1));
            byType.set(item.type, (byType.get(item.type) || 0) + itemTargetValue);

            if (item.accountsBreakdown) {
                const conversionRate = item.conversionRate || 1;
                Object.values(item.accountsBreakdown).forEach((acc: any) => {
                    const targetValue = (acc.valueNative ?? 0) * conversionRate;
                    if (targetValue < VALUE_EPSILON) return;
                    byAccountType.set(acc.accountType, (byAccountType.get(acc.accountType) || 0) + targetValue);
                    const compositeKey = `${acc.name} - ${acc.platformName}`;
                    byAccount.set(compositeKey, (byAccount.get(compositeKey) || 0) + targetValue);
                });
            }
        });

        const lookThroughConstituents = activeChartConstituents.map((item: any) => ({
            symbol: item.symbol,
            name: item.name,
            type: item.type,
            value: item.valueTarget ?? (item.value * (item.conversionRate || 1)),
            currency: item.currency,
            sector: item.sector,
            country: item.country,
            sectorAllocations: item.sectorAllocations,
            countryAllocations: item.countryAllocations,
            topHoldings: item.topHoldings
        }));

        const lookThrough = calculateLookThrough(lookThroughConstituents);
        const holdingsLookThrough = calculatePortfolioHoldingsLookThrough(lookThroughConstituents);
        const mapToObj = (map: Map<string, number>) => Array.from(map.entries()).map(([name, value]) => ({ name, value }));

        return {
            allocationByType: mapToObj(byType),
            allocationByAccountType: mapToObj(byAccountType),
            allocationByAccount: mapToObj(byAccount),
            allocationBySector: lookThrough.bySector,
            allocationByCountry: lookThrough.byCountry,
            sectorLookThrough: lookThrough.sectorDetails,
            countryLookThrough: lookThrough.countryDetails,
            holdingsLookThrough,
            totalValue: lookThrough.totalValue
        };
    }, [globalConstituents]);

    // On-demand X-Ray breakdowns (only resolved when user selects a Sector, Country, or Underlying Stock)
    const activeSectorBreakdown = useMemo(() => {
        if (!interactiveFilters.sector) return null;
        return chartAllocations.sectorLookThrough.find(s => s.name === interactiveFilters.sector) || null;
    }, [interactiveFilters.sector, chartAllocations.sectorLookThrough]);

    const activeCountryBreakdown = useMemo(() => {
        if (!interactiveFilters.country) return null;
        return chartAllocations.countryLookThrough.find(c => c.name === interactiveFilters.country) || null;
    }, [interactiveFilters.country, chartAllocations.countryLookThrough]);

    const selectedStock = useMemo<PortfolioHoldingStock | null>(() => {
        if (!interactiveFilters.stockKey) return null;
        return chartAllocations.holdingsLookThrough.holdings.find(h => h.key === interactiveFilters.stockKey) || null;
    }, [interactiveFilters.stockKey, chartAllocations.holdingsLookThrough.holdings]);

    // --- Layer 2: Interactive Filter Processing (For Table) ---
    const finalConstituents = useMemo(() => {
        return globalConstituents
            .filter((item: any) => {
                if (interactiveFilters.investmentType && item.type !== interactiveFilters.investmentType) return false;
                if (interactiveFilters.sector || interactiveFilters.country || interactiveFilters.stockKey) {
                    const targetValue = item.valueTarget ?? (item.value * (item.conversionRate || 1));
                    if (item.quantity < QUANTITY_EPSILON || targetValue < VALUE_EPSILON) return false;
                    const lookThroughItem = { ...item, value: targetValue };
                    if (interactiveFilters.sector && !constituentHasSectorExposure(lookThroughItem, interactiveFilters.sector)) return false;
                    if (interactiveFilters.country && !constituentHasCountryExposure(lookThroughItem, interactiveFilters.country)) return false;
                    if (interactiveFilters.stockKey && !constituentHoldsUnderlyingStock(lookThroughItem, selectedStock)) return false;
                }

                let matchesInteractiveAccount = true;
                if (interactiveFilters.accountType || interactiveFilters.accountName) {
                    matchesInteractiveAccount = false;
                    if (item.accountsBreakdown) {
                        Object.values(item.accountsBreakdown).forEach((acc: any) => {
                            const compositeKey = `${acc.name} - ${acc.platformName}`;
                            let breakdownMatch = true;
                            if (interactiveFilters.accountType && acc.accountType !== interactiveFilters.accountType) breakdownMatch = false;
                            if (interactiveFilters.accountName && compositeKey !== interactiveFilters.accountName) breakdownMatch = false;
                            if (breakdownMatch) matchesInteractiveAccount = true;
                        });
                    }
                }

                return matchesInteractiveAccount;
            })
            .map((item: any) => {
                if (!interactiveFilters.accountType && !interactiveFilters.accountName) return item;

                let newQuantity = 0;
                let newValue = 0;
                let newCostBasis = 0;
                let newLifetimeDividends = 0;
                let newDividendsYTD = 0;
                let newRealizedGain = 0;
                let weightedXirrSum = 0;
                let totalWeight = 0;

                if (item.accountsBreakdown) {
                    Object.values(item.accountsBreakdown).forEach((acc: any) => {
                        let match = true;
                        if (interactiveFilters.accountType && acc.accountType !== interactiveFilters.accountType) match = false;
                        const compositeKey = `${acc.name} - ${acc.platformName}`;
                        if (interactiveFilters.accountName && compositeKey !== interactiveFilters.accountName) match = false;

                        if (match) {
                            newQuantity += acc.quantity;
                            newValue += (acc.valueNative ?? (acc.quantity * item.price));
                            newCostBasis += (acc.costBasisNative ?? 0);
                            newLifetimeDividends += (acc.lifetimeDividendsNative ?? 0);
                            newDividendsYTD += (acc.dividendsYTDNative ?? 0);
                            newRealizedGain += (acc.realizedGainNative ?? 0);
                            if (acc.xirr !== null && acc.value > 0) {
                                weightedXirrSum += (acc.xirr * acc.value);
                                totalWeight += acc.value;
                            }
                        }
                    });
                }

                if (newQuantity <= QUANTITY_EPSILON) {
                    newQuantity = 0;
                    newValue = 0;
                    newCostBasis = 0;
                }

                if (newQuantity === 0 && newLifetimeDividends === 0 && newDividendsYTD === 0 && Math.abs(newRealizedGain) < 0.01) return null;

                const aggregatedXirr = totalWeight > 0 ? weightedXirrSum / totalWeight : null;
                const quantityRatio = item.quantity > 0 ? (newQuantity / item.quantity) : 0;

                const scaleMetric = (metric: any) => {
                    if (!metric) return metric;
                    return {
                        ...metric,
                        absolute: metric.absolute * quantityRatio,
                        absoluteTarget: metric.absoluteTarget !== undefined ? metric.absoluteTarget * quantityRatio : undefined
                    };
                };

                const conversionRate = item.conversionRate || 1;
                const newAvgPrice = newQuantity > QUANTITY_EPSILON ? newCostBasis / newQuantity : 0;

                return {
                    ...item,
                    quantity: newQuantity,
                    avgPrice: newAvgPrice,
                    value: newValue,
                    valueTarget: newValue * conversionRate,
                    bookValue: newCostBasis,
                    bookValueTarget: newCostBasis * conversionRate,
                    lifetimeDividends: newLifetimeDividends,
                    lifetimeDividendsNative: newLifetimeDividends,
                    lifetimeDividendsTarget: newLifetimeDividends * conversionRate,
                    dividendsYTD: newDividendsYTD,
                    dividendsYTDNative: newDividendsYTD,
                    dividendsYTDTarget: newDividendsYTD * conversionRate,
                    realizedGain: newRealizedGain,
                    realizedGainTarget: newRealizedGain * conversionRate,
                    dayChange: scaleMetric(item.dayChange),
                    change1W: scaleMetric(item.change1W),
                    change1M: scaleMetric(item.change1M),
                    change1Y: scaleMetric(item.change1Y),
                    changeYTD: scaleMetric(item.changeYTD),
                    inceptionChange: {
                        absolute: newValue - newCostBasis,
                        absoluteTarget: (newValue - newCostBasis) * conversionRate,
                        percent: newCostBasis > 0 ? ((newValue - newCostBasis) / newCostBasis) * 100 : 0
                    },
                    xirr: aggregatedXirr
                };
            })
            .filter(Boolean);
    }, [globalConstituents, interactiveFilters, selectedStock]);

    if (!summary) {
        if (fetchError) {
            return (
                <div className={styles.container}>
                    <header className={styles.header}>
                        <div className={styles.headerTop}>
                            <div>
                                <h1 className={styles.title}>Portfolio Analysis</h1>
                                <p className={styles.subtitle}>{fetchError}</p>
                            </div>
                            <button
                                type="button"
                                className={styles.clearBtn}
                                onClick={() => setSyncTick(t => t + 1)}
                            >
                                Retry
                            </button>
                        </div>
                    </header>
                </div>
            );
        }
        return <AnalysisSkeleton />;
    }

    const dimensionDataMap: Record<ActiveDimension, { name: string; value: number }[]> = {
        sector: chartAllocations.allocationBySector,
        country: chartAllocations.allocationByCountry,
        holdings: [],
        type: chartAllocations.allocationByType,
        accountType: chartAllocations.allocationByAccountType,
        account: chartAllocations.allocationByAccount
    };

    const currentDimConfig = DIMENSIONS.find(d => d.id === activeDimension) ?? DIMENSIONS[0];
    const activeFilterBadges = FILTER_BADGE_LABELS.filter(b => Boolean(interactiveFilters[b.key]));

    const showXrayPanel =
        (activeDimension === 'sector' && activeSectorBreakdown) ||
        (activeDimension === 'country' && activeCountryBreakdown);

    const activeXrayBreakdown = activeDimension === 'country' ? activeCountryBreakdown : activeSectorBreakdown;
    const activeXrayLabel = activeDimension === 'country' ? 'Country' : 'Sector';

    const dimensionTabs = (
        <div
            role="tablist"
            aria-label="Allocation dimensions"
            className={styles.tablist}
            onKeyDown={handleTabKeyDown}
        >
            {DIMENSIONS.map(dim => {
                const isSelected = activeDimension === dim.id;
                const Icon = dim.icon;
                const hasActiveFilter = Boolean(interactiveFilters[dim.filterKey]);

                return (
                    <button
                        key={dim.id}
                        ref={el => {
                            tabRefs.current[dim.id] = el;
                        }}
                        type="button"
                        role="tab"
                        id={`allocation-tab-${dim.id}`}
                        aria-selected={isSelected}
                        tabIndex={isSelected ? 0 : -1}
                        className={styles.tabBtn}
                        onClick={() => selectDimensionTab(dim.id)}
                    >
                        <Icon size={15} aria-hidden={true} />
                        <span>{dim.label}</span>
                        {hasActiveFilter && <span className={styles.tabFilterDot} aria-hidden="true" />}
                    </button>
                );
            })}
        </div>
    );

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerTop}>
                    <div>
                        <h1 className={styles.title}>Portfolio Analysis</h1>
                        <p className={styles.subtitle}>
                            Explore asset allocation across dimensions, inspect ETF look-through exposure, and track position performance.
                        </p>
                    </div>
                    {isFiltersLoaded && (
                        <ReportFilters onChange={setGlobalFilters} initialFilters={globalFilters || undefined} />
                    )}
                </div>

                {activeFilterBadges.length > 0 && (
                    <div className={styles.filterBadges}>
                        {activeFilterBadges.map(({ key, label }) => {
                            const displayValue =
                                key === 'stockKey' && selectedStock
                                    ? `${selectedStock.name}${selectedStock.ticker ? ` (${selectedStock.ticker})` : ''}`
                                    : interactiveFilters[key];
                            return (
                                <span key={key} className={styles.badge}>
                                    <span className={styles.badgeLabel}>{label}: {displayValue}</span>
                                    <button
                                        type="button"
                                        aria-label={`Remove ${label} filter`}
                                        onClick={() => setInteractiveFilters(prev => ({ ...prev, [key]: null }))}
                                    >
                                        &times;
                                    </button>
                                </span>
                            );
                        })}
                        <button
                            type="button"
                            onClick={() => setInteractiveFilters(EMPTY_INTERACTIVE_FILTERS)}
                            className={styles.clearBtn}
                        >
                            Clear Filters
                        </button>
                    </div>
                )}
            </header>

            <div className={styles.analysisGrid}>
                <div className={styles.explorerCard}>
                    <div className={styles.tablistBar}>
                        {dimensionTabs}
                    </div>
                    <div
                        role="tabpanel"
                        aria-labelledby={`allocation-tab-${activeDimension}`}
                        className={styles.tabpanel}
                    >
                        {activeDimension === 'country' ? (
                            <WorldAllocationMap
                                title={currentDimConfig.title}
                                subtitle={currentDimConfig.subtitle}
                                badgeText={currentDimConfig.badgeText}
                                embedded={true}
                                data={dimensionDataMap.country}
                                onSelect={(value, e) => handleDimensionSelect('country', value, e)}
                                selectedName={interactiveFilters.country}
                                isPreConverted={true}
                            />
                        ) : activeDimension === 'holdings' ? (
                            <PortfolioHoldingsXRay
                                result={chartAllocations.holdingsLookThrough}
                                selectedStockKey={interactiveFilters.stockKey}
                                onSelectStock={(stock, e) =>
                                    handleDimensionSelect('stockKey', stock ? stock.key : null, e)
                                }
                                format={format}
                            />
                        ) : (
                            <AllocationChart
                                key={activeDimension}
                                title={currentDimConfig.title}
                                subtitle={currentDimConfig.subtitle}
                                badgeText={currentDimConfig.badgeText}
                                itemLabel={currentDimConfig.itemLabel}
                                embedded={true}
                                data={dimensionDataMap[activeDimension]}
                                onSelect={(value, e) => handleDimensionSelect(currentDimConfig.filterKey, value, e)}
                                selectedName={interactiveFilters[currentDimConfig.filterKey]}
                                isPreConverted={true}
                            />
                        )}
                    </div>
                </div>

                {/* On-Demand Portfolio X-Ray Drill-Down Panel */}
                {showXrayPanel && activeXrayBreakdown && (
                    <SectorBreakdownCard
                        breakdown={activeXrayBreakdown}
                        dimensionLabel={activeXrayLabel}
                        onClose={() =>
                            setInteractiveFilters(prev => ({
                                ...prev,
                                [activeDimension === 'country' ? 'country' : 'sector']: null
                            }))
                        }
                        format={format}
                    />
                )}

                {activeDimension === 'holdings' && selectedStock && (
                    <StockContributorsBreakdownCard
                        stock={selectedStock}
                        onClose={() =>
                            setInteractiveFilters(prev => ({ ...prev, stockKey: null }))
                        }
                        format={format}
                    />
                )}

                {/* Constituents Grid (Using Final Filtered Data) */}
                <div className={styles.gridContainer}>
                    <ConstituentsGrid data={finalConstituents} />
                </div>
            </div>
        </div>
    );
}
