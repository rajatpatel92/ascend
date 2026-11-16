'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import React, { useEffect, useState, useMemo, useRef } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { MdRefresh } from 'react-icons/md';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import usePersistentState from '@/hooks/usePersistentState';
import { useLiveSync } from '@/hooks/useLiveSync';
import { ClientCache } from '@/lib/client-cache';
import { emitLiveSyncEvent, ensureMarketSyncConvergence } from '@/lib/live-sync';
import ReportFilters, { FilterOptions } from '@/components/ReportFilters';
import PerformanceChart from '@/components/PerformanceChart';
import TopMovers from '@/components/TopMovers';
import DividendSummary from '@/components/DividendSummary';
import DashboardSkeleton from '@/components/DashboardSkeleton';

interface AllocationItem {
  name: string;
  value: number;
  platformName?: string;
}

interface SyncStatusInfo {
  syncedAt: string | null;
  marketTime: string | null;
  isRefreshing: boolean;
  staleCount: number;
  marketDataVersion: number;
  isMarketOpen?: boolean;
  effectivePriceTtlMs?: number;
  throttledUntil: string | null;
}

interface PortfolioSummary {
  totalValue: number;
  totalCostBasis?: number;
  dayChange: number;
  dayChangePercent: number;
  totalGrowth: number;
  totalGrowthPercent: number;
  totalLifetimeDividends?: number;
  totalRealizedGain?: number;
  xirr: number | null;
  isPortfolioYoungerThan1Y?: boolean;
  allocationByType: AllocationItem[];
  allocationByAsset: AllocationItem[];
  allocationByPlatform: AllocationItem[];
  allocationByAccount: AllocationItem[];
  allocationByAccountType?: AllocationItem[];
  allocationBySector?: AllocationItem[];
  allocationByCountry?: AllocationItem[];
  constituents: any[];
  topMovers: any[];
  dividendsYTD: number;
  projectedDividends: number;
  upcomingDividends: any[];
  lastUpdated: string | null;
  syncStatus?: SyncStatusInfo;
}

type AllocTabKey = 'account' | 'accountType' | 'type' | 'sector';

const ALLOC_TABS: { id: AllocTabKey; label: string }[] = [
  { id: 'account', label: 'Accounts' },
  { id: 'accountType', label: 'Acct Type' },
  { id: 'type', label: 'Asset Type' },
  { id: 'sector', label: 'Sector' }
];

const SEGMENT_COLORS = ['#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#06b6d4', '#64748b'];

