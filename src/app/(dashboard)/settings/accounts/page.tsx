'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import styles from '../page.module.css';
import { useSession } from 'next-auth/react';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { emitLiveSyncEvent } from '@/lib/live-sync';
import { MdAccountBalance, MdAdd, MdClose, MdStorefront } from 'react-icons/md';

interface UserRecord {
    id: string;
    username: string;
    name?: string | null;
}

interface PlatformRecord {
    id: string;
    name: string;
    slug: string;
    currency: string;
}

interface AccountTypeRecord {
    id: string;
    name: string;
    currency: string;
}

interface AccountRecord {
    id: string;
    name: string;
    type: string;
    currency: string;
    platformId?: string;
    platform: { id?: string; name: string };
    isActive?: boolean;
}

interface SessionUser {
    role?: string;
}

type AccountStatusFilter = 'ALL' | 'ACTIVE' | 'INACTIVE';

export default function AccountsSettingsPage() {
    const [accounts, setAccounts] = useState<AccountRecord[]>([]);
    const [platforms, setPlatforms] = useState<PlatformRecord[]>([]);
    const [accountTypes, setAccountTypes] = useState<AccountTypeRecord[]>([]);
    const [users, setUsers] = useState<UserRecord[]>([]);

    const [newAccountName, setNewAccountName] = useState('');
    const [isCustomNewAccountName, setIsCustomNewAccountName] = useState(false);
    const [customNewAccountInput, setCustomNewAccountInput] = useState('');
    const [newAccountType, setNewAccountType] = useState('');
    const [newAccountCurrency, setNewAccountCurrency] = useState('USD');
    const [selectedPlatformId, setSelectedPlatformId] = useState('');

    const [newPlatformName, setNewPlatformName] = useState('');
    const [newPlatformCurrency, setNewPlatformCurrency] = useState('USD');

    const [editingPlatformId, setEditingPlatformId] = useState<string | null>(null);
    const [editPlatformData, setEditPlatformData] = useState<{ name: string; currency: string }>({
        name: '',
        currency: 'USD'
    });

    const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
    const [editAccountData, setEditAccountData] = useState<{
        name: string;
        type: string;
        currency: string;
        platformId: string;
        isActive: boolean;
    }>({
        name: '',
        type: '',
        currency: 'USD',
        platformId: '',
        isActive: true
    });
    const [isCustomEditAccountName, setIsCustomEditAccountName] = useState(false);

    const [customOptions, setCustomOptions] = useState<string[]>([]);
    const [statusFilter, setStatusFilter] = useState<AccountStatusFilter>('ALL');
    const [errorBanner, setErrorBanner] = useState<string | null>(null);
    const [successBanner, setSuccessBanner] = useState<string | null>(null);

    const { data: session } = useSession();
    const role = (session?.user as SessionUser | undefined)?.role || 'VIEWER';

    const loadAllData = useCallback(async (signal?: AbortSignal) => {
        try {
            const [accRes, platRes, typeRes, userRes] = await Promise.all([
                fetch('/api/accounts?includeInactive=true', { signal, cache: 'no-store' }),
                fetch('/api/platforms', { signal, cache: 'no-store' }),
                fetch('/api/settings/account-types', { signal, cache: 'no-store' }),
                fetch('/api/users', { signal, cache: 'no-store' }).catch(() => null)
            ]);

            if (signal?.aborted) return;

            if (accRes.ok) {
                const data = await accRes.json();
                if (Array.isArray(data)) setAccounts(data);
            }
            if (platRes.ok) {
                const data = await platRes.json();
                if (Array.isArray(data)) setPlatforms(data);
            }
            if (typeRes.ok) {
                const data = await typeRes.json();
                if (Array.isArray(data)) setAccountTypes(data);
            }
            if (userRes && userRes.ok) {
                const data = await userRes.json();
                if (Array.isArray(data)) setUsers(data);
            }
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            console.error('Failed to load accounts settings data', err);
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        const run = async () => {
            await loadAllData(controller.signal);
        };
        run();
        return () => controller.abort();
    }, [loadAllData]);

    const handleAddPlatform = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newPlatformName.trim()) return;
        setErrorBanner(null);
        setSuccessBanner(null);

        try {
            const res = await fetch('/api/platforms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newPlatformName.trim(), currency: newPlatformCurrency })
            });
            if (res.ok) {
                setNewPlatformName('');
                setSuccessBanner(`Platform "${newPlatformName.trim()}" added.`);
                await loadAllData();
                emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason: 'platform-created' });
            } else {
                const err = await res.json().catch(() => ({}));
                setErrorBanner(err.error || 'Failed to add platform.');
            }
        } catch (error) {
            console.error('Failed to add platform', error);
            setErrorBanner('Network error while adding platform.');
        }
    };

    const handleUpdatePlatform = async () => {
        if (!editingPlatformId || !editPlatformData.name.trim()) return;
        setErrorBanner(null);
        try {
            const res = await fetch(`/api/platforms/${editingPlatformId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: editPlatformData.name.trim(),
                    currency: editPlatformData.currency
                })
            });
            if (res.ok) {
                setEditingPlatformId(null);
                setSuccessBanner('Platform updated.');
                await loadAllData();
                emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason: 'platform-updated' });
            } else {
                const err = await res.json().catch(() => ({}));
                setErrorBanner(err.error || 'Failed to update platform.');
            }
        } catch (error) {
            console.error('Failed to update platform', error);
            setErrorBanner('Network error while updating platform.');
        }
    };

    const handleDeletePlatform = async (id: string) => {
        if (!confirm('Delete this platform? This cannot be undone.')) return;
        setErrorBanner(null);
        setSuccessBanner(null);
        try {
            const res = await fetch(`/api/platforms/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setSuccessBanner('Platform deleted.');
                await loadAllData();
                emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason: 'platform-deleted' });
            } else {
                const err = await res.json().catch(() => ({}));
                setErrorBanner(err.error || 'Failed to delete platform.');
            }
        } catch (error) {
            console.error('Failed to delete platform', error);
            setErrorBanner('Network error while deleting platform.');
        }
    };

    const handleAddAccount = async (e: React.FormEvent) => {
        e.preventDefault();
        const resolvedName = (isCustomNewAccountName ? customNewAccountInput : newAccountName).trim();
        if (!resolvedName || !selectedPlatformId) {
            setErrorBanner('Please select an account owner (or custom name) and platform.');
            return;
        }
        setErrorBanner(null);
        setSuccessBanner(null);

        try {
            const res = await fetch('/api/accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: resolvedName,
                    type: newAccountType,
                    platformId: selectedPlatformId,
                    currency: newAccountCurrency
                })
            });
            if (res.ok) {
                if (isCustomNewAccountName && !customOptions.includes(resolvedName)) {
                    setCustomOptions((prev) => [...prev, resolvedName]);
                }
                setNewAccountName('');
                setCustomNewAccountInput('');
                setIsCustomNewAccountName(false);
                setSelectedPlatformId('');
                setSuccessBanner(`Account "${resolvedName}" created.`);
                await loadAllData();
                emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason: 'account-created' });
            } else {
                const err = await res.json().catch(() => ({}));
                setErrorBanner(err.error || 'Failed to add account.');
            }
        } catch (error) {
            console.error('Failed to add account', error);
            setErrorBanner('Network error while adding account.');
        }
    };

    const startEditingAccount = (account: AccountRecord) => {
        const isUser = users.some((u) => u.username === account.name);
        if (!isUser && !customOptions.includes(account.name)) {
            setCustomOptions((prev) => [...prev, account.name]);
        }
        setEditingAccountId(account.id);
        setIsCustomEditAccountName(false);
        setEditAccountData({
            name: account.name,
            type: account.type,
            currency: account.currency,
            platformId: account.platformId || account.platform?.id || '',
            isActive: account.isActive !== false
        });
    };

    const handleUpdateAccount = async () => {
        if (!editingAccountId || !editAccountData.name.trim()) return;
        setErrorBanner(null);
        try {
            const res = await fetch(`/api/accounts/${editingAccountId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: editAccountData.name.trim(),
                    type: editAccountData.type,
                    platformId: editAccountData.platformId,
                    currency: editAccountData.currency,
                    isActive: editAccountData.isActive
                })
            });
            if (res.ok) {
                setEditingAccountId(null);
                setIsCustomEditAccountName(false);
                setSuccessBanner('Account updated.');
                await loadAllData();
                emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason: 'account-updated' });
            } else {
                const err = await res.json().catch(() => ({}));
                setErrorBanner(err.error || 'Failed to update account.');
            }
        } catch (error) {
            console.error('Failed to update account', error);
            setErrorBanner('Network error while updating account.');
        }
    };

    const handleDeleteAccount = async (id: string) => {
        if (!confirm('Delete this account? This cannot be undone.')) return;
        setErrorBanner(null);
        setSuccessBanner(null);
        try {
            const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
            if (res.ok) {
                setSuccessBanner('Account deleted.');
                await loadAllData();
                emitLiveSyncEvent('PORTFOLIO_UPDATED', { reason: 'account-deleted' });
            } else {
                const err = await res.json().catch(() => ({}));
                setErrorBanner(err.error || 'Failed to delete account.');
            }
        } catch (error) {
            console.error('Failed to delete account', error);
            setErrorBanner('Network error while deleting account.');
        }
    };

    const filteredAccounts = useMemo(() => {
        if (statusFilter === 'ACTIVE') return accounts.filter((a) => a.isActive !== false);
        if (statusFilter === 'INACTIVE') return accounts.filter((a) => a.isActive === false);
        return accounts;
    }, [accounts, statusFilter]);

    const activeAccountCount = useMemo(
        () => accounts.filter((a) => a.isActive !== false).length,
        [accounts]
    );

    const groupByCurrency = <T extends { currency?: string }>(items: T[]): Array<[string, T[]]> => {
        const map: Record<string, T[]> = {};
        for (const item of items) {
            const curr = item.currency || 'USD';
            if (!map[curr]) map[curr] = [];
            map[curr].push(item);
        }
        return Object.entries(map);
    };

    if (role === 'VIEWER') {
        return (
            <section className={styles.card}>
                <div className={styles.emptyState}>
                    Only Admin or Editor accounts can manage platforms and investment accounts.
                </div>
            </section>
        );
    }

    const platformGroups = groupByCurrency(platforms);
    const accountGroups = groupByCurrency(filteredAccounts);

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

            <div className={styles.settingsGrid}>
                {/* Platforms Card */}
                <section className={styles.card} aria-label="Brokerages and platforms">
                    <div className={styles.cardHeader}>
                        <div className={styles.cardTitleGroup}>
                            <h2 className={styles.cardTitle}>
                                <MdStorefront size={20} aria-hidden="true" />
                                Platforms &amp; Brokerages
                            </h2>
                            <p className={styles.cardSubheading}>
                                Institutions where your investment accounts are held.
                            </p>
                        </div>
                        <span className={`${styles.statusPill} ${styles.statusNeutral}`}>
                            {platforms.length} Platform{platforms.length === 1 ? '' : 's'}
                        </span>
                    </div>

                    <form onSubmit={handleAddPlatform} className={styles.form}>
                        <input
                            type="text"
                            value={newPlatformName}
                            onChange={(e) => setNewPlatformName(e.target.value)}
                            placeholder="New Platform (e.g. Wealthsimple)"
                            aria-label="New platform name"
                            className={styles.input}
                            style={{ flex: '2 1 180px' }}
                        />
                        <select
                            value={newPlatformCurrency}
                            onChange={(e) => setNewPlatformCurrency(e.target.value)}
                            aria-label="New platform currency"
                            className={styles.select}
                            style={{ flex: '1 1 95px' }}
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

                    {platformGroups.length === 0 ? (
                        <div className={styles.emptyState}>No platforms configured yet.</div>
                    ) : (
                        <div className={styles.groupedStack}>
                            {platformGroups.map(([curr, groupItems]) => (
                                <div key={curr} className={styles.groupSection}>
                                    <div className={styles.groupHeader}>
                                        <span>{curr}</span>
                                        <span>{groupItems.length}</span>
                                    </div>
                                    <ul className={styles.list}>
                                        {groupItems.map((platform) => (
                                            <li key={platform.id} className={styles.item}>
                                                {editingPlatformId === platform.id ? (
                                                    <div className={styles.editForm}>
                                                        <input
                                                            value={editPlatformData.name}
                                                            onChange={(e) => setEditPlatformData({ ...editPlatformData, name: e.target.value })}
                                                            aria-label="Edit platform name"
                                                            className={styles.input}
                                                            style={{ flex: '2 1 150px' }}
                                                        />
                                                        <select
                                                            value={editPlatformData.currency}
                                                            onChange={(e) => setEditPlatformData({ ...editPlatformData, currency: e.target.value })}
                                                            aria-label="Edit platform currency"
                                                            className={styles.select}
                                                            style={{ flex: '1 1 90px' }}
                                                        >
                                                            {SUPPORTED_CURRENCIES.map((c) => (
                                                                <option key={c.code} value={c.code}>{c.code}</option>
                                                            ))}
                                                        </select>
                                                        <div className={styles.editActions}>
                                                            <button type="button" onClick={handleUpdatePlatform} className={styles.saveButton}>Save</button>
                                                            <button type="button" onClick={() => setEditingPlatformId(null)} className={styles.cancelButton}>Cancel</button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <div className={styles.accountInfo}>
                                                            <span className={styles.accountName}>{platform.name}</span>
                                                            <span className={styles.accountMeta}>{platform.currency}</span>
                                                        </div>
                                                        <div className={styles.itemActions}>
                                                            <button
                                                                type="button"
                                                                onClick={() => {
                                                                    setEditingAccountId(null);
                                                                    setEditingPlatformId(platform.id);
                                                                    setEditPlatformData({ name: platform.name, currency: platform.currency });
                                                                }}
                                                                className={styles.editButton}
                                                            >
                                                                Edit
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={() => handleDeletePlatform(platform.id)}
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

                {/* Accounts Card */}
                <section className={styles.card} aria-label="Investment accounts">
                    <div className={styles.cardHeader}>
                        <div className={styles.cardTitleGroup}>
                            <h2 className={styles.cardTitle}>
                                <MdAccountBalance size={20} aria-hidden="true" />
                                Accounts
                            </h2>
                            <p className={styles.cardSubheading}>
                                Link account owners, tax classifications, and platforms.
                            </p>
                        </div>

                        <div className={styles.pillGroup}>
                            <span className={`${styles.statusPill} ${styles.statusPositive}`}>
                                {activeAccountCount} Active
                            </span>
                            <div className={styles.filterPillGroup} role="group" aria-label="Filter accounts by status">
                                {(
                                    [
                                        { id: 'ALL', label: `All (${accounts.length})` },
                                        { id: 'ACTIVE', label: `Active (${activeAccountCount})` },
                                        { id: 'INACTIVE', label: `Inactive (${accounts.length - activeAccountCount})` }
                                    ] as ReadonlyArray<{ id: AccountStatusFilter; label: string }>
                                ).map((tab) => (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        className={styles.filterPillBtn}
                                        aria-pressed={statusFilter === tab.id}
                                        onClick={() => setStatusFilter(tab.id)}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    <form onSubmit={handleAddAccount} className={styles.formColumnWrap}>
                        <div className={styles.field}>
                            <label htmlFor="newAccountOwner" className={styles.label}>Account Owner</label>
                            {isCustomNewAccountName ? (
                                <div className={styles.form} style={{ gap: '0.35rem' }}>
                                    <input
                                        type="text"
                                        value={customNewAccountInput}
                                        onChange={(e) => setCustomNewAccountInput(e.target.value)}
                                        placeholder="Enter account name"
                                        className={styles.input}
                                        style={{ flex: 1 }}
                                    />
                                    <button
                                        type="button"
                                        className={styles.cancelButton}
                                        onClick={() => {
                                            setIsCustomNewAccountName(false);
                                            setCustomNewAccountInput('');
                                        }}
                                    >
                                        List
                                    </button>
                                </div>
                            ) : (
                                <select
                                    id="newAccountOwner"
                                    value={newAccountName}
                                    onChange={(e) => {
                                        if (e.target.value === 'CUSTOM_TRIGGER') {
                                            setIsCustomNewAccountName(true);
                                            setNewAccountName('');
                                        } else {
                                            setNewAccountName(e.target.value);
                                        }
                                    }}
                                    className={styles.select}
                                >
                                    <option value="">Select Owner</option>
                                    {users.map((user) => (
                                        <option key={user.id} value={user.username}>
                                            {user.name || user.username}
                                        </option>
                                    ))}
                                    {customOptions.length > 0 && <option disabled>──────────</option>}
                                    {customOptions.map((name) => (
                                        <option key={name} value={name}>{name}</option>
                                    ))}
                                    <option value="CUSTOM_TRIGGER">Custom Name...</option>
                                </select>
                            )}
                        </div>

                        <div className={styles.field}>
                            <label htmlFor="newAccountCurr" className={styles.label}>Currency</label>
                            <select
                                id="newAccountCurr"
                                value={newAccountCurrency}
                                onChange={(e) => {
                                    setNewAccountCurrency(e.target.value);
                                    setNewAccountType('');
                                    setSelectedPlatformId('');
                                }}
                                className={styles.select}
                            >
                                {SUPPORTED_CURRENCIES.map((c) => (
                                    <option key={c.code} value={c.code}>{c.code}</option>
                                ))}
                            </select>
                        </div>

                        <div className={styles.field}>
                            <label htmlFor="newAccountType" className={styles.label}>Account Type</label>
                            <select
                                id="newAccountType"
                                value={newAccountType}
                                onChange={(e) => setNewAccountType(e.target.value)}
                                className={styles.select}
                            >
                                <option value="">Account Type</option>
                                {accountTypes
                                    .filter((t) => t.currency === newAccountCurrency)
                                    .map((type) => (
                                        <option key={type.id} value={type.name}>{type.name}</option>
                                    ))}
                            </select>
                        </div>

                        <div className={styles.field}>
                            <label htmlFor="newAccountPlatform" className={styles.label}>Platform</label>
                            <select
                                id="newAccountPlatform"
                                value={selectedPlatformId}
                                onChange={(e) => setSelectedPlatformId(e.target.value)}
                                className={styles.select}
                            >
                                <option value="">Platform</option>
                                {platforms
                                    .filter((p) => p.currency === newAccountCurrency)
                                    .map((p) => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                            </select>
                        </div>

                        <button type="submit" className={styles.button}>
                            <MdAdd size={18} aria-hidden="true" />
                            Add Account
                        </button>
                    </form>

                    {accountGroups.length === 0 ? (
                        <div className={styles.emptyState}>No accounts match the selected filter.</div>
                    ) : (
                        <div className={styles.groupedStack}>
                            {accountGroups.map(([curr, groupItems]) => (
                                <div key={curr} className={styles.groupSection}>
                                    <div className={styles.groupHeader}>
                                        <span>{curr}</span>
                                        <span>{groupItems.length}</span>
                                    </div>
                                    <ul className={styles.list}>
                                        {groupItems.map((account) => {
                                            const ownerDisplay = users.find((u) => u.username === account.name)?.name || account.name;
                                            return (
                                                <li
                                                    key={account.id}
                                                    className={`${styles.item} ${account.isActive === false ? styles.itemInactive : ''}`}
                                                >
                                                    {editingAccountId === account.id ? (
                                                        <div className={styles.editForm}>
                                                            {isCustomEditAccountName ? (
                                                                <input
                                                                    value={editAccountData.name}
                                                                    onChange={(e) => setEditAccountData({ ...editAccountData, name: e.target.value })}
                                                                    aria-label="Custom account name"
                                                                    className={styles.input}
                                                                    style={{ flex: '2 1 150px' }}
                                                                />
                                                            ) : (
                                                                <select
                                                                    value={editAccountData.name}
                                                                    onChange={(e) => {
                                                                        if (e.target.value === 'CUSTOM_TRIGGER') {
                                                                            setIsCustomEditAccountName(true);
                                                                        } else {
                                                                            setEditAccountData({ ...editAccountData, name: e.target.value });
                                                                        }
                                                                    }}
                                                                    aria-label="Account owner"
                                                                    className={styles.select}
                                                                    style={{ flex: '2 1 150px' }}
                                                                >
                                                                    <option value="">Select Owner</option>
                                                                    {users.map((user) => (
                                                                        <option key={user.id} value={user.username}>
                                                                            {user.name || user.username}
                                                                        </option>
                                                                    ))}
                                                                    {customOptions.length > 0 && <option disabled>──────────</option>}
                                                                    {customOptions.map((name) => (
                                                                        <option key={name} value={name}>{name}</option>
                                                                    ))}
                                                                    <option value="CUSTOM_TRIGGER">Custom Name...</option>
                                                                </select>
                                                            )}

                                                            <select
                                                                value={editAccountData.currency}
                                                                onChange={(e) => setEditAccountData({ ...editAccountData, currency: e.target.value })}
                                                                aria-label="Account currency"
                                                                className={styles.select}
                                                                style={{ flex: '1 1 85px' }}
                                                            >
                                                                {SUPPORTED_CURRENCIES.map((c) => (
                                                                    <option key={c.code} value={c.code}>{c.code}</option>
                                                                ))}
                                                            </select>

                                                            <select
                                                                value={editAccountData.type}
                                                                onChange={(e) => setEditAccountData({ ...editAccountData, type: e.target.value })}
                                                                aria-label="Account type"
                                                                className={styles.select}
                                                                style={{ flex: '1 1 115px' }}
                                                            >
                                                                <option value="">Account Type</option>
                                                                {accountTypes
                                                                    .filter((t) => t.currency === editAccountData.currency)
                                                                    .map((type) => (
                                                                        <option key={type.id} value={type.name}>{type.name}</option>
                                                                    ))}
                                                            </select>

                                                            <label className={styles.checkboxWrap}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={editAccountData.isActive}
                                                                    onChange={(e) => setEditAccountData({ ...editAccountData, isActive: e.target.checked })}
                                                                />
                                                                <span>Active</span>
                                                            </label>

                                                            <div className={styles.editActions}>
                                                                <button type="button" onClick={handleUpdateAccount} className={styles.saveButton}>Save</button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        setEditingAccountId(null);
                                                                        setIsCustomEditAccountName(false);
                                                                    }}
                                                                    className={styles.cancelButton}
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <div className={styles.accountInfo}>
                                                                <span className={styles.accountName}>
                                                                    <span>{ownerDisplay}</span>
                                                                    {account.type && (
                                                                        <span className={`${styles.statusPill} ${styles.statusInfo}`}>
                                                                            {account.type}
                                                                        </span>
                                                                    )}
                                                                    {account.isActive === false && (
                                                                        <span className={`${styles.statusPill} ${styles.statusNegative}`}>
                                                                            Inactive
                                                                        </span>
                                                                    )}
                                                                </span>
                                                                <span className={styles.accountMeta}>
                                                                    <span>{account.platform?.name || 'No Platform'}</span>
                                                                    <span>&bull;</span>
                                                                    <span>{account.currency}</span>
                                                                </span>
                                                            </div>
                                                            <div className={styles.itemActions}>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        setEditingPlatformId(null);
                                                                        startEditingAccount(account);
                                                                    }}
                                                                    className={styles.editButton}
                                                                >
                                                                    Edit
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleDeleteAccount(account.id)}
                                                                    className={styles.deleteButton}
                                                                >
                                                                    Delete
                                                                </button>
                                                            </div>
                                                        </>
                                                    )}
                                                </li>
                                            );
                                        })}
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
