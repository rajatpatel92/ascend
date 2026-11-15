'use client';

import { useCallback, useEffect, useState } from 'react';
import styles from '../page.module.css';
import { useSession } from 'next-auth/react';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import {
    MdAccountBalanceWallet,
    MdAdd,
    MdCategory,
    MdClose,
    MdPlayArrow,
    MdReceiptLong,
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

interface SessionUser {
    role?: string;
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

    const [logs, setLogs] = useState<string[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [errorBanner, setErrorBanner] = useState<string | null>(null);
    const [successBanner, setSuccessBanner] = useState<string | null>(null);

    const { data: session } = useSession();
    const role = (session?.user as SessionUser | undefined)?.role || 'VIEWER';

    const loadMasterData = useCallback(async (signal?: AbortSignal) => {
        try {
            const [invRes, yahooRes, actRes, accRes] = await Promise.all([
                fetch('/api/settings/investment-types', { signal }),
                fetch('/api/settings/yahoo-types', { signal }),
                fetch('/api/settings/activity-types', { signal }),
                fetch('/api/settings/account-types', { signal })
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

    useEffect(() => {
        if (role !== 'ADMIN') return;
        const controller = new AbortController();
        const run = async () => {
            await loadMasterData(controller.signal);
        };
        run();
        return () => controller.abort();
    }, [role, loadMasterData]);

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
            } else {
                setErrorBanner('Failed to delete investment type.');
            }
        } catch (error) {
            console.error('Failed to delete investment type', error);
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
            } else {
                setErrorBanner('Failed to delete activity type.');
            }
        } catch (error) {
            console.error('Failed to delete activity type', error);
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
            } else {
                setErrorBanner('Failed to delete account type.');
            }
        } catch (error) {
            console.error('Failed to delete account type', error);
        }
    };

    const triggerMarketDataRefresh = async () => {
        if (isRunning) return;
        if (!confirm('Start background market data refresh?')) return;

        setIsRunning(true);
        setLogs(['Initializing market data refresh stream...']);

        try {
            const response = await fetch('/api/cron/market-data?stream=true');
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();

            if (!reader) throw new Error('No readable stream');

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                const newLines = text.split('\n').filter(Boolean);
                if (newLines.length > 0) {
                    setLogs((prev) => [...prev, ...newLines]);
                }
            }
        } catch {
            setLogs((prev) => [...prev, 'Error: Failed to stream refresh logs.']);
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
                            Manually trigger a full background refresh of market quotes, historical prices, and dividends.
                        </p>
                    </div>
                    <span className={`${styles.statusPill} ${isRunning ? styles.statusWarning : styles.statusPositive}`}>
                        {isRunning ? 'Streaming...' : 'Idle'}
                    </span>
                </div>

                <div className={styles.summaryStrip}>
                    <button
                        type="button"
                        onClick={triggerMarketDataRefresh}
                        className={styles.button}
                        disabled={isRunning}
                    >
                        <MdPlayArrow size={18} aria-hidden="true" />
                        {isRunning ? 'Refreshing Market Data...' : 'Trigger Market Data Refresh'}
                    </button>

                    {logs.length > 0 && (
                        <button
                            type="button"
                            className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                            onClick={() => setLogs([])}
                            disabled={isRunning}
                        >
                            Clear Console
                        </button>
                    )}
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