function formatRelativeSyncedLabel(isoDate: string | null | undefined, nowMs: number): string {
  if (!isoDate) return 'Awaiting sync';
  const ts = Date.parse(isoDate);
  if (!Number.isFinite(ts)) return 'Synced recently';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 45) return 'Synced just now';
  if (diffSec < 3600) return `Synced ${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `Synced ${Math.floor(diffSec / 3600)}h ago`;
  return `Synced ${new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

export default function Dashboard() {
  const { data: session } = useSession();
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const { format, convert, currency } = useCurrency();

  const userRole = (session?.user as { role?: string } | undefined)?.role || 'VIEWER';
  const canRefresh = userRole === 'ADMIN' || userRole === 'EDITOR';

  // Layer 1 Global Filters
  const [globalFilters, setGlobalFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('dashboard_filters', null);

  // Unified Performance & Evolution chart state
  const [range, setRange] = useState('YTD');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  // Allocation Snapshot tab state
  const [allocTab, setAllocTab] = useState<AllocTabKey>('account');
  const allocTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Live sync, manual refresh & relative time tick state
  const [syncTick, setSyncTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [cooldownUntilMs, setCooldownUntilMs] = useState(0);
  const [refreshFeedback, setRefreshFeedback] = useState<string | null>(null);
  const loadedViewKeyRef = useRef<string | null>(null);

  useLiveSync({
    enabled: isFiltersLoaded,
    events: ['MARKET_SYNCED', 'PORTFOLIO_UPDATED', 'ACTIVITIES_CHANGED', 'SYNC_STATUS_CHANGED'],
    onSync: (_reason, event) => {
      if (event?.type === 'SYNC_STATUS_CHANGED') {
        setSummary((prev) => {
          if (!prev || 'error' in prev || !prev.syncStatus) return prev;
          return {
            ...prev,
            syncStatus: {
              ...prev.syncStatus,
              isRefreshing: event.isRefreshing ?? false,
              throttledUntil:
                event.throttledUntil !== undefined
                  ? event.throttledUntil
                  : prev.syncStatus.throttledUntil,
            },
          };
        });
        return;
      }
      setRefreshFeedback(null);
      setSyncTick((t) => t + 1);
    },
  });

  const activeThrottleResetMs = useMemo(() => {
    if (!summary || 'error' in summary || !summary.syncStatus?.throttledUntil) return 0;
    const parsed = Date.parse(summary.syncStatus.throttledUntil);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [summary]);

  const hasActiveCountdown = cooldownUntilMs > nowMs || activeThrottleResetMs > nowMs;

  useEffect(() => {
    const intervalMs = hasActiveCountdown ? 1_000 : 30_000;
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [hasActiveCountdown]);

  useEffect(() => {
    if (!isFiltersLoaded) return;

    const controller = new AbortController();

    const fetchData = async () => {
      const investmentTypes = globalFilters?.investmentTypes || [];
      const accountTypes = globalFilters?.accountTypes || [];
      const cacheKey = ClientCache.generateKey('portfolio_summary', {
        currency,
        investmentTypes,
        accountTypes,
      });

      try {
        let url = `/api/portfolio?currency=${encodeURIComponent(currency)}`;
        if (investmentTypes.length > 0) {
          url += `&investmentTypes=${encodeURIComponent(investmentTypes.join(','))}`;
        }
        if (accountTypes.length > 0) {
          url += `&accountTypes=${encodeURIComponent(accountTypes.join(','))}`;
        }

        const cached = ClientCache.get<PortfolioSummary>(cacheKey);
        if (cached && typeof cached === 'object' && !('error' in cached)) {
          setSummary(cached);
        }

        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        const data = await res.json();
        if (controller.signal.aborted) return;

        if (!res.ok || (data && typeof data === 'object' && 'error' in data)) {
          // Preserve currently rendered data on background sync error for the same view
          if (loadedViewKeyRef.current === cacheKey) {
            setRefreshFeedback('Background update failed; showing last loaded quotes.');
            return;
          }
          setSummary(
            data && typeof data === 'object' && 'error' in data
              ? data
              : ({ error: `HTTP ${res.status}` } as any)
          );
          return;
        }

        loadedViewKeyRef.current = cacheKey;
        setSummary(data);
        setRefreshFeedback(null);
        setNowMs(Date.now());
        ClientCache.set(cacheKey, data);

        if (data?.syncStatus) {
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
      }
    };

    void fetchData();
    return () => controller.abort();
  }, [currency, globalFilters, isFiltersLoaded, syncTick]);

  const handleManualRefresh = async () => {
    if (!canRefresh || isManualRefreshing || cooldownUntilMs > Date.now()) return;
    setIsManualRefreshing(true);
    setRefreshFeedback(null);

    try {
      const res = await fetch('/api/market-data/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'portfolio', mode: 'price' }),
      });
      const payload = await res.json().catch(() => ({}));

      if (!res.ok) {
        setRefreshFeedback(payload?.error || `Refresh failed (HTTP ${res.status})`);
        return;
      }

      const remainingMs =
        typeof payload.cooldownRemainingMs === 'number' && payload.cooldownRemainingMs > 0
          ? payload.cooldownRemainingMs
          : 15_000;
      setCooldownUntilMs(Date.now() + remainingMs);
      setNowMs(Date.now());

      if (payload.skippedReason === 'cooldown') {
        setRefreshFeedback(`On cooldown (${Math.ceil(remainingMs / 1000)}s)`);
        return;
      }

      emitLiveSyncEvent('MARKET_SYNCED', {
        version: payload?.syncStatus?.marketDataVersion,
        reason: 'manual-dashboard-refresh',
      });
    } catch (err) {
      console.error('Failed to refresh portfolio market data', err);
      setRefreshFeedback('Network error while refreshing quotes.');
    } finally {
      setIsManualRefreshing(false);
    }
  };

  const metrics = useMemo(() => {
    if (!summary || 'error' in summary) {
      return null;
    }

    const totalValue = summary.totalValue || 0;
    const constituents = summary.constituents || [];
    const activeConstituents = constituents.filter((c: any) => c.quantity > 0.00001);

    const investedPrincipal = typeof summary.totalCostBasis === 'number'
      ? summary.totalCostBasis
      : activeConstituents.reduce((sum: number, c: any) => {
          return sum + (c.bookValueTarget ?? convert(c.bookValue || 0, c.currency || 'USD'));
        }, 0);

    const unrealizedGain = totalValue - investedPrincipal;
    const unrealizedGainPercent = investedPrincipal > 0 ? (unrealizedGain / investedPrincipal) * 100 : 0;

    const lifetimeDividends = typeof summary.totalLifetimeDividends === 'number'
      ? summary.totalLifetimeDividends
      : constituents.reduce((sum: number, c: any) => {
          return sum + (c.lifetimeDividendsTarget ?? convert(c.lifetimeDividends || 0, 'USD'));
        }, 0);

    const realizedGain = typeof summary.totalRealizedGain === 'number'
      ? summary.totalRealizedGain
      : constituents.reduce((sum: number, c: any) => {
          return sum + (c.realizedGainTarget ?? convert(c.realizedGain || 0, 'USD'));
        }, 0);

    const capitalGainTotal = unrealizedGain + realizedGain;
    const totalGrowthVal = summary.totalGrowth || 0;
    let capitalSharePct = 0;
    let dividendSharePct = 0;
    if (capitalGainTotal < 0) {
      capitalSharePct = 0;
      dividendSharePct = totalGrowthVal > 0 && lifetimeDividends > 0 ? 100 : 0;
    } else {
      const posCap = Math.max(0, capitalGainTotal);
      const posDiv = Math.max(0, lifetimeDividends);
      const splitDenominator = posCap + posDiv;
      capitalSharePct = splitDenominator > 0 ? (posCap / splitDenominator) * 100 : 0;
      dividendSharePct = splitDenominator > 0 ? (posDiv / splitDenominator) * 100 : 0;
    }

    const activeHoldingsCount = activeConstituents.length;
    const activeAccountKeys = new Set<string>();
    let hasAccountsBreakdown = false;
    activeConstituents.forEach((c: any) => {
      if (c.accountsBreakdown && typeof c.accountsBreakdown === 'object') {
        hasAccountsBreakdown = true;
        Object.entries(c.accountsBreakdown).forEach(([key, acc]: [string, any]) => {
          if ((acc?.quantity ?? 0) > 0.00001 || (acc?.value ?? 0) >= 0.01) {
            const distinctKey = `${acc?.name || key}:${acc?.accountType || 'Unassigned'}:${acc?.platformName || ''}`;
            activeAccountKeys.add(distinctKey);
          }
        });
      }
    });
    const activeAccountsCount = hasAccountsBreakdown
      ? activeAccountKeys.size
      : (summary.allocationByAccount || []).filter(a => a.value >= 0.01).length;

    const projectedDividends = summary.projectedDividends || 0;
    const dividendsYTD = summary.dividendsYTD || 0;
    const currentYield = totalValue > 0 ? (projectedDividends / totalValue) * 100 : 0;
    const yieldOnCost = investedPrincipal > 0 ? (projectedDividends / investedPrincipal) * 100 : 0;
    const ytdProgressPct = projectedDividends > 0
      ? Math.min(100, Math.max(0, (dividendsYTD / projectedDividends) * 100))
      : 0;

    return {
      investedPrincipal,
      unrealizedGain,
      unrealizedGainPercent,
      lifetimeDividends,
      realizedGain,
      capitalGainTotal,
      capitalSharePct,
      dividendSharePct,
      activeHoldingsCount,
      activeAccountsCount,
      projectedDividends,
      dividendsYTD,
      currentYield,
      yieldOnCost,
      ytdProgressPct
    };
  }, [summary, convert]);

  const allocSnapshot = useMemo(() => {
    if (!summary || 'error' in summary) {
      return { items: [], total: 0 };
    }

    let rawList: AllocationItem[] = [];
    switch (allocTab) {
      case 'accountType':
        rawList = summary.allocationByAccountType || [];
        break;
      case 'type':
        rawList = summary.allocationByType || [];
        break;
      case 'sector':
        rawList = summary.allocationBySector || [];
        break;
      case 'account':
      default:
        rawList = summary.allocationByAccount || [];
        break;
    }

    const filtered = rawList
      .filter(item => item.value >= 0.01)
      .slice()
      .sort((a, b) => b.value - a.value);

    const total = filtered.reduce((sum, item) => sum + item.value, 0);
    return { items: filtered, total };
  }, [summary, allocTab]);

  if (!summary) return <DashboardSkeleton />;

  if ('error' in summary) {
    return (
      <div className={styles.container}>
        <div className={styles.errorBox}>
          <h2>Failed to load portfolio data</h2>
          <p>Please try again later. {(summary as any).error}</p>
        </div>
      </div>
    );
  }

  if (!metrics) return <DashboardSkeleton />;

  const totalValue = summary.totalValue || 0;
  const dayChange = summary.dayChange || 0;
  const dayChangePercent = Number.isFinite(summary.dayChangePercent) ? summary.dayChangePercent : 0;
  const totalGrowth = summary.totalGrowth || 0;
  const totalGrowthPercent = summary.totalGrowthPercent || 0;
  const isPositive = dayChange >= 0;
  const isTotalGrowthPositive = totalGrowth >= 0;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const userName = session?.user?.name || 'Investor';

  const handleAllocTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = ALLOC_TABS.findIndex(t => t.id === allocTab);
    if (currentIndex === -1) return;

    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % ALLOC_TABS.length;
    else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + ALLOC_TABS.length) % ALLOC_TABS.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = ALLOC_TABS.length - 1;

    if (nextIndex !== null) {
      e.preventDefault();
      setAllocTab(ALLOC_TABS[nextIndex].id);
      allocTabRefs.current[nextIndex]?.focus();
    }
  };

  const topAllocItems = allocSnapshot.items.slice(0, 4);
  const remainingAllocCount = Math.max(0, allocSnapshot.items.length - 4);
  const otherAllocValue = allocSnapshot.items.slice(4).reduce((sum, item) => sum + item.value, 0);

  const syncedAtIso = summary.syncStatus?.syncedAt || summary.lastUpdated;
  const marketTimeIso = summary.syncStatus?.marketTime || summary.lastUpdated;
  const isSyncingNow = isManualRefreshing || Boolean(summary.syncStatus?.isRefreshing);
  const isThrottled = activeThrottleResetMs > nowMs;
  const throttleRemainingSec = isThrottled ? Math.max(1, Math.ceil((activeThrottleResetMs - nowMs) / 1000)) : 0;
  const cooldownRemainingSec = cooldownUntilMs > nowMs ? Math.max(1, Math.ceil((cooldownUntilMs - nowMs) / 1000)) : 0;
  const marketTimeLabel = marketTimeIso
    ? new Date(marketTimeIso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.greeting}>{greeting}, {userName}</h1>
          <div className={styles.metaLine}>
            <span className={styles.date}>{dateStr}</span>
            <span
              className={styles.syncStatus}
              title={marketTimeLabel ? `Market data as of ${marketTimeLabel}` : 'Market data sync status'}
            >
              <span
                className={`${styles.statusDot} ${
                  isSyncingNow ? styles.statusDotRefreshing : isThrottled ? styles.statusDotWarning : ''
                }`}
                aria-hidden="true"
              />
              <span>{isSyncingNow ? 'Syncing quotes…' : formatRelativeSyncedLabel(syncedAtIso, nowMs)}</span>
              {marketTimeLabel && (
                <span className={styles.marketAsOf}>&bull; Market {marketTimeLabel}</span>
              )}
            </span>
            {isThrottled && (
              <span className={styles.throttlePill} role="status">
                Rate-limited &bull; retrying in {throttleRemainingSec}s
              </span>
            )}
            {refreshFeedback && (
              <span className={styles.refreshFeedback} role="status">
                {refreshFeedback}
              </span>
            )}
          </div>
        </div>
        <div className={styles.headerControls}>
          {canRefresh && (
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={handleManualRefresh}
              disabled={isManualRefreshing || cooldownRemainingSec > 0}
              title="Refresh live market prices"
            >
              <MdRefresh
                size={16}
                className={isManualRefreshing ? styles.spinIcon : undefined}
                aria-hidden="true"
              />
              <span>
                {isManualRefreshing
                  ? 'Refreshing…'
                  : cooldownRemainingSec > 0
                    ? `Refresh (${cooldownRemainingSec}s)`
                    : 'Refresh'}
              </span>
            </button>
          )}
          {isFiltersLoaded && (
            <ReportFilters onChange={setGlobalFilters} initialFilters={globalFilters || undefined} />
          )}
        </div>
      </header>

      <div className={styles.dashboardGrid}>
        {/* Tier 1: Executive Wealth Strip */}
        <section className={styles.executiveGrid} aria-label="Portfolio summary metrics">
          {/* Card 1: Net Worth Hero Card */}
          <div className={styles.heroCard}>
            <div className={styles.heroTop}>
              <div className={styles.heroLabel}>Total Net Worth</div>
              <div className={styles.heroValue}>{format(totalValue)}</div>
              <div className={styles.heroChange}>
                <span>{isPositive ? '▲' : '▼'}</span>
                <span>{format(Math.abs(dayChange))} ({Math.abs(dayChangePercent).toFixed(2)}%)</span>
                <span className={styles.heroChangeLabel}>Today</span>
              </div>
            </div>

            <div className={styles.heroMetaGrid}>
              <div className={styles.heroMetaItem}>
                <span className={styles.heroMetaLabel}>Invested Principal</span>
                <span className={styles.heroMetaValue}>{format(metrics.investedPrincipal)}</span>
              </div>
              <div className={styles.heroMetaItem}>
                <span className={styles.heroMetaLabel}>Unrealized P&amp;L</span>
                <span className={styles.heroMetaValue}>
                  {metrics.unrealizedGain >= 0 ? '+' : ''}{format(metrics.unrealizedGain)} ({metrics.unrealizedGainPercent >= 0 ? '+' : ''}{metrics.unrealizedGainPercent.toFixed(2)}%)
                </span>
              </div>
              <div className={styles.heroMetaItem}>
                <span className={styles.heroMetaLabel}>Scope</span>
                <span className={styles.heroMetaValue}>
                  {metrics.activeHoldingsCount} Active &bull; {metrics.activeAccountsCount} {metrics.activeAccountsCount === 1 ? 'Acct' : 'Accts'}
                </span>
              </div>
            </div>
          </div>

          {/* Card 2: All-Time Profit */}
          <div className={styles.kpiCard}>
            <div className={styles.kpiHeader}>
              <span className={styles.kpiLabel}>All-Time Profit</span>
              <span className={`${styles.kpiPill} ${isTotalGrowthPositive ? styles.positivePill : styles.negativePill}`}>
                {isTotalGrowthPositive ? '▲' : '▼'} {Math.abs(totalGrowthPercent).toFixed(2)}%
              </span>
            </div>

            <div className={`${styles.kpiValue} ${isTotalGrowthPositive ? styles.positiveText : styles.negativeText}`}>
              {totalGrowth >= 0 ? '+' : ''}{format(totalGrowth)}
            </div>

            <div className={styles.kpiFooter}>
              <div className={styles.splitBar} aria-hidden="true">
                <div className={styles.splitCapital} style={{ width: `${metrics.capitalSharePct}%` }} />
                <div className={styles.splitDividends} style={{ width: `${metrics.dividendSharePct}%` }} />
              </div>
              <div className={styles.kpiSubRow}>
                <span className={styles.legendDotItem}>
                  <span className={styles.dotBlue} />
                  Capital: <strong>{format(metrics.capitalGainTotal)}</strong>
                </span>
                <span className={styles.legendDotItem}>
                  <span className={styles.dotGreen} />
                  Divs: <strong>{format(metrics.lifetimeDividends)}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Card 3: Annualized Return (XIRR) */}
          <div className={styles.kpiCard}>
            <div className={styles.kpiHeader}>
              <span className={styles.kpiLabel}>Annualized Return</span>
              <span className={styles.kpiTag}>XIRR</span>
            </div>

            <div className={`${styles.kpiValue} ${
              summary.isPortfolioYoungerThan1Y || summary.xirr === null
                ? ''
                : summary.xirr >= 0
                  ? styles.positiveText
                  : styles.negativeText
            }`}>
              {summary.isPortfolioYoungerThan1Y
                ? 'N/A (<1Y)'
                : summary.xirr !== null
                  ? `${summary.xirr >= 0 ? '+' : ''}${(summary.xirr * 100).toFixed(2)}%`
                  : 'N/A'}
            </div>

            <div className={styles.kpiFooter}>
              <div className={styles.kpiFootDivider} />
              <div className={styles.kpiSubRow}>
                <span>
                  Unrealized ROI: <strong>{metrics.unrealizedGainPercent >= 0 ? '+' : ''}{metrics.unrealizedGainPercent.toFixed(2)}%</strong>
                </span>
                <span>
                  Realized: <strong>{metrics.realizedGain >= 0 ? '+' : ''}{format(metrics.realizedGain)}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Card 4: Passive Income & Yield */}
          <div className={styles.kpiCard}>
            <div className={styles.kpiHeader}>
              <span className={styles.kpiLabel}>Passive Income</span>
              <span className={`${styles.kpiPill} ${styles.positivePill}`}>
                {metrics.currentYield.toFixed(2)}% Yield
              </span>
            </div>

            <div className={styles.kpiValue}>
              {format(metrics.projectedDividends)}
              <span className={styles.kpiUnit}>/ yr</span>
            </div>

            <div className={styles.kpiFooter}>
              <div className={styles.progressTrack} aria-hidden="true">
                <div className={styles.progressFill} style={{ width: `${metrics.ytdProgressPct}%` }} />
              </div>
              <div className={styles.kpiSubRow}>
                <span>
                  YTD: <strong>{format(metrics.dividendsYTD)}</strong>
                </span>
                <span>
                  YoC: <strong>{metrics.yieldOnCost.toFixed(2)}%</strong>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Tier 2: Unified Portfolio Performance & Evolution Card */}
        <section className={styles.chartSection} aria-label="Portfolio performance and value history">
          <PerformanceChart
            range={range}
            setRange={setRange}
            customStart={customStart}
            setCustomStart={setCustomStart}
            customEnd={customEnd}
            setCustomEnd={setCustomEnd}
            overrideChange={summary.dayChange}
            overrideChangePercent={Number.isFinite(dayChangePercent) ? dayChangePercent : 0}
            filterInvestmentTypes={globalFilters?.investmentTypes}
            filterAccountTypes={globalFilters?.accountTypes}
          />
        </section>

        {/* Tier 3: 3-Column Portfolio Pulse Row */}
        <section className={styles.pulseGrid} aria-label="Portfolio pulse insights">
          <TopMovers
            constituents={summary.constituents}
            portfolioTotalValue={summary.totalValue}
            portfolioDayChange={summary.dayChange}
          />

          {/* Allocation & Accounts Snapshot Card */}
          <div className={styles.pulseCard}>
            <div className={styles.pulseCardHeader}>
              <h2 className={styles.pulseTitle}>Allocation Snapshot</h2>
              <Link href="/analysis/allocation" className={styles.pulseLink}>
                Explore X-Ray &rarr;
              </Link>
            </div>

            <div className={styles.allocTabBar}>
              <div
                role="tablist"
                aria-label="Allocation snapshot dimension"
                className={styles.allocTablist}
                onKeyDown={handleAllocTabKeyDown}
              >
                {ALLOC_TABS.map((tab, idx) => {
                  const selected = allocTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      ref={el => { allocTabRefs.current[idx] = el; }}
                      type="button"
                      role="tab"
                      id={`alloc-snap-tab-${tab.id}`}
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      className={styles.allocTabBtn}
                      onClick={() => setAllocTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              role="tabpanel"
              aria-labelledby={`alloc-snap-tab-${allocTab}`}
              tabIndex={0}
              className={styles.allocPanel}
            >
              {topAllocItems.length > 0 && allocSnapshot.total > 0 ? (
                <>
                  <div className={styles.stackedBar} aria-hidden="true">
                    {topAllocItems.map((item, idx) => {
                      const pct = (item.value / allocSnapshot.total) * 100;
                      return (
                        <div
                          key={item.name}
                          className={styles.stackedSegment}
                          style={{
                            width: `${pct}%`,
                            backgroundColor: SEGMENT_COLORS[idx % SEGMENT_COLORS.length]
                          }}
                        />
                      );
                    })}
                    {otherAllocValue > 0 && (
                      <div
                        className={styles.stackedSegment}
                        style={{
                          width: `${(otherAllocValue / allocSnapshot.total) * 100}%`,
                          backgroundColor: SEGMENT_COLORS[5]
                        }}
                      />
                    )}
                  </div>

                  <ul className={styles.allocList}>
                    {topAllocItems.map((item, idx) => {
                      const pct = (item.value / allocSnapshot.total) * 100;
                      const color = SEGMENT_COLORS[idx % SEGMENT_COLORS.length];
                      return (
                        <li key={item.name} className={styles.allocRow}>
                          <div className={styles.allocRowTop}>
                            <div className={styles.allocNameWrap}>
                              <span className={styles.allocDot} style={{ backgroundColor: color }} aria-hidden="true" />
                              <span className={styles.allocName}>{item.name}</span>
                            </div>
                            <div className={styles.allocStats}>
                              <span className={styles.allocVal}>{format(item.value)}</span>
                              <span className={styles.allocPct}>{pct.toFixed(1)}%</span>
                            </div>
                          </div>
                          <div className={styles.allocBarTrack} aria-hidden="true">
                            <div
                              className={styles.allocBarFill}
                              style={{ width: `${Math.min(100, Math.max(pct, 2))}%`, backgroundColor: color }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {remainingAllocCount > 0 && (
                    <div className={styles.allocFooterNote}>
                      +{remainingAllocCount} more {remainingAllocCount === 1 ? 'category' : 'categories'} ({format(otherAllocValue)})
                    </div>
                  )}
                </>
              ) : (
                <div className={styles.allocEmpty}>
                  No allocation breakdown available for this view
                </div>
              )}
            </div>
          </div>

          <DividendSummary
            dividendsYTD={summary.dividendsYTD}
            upcomingDividends={summary.upcomingDividends}
            totalValue={summary.totalValue}
            projectedDividends={summary.projectedDividends}
            lifetimeDividends={metrics.lifetimeDividends}
            constituents={summary.constituents}
          />
        </section>
      </div>
    </div>
  );
}
