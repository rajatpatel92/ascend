/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect } from 'react';
import styles from '../page.module.css';
import { useSession } from 'next-auth/react';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';

interface User {
    id: string;
    username: string;
    name?: string;
}

export default function AccountsSettingsPage() {
    const [accounts, setAccounts] = useState<{ id: string, name: string, type: string, currency: string, platform: { name: string }, isActive?: boolean }[]>([]);
    const [platforms, setPlatforms] = useState<{ id: string, name: string, slug: string, currency: string }[]>([]);
    const [accountTypes, setAccountTypes] = useState<{ id: string, name: string, currency: string }[]>([]);
    const [users, setUsers] = useState<User[]>([]);

    const [newAccountName, setNewAccountName] = useState('');
    const [newAccountType, setNewAccountType] = useState('');
    const [newAccountCurrency, setNewAccountCurrency] = useState('USD');
    const [selectedPlatformId, setSelectedPlatformId] = useState('');

    const [newPlatformName, setNewPlatformName] = useState('');
    const [newPlatformCurrency, setNewPlatformCurrency] = useState('USD');

    const [editingId, setEditingId] = useState<string | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [editFormData, setEditFormData] = useState<any>({});

    const [customOptions, setCustomOptions] = useState<string[]>([]);

    const { data: session } = useSession();
    const role = (session?.user as any)?.role || 'VIEWER';

    async function fetchAccounts() {
        const res = await fetch('/api/accounts?includeInactive=true');
        const data = await res.json();
        if (Array.isArray(data)) setAccounts(data);
    }
    // ...
    // Note: I am skipping some functions to keep context short if possible, but replace_file_content needs contiguity.
    // I will target the block around state declarations.

    // Actually, I should just replace the top block to add state, and then `startEditing`.
    // Let's do state first.


    async function fetchPlatforms() {
        const res = await fetch('/api/platforms');
        const data = await res.json();
        if (Array.isArray(data)) setPlatforms(data);
    }

    async function fetchAccountTypes() {
        const res = await fetch('/api/settings/account-types');
        const data = await res.json();
        setAccountTypes(data);
    }


    async function fetchUsers() {
        try {
            const res = await fetch('/api/users');
            if (res.ok) {
                const data = await res.json();
                setUsers(data);
            }
        } catch (err) {
            console.error('Failed to fetch users', err);
        }
    }

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchAccounts();
        fetchPlatforms();
        fetchAccountTypes();
        fetchUsers();
    }, []);

    const handleAddAccount = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newAccountName || !selectedPlatformId) {
            alert('Please fill all fields');
            return;
        }

        try {
            const res = await fetch('/api/accounts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newAccountName,
                    type: newAccountType,
                    platformId: selectedPlatformId,
                    currency: newAccountCurrency
                }),
            });
            if (res.ok) {
                setNewAccountName('');
                if (accountTypes.length > 0) setNewAccountType(accountTypes[0].name);
                setSelectedPlatformId('');
                fetchAccounts();
            }
        } catch (error) {
            console.error('Failed to add account', error);
        }
    };

    const handleDeleteAccount = async (id: string) => {
        if (!confirm('Are you sure? This cannot be undone.')) return;
        try {
            const res = await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
            if (res.ok) {
                fetchAccounts();
            } else {
                const err = await res.json();
                alert(err.error || 'Failed to delete account');
            }
        } catch (error) {
            console.error('Failed to delete account', error);
        }
    };

    const handleAddPlatform = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newPlatformName) return;

        try {
            const res = await fetch('/api/platforms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newPlatformName, currency: newPlatformCurrency }),
            });
            if (res.ok) {
                setNewPlatformName('');
                fetchPlatforms();
            }
        } catch (error) {
            console.error('Failed to add platform', error);
        }
    };

    const handleDeletePlatform = async (id: string) => {
        if (!confirm('Are you sure? This cannot be undone.')) return;
        try {
            const res = await fetch(`/api/platforms/${id}`, { method: 'DELETE' });
            if (res.ok) {
                fetchPlatforms();
            } else {
                const err = await res.json();
                alert(err.error || 'Failed to delete platform');
            }
        } catch (error) {
            console.error('Failed to delete platform', error);
        }
    };

    const startEditing = (item: any) => {
        setEditingId(item.id);
        const isUser = users.some(u => u.username === item.name);
        if (!isUser) {
            setCustomOptions(prev => prev.includes(item.name) ? prev : [...prev, item.name]);
        }
        setEditFormData({ ...item });
    };

    const cancelEditing = () => {
        setEditingId(null);
        setEditFormData({});
    };

    const handleUpdateAccount = async () => {
        if (!editFormData.name) return;
        try {
            const res = await fetch(`/api/accounts/${editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: editFormData.name,
                    type: editFormData.type,
                    platformId: editFormData.platformId || editFormData.platform?.id,
                    currency: editFormData.currency,
                    isActive: editFormData.isActive
                }),
            });
            if (res.ok) {
                cancelEditing();
                fetchAccounts();
            }
        } catch (error) {
            console.error('Failed to update account', error);
        }
    };

    const handleUpdatePlatform = async () => {
        if (!editFormData.name) return;
        try {
            const res = await fetch(`/api/platforms/${editingId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: editFormData.name, currency: editFormData.currency }),
            });
            if (res.ok) {
                cancelEditing();
                fetchPlatforms();
            }
        } catch (error) {
            console.error('Failed to update platform', error);
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderGroupedList = (items: any[], renderItem: (item: any) => React.ReactNode) => {
        const grouped = items.reduce((acc, item) => {
            const curr = item.currency || 'USD';
            if (!acc[curr]) acc[curr] = [];
            acc[curr].push(item);
            return acc;
        }, {} as Record<string, any[]>);

        return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {(Object.entries(grouped) as [string, any[]][]).map(([curr, groupItems]) => (
                    <div key={curr}>
                        <h3 style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.5rem', borderBottom: '1px solid var(--card-border)', paddingBottom: '0.25rem' }}>{curr}</h3>
                        <ul className={styles.list}>
                            {groupItems.map(renderItem)}
                        </ul>
                    </div>
                ))}
            </div>
        );
    };

    if (role === 'VIEWER') {
        return <div className={styles.container}>Unauthorized</div>;
    }

    return (
        <div className={styles.grid}>
            {/* Platforms */}
            <div className={`${styles.card} ${styles.platforms}`}>
                <h2 className={styles.cardTitle}>Platforms</h2>
                <form onSubmit={handleAddPlatform} className={styles.form}>
                    <input
                        type="text"
                        value={newPlatformName}
                        onChange={(e) => setNewPlatformName(e.target.value)}
                        placeholder="New Platform Name"
                        className={styles.input}
                        style={{ flex: 2 }}
                    />
                    <select
                        value={newPlatformCurrency}
                        onChange={(e) => setNewPlatformCurrency(e.target.value)}
                        className={styles.select}
                        style={{ flex: 1 }}
                    >
                        {SUPPORTED_CURRENCIES.map(c => (
                            <option key={c.code} value={c.code}>{c.code}</option>
                        ))}
                    </select>
                    <button type="submit" className={styles.button}>Add</button>
                </form>

                {renderGroupedList(platforms, (platform) => (
                    <li key={platform.id} className={styles.item}>
                        {editingId === platform.id ? (
                            <div className={styles.editForm}>
                                <input
                                    value={editFormData.name}
                                    onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                                    className={styles.input}
                                    style={{ flex: 2 }}
                                />
                                <select
                                    value={editFormData.currency}
                                    onChange={(e) => setEditFormData({ ...editFormData, currency: e.target.value })}
                                    className={styles.select}
                                    style={{ flex: 1 }}
                                >
                                    {SUPPORTED_CURRENCIES.map(c => (
                                        <option key={c.code} value={c.code}>{c.code}</option>
                                    ))}
                                </select>
                                <div className={styles.editActions}>
                                    <button onClick={handleUpdatePlatform} className={styles.saveButton}>Save</button>
                                    <button onClick={cancelEditing} className={styles.cancelButton}>Cancel</button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <span>{platform.name}</span>
                                <div className={styles.itemActions}>
                                    <button onClick={() => startEditing(platform)} className={styles.editButton}>Edit</button>
                                    <button
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
            </div>

            <div className={`${styles.card} ${styles.accounts}`}>
                <h2 className={styles.cardTitle}>Accounts</h2>
                <form onSubmit={handleAddAccount} className={styles.form}>
                    <div style={{ flex: 2 }}>
                        <select
                            value={newAccountName}
                            onChange={(e) => {
                                if (e.target.value === 'CUSTOM_TRIGGER') {
                                    const name = prompt("Enter Custom Account Name:");
                                    if (name) {
                                        setCustomOptions(prev => [...prev, name]);
                                        setNewAccountName(name);
                                    }
                                } else {
                                    setNewAccountName(e.target.value);
                                }
                            }}
                            className={styles.select}
                            style={{ width: '100%' }}
                        >
                            <option value="">Select Account Owner</option>
                            {users.map(user => (
                                <option key={user.id} value={user.username}>{user.name || user.username}</option>
                            ))}
                            <option disabled>──────────</option>
                            {customOptions.map(name => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                            <option value="CUSTOM_TRIGGER">Custom Name...</option>
                        </select>
                    </div>
                    <select
                        value={newAccountCurrency}
                        onChange={(e) => setNewAccountCurrency(e.target.value)}
                        className={styles.select}
                        style={{ flex: 1 }}
                    >
                        {SUPPORTED_CURRENCIES.map(c => (
                            <option key={c.code} value={c.code}>{c.code}</option>
                        ))}
                    </select>
                    <select
                        value={newAccountType}
                        onChange={(e) => setNewAccountType(e.target.value)}
                        className={styles.select}
                        style={{ flex: 1 }}
                    >
                        <option value="">Account Type</option>
                        {accountTypes.filter(t => t.currency === newAccountCurrency).map(type => (
                            <option key={type.id} value={type.name}>{type.name}</option>
                        ))}
                    </select>
                    <select
                        value={selectedPlatformId}
                        onChange={(e) => setSelectedPlatformId(e.target.value)}
                        className={styles.select}
                        style={{ flex: 1 }}
                    >
                        <option value="">Platform</option>
                        {platforms.filter(p => p.currency === newAccountCurrency).map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                    <button type="submit" className={styles.button}>Add</button>
                </form>

                {renderGroupedList(accounts, (account) => (
                    <li 
                        key={account.id} 
                        className={styles.item}
                        style={account.isActive === false ? { opacity: 0.6 } : undefined}
                    >
                        {editingId === account.id ? (
                            <div className={styles.editForm}>
                                <div style={{ flex: 2 }}>
                                    <select
                                        value={editFormData.name}
                                        onChange={(e) => {
                                            if (e.target.value === 'CUSTOM_TRIGGER') {
                                                const name = prompt("Enter Custom Account Name:");
                                                if (name) {
                                                    setCustomOptions(prev => [...prev, name]);
                                                    setEditFormData({ ...editFormData, name });
                                                }
                                            } else {
                                                setEditFormData({ ...editFormData, name: e.target.value });
                                            }
                                        }}
                                        className={styles.select}
                                        style={{ width: '100%' }}
                                    >
                                        <option value="">Select Account Owner</option>
                                        {users.map(user => (
                                            <option key={user.id} value={user.username}>{user.name || user.username}</option>
                                        ))}
                                        <option disabled>──────────</option>
                                        {customOptions.map(name => (
                                            <option key={name} value={name}>{name}</option>
                                        ))}
                                        <option value="CUSTOM_TRIGGER">Custom Name...</option>
                                    </select>
                                </div>
                                <select
                                    value={editFormData.currency}
                                    onChange={(e) => setEditFormData({ ...editFormData, currency: e.target.value })}
                                    className={styles.select}
                                    style={{ flex: 1 }}
                                >
                                    {SUPPORTED_CURRENCIES.map(c => (
                                        <option key={c.code} value={c.code}>{c.code}</option>
                                    ))}
                                </select>
                                <select
                                    value={editFormData.type}
                                    onChange={(e) => setEditFormData({ ...editFormData, type: e.target.value })}
                                    className={styles.select}
                                    style={{ flex: 1 }}
                                >
                                    <option value="">Account Type</option>
                                    {accountTypes.filter(t => t.currency === editFormData.currency).map(type => (
                                        <option key={type.id} value={type.name}>{type.name}</option>
                                    ))}
                                </select>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: '80px' }}>
                                    <input
                                        type="checkbox"
                                        id={`isActive-${account.id}`}
                                        checked={editFormData.isActive !== false}
                                        onChange={(e) => setEditFormData({ ...editFormData, isActive: e.target.checked })}
                                    />
                                    <label htmlFor={`isActive-${account.id}`} style={{ fontSize: '0.8rem', userSelect: 'none', color: 'var(--text-primary)' }}>Active</label>
                                </div>
                                <div className={styles.editActions}>
                                    <button onClick={handleUpdateAccount} className={styles.saveButton}>Save</button>
                                    <button onClick={cancelEditing} className={styles.cancelButton}>Cancel</button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <div className={styles.accountInfo}>
                                    <span className={styles.accountName}>
                                        {(users.find(u => u.username === account.name)?.name || account.name)} - {account.type}
                                        {account.isActive === false && (
                                            <span style={{ 
                                                marginLeft: '0.5rem', 
                                                fontSize: '0.7rem', 
                                                backgroundColor: 'var(--text-error)', 
                                                color: '#fff', 
                                                padding: '0.15rem 0.35rem', 
                                                borderRadius: '0.25rem',
                                                fontWeight: 'bold',
                                                verticalAlign: 'middle'
                                            }}>
                                                Inactive
                                            </span>
                                        )}
                                    </span>
                                    <span className={styles.accountMeta}>{account.platform.name}</span>
                                </div>
                                <div className={styles.itemActions}>
                                    <button onClick={() => startEditing(account)} className={styles.editButton}>Edit</button>
                                    <button
                                        onClick={() => handleDeleteAccount(account.id)}
                                        className={styles.deleteButton}
                                    >
                                        Delete
                                    </button>
                                </div>
                            </>
                        )}
                    </li>
                ))}
            </div>
        </div>

    );
}
