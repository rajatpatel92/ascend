'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from '../page.module.css';
import { useSession } from 'next-auth/react';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { useLiveSync } from '@/hooks/useLiveSync';
import { emitLiveSyncEvent, ensureMarketSyncConvergence } from '@/lib/live-sync';
import {
    MdAccountBalanceWallet,
    MdAdd,
    MdBolt,
    MdCategory,
    MdClose,
    MdPlayArrow,
    MdReceiptLong,
    MdRefresh,
    MdSync
} from 'react-icons/md';

interface InvestmentTypeRecord {
    id: string;
    name: string;
    yahooInvestmentTypeId?: string | null;
    yahooInvestmentType?: { name: string } | null;
}

interface ActivityTypeRecord {
    id: string;
    name: string;
    behavior: 'ADD' | 'REMOVE' | 'NEUTRAL';
    isSystem?: boolean;
}

interface AccountTypeRecord {
    id: string;
    name: string;
    currency: string;
}

interface YahooTypeRecord {
    id: string;
    name: string;
}

interface MarketSyncStatusResponse {
    marketDataVersion: number;
    portfolioMutationVersion: number;
    isIncrementalRunning: boolean;
    isFullSyncRunning: boolean;
    isRefreshing: boolean;
    lastIncrementalSyncAt: string | null;
    lastFullSyncAt: string | null;
    lastMarketWriteAt: string | null;
    lastSyncError: string | null;
    lastIncrementalStats: {
        total: number;
        success: number;
        failed: number;
    } | null;
    isMarketOpen: boolean;
    sessionLabel: string;
    effectivePriceTtlMs: number;
    config?: {
        priceCacheTtlMs: number;
        offHoursPriceCacheTtlMs: number;
        metadataCacheTtlMs: number;
        historyCacheTtlMs: number;
        manualRefreshCooldownMs: number;
        marketHoursAware: boolean;
    };
    throttler?: {
        isRateLimited: boolean;
        resetTime: string | null;
        queueLength: number;
        activeCount: number;
    };
    activeSymbolCount: number;
    staleSymbolCount: number;
    oldestSyncAt: string | null;
    newestSyncAt: string | null;
}

interface SessionUser {
    role?: string;
}

