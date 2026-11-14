'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import ConstituentsGrid from '@/components/ConstituentsGrid';
import AllocationChart from '@/components/AllocationChart';
import SectorBreakdownCard from '@/components/SectorBreakdownCard';
import AnalysisSkeleton from '@/components/AnalysisSkeleton';
import ReportFilters, { FilterOptions } from '@/components/ReportFilters';
import usePersistentState from '@/hooks/usePersistentState';
import {
    calculateLookThrough,
    constituentHasSectorExposure,
    constituentHasCountryExposure,
    SectorBreakdown,
    CountryBreakdown
} from '@/lib/look-through';
import { PieChart, Globe, Layers, Landmark, Wallet } from 'lucide-react';

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
}

type ActiveDimension = 'sector' | 'country' | 'type' | 'accountType' | 'account';

interface InteractiveFilters {
    investmentType: string | null;
    accountType: string | null;
    accountName: string | null;
    sector: string | null;
    country: string | null;
}

const EMPTY_INTERACTIVE_FILTERS: InteractiveFilters = {
    investmentType: null,
    accountType: null,
    accountName: null,
    sector: null,
    country: null
};

const QUANTITY_EPSILON = 0.00001;
const VALUE_EPSILON = 0.01;

const DIMENSIONS: ReadonlyArray<{
    id: ActiveDimension;
    label: string;
    title: string;
    subtitle: string;
    badgeText?: string;
    filterKey: keyof InteractiveFilters;
    icon: React.ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}> = [
    {
        id: 'sector',
        label: 'Sector',
        title: 'By Sector',
        subtitle: 'Look-through sector exposure combining direct holdings and underlying ETF weights.',
        badgeText: 'Look-Through X-Ray',
        filterKey: 'sector',
        icon: PieChart
    },
    {
        id: 'country',
        label: 'Geography',
        title: 'By Geography',
        subtitle: 'Country exposure combining direct holdings and underlying ETF geographic weights.',
        badgeText: 'Look-Through X-Ray',
        filterKey: 'country',
        icon: Globe
    },
    {
        id: 'type',
        label: 'Asset Type',
        title: 'By Investment Type',
        subtitle: 'Distribution across asset classes such as ETFs, equities, cash, and crypto.',
        filterKey: 'investmentType',
        icon: Layers
    },
    {
        id: 'accountType',
        label: 'Account Type',
        title: 'By Account Type',
        subtitle: 'Allocation grouped by tax-advantaged and taxable account categories.',
        filterKey: 'accountType',
        icon: Landmark
    },
    {
        id: 'account',
        label: 'Account',
        title: 'By Account & Platform',
        subtitle: 'Portfolio distribution across your individual brokerage accounts.',
        filterKey: 'accountName',
        icon: Wallet
    }
];

const FILTER_BADGE_LABELS: ReadonlyArray<{ key: keyof InteractiveFilters; label: string }> = [
    { key: 'sector', label: 'Sector' },
    { key: 'country', label: 'Geography' },
    { key: 'investmentType', label: 'Asset Type' },
    { key: 'accountType', label: 'Account Type' },
    { key: 'accountName', label: 'Account' }
];

