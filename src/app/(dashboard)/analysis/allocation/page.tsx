'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState, useMemo } from 'react';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import ConstituentsGrid from '@/components/ConstituentsGrid';
import AllocationChart from '@/components/AllocationChart';
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
import { Sparkles, Building2, Layers, PieChart } from 'lucide-react';

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

type ViewMode = 'xray' | 'structure' | 'all';

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
    const [viewMode, setViewMode] = useState<ViewMode>('xray');
    const { currency, format } = useCurrency();

    // Global Filters (Layer 1)
    const [globalFilters, setGlobalFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('allocation_filters', null);

    // Interactive Chart Filters (Layer 2)
    const [interactiveFilters, setInteractiveFilters] = useState<{
        investmentType: string | null;
        accountType: string | null;
        accountName: string | null;
        sector: string | null;
        country: string | null;
    }>({
        investmentType: null,
        accountType: null,
        accountName: null,
        sector: null,
        country: null
    });

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

    const handleInvestmentSelect = (type: string | null, e?: React.MouseEvent) => {
        const isMulti = e?.ctrlKey || e?.metaKey;
        setInteractiveFilters(prev => {
            const next = isMulti ? { ...prev } : { investmentType: null, accountType: null, accountName: null, sector: null, country: null };
            next.investmentType = type === prev.investmentType ? null : type;
            return next;
        });
    };

    const handleAccountTypeSelect = (type: string | null, e?: React.MouseEvent) => {
        const isMulti = e?.ctrlKey || e?.metaKey;
        setInteractiveFilters(prev => {
            const next = isMulti ? { ...prev } : { investmentType: null, accountType: null, accountName: null, sector: null, country: null };
            next.accountType = type === prev.accountType ? null : type;
            return next;
        });
    };

    const handleAccountNameSelect = (name: string | null, e?: React.MouseEvent) => {
        const isMulti = e?.ctrlKey || e?.metaKey;
        setInteractiveFilters(prev => {
            const next = isMulti ? { ...prev } : { investmentType: null, accountType: null, accountName: null, sector: null, country: null };
            next.accountName = name === prev.accountName ? null : name;
            return next;
        });
    };

    const handleSectorSelect = (sector: string | null, e?: React.MouseEvent) => {
        const isMulti = e?.ctrlKey || e?.metaKey;
        setInteractiveFilters(prev => {
            const next = isMulti ? { ...prev } : { investmentType: null, accountType: null, accountName: null, sector: null, country: null };
            next.sector = sector === prev.sector ? null : sector;
            return next;
        });
    };

    const handleCountrySelect = (country: string | null, e?: React.MouseEvent) => {
        const isMulti = e?.ctrlKey || e?.metaKey;
        setInteractiveFilters(prev => {
            const next = isMulti ? { ...prev } : { investmentType: null, accountType: null, accountName: null, sector: null, country: null };
            next.country = country === prev.country ? null : country;
            return next;
        });
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

                if (!hasValidAccount || (newQuantity === 0 && newLifetimeDividends === 0 && Math.abs(newRealizedGain) < 0.01)) return null;

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
                    lifetimeDividendsTarget: newLifetimeDividends * conversionRate,
                    dividendsYTD: newDividendsYTD,
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

    // --- Dynamic Allocations for Charts (Based on Layer 1) ---
    const chartAllocations = useMemo(() => {
        const byType = new Map<string, number>();
        const byAccountType = new Map<string, number>();
        const byAccount = new Map<string, number>();

        globalConstituents.forEach((item: any) => {
            const itemTargetValue = item.valueTarget ?? (item.value * (item.conversionRate || 1));
            byType.set(item.type, (byType.get(item.type) || 0) + itemTargetValue);

            if (item.accountsBreakdown) {
                const conversionRate = item.conversionRate || 1;
                Object.values(item.accountsBreakdown).forEach((acc: any) => {
                    const targetValue = (acc.valueNative ?? 0) * conversionRate;
                    byAccountType.set(acc.accountType, (byAccountType.get(acc.accountType) || 0) + targetValue);
                    const compositeKey = `${acc.name} - ${acc.platformName}`;
                    byAccount.set(compositeKey, (byAccount.get(compositeKey) || 0) + targetValue);
                });
            }
        });

        const lookThroughConstituents = globalConstituents.map((item: any) => ({
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

    // Currently focused sector for detailed Look-Through Breakdown Card
    const focusedSectorName = interactiveFilters.sector || chartAllocations.allocationBySector[0]?.name || null;
    const activeSectorBreakdown = useMemo(() => {
        if (!focusedSectorName) return null;
        return chartAllocations.sectorLookThrough.find(s => s.name === focusedSectorName) || null;
    }, [focusedSectorName, chartAllocations.sectorLookThrough]);

    // --- Layer 2: Interactive Filter Processing (For Table) ---
    const finalConstituents = useMemo(() => {
        return globalConstituents
            .filter((item: any) => {
                if (interactiveFilters.investmentType && item.type !== interactiveFilters.investmentType) return false;
                if (interactiveFilters.sector && !constituentHasSectorExposure(item, interactiveFilters.sector)) return false;
                if (interactiveFilters.country && !constituentHasCountryExposure(item, interactiveFilters.country)) return false;

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

                if (newQuantity === 0 && newLifetimeDividends === 0 && Math.abs(newRealizedGain) < 0.01) return null;

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
                    lifetimeDividendsTarget: newLifetimeDividends * conversionRate,
                    dividendsYTD: newDividendsYTD,
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

    const hasInteractiveFilters = interactiveFilters.investmentType ||
        interactiveFilters.accountType ||
        interactiveFilters.accountName ||
        interactiveFilters.sector ||
        interactiveFilters.country;

    // Direct vs Look-through values for focused sector
    const directValue = activeSectorBreakdown
        ? activeSectorBreakdown.contributors.filter(c => !c.isLookThrough).reduce((sum, c) => sum + c.allocatedValue, 0)
        : 0;
    const lookThroughValue = activeSectorBreakdown
        ? activeSectorBreakdown.contributors.filter(c => c.isLookThrough).reduce((sum, c) => sum + c.allocatedValue, 0)
        : 0;
    const totalSectorValue = activeSectorBreakdown ? activeSectorBreakdown.value : 0;
    const directPercent = totalSectorValue > 0 ? (directValue / totalSectorValue) * 100 : 0;
    const lookThroughPercent = totalSectorValue > 0 ? (lookThroughValue / totalSectorValue) * 100 : 0;

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerTop}>
                    <div>
                        <h1 className={styles.title}>Portfolio Analysis</h1>
                        <p className={styles.subtitle}>
                            Deep dive into your asset allocation, ETF look-through decomposition, and performance metrics.
                        </p>
                    </div>
                    {isFiltersLoaded && (
                        <ReportFilters onChange={setGlobalFilters} initialFilters={globalFilters || undefined} />
                    )}
                </div>

                {/* View Switcher Controls */}
                <div className={styles.viewSwitcher}>
                    <button
                        className={`${styles.viewBtn} ${viewMode === 'xray' ? styles.viewBtnActive : ''}`}
                        onClick={() => setViewMode('xray')}
                    >
                        <Sparkles size={16} />
                        Macro X-Ray (Sectors & Geography)
                    </button>
                    <button
                        className={`${styles.viewBtn} ${viewMode === 'structure' ? styles.viewBtnActive : ''}`}
                        onClick={() => setViewMode('structure')}
                    >
                        <Building2 size={16} />
                        Structure & Accounts
                    </button>
                    <button
                        className={`${styles.viewBtn} ${viewMode === 'all' ? styles.viewBtnActive : ''}`}
                        onClick={() => setViewMode('all')}
                    >
                        <Layers size={16} />
                        All Dimensions
                    </button>
                </div>

                {hasInteractiveFilters && (
                    <div className={styles.filterBadges}>
                        {interactiveFilters.sector && (
                            <span className={styles.badge}>
                                Sector: {interactiveFilters.sector}
                                <button onClick={() => setInteractiveFilters(prev => ({ ...prev, sector: null }))}>&times;</button>
                            </span>
                        )}
                        {interactiveFilters.country && (
                            <span className={styles.badge}>
                                Geography: {interactiveFilters.country}
                                <button onClick={() => setInteractiveFilters(prev => ({ ...prev, country: null }))}>&times;</button>
                            </span>
                        )}
                        {interactiveFilters.investmentType && (
                            <span className={styles.badge}>
                                Type: {interactiveFilters.investmentType}
                                <button onClick={() => setInteractiveFilters(prev => ({ ...prev, investmentType: null }))}>&times;</button>
                            </span>
                        )}
                        {interactiveFilters.accountType && (
                            <span className={styles.badge}>
                                Account Type: {interactiveFilters.accountType}
                                <button onClick={() => setInteractiveFilters(prev => ({ ...prev, accountType: null }))}>&times;</button>
                            </span>
                        )}
                        {interactiveFilters.accountName && (
                            <span className={styles.badge}>
                                Account: {interactiveFilters.accountName}
                                <button onClick={() => setInteractiveFilters(prev => ({ ...prev, accountName: null }))}>&times;</button>
                            </span>
                        )}
                        <button
                            onClick={() => setInteractiveFilters({ investmentType: null, accountType: null, accountName: null, sector: null, country: null })}
                            className={styles.clearBtn}
                        >
                            Clear Chart Filters
                        </button>
                    </div>
                )}
            </header>

            <div className={styles.analysisGrid}>
                {/* Mode 1: Macro X-Ray (Look-Through Sectors & Geography) */}
                {(viewMode === 'xray' || viewMode === 'all') && (
                    <div className={styles.chartsRow}>
                        <AllocationChart
                            title="By Sector (Look-Through X-Ray)"
                            data={chartAllocations.allocationBySector}
                            onSelect={handleSectorSelect}
                            selectedName={interactiveFilters.sector}
                            isPreConverted={true}
                        />
                        <AllocationChart
                            title="By Geography (Country Exposure)"
                            data={chartAllocations.allocationByCountry}
                            onSelect={handleCountrySelect}
                            selectedName={interactiveFilters.country}
                            isPreConverted={true}
                        />
                        <AllocationChart
                            title="By Investment Type"
                            data={chartAllocations.allocationByType}
                            onSelect={handleInvestmentSelect}
                            selectedName={interactiveFilters.investmentType}
                            isPreConverted={true}
                        />
                    </div>
                )}

                {/* Mode 2: Structure & Accounts */}
                {(viewMode === 'structure' || viewMode === 'all') && (
                    <div className={styles.chartsRow}>
                        {viewMode === 'structure' && (
                            <AllocationChart
                                title="By Investment Type"
                                data={chartAllocations.allocationByType}
                                onSelect={handleInvestmentSelect}
                                selectedName={interactiveFilters.investmentType}
                                isPreConverted={true}
                            />
                        )}
                        <AllocationChart
                            title="By Account Type"
                            data={chartAllocations.allocationByAccountType}
                            onSelect={handleAccountTypeSelect}
                            selectedName={interactiveFilters.accountType}
                            isPreConverted={true}
                        />
                        <AllocationChart
                            title="By Account & Platform"
                            data={chartAllocations.allocationByAccount}
                            onSelect={handleAccountNameSelect}
                            selectedName={interactiveFilters.accountName}
                            isPreConverted={true}
                        />
                    </div>
                )}

                {/* Interactive Sector Decomposition Card (Portfolio X-Ray) */}
                {(viewMode === 'xray' || viewMode === 'all') && activeSectorBreakdown && (
                    <div className={styles.breakdownCard}>
                        <div className={styles.breakdownHeader}>
                            <div className={styles.breakdownTitleGroup}>
                                <span className={styles.breakdownBadge}>
                                    <PieChart size={12} />
                                    Portfolio X-Ray Decomposition
                                </span>
                                <h2 className={styles.breakdownTitle}>
                                    {activeSectorBreakdown.name}
                                </h2>
                                <p className={styles.breakdownSubtitle}>
                                    Aggregate exposure across direct equities and underlying ETF holdings.
                                </p>
                            </div>
                            <div className={styles.breakdownMetric}>
                                <div className={styles.breakdownValue}>{format(activeSectorBreakdown.value)}</div>
                                <div className={styles.breakdownPercent}>
                                    {activeSectorBreakdown.percentage.toFixed(1)}% of Portfolio
                                </div>
                            </div>
                        </div>

                        {/* Quick Sector Selector Pills */}
                        <div className={styles.sectorPills}>
                            {chartAllocations.allocationBySector.map(s => {
                                const isActive = s.name === activeSectorBreakdown.name;
                                return (
                                    <button
                                        key={s.name}
                                        className={`${styles.sectorPill} ${isActive ? styles.sectorPillActive : ''}`}
                                        onClick={() => setInteractiveFilters(prev => ({
                                            ...prev,
                                            sector: isActive && interactiveFilters.sector ? null : s.name
                                        }))}
                                    >
                                        {s.name} ({format(s.value)})
                                    </button>
                                );
                            })}
                        </div>

                        {/* Direct Stock vs ETF Decomposition Split */}
                        <div className={styles.splitOverview}>
                            <div className={styles.splitCard}>
                                <span className={styles.splitLabel}>
                                    <span className={styles.dotDirect} />
                                    Direct Stock Holdings
                                </span>
                                <span className={styles.splitValue}>{format(directValue)}</span>
                                <span className={styles.splitSubtext}>{directPercent.toFixed(1)}% of {activeSectorBreakdown.name}</span>
                            </div>

                            <div className={styles.splitCard}>
                                <span className={styles.splitLabel}>
                                    <span className={styles.dotLookThrough} />
                                    ETF Look-Through Decomposition
                                </span>
                                <span className={styles.splitValue}>{format(lookThroughValue)}</span>
                                <span className={styles.splitSubtext}>{lookThroughPercent.toFixed(1)}% of {activeSectorBreakdown.name}</span>
                            </div>
                        </div>

                        {/* Dual Progress Bar */}
                        <div className={styles.splitProgressContainer}>
                            <div className={styles.splitProgressBar}>
                                <div className={styles.barDirect} style={{ width: `${directPercent}%` }} />
                                <div className={styles.barLookThrough} style={{ width: `${lookThroughPercent}%` }} />
                            </div>
                            <div className={styles.splitLegend}>
                                <div className={styles.splitLegendItem}>
                                    <span className={styles.dotDirect} /> Direct Equities ({directPercent.toFixed(1)}%)
                                </div>
                                <div className={styles.splitLegendItem}>
                                    <span className={styles.dotLookThrough} /> ETF Look-Through ({lookThroughPercent.toFixed(1)}%)
                                </div>
                            </div>
                        </div>

                        {/* Contributor Overlap Table */}
                        <div className={styles.contributorsWrapper}>
                            <table className={styles.contributorsTable}>
                                <thead>
                                    <tr>
                                        <th>Holding</th>
                                        <th>Source Type</th>
                                        <th>Holding Value</th>
                                        <th>Weight In Holding</th>
                                        <th>Sector Exposure</th>
                                        <th>Share of Sector</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {activeSectorBreakdown.contributors.map(contrib => {
                                        return (
                                            <tr key={contrib.symbol}>
                                                <td>
                                                    <div className={styles.holdingSymbol}>{contrib.symbol}</div>
                                                    <div className={styles.holdingName}>{contrib.name}</div>
                                                </td>
                                                <td>
                                                    {contrib.isLookThrough ? (
                                                        <span className={styles.typeBadgeETF}>ETF Decomposition</span>
                                                    ) : (
                                                        <span className={styles.typeBadgeDirect}>Direct Equity</span>
                                                    )}
                                                </td>
                                                <td>{format(contrib.holdingValue)}</td>
                                                <td>{(contrib.weightInHolding * 100).toFixed(1)}%</td>
                                                <td><strong>{format(contrib.allocatedValue)}</strong></td>
                                                <td>
                                                    <div className={styles.shareCell}>
                                                        <div className={styles.shareBarBg}>
                                                            <div
                                                                className={styles.shareBarFill}
                                                                style={{ width: `${Math.min(100, contrib.weightInSector)}%` }}
                                                            />
                                                        </div>
                                                        <span>{contrib.weightInSector.toFixed(1)}%</span>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {/* Constituents Grid (Using Final Filtered Data) */}
                <div className={styles.gridContainer}>
                    <ConstituentsGrid data={finalConstituents} />
                </div>
            </div>
        </div>
    );
}