function formatDurationShort(ms: number | undefined): string {
    if (!ms || !Number.isFinite(ms)) return '—';
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = (ms / 3_600_000);
    return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

function formatRelativeTimestamp(isoDate: string | null | undefined, nowMs: number): string {
    if (!isoDate) return 'Never';
    const ts = Date.parse(isoDate);
    if (!Number.isFinite(ts)) return 'Unknown';
    const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
    if (diffSec < 45) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function MasterDataSettingsPage() {
    const [investmentTypes, setInvestmentTypes] = useState<InvestmentTypeRecord[]>([]);
    const [activityTypes, setActivityTypes] = useState<ActivityTypeRecord[]>([]);
    const [accountTypes, setAccountTypes] = useState<AccountTypeRecord[]>([]);
    const [yahooTypes, setYahooTypes] = useState<YahooTypeRecord[]>([]);

    const [newInvestmentType, setNewInvestmentType] = useState('');
    const [newInvestmentTypeMapping, setNewInvestmentTypeMapping] = useState('');
    const [newActivityType, setNewActivityType] = useState('');
    const [newActivityBehavior, setNewActivityBehavior] = useState<'ADD' | 'REMOVE' | 'NEUTRAL'>('ADD');
    const [newAccountTypeName, setNewAccountTypeName] = useState('');
    const [newAccountTypeCurrency, setNewAccountTypeCurrency] = useState('USD');

    const [editingScope, setEditingScope] = useState<'INV' | 'ACT' | 'ACC' | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const [editYahooId, setEditYahooId] = useState('');
    const [editBehavior, setEditBehavior] = useState<'ADD' | 'REMOVE' | 'NEUTRAL'>('ADD');
    const [editCurrency, setEditCurrency] = useState('USD');

    const [syncStatus, setSyncStatus] = useState<MarketSyncStatusResponse | null>(null);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const [logs, setLogs] = useState<string[]>([]);
    const [isQuickSyncing, setIsQuickSyncing] = useState(false);
    const [isRunning, setIsRunning] = useState(false);
    const [errorBanner, setErrorBanner] = useState<string | null>(null);
    const [successBanner, setSuccessBanner] = useState<string | null>(null);

    const suppressSelfSyncRef = useRef(false);

    const { data: session } = useSession();
    const role = (session?.user as SessionUser | undefined)?.role || 'VIEWER';

    const loadMasterData = useCallback(async (signal?: AbortSignal) => {
        try {
            const [invRes, yahooRes, actRes, accRes] = await Promise.all([
                fetch('/api/settings/investment-types', { signal, cache: 'no-store' }),
                fetch('/api/settings/yahoo-types', { signal, cache: 'no-store' }),
                fetch('/api/settings/activity-types', { signal, cache: 'no-store' }),
                fetch('/api/settings/account-types', { signal, cache: 'no-store' })
            ]);

            if (signal?.aborted) return;

            if (invRes.ok) {
                const data = await invRes.json();
                if (Array.isArray(data)) setInvestmentTypes(data);
            }
            if (yahooRes.ok) {
                const data = await yahooRes.json();
                if (Array.isArray(data)) setYahooTypes(data);
            }
            if (actRes.ok) {
                const data = await actRes.json();
                if (Array.isArray(data)) setActivityTypes(data);
            }
            if (accRes.ok) {
                const data = await accRes.json();
                if (Array.isArray(data)) setAccountTypes(data);
            }
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            console.error('Failed to load master data', err);
        }
    }, []);

    const loadSyncStatus = useCallback(async (signal?: AbortSignal) => {
        try {
            const res = await fetch('/api/market-data/status', { signal, cache: 'no-store' });
            if (!res.ok || signal?.aborted) return;
            const status = (await res.json()) as MarketSyncStatusResponse;
            if (signal?.aborted || !status || typeof status !== 'object') return;
            setSyncStatus(status);
            setNowMs(Date.now());
            ensureMarketSyncConvergence({
                currentVersion: status.marketDataVersion,
                isRefreshing: status.isRefreshing,
                staleCount: status.staleSymbolCount,
                throttledUntil: status.throttler?.resetTime ?? null,
            });
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            console.error('Failed to load market sync status', err);
        }
    }, []);

    const notifyPortfolioUpdated = useCallback((reason: string) => {
        try {
            suppressSelfSyncRef.current = true;
            emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason });
        } finally {
            suppressSelfSyncRef.current = false;
        }
    }, []);

    const notifyMarketSynced = useCallback((reason: string, version?: number) => {
        try {
            suppressSelfSyncRef.current = true;
            emitLiveSyncEvent('MARKET_SYNCED', { reason, version, isRefreshing: false });
        } finally {
            suppressSelfSyncRef.current = false;
        }
    }, []);

    useLiveSync({
        enabled: role === 'ADMIN',
        events: ['MARKET_SYNCED', 'PORTFOLIO_UPDATED', 'ACTIVITIES_CHANGED', 'SYNC_STATUS_CHANGED'],
        onSync: () => {
            if (suppressSelfSyncRef.current) return;
            void loadSyncStatus();
        },
    });

    useEffect(() => {
        if (role !== 'ADMIN') return;
        const controller = new AbortController();
        void loadMasterData(controller.signal);
        void loadSyncStatus(controller.signal);
        return () => controller.abort();
    }, [role, loadMasterData, loadSyncStatus]);

    useEffect(() => {
        if (role !== 'ADMIN') return;
        const id = window.setInterval(() => {
            setNowMs(Date.now());
        }, 15_000);
        return () => window.clearInterval(id);
    }, [role]);

    const cancelEditing = () => {
        setEditingScope(null);
        setEditingId(null);
    };

    const handleAddInvestmentType = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newInvestmentType.trim()) return;
        setErrorBanner(null);
        try {
            const res = await fetch('/api/settings/investment-types', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newInvestmentType.trim(),
                    yahooInvestmentTypeId: newInvestmentTypeMapping || null
                })
            });
            if (res.ok) {
                setNewInvestmentType('');
                setNewInvestmentTypeMapping('');
                setSuccessBanner('Investment type added.');
                await loadMasterData();
                notifyPortfolioUpdated('investment-type-created');
            } else {
                const body = await res.json().catch(() => ({}));
                setErrorBanner(body.error || 'Failed to add investment type.');
            }
        } catch (error) {
            console.error('Failed to add investment type', error);
            setErrorBanner('Network error while adding investment type.');
        }
    };

    const handleUpdateInvestmentType = async () => {
        if (!editingId || !editName.trim()) return;
        setErrorBanner(null);
        try {
            const res = await fetch(`/api/settings/investment-types/${editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: editName.trim(),
                    yahooInvestmentTypeId: editYahooId || null
                })
            });
            if (res.ok) {
                cancelEditing();
                setSuccessBanner('Investment type updated.');
                await loadMasterData();
                notifyPortfolioUpdated('investment-type-updated');
            } else {
                const body = await res.json().catch(() => ({}));
                setErrorBanner(body.error || 'Failed to update investment type.');
            }
        } catch (error) {
            console.error('Failed to update investment type', error);
            setErrorBanner('Failed to update investment type.');
        }
    };

    const handleDeleteInvestmentType = async (id: string) => {
        if (!confirm('Delete this investment type?')) return;
        setErrorBanner(null);
        try {
            const res = await fetch(`/api/settings/investment-types/${id}`, { method: 'DELETE' });
            if (res.ok) {
                await loadMasterData();
                notifyPortfolioUpdated('investment-type-deleted');
            } else {
                setErrorBanner('Failed to delete investment type.');
            }
        } catch (error) {
            console.error('Failed to delete investment type', error);
            setErrorBanner('Network error while deleting investment type.');
        }
    };

    const handleAddActivityType = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newActivityType.trim()) return;
        setErrorBanner(null);
        try {
            const res = await fetch('/api/settings/activity-types', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newActivityType.trim(), behavior: newActivityBehavior })
            });
            if (res.ok) {
                setNewActivityType('');
                setSuccessBanner('Activity type added.');
                await loadMasterData();
                notifyPortfolioUpdated('activity-type-created');
            } else {
                const body = await res.json().catch(() => ({}));
                setErrorBanner(body.error || 'Failed to add activity type.');
            }
        } catch (error) {
            console.error('Failed to add activity type', error);
            setErrorBanner('Network error while adding activity type.');
        }
    };

    const handleUpdateActivityType = async () => {
        if (!editingId || !editName.trim()) return;
        setErrorBanner(null);
        try {
            const res = await fetch(`/api/settings/activity-types/${editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editName.trim(), behavior: editBehavior })
            });
            if (res.ok) {
                cancelEditing();
                setSuccessBanner('Activity type updated.');
                await loadMasterData();
                notifyPortfolioUpdated('activity-type-updated');
            } else {
                const body = await res.json().catch(() => ({}));
                setErrorBanner(body.error || 'Failed to update activity type.');
            }
        } catch (error) {
            console.error('Failed to update activity type', error);
            setErrorBanner('Failed to update activity type.');
        }
    };

    const handleDeleteActivityType = async (id: string) => {
        if (!confirm('Delete this activity type?')) return;
        setErrorBanner(null);
        try {
            const res = await fetch(`/api/settings/activity-types/${id}`, { method: 'DELETE' });
            if (res.ok) {
                await loadMasterData();
                notifyPortfolioUpdated('activity-type-deleted');
            } else {
                setErrorBanner('Failed to delete activity type.');
            }
        } catch (error) {
            console.error('Failed to delete activity type', error);
            setErrorBanner('Network error while deleting activity type.');
        }
    };

    const handleAddAccountType = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newAccountTypeName.trim()) return;
        setErrorBanner(null);
        try {
            const res = await fetch('/api/settings/account-types', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newAccountTypeName.trim(), currency: newAccountTypeCurrency })
            });
            if (res.ok) {
                setNewAccountTypeName('');
                setSuccessBanner('Account type added.');
                await loadMasterData();
                notifyPortfolioUpdated('account-type-created');
            } else {
                const body = await res.json().catch(() => ({}));
                setErrorBanner(body.error || 'Failed to add account type.');
            }
        } catch (error) {
            console.error('Failed to add account type', error);
            setErrorBanner('Network error while adding account type.');
        }
    };

    const handleUpdateAccountType = async () => {
        if (!editingId || !editName.trim()) return;
        setErrorBanner(null);
        try {
            const res = await fetch(`/api/settings/account-types/${editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editName.trim(), currency: editCurrency })
            });
            if (res.ok) {
                cancelEditing();
                setSuccessBanner('Account type updated.');
                await loadMasterData();
                notifyPortfolioUpdated('account-type-updated');
            } else {
                const body = await res.json().catch(() => ({}));
                setErrorBanner(body.error || 'Failed to update account type.');
            }
        } catch (error) {
            console.error('Failed to update account type', error);
            setErrorBanner('Failed to update account type.');
        }
    };

    const handleDeleteAccountType = async (id: string) => {
        if (!confirm('Delete this account type?')) return;
        setErrorBanner(null);
        try {
            const res = await fetch(`/api/settings/account-types/${id}`, { method: 'DELETE' });
            if (res.ok) {
                await loadMasterData();
                notifyPortfolioUpdated('account-type-deleted');
            } else {
                setErrorBanner('Failed to delete account type.');
            }
        } catch (error) {
            console.error('Failed to delete account type', error);
            setErrorBanner('Network error while deleting account type.');
        }
    };

    const triggerQuickPriceSync = async () => {
        if (isQuickSyncing || isRunning) return;
        setIsQuickSyncing(true);
        setErrorBanner(null);
        setSuccessBanner(null);

        try {
            const res = await fetch('/api/cron/market-data/incremental', { cache: 'no-store' });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(payload?.error || `HTTP ${res.status}`);
            }

            const stats = payload?.stats;
            const summaryText = stats
                ? `Quick price sync finished: ${stats.success}/${stats.total} updated${stats.failed > 0 ? `, ${stats.failed} failed` : ''}${payload.coalesced ? ' (coalesced with active run)' : ''}.`
                : 'Quick price sync completed.';

            setSuccessBanner(summaryText);
            setLogs((prev) => [...prev, `[Quick Sync] ${summaryText}`]);

            const statusRes = await fetch('/api/market-data/status', { cache: 'no-store' });
            let version: number | undefined;
            if (statusRes.ok) {
                const freshStatus = (await statusRes.json()) as MarketSyncStatusResponse;
                setSyncStatus(freshStatus);
                setNowMs(Date.now());
                version = freshStatus.marketDataVersion;
            }
            notifyMarketSynced('admin-quick-sync', version);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Quick price sync failed.';
            setErrorBanner(msg);
            setLogs((prev) => [...prev, `[Quick Sync Error] ${msg}`]);
        } finally {
            setIsQuickSyncing(false);
        }
    };

    const triggerMarketDataRefresh = async () => {
        if (isRunning || isQuickSyncing) return;
        if (!confirm('Start full background refresh of market quotes, metadata, and history?')) return;

        setIsRunning(true);
        setErrorBanner(null);
        setSuccessBanner(null);
        setLogs(['Initializing full metadata & history sync stream...']);

        try {
            const response = await fetch('/api/cron/market-data?stream=true', { cache: 'no-store' });
            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(errText || `HTTP ${response.status}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No readable stream');

            const decoder = new TextDecoder();
            let lineBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                lineBuffer += decoder.decode(value, { stream: true });
                const parts = lineBuffer.split('\n');
                lineBuffer = parts.pop() ?? '';
                const lines = parts.filter(Boolean);
                if (lines.length > 0) {
                    setLogs((prev) => [...prev, ...lines]);
                }
            }

            lineBuffer += decoder.decode();
            const trailingLines = lineBuffer.split('\n').filter(Boolean);
            if (trailingLines.length > 0) {
                setLogs((prev) => [...prev, ...trailingLines]);
            }

            const statusRes = await fetch('/api/market-data/status', { cache: 'no-store' });
            let version: number | undefined;
            if (statusRes.ok) {
                const freshStatus = (await statusRes.json()) as MarketSyncStatusResponse;
                setSyncStatus(freshStatus);
                setNowMs(Date.now());
                version = freshStatus.marketDataVersion;
            }
            setSuccessBanner('Full metadata & history sync completed.');
            notifyMarketSynced('admin-full-sync', version);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to stream refresh logs.';
            setErrorBanner(msg);
            setLogs((prev) => [...prev, `Error: ${msg}`]);
        } finally {
            setIsRunning(false);
        }
    };

    if (role !== 'ADMIN') {
        return (
            <section className={styles.card}>
                <div className={styles.emptyState}>
                    Administrator access is required to manage system master data and market data jobs.
                </div>
            </section>
        );
    }

    const accountTypeGroups = Object.entries(
        accountTypes.reduce<Record<string, AccountTypeRecord[]>>((acc, item) => {
            const curr = item.currency || 'USD';
            if (!acc[curr]) acc[curr] = [];
            acc[curr].push(item);
            return acc;
        }, {})
    );

    const isSyncBusy = isRunning || isQuickSyncing || Boolean(syncStatus?.isRefreshing);
    const isRateLimited = Boolean(syncStatus?.throttler?.isRateLimited);

    return (
        <div className={styles.stack}>
            {errorBanner && (
                <div role="alert" className={styles.errorBanner}>
                    <span>{errorBanner}</span>
                    <button
                        type="button"
                        className={styles.iconDismissBtn}
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
                        className={styles.iconDismissBtn}
                        onClick={() => setSuccessBanner(null)}
                        aria-label="Dismiss notification"
                    >
                        <MdClose size={18} aria-hidden="true" />
                    </button>
                </div>
            )}

            {/* Market Data Sync Console Card */}
            <section className={styles.card} aria-label="Market data synchronization">
                <div className={styles.cardHeader}>
                    <div className={styles.cardTitleGroup}>
                        <h2 className={styles.cardTitle}>
                            <MdSync size={20} aria-hidden="true" />
                            Data Management &amp; Market Sync
                        </h2>
                        <p className={styles.cardSubheading}>
                            Monitor market-hours freshness, throttler health, and run quick or full synchronization jobs.
                        </p>
                    </div>
                    <div className={styles.pillGroup}>
                        {syncStatus && (
                            <span className={`${styles.statusPill} ${styles.statusNeutral}`}>
                                v{syncStatus.marketDataVersion}
                            </span>
                        )}
                        <span
                            className={`${styles.statusPill} ${
                                isSyncBusy
                                    ? styles.statusWarning
                                    : isRateLimited
                                        ? styles.statusNegative
                                        : styles.statusPositive
                            }`}
                        >
                            {isRunning
                                ? 'Full Sync Running...'
                                : isQuickSyncing || syncStatus?.isRefreshing
                                    ? 'Syncing Quotes...'
                                    : isRateLimited
                                        ? 'Rate Limited'
                                        : 'Idle'}
                        </span>
                    </div>
                </div>

                {syncStatus && (
                    <div className={styles.diagGrid}>
                        <div className={styles.diagTile}>
                            <span className={styles.diagLabel}>Market Session</span>
                            <div className={styles.diagValueRow}>
                                <span className={styles.diagValue}>{syncStatus.sessionLabel}</span>
                                <span
                                    className={`${styles.statusPill} ${
                                        syncStatus.isMarketOpen ? styles.statusPositive : styles.statusNeutral
                                    }`}
                                >
                                    {syncStatus.isMarketOpen ? 'Open' : 'Off-Hours'}
                                </span>
                            </div>
                            <span className={styles.diagSub}>
                                Effective TTL: {formatDurationShort(syncStatus.effectivePriceTtlMs)}
                            </span>
                        </div>

                        <div className={styles.diagTile}>
                            <span className={styles.diagLabel}>Tracked Symbols</span>
                            <div className={styles.diagValueRow}>
                                <span className={styles.diagValue}>{syncStatus.activeSymbolCount} active</span>
                                <span
                                    className={`${styles.statusPill} ${
                                        syncStatus.staleSymbolCount > 0 ? styles.statusWarning : styles.statusPositive
                                    }`}
                                >
                                    {syncStatus.staleSymbolCount} stale
                                </span>
                            </div>
                            <span className={styles.diagSub}>
                                Oldest quote: {formatRelativeTimestamp(syncStatus.oldestSyncAt, nowMs)}
                            </span>
                        </div>

                        <div className={styles.diagTile}>
                            <span className={styles.diagLabel}>Last Quick Price Sync</span>
                            <div className={styles.diagValueRow}>
                                <span className={styles.diagValue}>
                                    {formatRelativeTimestamp(syncStatus.lastIncrementalSyncAt, nowMs)}
                                </span>
                            </div>
                            <span className={styles.diagSub}>
                                {syncStatus.lastIncrementalStats
                                    ? `${syncStatus.lastIncrementalStats.success}/${syncStatus.lastIncrementalStats.total} updated${
                                          syncStatus.lastIncrementalStats.failed > 0
                                              ? ` · ${syncStatus.lastIncrementalStats.failed} failed`
                                              : ''
                                      }`
                                    : 'No incremental run recorded yet'}
                            </span>
                        </div>

                        <div className={styles.diagTile}>
                            <span className={styles.diagLabel}>Full Sync &amp; Throttler</span>
                            <div className={styles.diagValueRow}>
                                <span className={styles.diagValue}>
                                    {formatRelativeTimestamp(syncStatus.lastFullSyncAt, nowMs)}
                                </span>
                                <span
                                    className={`${styles.statusPill} ${
                                        isRateLimited ? styles.statusNegative : styles.statusPositive
                                    }`}
                                >
                                    {isRateLimited ? 'Cooldown' : 'Healthy'}
                                </span>
                            </div>
                            <span className={styles.diagSub}>
                                {isRateLimited && syncStatus.throttler?.resetTime
                                    ? `Resets ${new Date(syncStatus.throttler.resetTime).toLocaleTimeString([], {
                                          hour: '2-digit',
                                          minute: '2-digit',
                                      })}`
                                    : `Queue ${syncStatus.throttler?.queueLength ?? 0} · Active ${
                                          syncStatus.throttler?.activeCount ?? 0
                                      }`}
                            </span>
                        </div>
                    </div>
                )}

                {syncStatus?.lastSyncError && (
                    <div role="status" className={styles.errorBanner}>
                        <span>Last sync error: {syncStatus.lastSyncError}</span>
                    </div>
                )}

                <div className={styles.summaryStrip}>
                    <div className={styles.diagActions}>
                        <button
                            type="button"
                            onClick={triggerQuickPriceSync}
                            className={styles.button}
                            disabled={isQuickSyncing || isRunning}
                        >
                            <MdBolt size={18} aria-hidden="true" />
                            {isQuickSyncing ? 'Running Quick Price Sync...' : 'Run Quick Price Sync'}
                        </button>

                        <button
                            type="button"
                            onClick={triggerMarketDataRefresh}
                            className={styles.secondaryBtn}
                            disabled={isRunning || isQuickSyncing}
                        >
                            <MdPlayArrow size={18} aria-hidden="true" />
                            {isRunning ? 'Running Full Sync...' : 'Run Full Metadata & History Sync'}
                        </button>
                    </div>

                    <div className={styles.diagActions}>
                        <button
                            type="button"
                            className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                            onClick={() => void loadSyncStatus()}
                            disabled={isRunning || isQuickSyncing}
                        >
                            <MdRefresh size={16} aria-hidden="true" />
                            Refresh Status
                        </button>

                        {logs.length > 0 && (
                            <button
                                type="button"
                                className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                onClick={() => setLogs([])}
                                disabled={isRunning || isQuickSyncing}
                            >
                                Clear Console
                            </button>
                        )}
                    </div>
                </div>

                {logs.length > 0 && (
                    <div className={styles.terminalBox} role="log" aria-live="polite">
                        {logs.map((line, i) => (
                            <div key={i}>{line}</div>
                        ))}
                    </div>
                )}
            </section>

            <div className={styles.settingsGrid}>
                {/* Investment Types */}
                <section className={styles.card} aria-label="Investment types">
                    <div className={styles.cardHeader}>
                        <div className={styles.cardTitleGroup}>
                            <h2 className={styles.cardTitle}>
                                <MdCategory size={20} aria-hidden="true" />
                                Investment Types
                            </h2>
                            <p className={styles.cardSubheading}>
                                Classify holdings and map custom asset classes to Yahoo Finance types.
                            </p>
                        </div>
                        <span className={`${styles.statusPill} ${styles.statusNeutral}`}>
                            {investmentTypes.length} Types
                        </span>
                    </div>

                    <form onSubmit={handleAddInvestmentType} className={styles.form}>
                        <input
                            type="text"
                            value={newInvestmentType}
                            onChange={(e) => setNewInvestmentType(e.target.value)}
                            placeholder="New Type (e.g. ART)"
                            aria-label="New investment type"
                            className={styles.input}
                            style={{ flex: '2 1 140px' }}
                        />
                        <select
                            value={newInvestmentTypeMapping}
                            onChange={(e) => setNewInvestmentTypeMapping(e.target.value)}
                            aria-label="Map to Yahoo type"
                            className={styles.select}
                            style={{ flex: '1 1 130px' }}
                        >
                            <option value="">-- Yahoo Type --</option>
                            {yahooTypes.map((yt) => (
                                <option key={yt.id} value={yt.id}>{yt.name}</option>
                            ))}
                        </select>
                        <button type="submit" className={styles.button}>
                            <MdAdd size={18} aria-hidden="true" />
                            Add
                        </button>
                    </form>

                    <ul className={styles.list}>
                        {investmentTypes.map((type) => (
                            <li key={type.id} className={styles.item}>
                                {editingScope === 'INV' && editingId === type.id ? (
                                    <div className={styles.editForm}>
                                        <input
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            className={styles.input}
                                            style={{ flex: '2 1 130px' }}
                                        />
                                        <select
                                            value={editYahooId}
                                            onChange={(e) => setEditYahooId(e.target.value)}
                                            className={styles.select}
                                            style={{ flex: '1 1 120px' }}
                                        >
                                            <option value="">-- Yahoo Type --</option>
                                            {yahooTypes.map((yt) => (
                                                <option key={yt.id} value={yt.id}>{yt.name}</option>
                                            ))}
                                        </select>
                                        <div className={styles.editActions}>
                                            <button type="button" onClick={handleUpdateInvestmentType} className={styles.saveButton}>Save</button>
                                            <button type="button" onClick={cancelEditing} className={styles.cancelButton}>Cancel</button>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className={styles.accountInfo}>
                                            <span className={styles.accountName}>
                                                <span>{type.name}</span>
                                                {type.yahooInvestmentType && (
                                                    <span className={`${styles.statusPill} ${styles.statusInfo}`}>
                                                        Yahoo: {type.yahooInvestmentType.name}
                                                    </span>
                                                )}
                                            </span>
                                        </div>
                                        <div className={styles.itemActions}>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setEditingScope('INV');
                                                    setEditingId(type.id);
                                                    setEditName(type.name);
                                                    setEditYahooId(type.yahooInvestmentTypeId || '');
                                                }}
                                                className={styles.editButton}
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => handleDeleteInvestmentType(type.id)}
                                                className={styles.deleteButton}
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>

                {/* Activity Types */}
                <section className={styles.card} aria-label="Activity types">
                    <div className={styles.cardHeader}>
                        <div className={styles.cardTitleGroup}>
                            <h2 className={styles.cardTitle}>
                                <MdReceiptLong size={20} aria-hidden="true" />
                                Activity Types
                            </h2>
                            <p className={styles.cardSubheading}>
                                Configure ledger transaction types and share quantity behavior.
                            </p>
                        </div>
                        <span className={`${styles.statusPill} ${styles.statusNeutral}`}>
                            {activityTypes.length} Types
                        </span>
                    </div>

                    <form onSubmit={handleAddActivityType} className={styles.form}>
                        <input
                            type="text"
                            value={newActivityType}
                            onChange={(e) => setNewActivityType(e.target.value)}
                            placeholder="New Type (e.g. GIFT)"
                            aria-label="New activity type"
                            className={styles.input}
                            style={{ flex: '2 1 140px' }}
                        />
                        <select
                            value={newActivityBehavior}
                            onChange={(e) => setNewActivityBehavior(e.target.value as 'ADD' | 'REMOVE' | 'NEUTRAL')}
                            aria-label="Activity behavior"
                            className={styles.select}
                            style={{ flex: '1 1 120px' }}
                        >
                            <option value="ADD">Adds (+)</option>
                            <option value="REMOVE">Removes (-)</option>
                            <option value="NEUTRAL">Neutral</option>
                        </select>
                        <button type="submit" className={styles.button}>
                            <MdAdd size={18} aria-hidden="true" />
                            Add
                        </button>
                    </form>

                    <ul className={styles.list}>
                        {activityTypes.map((type) => (
                            <li key={type.id} className={styles.item}>
                                {editingScope === 'ACT' && editingId === type.id ? (
                                    <div className={styles.editForm}>
                                        <input
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            className={styles.input}
                                            style={{ flex: '2 1 130px' }}
                                        />
                                        <select
                                            value={editBehavior}
                                            onChange={(e) => setEditBehavior(e.target.value as 'ADD' | 'REMOVE' | 'NEUTRAL')}
                                            className={styles.select}
                                            style={{ flex: '1 1 115px' }}
                                        >
                                            <option value="ADD">Adds (+)</option>
                                            <option value="REMOVE">Removes (-)</option>
                                            <option value="NEUTRAL">Neutral</option>
                                        </select>
                                        <div className={styles.editActions}>
                                            <button type="button" onClick={handleUpdateActivityType} className={styles.saveButton}>Save</button>
                                            <button type="button" onClick={cancelEditing} className={styles.cancelButton}>Cancel</button>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <div className={styles.accountInfo}>
                                            <span className={styles.accountName}>
                                                <span>{type.name}</span>
                                                <span
                                                    className={`${styles.statusPill} ${
                                                        type.behavior === 'ADD'
                                                            ? styles.statusPositive
                                                            : type.behavior === 'REMOVE'
                                                                ? styles.statusNegative
                                                                : styles.statusNeutral
                                                    }`}
                                                >
                                                    {type.behavior === 'ADD' ? 'Adds (+)' : type.behavior === 'REMOVE' ? 'Removes (-)' : 'Neutral'}
                                                </span>
                                            </span>
                                        </div>
                                        <div className={styles.itemActions}>
                                            {type.isSystem ? (
                                                <span className={`${styles.statusPill} ${styles.statusNeutral}`}>System</span>
                                            ) : (
                                                <>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setEditingScope('ACT');
                                                            setEditingId(type.id);
                                                            setEditName(type.name);
                                                            setEditBehavior(type.behavior);
                                                        }}
                                                        className={styles.editButton}
                                                    >
                                                        Edit
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDeleteActivityType(type.id)}
                                                        className={styles.deleteButton}
                                                    >
                                                        Delete
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>

                {/* Account Types */}
                <section className={`${styles.card} ${styles.fullSpan}`} aria-label="Account types">
                    <div className={styles.cardHeader}>
                        <div className={styles.cardTitleGroup}>
                            <h2 className={styles.cardTitle}>
                                <MdAccountBalanceWallet size={20} aria-hidden="true" />
                                Account Types
                            </h2>
                            <p className={styles.cardSubheading}>
                                Regional account wrappers grouped by currency (TFSA, RRSP, Roth IRA, Brokerage, Demat).
                            </p>
                        </div>
                        <span className={`${styles.statusPill} ${styles.statusNeutral}`}>
                            {accountTypes.length} Types
                        </span>
                    </div>

                    <form onSubmit={handleAddAccountType} className={styles.form}>
                        <input
                            type="text"
                            value={newAccountTypeName}
                            onChange={(e) => setNewAccountTypeName(e.target.value)}
                            placeholder="New Type (e.g. FHSA)"
                            aria-label="New account type name"
                            className={styles.input}
                            style={{ flex: '2 1 180px' }}
                        />
                        <select
                            value={newAccountTypeCurrency}
                            onChange={(e) => setNewAccountTypeCurrency(e.target.value)}
                            aria-label="New account type currency"
                            className={styles.select}
                            style={{ flex: '1 1 100px' }}
                        >
                            {SUPPORTED_CURRENCIES.map((c) => (
                                <option key={c.code} value={c.code}>{c.code}</option>
                            ))}
                        </select>
                        <button type="submit" className={styles.button}>
                            <MdAdd size={18} aria-hidden="true" />
                            Add
                        </button>
                    </form>

                    {accountTypeGroups.length === 0 ? (
                        <div className={styles.emptyState}>No account types configured.</div>
                    ) : (
                        <div className={styles.groupedStack}>
                            {accountTypeGroups.map(([curr, groupItems]) => (
                                <div key={curr} className={styles.groupSection}>
                                    <div className={styles.groupHeader}>
                                        <span>{curr}</span>
                                        <span>{groupItems.length}</span>
                                    </div>
                                    <ul className={styles.list}>
                                        {groupItems.map((type) => (
                                            <li key={type.id} className={styles.item}>
                                                {editingScope === 'ACC' && editingId === type.id ? (
                                                    <div className={styles.editForm}>
                                                        <input
                                                            value={editName}
                                                            onChange={(e) => setEditName(e.target.value)}
                                                            className={styles.input}
                                                            style={{ flex: '2 1 150px' }}
                                                        />
                                                        <select
                                                            value={editCurrency}
                                                            onChange={(e) => setEditCurrency(e.target.value)}
                                                            className={styles.select}
                                                            style={{ flex: '1 1 95px' }}
                                                        >
                                                            {SUPPORTED_CURRENCIES.map((c) => (
                                                                <option key={c.code} value={c.code}>{c.code}</option>
                                                            ))}
                                                        </select>
                                                        <div className={styles.editActions}>
                                                            <button type="button" onClick={handleUpdateAccountType} className={styles.saveButton}>Save</button>
                                                            <button type="button" onClick={cancelEditing} className={styles.cancelButton}>Cancel</button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <div className={styles.accountInfo}>
                                                            <span className={styles.accountName}>{type.name}</span>
                                                        </div>
                                                        <div className={styles.itemActions}>
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setEditingScope('ACC');
                                                                    setEditingId(type.id);
                                                                    setEditName(type.name);
                                                                    setEditCurrency(type.currency);
                                                                }}
                                                                className={styles.editButton}
                                                            >
                                                                Edit
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => handleDeleteAccountType(type.id)}
                                                                className={styles.deleteButton}
                                                            >
                                                                Delete
                                                            </button>
                                                        </div>
                                                    </>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
