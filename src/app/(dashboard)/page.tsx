'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import usePersistentState from '@/hooks/usePersistentState';
import ReportFilters, { FilterOptions } from '@/components/ReportFilters';

import PortfolioChart from '@/components/PortfolioChart';
import PerformanceChart from '@/components/PerformanceChart';
import TopMovers from '@/components/TopMovers';
import DividendSummary from '@/components/DividendSummary';
import DashboardSkeleton from '@/components/DashboardSkeleton';

interface PortfolioSummary {
  totalValue: number;
  dayChange: number;
  dayChangePercent: number;
  totalGrowth: number;
  totalGrowthPercent: number;
  xirr: number | null;
  isPortfolioYoungerThan1Y?: boolean;
  allocationByType: { name: string; value: number }[];
  allocationByAsset: { name: string; value: number }[];
  allocationByPlatform: { name: string; value: number }[];
  allocationByAccount: { name: string; value: number; platformName: string }[];
  constituents: any[];
  topMovers: any[];
  dividendsYTD: number;
  projectedDividends: number;
  upcomingDividends: any[];
  lastUpdated: string | null;
}

export default function Dashboard() {
  const { data: session } = useSession();
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const { format, convert, currency } = useCurrency();

  // Filters
  const [globalFilters, setGlobalFilters, isFiltersLoaded] = usePersistentState<FilterOptions | null>('dashboard_filters', null);

  // Lifted state for chart synchronization
  const [range, setRange] = useState('1D');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  // Last Updated Time State
  const [timeAgo, setTimeAgo] = useState<string>('');

  useEffect(() => {
    // 2. Fetch fresh data
    const fetchData = async () => {
      try {
        let url = `/api/portfolio?currency=${currency}`;
        if (globalFilters) {
          if (globalFilters.investmentTypes.length > 0) {
            url += `&investmentTypes=${globalFilters.investmentTypes.join(',')}`;
          }
          if (globalFilters.accountTypes.length > 0) {
            url += `&accountTypes=${globalFilters.accountTypes.join(',')}`;
          }
        }

        const cacheKey = `portfolio_summary_${currency}_${globalFilters ? JSON.stringify(globalFilters) : 'ALL'}`;

        // Try cache first
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          try { setSummary(JSON.parse(cached)); } catch (e) { }
        }

        const res = await fetch(url);
        const data = await res.json();
        setSummary(data);
        localStorage.setItem(cacheKey, JSON.stringify(data));
      } catch (err) {
        console.error('Failed to fetch portfolio', err);
      }
    };
    if (isFiltersLoaded) {
      fetchData();
    }
  }, [currency, globalFilters, isFiltersLoaded]);

  if (!summary) return <DashboardSkeleton />;

  const activeSummary = summary;

  if (!activeSummary) return <DashboardSkeleton />;

  // Handle API Error Case
  if ('error' in activeSummary) {
    return (
      <div className={styles.container}>
        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-error)' }}>
          <h3>Failed to load portfolio data</h3>
          <p>Please try again later. {(activeSummary as any).error}</p>
        </div>
      </div>
    );
  }

  const totalValue = activeSummary.totalValue || 0;
  const dayChange = activeSummary.dayChange || 0;
  const totalGrowth = activeSummary.totalGrowth || 0;
  const isPositive = dayChange >= 0;

  // Greeting Logic
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const userName = session?.user?.name || 'Investor';

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.greeting}>{greeting}, {userName}</h1>
          <p className={styles.date}>{dateStr}</p>
        </div>
        {isFiltersLoaded && (
          <ReportFilters onChange={setGlobalFilters} initialFilters={globalFilters || undefined} />
        )}
      </header>

      <div className={styles.dashboardGrid}>
        {/* Hero Card: Net Worth */}
        <div className={styles.heroCard}>
          <div className={styles.heroLabel}>Total Net Worth</div>
          <div className={styles.heroValue}>{format(totalValue)}</div>
          <div className={styles.heroChange}>
            <span>{isPositive ? '▲' : '▼'}</span>
            <span>{format(Math.abs(dayChange))} ({activeSummary.dayChangePercent.toFixed(2)}%)</span>
            <span className={styles.heroChangeLabel}>Today</span>
          </div>
        </div>

        {/* Stats Grid */}
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>Portfolio XIRR</div>
            <div className={`${styles.statValue} ${activeSummary.isPortfolioYoungerThan1Y ? '' : (activeSummary.xirr && activeSummary.xirr >= 0 ? styles.positive : styles.negative)}`}>
              {activeSummary.isPortfolioYoungerThan1Y
                ? 'N/A (<1Y)'
                : activeSummary.xirr !== null
                  ? `${(activeSummary.xirr * 100).toFixed(2)}%`
                  : 'N/A'}
            </div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statLabel}>All Time Return</div>
            <div className={styles.statValueRow}>
              <span className={styles.statAmount}>{format(totalGrowth)}</span>
              <span className={`${styles.statPercentPill} ${activeSummary.totalGrowthPercent >= 0 ? styles.positive : styles.negative}`}>
                {activeSummary.totalGrowthPercent >= 0 ? '▲' : '▼'} {activeSummary.totalGrowthPercent ? `${Math.abs(activeSummary.totalGrowthPercent).toFixed(2)}%` : '0.00%'}
              </span>
            </div>
          </div>
        </div>

        {/* Insights Grid */}
        <div className={styles.insightsGrid}>
          <TopMovers
            constituents={activeSummary.constituents}
            portfolioTotalValue={activeSummary.totalValue}
            portfolioDayChange={activeSummary.dayChange}
          />
          <DividendSummary
            dividendsYTD={activeSummary.dividendsYTD}
            upcomingDividends={activeSummary.upcomingDividends}
            totalValue={activeSummary.totalValue}
            projectedDividends={activeSummary.projectedDividends}
          />
        </div>

        {/* Performance Chart Section */}
        <section className={styles.performanceSection}>
          <PerformanceChart
            range={range}
            setRange={setRange}
            customStart={customStart}
            setCustomStart={setCustomStart}
            customEnd={customEnd}
            setCustomEnd={setCustomEnd}
            overrideChange={activeSummary?.dayChange}
            overrideChangePercent={activeSummary?.dayChangePercent}
            filterInvestmentTypes={globalFilters?.investmentTypes}
            filterAccountTypes={globalFilters?.accountTypes}
          />
        </section>

        {/* Chart Section */}
        <section className={styles.chartSection}>
          <PortfolioChart
            range={range}
            setRange={setRange}
            customStart={customStart}
            setCustomStart={setCustomStart}
            customEnd={customEnd}
            setCustomEnd={setCustomEnd}
            filterInvestmentTypes={globalFilters?.investmentTypes}
            filterAccountTypes={globalFilters?.accountTypes}
          />
        </section>

      </div>

      {activeSummary?.lastUpdated && (
        <div style={{
          textAlign: 'right',
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          marginTop: '2rem',
          paddingRight: '1rem',
          opacity: 0.8
        }}>
          Last Data Refresh: {new Date(activeSummary.lastUpdated).toLocaleString()}
        </div>
      )}
    </div>
  );
}
