'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { MdArrowBack, MdRefresh } from 'react-icons/md';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import { useLiveSync } from '@/hooks/useLiveSync';
import { ClientCache } from '@/lib/client-cache';
import { emitLiveSyncEvent } from '@/lib/live-sync';
import StockChart from '@/components/StockChart';
import SymbolSkeleton from '@/components/SymbolSkeleton';
import { formatQuantity } from '@/lib/format';
import { computeActivityNetAmount } from '@/lib/activities-filters';
import { sanitizeStoredHoldings } from '@/lib/issuers/holdings';
import type { UnderlyingHoldingEntry } from '@/lib/issuers/types';
import styles from './page.module.css';

interface AccountAllocation {
    quantity: number;
    value: number;
    name: string;
    type: string;
    platform?: { name: string };
}

interface AnalysisData {
    symbol: string;
    name: string;
    currency: string;
    stats: {
        quantity: number;
        avgPrice: number;
        marketPrice: number;
        totalInvestment: number;
        currentValue: number;
        absoluteReturn: number;
        percentReturn: number;
        totalFees: number;
        investmentAge: string;
        activityCount: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        sector?: string;
        country?: string;
        sectorAllocations?: { [key: string]: number }[];
        countryAllocations?: any[];
        topHoldings?: UnderlyingHoldingEntry[];
        totalDividends?: number;
        totalDripAmount?: number;
        dripCount?: number;
        totalDripShares?: number;
        dividendRate?: number;
        dividendYield?: number;
    };
    allocation: {
        accounts: AccountAllocation[];
    };
    activities: any[];
    historical: Record<string, number>;
    avgPriceHistory: Record<string, number>;
}

interface User {
    id: string;
    username: string;
    name?: string;
}

const ALLOCATION_PALETTE = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#06b6d4', '#ec4899'];
const SYMBOL_CACHE_HOLDINGS_PREVIEW_LIMIT = 250;

function capSymbolAnalysisForClientCache(analysis: AnalysisData): AnalysisData {
    const holdings = analysis?.stats?.topHoldings;
    if (!Array.isArray(holdings) || holdings.length <= SYMBOL_CACHE_HOLDINGS_PREVIEW_LIMIT) {
        return analysis;
    }
    return {
        ...analysis,
        stats: {
            ...analysis.stats,
            topHoldings: holdings.slice(0, SYMBOL_CACHE_HOLDINGS_PREVIEW_LIMIT),
        },
    };
}