export default function AnalysisPage() {
    const [summary, setSummary] = useState<PortfolioSummary | null>(() => {
        if (typeof window === 'undefined') return null;
        try {
            const cached = localStorage.getItem('portfolio_summary');
            return cached ? JSON.parse(cached) : null;
        } catch {
            return null;
        }
    });
    const [activeDimension, setActiveDimension] = useState<ActiveDimension>('sector');
    const tabRefs = useRef<Partial<Record<ActiveDimension, HTMLButtonElement | null>>>({});
    const { currency, format } = useCurrency();

    // Global Filters (Layer 1)
    const [globalFilters, setGlobalFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('allocation_filters', null);

    // Interactive Chart Filters (Layer 2)
    const [interactiveFilters, setInteractiveFilters] = useState<InteractiveFilters>(EMPTY_INTERACTIVE_FILTERS);

    useEffect(() => {
        fetch(`/api/portfolio?currency=${currency}`)
            .then(res => res.json())
            .then(data => {
                setSummary(data);
                try {
                    localStorage.setItem('portfolio_summary', JSON.stringify(data));
                } catch {
                    // Ignore storage quota errors
                }
            })
            .catch(err => console.error('Failed to fetch portfolio', err));
    }, [currency]);

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
                        absoluteTarget: metric.absoluteTarget ? metric.absoluteTarget * quantityRatio : undefined
                    };
                };

                const conversionRate = item.conversionRate || 1;

                return {
                    ...item,
                    quantity: newQuantity,
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
            countryAllocations: item.countryAllocations
        }));

        const lookThrough = calculateLookThrough(lookThroughConstituents);
        const mapToObj = (map: Map<string, number>) => Array.from(map.entries()).map(([name, value]) => ({ name, value }));

        return {
            allocationByType: mapToObj(byType),
            allocationByAccountType: mapToObj(byAccountType),
            allocationByAccount: mapToObj(byAccount),
            allocationBySector: lookThrough.bySector,
            allocationByCountry: lookThrough.byCountry,
            sectorLookThrough: lookThrough.sectorDetails,
            countryLookThrough: lookThrough.countryDetails,
            totalValue: lookThrough.totalValue
        };
    }, [globalConstituents]);

    // On-demand X-Ray breakdowns (only resolved when user selects a Sector or Country)
    const activeSectorBreakdown = useMemo(() => {
        if (!interactiveFilters.sector) return null;
        return chartAllocations.sectorLookThrough.find(s => s.name === interactiveFilters.sector) || null;
    }, [interactiveFilters.sector, chartAllocations.sectorLookThrough]);

    const activeCountryBreakdown = useMemo(() => {
        if (!interactiveFilters.country) return null;
        return chartAllocations.countryLookThrough.find(c => c.name === interactiveFilters.country) || null;
    }, [interactiveFilters.country, chartAllocations.countryLookThrough]);

    // --- Layer 2: Interactive Filter Processing (For Table) ---
    const finalConstituents = useMemo(() => {
        return globalConstituents
            .filter((item: any) => {
                if (interactiveFilters.investmentType && item.type !== interactiveFilters.investmentType) return false;
                if (interactiveFilters.sector || interactiveFilters.country) {
                    const targetValue = item.valueTarget ?? (item.value * (item.conversionRate || 1));
                    if (item.quantity < QUANTITY_EPSILON || targetValue < VALUE_EPSILON) return false;
                    const lookThroughItem = { ...item, value: targetValue };
                    if (interactiveFilters.sector && !constituentHasSectorExposure(lookThroughItem, interactiveFilters.sector)) return false;
                    if (interactiveFilters.country && !constituentHasCountryExposure(lookThroughItem, interactiveFilters.country)) return false;
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
                        absoluteTarget: metric.absoluteTarget ? metric.absoluteTarget * quantityRatio : undefined
                    };
                };

                const conversionRate = item.conversionRate || 1;

                return {
                    ...item,
                    quantity: newQuantity,
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
                        percent: newCostBasis > 0 ? ((newValue - newCostBasis) / newCostBasis) * 100 : 0
                    },
                    xirr: aggregatedXirr
                };
            })
            .filter(Boolean);
    }, [globalConstituents, interactiveFilters]);

    if (!summary) return <AnalysisSkeleton />;

    const dimensionDataMap: Record<ActiveDimension, { name: string; value: number }[]> = {
        sector: chartAllocations.allocationBySector,
        country: chartAllocations.allocationByCountry,
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
                        {activeFilterBadges.map(({ key, label }) => (
                            <span key={key} className={styles.badge}>
                                <span className={styles.badgeLabel}>{label}: {interactiveFilters[key]}</span>
                                <button
                                    type="button"
                                    aria-label={`Remove ${label} filter`}
                                    onClick={() => setInteractiveFilters(prev => ({ ...prev, [key]: null }))}
                                >
                                    &times;
                                </button>
                            </span>
                        ))}
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
                        <AllocationChart
                            key={activeDimension}
                            title={currentDimConfig.title}
                            subtitle={currentDimConfig.subtitle}
                            badgeText={currentDimConfig.badgeText}
                            embedded={true}
                            data={dimensionDataMap[activeDimension]}
                            onSelect={(value, e) => handleDimensionSelect(currentDimConfig.filterKey, value, e)}
                            selectedName={interactiveFilters[currentDimConfig.filterKey]}
                            isPreConverted={true}
                        />
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

                {/* Constituents Grid (Using Final Filtered Data) */}
                <div className={styles.gridContainer}>
                    <ConstituentsGrid data={finalConstituents} />
                </div>
            </div>
        </div>
    );
}