function AnalysisContent() {
    const { symbol } = useParams();
    const symbolStr = Array.isArray(symbol) ? symbol[0] : symbol;
    const searchParams = useSearchParams();
    const from = searchParams.get('from');
    const { data: session } = useSession();
    const userRole = (session?.user as { role?: string } | undefined)?.role || 'VIEWER';
    const canRefresh = userRole === 'ADMIN' || userRole === 'EDITOR';

    const [data, setData] = useState<AnalysisData | null>(null);
    const { format, convert } = useCurrency();
    const { formatDate } = useDate();
    const [activeTab, setActiveTab] = useState<'overview' | 'activities'>('overview');
    const [users, setUsers] = useState<User[]>([]);
    const [navContext, setNavContext] = useState<string | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const [syncTick, setSyncTick] = useState(0);
    const loadedSymbolRef = useRef<string | null>(null);
    const suppressSelfSyncRef = useRef(false);

    // Underlying holdings filters
    const [holdingsQuery, setHoldingsQuery] = useState('');
    const [showAllHoldings, setShowAllHoldings] = useState(false);

    // Activities tab filters
    const [filterType, setFilterType] = useState('');
    const [filterAccount, setFilterAccount] = useState('');
    const [filterAccountType, setFilterAccountType] = useState('');
    const [filterPlatform, setFilterPlatform] = useState('');

    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useLiveSync({
        enabled: Boolean(symbolStr),
        onSync: () => {
            if (suppressSelfSyncRef.current) return;
            setSyncTick((t) => t + 1);
        },
    });

    useEffect(() => {
        if (from) {
            setNavContext(from);
            sessionStorage.setItem('navContext', from);
        } else {
            const stored = sessionStorage.getItem('navContext');
            if (stored) setNavContext(stored);
        }
    }, [from]);

    const handleBack = () => {
        sessionStorage.removeItem('navContext');
    };

    useEffect(() => {
        const controller = new AbortController();
        fetch('/api/users', { signal: controller.signal })
            .then(res => (res.ok ? res.json() : []))
            .then(resData => {
                if (!controller.signal.aborted && Array.isArray(resData)) {
                    setUsers(resData);
                }
            })
            .catch(err => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to fetch users', err);
            });
        return () => controller.abort();
    }, []);

    useEffect(() => {
        if (!symbolStr) return;

        const controller = new AbortController();
        const cacheKey = ClientCache.generateKey('analysis', { symbol: symbolStr });
        const cached = ClientCache.get<AnalysisData>(cacheKey);
        if (cached && typeof cached === 'object' && !('error' in cached) && cached.stats) {
            setData(cached);
        }

        const fetchAnalysis = async () => {
            try {
                const res = await fetch(`/api/analysis/${encodeURIComponent(symbolStr)}`, {
                    signal: controller.signal,
                    cache: 'no-store',
                });
                const newData = await res.json().catch(() => ({}));
                if (controller.signal.aborted) return;

                if (!res.ok || !newData || typeof newData !== 'object' || 'error' in newData || !newData.stats) {
                    if (loadedSymbolRef.current === symbolStr) {
                        return;
                    }
                    setData(
                        newData && typeof newData === 'object' && 'error' in newData
                            ? (newData as any)
                            : ({ error: `HTTP ${res.status}` } as any)
                    );
                    return;
                }

                loadedSymbolRef.current = symbolStr;
                setData(newData);
                setRefreshError(null);
                ClientCache.set(cacheKey, capSymbolAnalysisForClientCache(newData));
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to fetch analysis', err);
            }
        };

        void fetchAnalysis();
        return () => controller.abort();
    }, [symbolStr, syncTick]);

    const sortedActivities = useMemo(() => {
        if (!data?.activities) return [];
        return [...data.activities].sort(
            (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );
    }, [data]);

    const filteredActivities = useMemo(() => {
        return sortedActivities
            .filter((a: any) => !filterType || a.type === filterType)
            .filter((a: any) => !filterAccount || a.account?.name === filterAccount)
            .filter((a: any) => !filterAccountType || a.account?.type === filterAccountType)
            .filter((a: any) => !filterPlatform || a.platform?.name === filterPlatform);
    }, [sortedActivities, filterType, filterAccount, filterAccountType, filterPlatform]);

    const normalizedTopHoldings = useMemo(() => {
        return sanitizeStoredHoldings(data?.stats?.topHoldings).map((entry, idx) => ({
            entry,
            rank: idx + 1,
        }));
    }, [data]);

    const filteredTopHoldings = useMemo(() => {
        const q = holdingsQuery.trim().toLowerCase();
        if (!q) return normalizedTopHoldings;
        return normalizedTopHoldings.filter(({ entry }) => {
            const hay = `${entry.name} ${entry.ticker || ''} ${entry.sector || ''} ${entry.country || ''}`.toLowerCase();
            return hay.includes(q);
        });
    }, [normalizedTopHoldings, holdingsQuery]);

    const trackedHoldingsWeight = useMemo(() => {
        return normalizedTopHoldings.reduce((sum, { entry }) => sum + entry.weight, 0);
    }, [normalizedTopHoldings]);

    if (!data) return <SymbolSkeleton />;

    if ('error' in data) {
        return (
            <div className={styles.container}>
                <div className={styles.errorState}>Error: {(data as any).error}</div>
            </div>
        );
    }

    if (!data.stats) {
        return (
            <div className={styles.container}>
                <div className={styles.errorState}>Error: Invalid data received</div>
            </div>
        );
    }

    const isPositive = data.stats.absoluteReturn >= 0;

    const sectorAllocations = data.stats.sectorAllocations
        ?.flatMap(obj =>
            Object.entries(obj).map(([key, value]) => ({
                name: key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                value: (value as number) * 100,
            }))
        )
        .sort((a, b) => b.value - a.value) || [];

    const countryAllocations = data.stats.countryAllocations
        ?.flatMap(obj =>
            obj && typeof obj === 'object'
                ? Object.entries(obj).map(([key, value]) => ({
                      name: key,
                      value: (value as number) * 100,
                  }))
                : []
        )
        .filter(item => Number.isFinite(item.value) && item.value > 0)
        .sort((a, b) => b.value - a.value) || [];

    const holdingValueConverted = convert(data.stats.currentValue || 0, data.currency);

    const totalAllocValue = data.allocation.accounts.reduce((sum, acc) => sum + acc.value, 0);
    const accountAllocations = data.allocation.accounts
        .map(acc => {
            const user = users.find(u => u.username === acc.name);
            const displayName = user?.name || acc.name;
            return {
                name: `${displayName} · ${acc.type}`,
                quantity: acc.quantity,
                value: acc.value,
                percent: totalAllocValue > 0 ? (acc.value / totalAllocValue) * 100 : 0,
            };
        })
        .sort((a, b) => b.value - a.value);

    const handleRefresh = async () => {
        if (!canRefresh || !data || isRefreshing) return;
        setIsRefreshing(true);
        setRefreshError(null);

        try {
            const refreshRes = await fetch('/api/market-data/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol: data.symbol }),
            });
            const refreshPayload = await refreshRes.json().catch(() => ({}));
            if (!refreshRes.ok) {
                setRefreshError(refreshPayload?.error || `Refresh failed (HTTP ${refreshRes.status})`);
                return;
            }

            const res = await fetch(`/api/analysis/${encodeURIComponent(data.symbol)}`, {
                cache: 'no-store',
            });
            const newData = await res.json().catch(() => ({}));
            if (!res.ok || !newData || typeof newData !== 'object' || 'error' in newData || !newData.stats) {
                setRefreshError(newData?.error || `Failed to reload analysis (HTTP ${res.status})`);
                return;
            }

            loadedSymbolRef.current = symbolStr || data.symbol;
            setData(newData);
            // Emit before ClientCache.set so MARKET_SYNCED clears stale caches without wiping the fresh result
            try {
                suppressSelfSyncRef.current = true;
                emitLiveSyncEvent('MARKET_SYNCED', { reason: 'manual-symbol-refresh' });
            } finally {
                suppressSelfSyncRef.current = false;
            }
            const cacheKey = ClientCache.generateKey('analysis', { symbol: symbolStr || data.symbol });
            ClientCache.set(cacheKey, capSymbolAnalysisForClientCache(newData));
        } catch (error) {
            console.error('Refresh failed', error);
            setRefreshError('Network error while refreshing quote.');
        } finally {
            setIsRefreshing(false);
        }
    };

    const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const tabs: Array<'overview' | 'activities'> = ['overview', 'activities'];
        const currentIndex = tabs.indexOf(activeTab);
        let nextIndex: number | null = null;

        if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') nextIndex = 0;
        else if (e.key === 'End') nextIndex = tabs.length - 1;

        if (nextIndex !== null) {
            e.preventDefault();
            setActiveTab(tabs[nextIndex]);
            tabRefs.current[nextIndex]?.focus();
        }
    };

    let backHref = '/analysis/allocation';
    let backLabel = 'Back to Allocation Analysis';

    if (navContext === 'dashboard') {
        backHref = '/';
        backLabel = 'Back to Dashboard';
    } else if (navContext === 'comparison') {
        backHref = '/analysis/comparison';
        backLabel = 'Back to Comparison';
    } else if (navContext === 'rebalancer') {
        backHref = '/rebalancer';
        backLabel = 'Back to Rebalancer';
    } else if (navContext === 'activities') {
        backHref = '/activities';
        backLabel = 'Back to Activities';
    }

    const low52 = data.stats.fiftyTwoWeekLow;
    const high52 = data.stats.fiftyTwoWeekHigh;
    const has52WRange = typeof low52 === 'number' && typeof high52 === 'number' && high52 > low52;
    const rangePosition = has52WRange
        ? Math.min(100, Math.max(0, ((data.stats.marketPrice - low52) / (high52 - low52)) * 100))
        : 0;

    const estAnnualDiv = data.stats.dividendRate && data.stats.quantity > 0
        ? data.stats.dividendRate * data.stats.quantity
        : null;

    const hasActiveFilters = Boolean(filterType || filterAccount || filterAccountType || filterPlatform);

    const clearFilters = () => {
        setFilterType('');
        setFilterAccount('');
        setFilterAccountType('');
        setFilterPlatform('');
    };

    return (
        <div className={styles.container}>
            <div className={styles.backLinkContainer}>
                <Link href={backHref} className={styles.backLink} onClick={handleBack}>
                    <MdArrowBack size={16} />
                    <span>{backLabel}</span>
                </Link>
            </div>

            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <div className={styles.titleRow}>
                        <h1 className={styles.title}>{data.name}</h1>
                        <span className={styles.symbolPill}>{data.symbol}</span>
                    </div>
                    <div className={styles.metaChips}>
                        <span className={styles.metaChip}>{data.currency}</span>
                        {data.stats.sector && (
                            <span className={styles.metaChip}>{data.stats.sector}</span>
                        )}
                        {data.stats.country && (
                            <span className={styles.metaChip}>{data.stats.country}</span>
                        )}
                        <span className={styles.metaChip}>
                            {data.stats.activityCount} {data.stats.activityCount === 1 ? 'Activity' : 'Activities'}
                        </span>
                    </div>
                </div>

                {canRefresh && (
                    <div className={styles.headerActions}>
                        {refreshError && (
                            <span className={styles.refreshError} role="status">
                                {refreshError}
                            </span>
                        )}
                        <button
                            type="button"
                            id="refresh-btn"
                            className={styles.refreshButton}
                            onClick={handleRefresh}
                            disabled={isRefreshing}
                            title="Refresh Market Data"
                        >
                            <MdRefresh size={18} className={isRefreshing ? styles.spinning : undefined} />
                            <span>{isRefreshing ? 'Refreshing...' : 'Refresh Quote'}</span>
                        </button>
                    </div>
                )}
            </header>

            <div className={styles.tablistBar}>
                <div
                    role="tablist"
                    aria-label="Symbol details sections"
                    className={styles.tablist}
                    onKeyDown={handleTabKeyDown}
                >
                    <button
                        ref={el => { tabRefs.current[0] = el; }}
                        type="button"
                        role="tab"
                        id="symbol-tab-overview"
                        aria-selected={activeTab === 'overview'}
                        aria-controls="symbol-panel-overview"
                        tabIndex={activeTab === 'overview' ? 0 : -1}
                        className={styles.tabBtn}
                        onClick={() => setActiveTab('overview')}
                    >
                        Overview
                    </button>
                    <button
                        ref={el => { tabRefs.current[1] = el; }}
                        type="button"
                        role="tab"
                        id="symbol-tab-activities"
                        aria-selected={activeTab === 'activities'}
                        aria-controls="symbol-panel-activities"
                        tabIndex={activeTab === 'activities' ? 0 : -1}
                        className={styles.tabBtn}
                        onClick={() => setActiveTab('activities')}
                    >
                        Activities
                        <span className={styles.tabCount}>{data.activities.length}</span>
                    </button>
                </div>
            </div>

            {activeTab === 'overview' && (
                <div
                    role="tabpanel"
                    id="symbol-panel-overview"
                    aria-labelledby="symbol-tab-overview"
                    className={styles.content}
                >
                    {/* Tier 1: Executive Wealth Strip */}
                    <section className={styles.executiveGrid}>
                        <div className={styles.heroCard}>
                            <div className={styles.heroTop}>
                                <span className={styles.heroLabel}>Position Value</span>
                                <div className={styles.heroValue}>
                                    {format(convert(data.stats.currentValue, data.currency))}
                                </div>
                                <div className={styles.heroChange}>
                                    <span>{isPositive ? '▲ +' : '▼ '}{format(convert(data.stats.absoluteReturn, data.currency))}</span>
                                    <span>({isPositive ? '+' : ''}{data.stats.percentReturn.toFixed(2)}%)</span>
                                    <span className={styles.heroChangeLabel}>Total</span>
                                </div>
                            </div>

                            <div className={styles.heroMetaGrid}>
                                <div className={styles.heroMetaItem}>
                                    <span className={styles.heroMetaLabel}>Market Price</span>
                                    <span className={styles.heroMetaValue}>
                                        {format(convert(data.stats.marketPrice, data.currency))}
                                    </span>
                                </div>
                                <div className={styles.heroMetaItem}>
                                    <span className={styles.heroMetaLabel}>Avg Cost</span>
                                    <span className={styles.heroMetaValue}>
                                        {format(convert(data.stats.avgPrice, data.currency))}
                                    </span>
                                </div>
                                <div className={styles.heroMetaItem}>
                                    <span className={styles.heroMetaLabel}>Shares Held</span>
                                    <span className={styles.heroMetaValue}>
                                        {formatQuantity(data.stats.quantity)}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className={styles.kpiCard}>
                            <div className={styles.kpiHeader}>
                                <span className={styles.kpiLabel}>Total Return</span>
                                <span className={`${styles.kpiPill} ${isPositive ? styles.positivePill : styles.negativePill}`}>
                                    {isPositive ? '+' : ''}{data.stats.percentReturn.toFixed(2)}%
                                </span>
                            </div>
                            <div className={`${styles.kpiValue} ${isPositive ? styles.positiveText : styles.negativeText}`}>
                                {isPositive ? '+' : ''}{format(convert(data.stats.absoluteReturn, data.currency))}
                            </div>
                            <div className={styles.kpiFooter}>
                                <div className={styles.kpiFootDivider} />
                                <div className={styles.kpiSubRow}>
                                    <span>Cost Basis: <strong>{format(convert(data.stats.totalInvestment, data.currency))}</strong></span>
                                    <span>Fees: <strong>{format(convert(data.stats.totalFees, data.currency))}</strong></span>
                                </div>
                            </div>
                        </div>

                        <div className={styles.kpiCard}>
                            <div className={styles.kpiHeader}>
                                <span className={styles.kpiLabel}>Dividends Received</span>
                                {data.stats.dividendYield ? (
                                    <span className={`${styles.kpiPill} ${styles.positivePill}`}>
                                        Yield {(data.stats.dividendYield * 100).toFixed(2)}%
                                    </span>
                                ) : (
                                    <span className={styles.kpiTag}>Income</span>
                                )}
                            </div>
                            <div className={styles.kpiValue}>
                                {data.stats.totalDividends !== undefined
                                    ? format(convert(data.stats.totalDividends, data.currency))
                                    : format(0)}
                            </div>
                            <div className={styles.kpiFooter}>
                                <div className={styles.kpiFootDivider} />
                                <div className={styles.kpiSubRow}>
                                    <span>
                                        Rate/Sh:{' '}
                                        <strong>
                                            {data.stats.dividendRate
                                                ? format(convert(data.stats.dividendRate, data.currency))
                                                : '—'}
                                        </strong>
                                    </span>
                                    <span>
                                        Est. Annual:{' '}
                                        <strong>
                                            {estAnnualDiv !== null
                                                ? format(convert(estAnnualDiv, data.currency))
                                                : '—'}
                                        </strong>
                                    </span>
                                </div>
                                {(data.stats.dripCount ?? 0) > 0 && (
                                    <div className={styles.kpiSubRow}>
                                        <span>
                                            DRIP Reinvested:{' '}
                                            <strong className={styles.tealText}>
                                                {format(convert(data.stats.totalDripAmount || 0, data.currency))}
                                            </strong>
                                            {data.stats.totalDividends && data.stats.totalDividends > 0
                                                ? ` (${Math.min(100, ((data.stats.totalDripAmount || 0) / data.stats.totalDividends) * 100).toFixed(0)}%)`
                                                : ''}
                                        </span>
                                        <span>
                                            <strong>{formatQuantity(data.stats.totalDripShares || 0)}</strong> sh
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className={styles.kpiCard}>
                            <div className={styles.kpiHeader}>
                                <span className={styles.kpiLabel}>Holding Tenure</span>
                                <span className={styles.kpiTag}>{data.stats.activityCount} Trades</span>
                            </div>
                            <div className={styles.kpiValue}>{data.stats.investmentAge}</div>
                            <div className={styles.kpiFooter}>
                                {has52WRange ? (
                                    <div className={styles.rangeTrackWrap}>
                                        <div className={styles.rangeHeader}>
                                            <span>52W Low</span>
                                            <span>52W High</span>
                                        </div>
                                        <div className={styles.rangeTrack}>
                                            <div className={styles.rangeFill} style={{ width: `${rangePosition}%` }} />
                                            <span className={styles.rangeMarker} style={{ left: `${rangePosition}%` }} />
                                        </div>
                                        <div className={styles.kpiSubRow}>
                                            <strong>{format(convert(low52, data.currency))}</strong>
                                            <strong>{format(convert(high52, data.currency))}</strong>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className={styles.kpiFootDivider} />
                                        <div className={styles.kpiSubRow}>
                                            <span>Sector: <strong>{data.stats.sector || 'N/A'}</strong></span>
                                            <span>Country: <strong>{data.stats.country || 'N/A'}</strong></span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* Tier 2: Chart Section */}
                    <section className={styles.chartSection}>
                        <StockChart
                            data={data.historical}
                            currency={data.currency}
                            avgPriceHistory={data.avgPriceHistory}
                            symbol={data.symbol}
                        />
                    </section>

                    {/* Tier 3: Allocation & Fundamentals */}
                    <div className={styles.splitGrid}>
                        <section className={styles.detailCard}>
                            <div className={styles.detailCardHeader}>
                                <h2 className={styles.detailCardTitle}>Account Allocation</h2>
                                <span className={styles.kpiTag}>
                                    {accountAllocations.length} {accountAllocations.length === 1 ? 'Account' : 'Accounts'}
                                </span>
                            </div>

                            {accountAllocations.length > 0 ? (
                                <>
                                    <div className={styles.stackedBar} aria-hidden="true">
                                        {accountAllocations.map((item, idx) => (
                                            <div
                                                key={item.name}
                                                className={styles.stackedSegment}
                                                style={{
                                                    width: `${item.percent}%`,
                                                    backgroundColor: ALLOCATION_PALETTE[idx % ALLOCATION_PALETTE.length],
                                                }}
                                            />
                                        ))}
                                    </div>
                                    <ul className={styles.allocList}>
                                        {accountAllocations.map((item, idx) => {
                                            const color = ALLOCATION_PALETTE[idx % ALLOCATION_PALETTE.length];
                                            return (
                                                <li key={item.name} className={styles.allocRow}>
                                                    <div className={styles.allocRowTop}>
                                                        <div className={styles.allocNameWrap}>
                                                            <span className={styles.allocDot} style={{ backgroundColor: color }} />
                                                            <span className={styles.allocName}>{item.name}</span>
                                                            <span className={styles.allocSub}>
                                                                ({formatQuantity(item.quantity)} sh)
                                                            </span>
                                                        </div>
                                                        <div className={styles.allocStats}>
                                                            <span className={styles.allocVal}>
                                                                {format(convert(item.value, data.currency))}
                                                            </span>
                                                            <span className={styles.allocPct}>
                                                                {item.percent.toFixed(1)}%
                                                            </span>
                                                        </div>
                                                    </div>
                                                    <div className={styles.allocBarTrack}>
                                                        <div
                                                            className={styles.allocBarFill}
                                                            style={{ width: `${item.percent}%`, backgroundColor: color }}
                                                        />
                                                    </div>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </>
                            ) : (
                                <div className={styles.emptyState}>No active position held across accounts</div>
                            )}
                        </section>

                        {sectorAllocations.length > 0 && (
                            <section className={styles.detailCard}>
                                <div className={styles.detailCardHeader}>
                                    <h2 className={styles.detailCardTitle}>Sector Exposure</h2>
                                    <span className={styles.kpiTag}>{sectorAllocations.length} Sectors</span>
                                </div>

                                <div className={styles.stackedBar} aria-hidden="true">
                                    {sectorAllocations.map((item, idx) => (
                                        <div
                                            key={item.name}
                                            className={styles.stackedSegment}
                                            style={{
                                                width: `${item.value}%`,
                                                backgroundColor: ALLOCATION_PALETTE[idx % ALLOCATION_PALETTE.length],
                                            }}
                                        />
                                    ))}
                                </div>

                                <ul className={`${styles.allocList} ${sectorAllocations.length > 8 ? styles.allocListScrollable : ''}`}>
                                    {sectorAllocations.map((item, idx) => {
                                        const color = ALLOCATION_PALETTE[idx % ALLOCATION_PALETTE.length];
                                        return (
                                            <li key={item.name} className={styles.allocRow}>
                                                <div className={styles.allocRowTop}>
                                                    <div className={styles.allocNameWrap}>
                                                        <span className={styles.allocDot} style={{ backgroundColor: color }} />
                                                        <span className={styles.allocName}>{item.name}</span>
                                                    </div>
                                                    <div className={styles.allocStats}>
                                                        {holdingValueConverted > 0 && (
                                                            <span className={styles.allocVal}>
                                                                {format(holdingValueConverted * (item.value / 100))}
                                                            </span>
                                                        )}
                                                        <span className={styles.allocPct}>{item.value.toFixed(2)}%</span>
                                                    </div>
                                                </div>
                                                <div className={styles.allocBarTrack}>
                                                    <div
                                                        className={styles.allocBarFill}
                                                        style={{ width: `${item.value}%`, backgroundColor: color }}
                                                    />
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        )}

                        {countryAllocations.length > 0 ? (
                            <section className={styles.detailCard}>
                                <div className={styles.detailCardHeader}>
                                    <h2 className={styles.detailCardTitle}>Geographic Exposure</h2>
                                    <span className={styles.kpiTag}>{countryAllocations.length} {countryAllocations.length === 1 ? 'Country' : 'Countries'}</span>
                                </div>

                                <div className={styles.stackedBar} aria-hidden="true">
                                    {countryAllocations.map((item, idx) => (
                                        <div
                                            key={item.name}
                                            className={styles.stackedSegment}
                                            style={{
                                                width: `${item.value}%`,
                                                backgroundColor: ALLOCATION_PALETTE[idx % ALLOCATION_PALETTE.length],
                                            }}
                                        />
                                    ))}
                                </div>

                                <ul className={`${styles.allocList} ${countryAllocations.length > 8 ? styles.allocListScrollable : ''}`}>
                                    {countryAllocations.map((item, idx) => {
                                        const color = ALLOCATION_PALETTE[idx % ALLOCATION_PALETTE.length];
                                        return (
                                            <li key={item.name} className={styles.allocRow}>
                                                <div className={styles.allocRowTop}>
                                                    <div className={styles.allocNameWrap}>
                                                        <span className={styles.allocDot} style={{ backgroundColor: color }} />
                                                        <span className={styles.allocName}>{item.name}</span>
                                                    </div>
                                                    <div className={styles.allocStats}>
                                                        {holdingValueConverted > 0 && (
                                                            <span className={styles.allocVal}>
                                                                {format(holdingValueConverted * (item.value / 100))}
                                                            </span>
                                                        )}
                                                        <span className={styles.allocPct}>{item.value.toFixed(2)}%</span>
                                                    </div>
                                                </div>
                                                <div className={styles.allocBarTrack}>
                                                    <div
                                                        className={styles.allocBarFill}
                                                        style={{ width: `${item.value}%`, backgroundColor: color }}
                                                    />
                                                </div>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </section>
                        ) : (sectorAllocations.length > 0 || /\b(etf|ishares|vanguard|bmo|index|fund|trust)\b/i.test(data.name || '')) && (
                            <section className={styles.detailCard}>
                                <div className={styles.detailCardHeader}>
                                    <h2 className={styles.detailCardTitle}>Geographic Exposure</h2>
                                    <span className={styles.kpiTag}>{data.stats.country || 'Pending Sync'}</span>
                                </div>
                                <div className={styles.emptyState}>
                                    No look-through geographic breakdown cached yet.
                                    {data.stats.country ? ` Domicile fallback: ${data.stats.country}. ` : ' '}
                                    Run <strong>Refresh Quote</strong> above or <strong>Settings &rarr; Data Management &rarr; Run Full Metadata &amp; History Sync</strong> (check <code>[Look-Through]</code> / <code>[IssuerAdapter:*]</code> logs if still empty).
                                </div>
                            </section>
                        )}

                        {/* Underlying Holdings (paired next to Geographic Exposure) */}
                        {(normalizedTopHoldings.length > 0 ||
                            sectorAllocations.length > 0 ||
                            countryAllocations.length > 0 ||
                            /\b(etf|ishares|vanguard|bmo|index|fund|trust)\b/i.test(data.name || '')) && (() => {
                            const isYahooSource =
                                normalizedTopHoldings.length > 0 &&
                                normalizedTopHoldings.every(({ entry }) => entry.source === 'yahoo');
                            const topWeight = normalizedTopHoldings[0]?.entry.weight || 0.01;
                            const isSearching = Boolean(holdingsQuery.trim());
                            const visibleHoldings =
                                showAllHoldings || isSearching
                                    ? filteredTopHoldings
                                    : filteredTopHoldings.slice(0, 50);

                            return (
                                <section className={styles.detailCard}>
                                    <div className={styles.detailCardHeader}>
                                        <h2 className={styles.detailCardTitle}>Underlying Holdings</h2>
                                        <div className={styles.holdingsHeaderRight}>
                                            {normalizedTopHoldings.length > 0 && (
                                                <span className={styles.kpiTag}>
                                                    {isYahooSource ? 'Yahoo Top 10' : 'Direct Issuer'}
                                                </span>
                                            )}
                                            <span className={styles.kpiTag}>
                                                {normalizedTopHoldings.length > 0
                                                    ? `${normalizedTopHoldings.length} ${normalizedTopHoldings.length === 1 ? 'Holding' : 'Holdings'}`
                                                    : 'Pending Sync'}
                                            </span>
                                        </div>
                                    </div>

                                    {normalizedTopHoldings.length > 0 ? (
                                        <>
                                            <div className={styles.holdingsToolbar}>
                                                {normalizedTopHoldings.length > 10 ? (
                                                    <input
                                                        type="search"
                                                        className={styles.holdingsSearch}
                                                        value={holdingsQuery}
                                                        onChange={(e) => setHoldingsQuery(e.target.value)}
                                                        placeholder="Search holding name, ticker, sector, or country..."
                                                        aria-label="Filter underlying holdings"
                                                    />
                                                ) : (
                                                    <span />
                                                )}

                                                <div className={styles.holdingsTrackedSummary}>
                                                    Tracked weight:{' '}
                                                    <strong>{(trackedHoldingsWeight * 100).toFixed(1)}%</strong>
                                                    {holdingValueConverted > 0 && (
                                                        <>
                                                            {' '}
                                                            (<strong>{format(holdingValueConverted * trackedHoldingsWeight)}</strong>)
                                                        </>
                                                    )}
                                                </div>
                                            </div>

                                            {visibleHoldings.length === 0 ? (
                                                <div className={styles.emptyState}>
                                                    No underlying holdings match &ldquo;{holdingsQuery.trim()}&rdquo;.
                                                </div>
                                            ) : (
                                                <ul
                                                    className={`${styles.allocList} ${
                                                        visibleHoldings.length > 8 ? styles.holdingsScrollable : ''
                                                    }`}
                                                >
                                                    {visibleHoldings.map(({ entry: item, rank }) => {
                                                        const color = ALLOCATION_PALETTE[(rank - 1) % ALLOCATION_PALETTE.length];
                                                        const metaParts = [
                                                            item.assetClass === 'BOND' ? 'Bond' : undefined,
                                                            item.sector,
                                                            item.country,
                                                        ].filter(Boolean);
                                                        const pct = item.weight * 100;
                                                        const barWidth = Math.min(100, (item.weight / topWeight) * 100);
                                                        const key = `${item.isin || item.ticker || item.name}-${rank}`;

                                                        return (
                                                            <li key={key} className={styles.allocRow}>
                                                                <div className={styles.allocRowTop}>
                                                                    <div className={styles.allocNameWrap}>
                                                                        <span className={styles.holdingsRank}>#{rank}</span>
                                                                        <span
                                                                            className={styles.allocDot}
                                                                            style={{ backgroundColor: color }}
                                                                        />
                                                                        <span className={styles.allocName}>{item.name}</span>
                                                                        {item.ticker && (
                                                                            <span className={styles.holdingTickerPill}>
                                                                                {item.ticker}
                                                                            </span>
                                                                        )}
                                                                        {metaParts.length > 0 && (
                                                                            <span className={styles.holdingMetaTag}>
                                                                                {metaParts.join(' · ')}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    <div className={styles.allocStats}>
                                                                        {holdingValueConverted > 0 && (
                                                                            <span className={styles.allocVal}>
                                                                                {format(holdingValueConverted * item.weight)}
                                                                            </span>
                                                                        )}
                                                                        <span className={styles.allocPct}>
                                                                            {pct.toFixed(2)}%
                                                                        </span>
                                                                    </div>
                                                                </div>
                                                                <div className={styles.allocBarTrack}>
                                                                    <div
                                                                        className={styles.allocBarFill}
                                                                        style={{
                                                                            width: `${barWidth}%`,
                                                                            backgroundColor: color,
                                                                        }}
                                                                    />
                                                                </div>
                                                            </li>
                                                        );
                                                    })}
                                                </ul>
                                            )}

                                            {!isSearching && filteredTopHoldings.length > 50 && (
                                                <div className={styles.holdingsFooter}>
                                                    <span>
                                                        Showing {visibleHoldings.length} of {filteredTopHoldings.length} holdings
                                                    </span>
                                                    <button
                                                        type="button"
                                                        className={styles.holdingsToggleBtn}
                                                        onClick={() => setShowAllHoldings(prev => !prev)}
                                                    >
                                                        {showAllHoldings
                                                            ? 'Show Top 50'
                                                            : `Show All ${filteredTopHoldings.length} Holdings`}
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className={styles.emptyState}>
                                            No underlying stock holdings cached yet. Run <strong>Refresh Quote</strong> above or your issuer allocations push job to populate underlying look-through holdings.
                                        </div>
                                    )}
                                </section>
                            );
                        })()}

                        {sectorAllocations.length === 0 && countryAllocations.length === 0 && (
                            <section className={styles.detailCard}>
                                <div className={styles.detailCardHeader}>
                                    <h2 className={styles.detailCardTitle}>Security Fundamentals</h2>
                                    <span className={styles.kpiTag}>{data.currency}</span>
                                </div>

                                <div className={styles.fundamentalsList}>
                                    <div className={styles.fundamentalRow}>
                                        <span className={styles.fundamentalLabel}>Sector</span>
                                        <span className={styles.fundamentalValue}>{data.stats.sector || 'N/A'}</span>
                                    </div>
                                    <div className={styles.fundamentalRow}>
                                        <span className={styles.fundamentalLabel}>Country</span>
                                        <span className={styles.fundamentalValue}>{data.stats.country || 'N/A'}</span>
                                    </div>
                                    <div className={styles.fundamentalRow}>
                                        <span className={styles.fundamentalLabel}>52-Week High</span>
                                        <span className={styles.fundamentalValue}>
                                            {data.stats.fiftyTwoWeekHigh
                                                ? format(convert(data.stats.fiftyTwoWeekHigh, data.currency))
                                                : '—'}
                                        </span>
                                    </div>
                                    <div className={styles.fundamentalRow}>
                                        <span className={styles.fundamentalLabel}>52-Week Low</span>
                                        <span className={styles.fundamentalValue}>
                                            {data.stats.fiftyTwoWeekLow
                                                ? format(convert(data.stats.fiftyTwoWeekLow, data.currency))
                                                : '—'}
                                        </span>
                                    </div>
                                    <div className={styles.fundamentalRow}>
                                        <span className={styles.fundamentalLabel}>Cost Basis</span>
                                        <span className={styles.fundamentalValue}>
                                            {format(convert(data.stats.totalInvestment, data.currency))}
                                        </span>
                                    </div>
                                    <div className={styles.fundamentalRow}>
                                        <span className={styles.fundamentalLabel}>Total Fees Paid</span>
                                        <span className={styles.fundamentalValue}>
                                            {format(convert(data.stats.totalFees, data.currency))}
                                        </span>
                                    </div>
                                </div>
                            </section>
                        )}
                    </div>
                </div>
            )}

            {activeTab === 'activities' && (
                <div
                    role="tabpanel"
                    id="symbol-panel-activities"
                    aria-labelledby="symbol-tab-activities"
                    className={styles.content}
                >
                    <section className={styles.tableCard}>
                        <div className={styles.filterBar}>
                            <div className={styles.filterGroup}>
                                <select
                                    aria-label="Filter by activity type"
                                    className={styles.select}
                                    value={filterType}
                                    onChange={(e) => setFilterType(e.target.value)}
                                >
                                    <option value="">All Types</option>
                                    {Array.from(new Set(data.activities.map((a: any) => a.type))).sort().map((type: any) => (
                                        <option key={type} value={type}>{type === 'STOCK_SPLIT' ? 'SPLIT' : type}</option>
                                    ))}
                                </select>

                                <select
                                    aria-label="Filter by account owner"
                                    className={styles.select}
                                    value={filterAccount}
                                    onChange={(e) => setFilterAccount(e.target.value)}
                                >
                                    <option value="">All Accounts</option>
                                    {Array.from(new Set(data.activities.map((a: any) => a.account?.name).filter(Boolean))).sort().map((name: any) => {
                                        const user = users.find(u => u.username === name);
                                        const displayName = user?.name || name;
                                        return <option key={name} value={name}>{displayName}</option>;
                                    })}
                                </select>

                                <select
                                    aria-label="Filter by account type"
                                    className={styles.select}
                                    value={filterAccountType}
                                    onChange={(e) => setFilterAccountType(e.target.value)}
                                >
                                    <option value="">All Account Types</option>
                                    {Array.from(new Set(data.activities.map((a: any) => a.account?.type).filter(Boolean))).sort().map((type: any) => (
                                        <option key={type} value={type}>{type}</option>
                                    ))}
                                </select>

                                <select
                                    aria-label="Filter by platform"
                                    className={styles.select}
                                    value={filterPlatform}
                                    onChange={(e) => setFilterPlatform(e.target.value)}
                                >
                                    <option value="">All Platforms</option>
                                    {Array.from(new Set(data.activities.map((a: any) => a.platform?.name).filter(Boolean))).sort().map((name: any) => (
                                        <option key={name} value={name}>{name}</option>
                                    ))}
                                </select>
                            </div>

                            <div className={styles.filterMeta}>
                                <span className={styles.filterCount}>
                                    Showing {filteredActivities.length} of {data.activities.length}
                                </span>
                                {hasActiveFilters && (
                                    <button type="button" className={styles.clearBtn} onClick={clearFilters}>
                                        Clear filters
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className={styles.tableWrap}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th>Type</th>
                                        <th className={styles.alignRight}>Quantity</th>
                                        <th className={styles.alignRight}>Price</th>
                                        <th className={styles.alignRight}>Fee</th>
                                        <th className={styles.alignRight}>Total</th>
                                        <th>Account</th>
                                        <th>Platform</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredActivities.length === 0 ? (
                                        <tr>
                                            <td colSpan={8} className={styles.emptyState}>
                                                No activities match the selected filters.
                                            </td>
                                        </tr>
                                    ) : (
                                        filteredActivities.map((activity: any) => {
                                            const isSplit = activity.type === 'STOCK_SPLIT';
                                            const actCurrency = activity.currency || data.currency;
                                            const convertedPrice = convert(activity.price, actCurrency);
                                            const convertedFee = activity.fee ? convert(activity.fee, actCurrency) : 0;
                                            const totalRaw = computeActivityNetAmount(activity);
                                            const convertedTotal = convert(totalRaw, actCurrency);

                                            const user = users.find(u => u.username === activity.account?.name);
                                            const displayName = user?.name || activity.account?.name;

                                            return (
                                                <tr key={activity.id}>
                                                    <td>{formatDate(activity.date)}</td>
                                                    <td>
                                                        <span className={`${styles.badge} ${styles[activity.type] || ''}`}>
                                                            {isSplit ? 'SPLIT' : activity.type}
                                                        </span>
                                                    </td>
                                                    <td className={styles.numCell}>
                                                        {isSplit ? `${formatQuantity(activity.quantity)}:1` : formatQuantity(activity.quantity)}
                                                    </td>
                                                    <td className={styles.numCell}>
                                                        {isSplit ? '—' : format(convertedPrice)}
                                                    </td>
                                                    <td className={`${styles.numCell} ${styles.mutedCell}`}>
                                                        {activity.fee ? format(convertedFee) : '—'}
                                                    </td>
                                                    <td className={`${styles.numCell} ${styles.strongCell}`}>
                                                        {isSplit ? '—' : format(convertedTotal)}
                                                    </td>
                                                    <td>
                                                        {activity.account ? (
                                                            <span className={styles.mutedCell}>
                                                                {displayName} · {activity.account.type}
                                                            </span>
                                                        ) : (
                                                            '—'
                                                        )}
                                                    </td>
                                                    <td>
                                                        <span className={styles.mutedCell}>
                                                            {activity.platform?.name || '—'}
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
                </div>
            )}
        </div>
    );
}

export default function AnalysisPage() {
    return (
        <Suspense fallback={<SymbolSkeleton />}>
            <AnalysisContent />
        </Suspense>
    );
}
