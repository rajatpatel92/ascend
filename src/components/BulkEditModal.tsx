/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect } from 'react';
import { FaSpinner, FaTimes } from 'react-icons/fa';
import { MdEditNote } from 'react-icons/md';
import { useModalBehavior } from '@/hooks/useModalBehavior';
import styles from './ActivitiesModal.module.css';

interface BulkEditModalProps {
    count: number;
    onClose: () => void;
    onSuccess: (updatedCount?: number) => void;
    selectedIds: string[];
    uniqueSymbolsCount: number;
}

export default function BulkEditModal({
    count,
    onClose,
    onSuccess,
    selectedIds,
    uniqueSymbolsCount
}: BulkEditModalProps) {
    const [loading, setLoading] = useState(false);
    const [loadingMeta, setLoadingMeta] = useState(true);
    const [confirmStep, setConfirmStep] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [accounts, setAccounts] = useState<any[]>([]);
    const [platforms, setPlatforms] = useState<any[]>([]);
    const [users, setUsers] = useState<any[]>([]);
    const [types, setTypes] = useState<any[]>([]);
    const [investmentTypes, setInvestmentTypes] = useState<any[]>([]);

    const [updates, setUpdates] = useState<{
        accountId?: string;
        platformId?: string;
        type?: string;
        investmentType?: string;
    }>({});

    const { handleOverlayPointerDown, handleOverlayPointerUp } = useModalBehavior({
        isOpen: true,
        onClose,
        disabled: loading
    });

    useEffect(() => {
        const loadData = async () => {
            try {
                const [accRes, platRes, usersRes, typesRes, invTypesRes] = await Promise.all([
                    fetch('/api/accounts'),
                    fetch('/api/platforms'),
                    fetch('/api/users'),
                    fetch('/api/settings/activity-types'),
                    fetch('/api/settings/investment-types')
                ]);

                if (accRes.ok) setAccounts(await accRes.json());
                if (platRes.ok) setPlatforms(await platRes.json());
                if (usersRes.ok) setUsers(await usersRes.json());
                if (typesRes.ok) setTypes(await typesRes.json());
                if (invTypesRes.ok) setInvestmentTypes(await invTypesRes.json());
            } catch (err) {
                console.error('Failed to load metadata', err);
                setError('Unable to load account and type options.');
            } finally {
                setLoadingMeta(false);
            }
        };
        loadData();
    }, []);

    const handleChange = (field: keyof typeof updates, value: string) => {
        setError(null);
        setConfirmStep(false);
        setUpdates((prev) => {
            const next = { ...prev };
            if (value === '') {
                delete next[field];
            } else {
                next[field] = value;
            }
            return next;
        });
    };

    const handleProceedConfirm = () => {
        if (Object.keys(updates).length === 0) {
            setError('Please select at least one field to update.');
            return;
        }
        setError(null);
        setConfirmStep(true);
    };

    const handleSubmit = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch('/api/activities/batch-update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: selectedIds, updates })
            });

            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                onSuccess(data.count ?? count);
            } else {
                setError(data.error || 'Failed to update selected activities.');
                setConfirmStep(false);
            }
        } catch (err) {
            console.error('Update failed', err);
            setError('An unexpected error occurred while updating.');
            setConfirmStep(false);
        } finally {
            setLoading(false);
        }
    };

    const selectedFieldCount = Object.keys(updates).length;

    return (
        <div
            className={styles.overlay}
            onPointerDown={handleOverlayPointerDown}
            onPointerUp={handleOverlayPointerUp}
        >
            <div
                className={`${styles.modal} ${styles.modalMd}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="bulk-edit-title"
            >
                <div className={styles.header}>
                    <div className={styles.headerTitleGroup}>
                        <span className={styles.headerIcon} aria-hidden="true">
                            <MdEditNote />
                        </span>
                        <div className={styles.headerText}>
                            <div className={styles.titleRow}>
                                <h2 id="bulk-edit-title" className={styles.title}>
                                    Bulk Update Activities
                                </h2>
                                <span className={`${styles.pill} ${styles.pillInfo}`}>
                                    {count} selected
                                </span>
                            </div>
                            <p className={styles.subtitle}>
                                Apply changes across {count} {count === 1 ? 'activity' : 'activities'} ({uniqueSymbolsCount}{' '}
                                {uniqueSymbolsCount === 1 ? 'symbol' : 'symbols'}). Blank fields stay unchanged.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className={styles.closeButton}
                        onClick={onClose}
                        disabled={loading}
                        aria-label="Close bulk update modal"
                    >
                        <FaTimes aria-hidden="true" />
                    </button>
                </div>

                <div className={styles.body}>
                    {error && (
                        <div className={styles.errorBanner} role="alert">
                            {error}
                        </div>
                    )}

                    {loadingMeta ? (
                        <div className={styles.loadingState}>
                            <FaSpinner className={styles.spinner} aria-hidden="true" />
                            <p style={{ margin: 0 }}>Loading options...</p>
                        </div>
                    ) : (
                        <>
                            <div className={styles.field}>
                                <label htmlFor="bulk-edit-account" className={styles.label}>
                                    <span>Change Account</span>
                                </label>
                                <select
                                    id="bulk-edit-account"
                                    className={styles.select}
                                    value={updates.accountId || ''}
                                    onChange={(e) => handleChange('accountId', e.target.value)}
                                >
                                    <option value="">-- No Change --</option>
                                    {accounts.map((acc) => {
                                        const user = users.find((u) => u.username === acc.name);
                                        const displayName = user?.name || acc.name;
                                        return (
                                            <option key={acc.id} value={acc.id}>
                                                {displayName} - {acc.type} ({acc.platform?.name || 'No Platform'})
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="bulk-edit-platform" className={styles.label}>
                                    <span>Change Platform</span>
                                </label>
                                <select
                                    id="bulk-edit-platform"
                                    className={styles.select}
                                    value={updates.platformId || ''}
                                    onChange={(e) => handleChange('platformId', e.target.value)}
                                >
                                    <option value="">-- No Change --</option>
                                    {platforms.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="bulk-edit-activity-type" className={styles.label}>
                                    <span>Change Activity Type</span>
                                </label>
                                <select
                                    id="bulk-edit-activity-type"
                                    className={styles.select}
                                    value={updates.type || ''}
                                    onChange={(e) => handleChange('type', e.target.value)}
                                >
                                    <option value="">-- No Change --</option>
                                    {types.map((t) => (
                                        <option key={t.id} value={t.name}>
                                            {t.name}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className={styles.field}>
                                <label htmlFor="bulk-edit-investment-type" className={styles.label}>
                                    <span>Change Investment Type</span>
                                    <span className={styles.labelMeta}>
                                        {uniqueSymbolsCount > 1
                                            ? 'Disabled for multiple symbols'
                                            : 'Updates symbol classification'}
                                    </span>
                                </label>
                                <select
                                    id="bulk-edit-investment-type"
                                    className={styles.select}
                                    value={updates.investmentType || ''}
                                    onChange={(e) => handleChange('investmentType', e.target.value)}
                                    disabled={uniqueSymbolsCount > 1}
                                >
                                    <option value="">-- No Change --</option>
                                    {investmentTypes.map((t) => (
                                        <option key={t.id} value={t.name}>
                                            {t.name}
                                        </option>
                                    ))}
                                </select>
                                {uniqueSymbolsCount === 1 && updates.investmentType && (
                                    <p className={styles.fieldHint}>
                                        Changing investment type updates the underlying security across the portfolio.
                                    </p>
                                )}
                            </div>

                            {confirmStep && (
                                <div className={styles.confirmPrompt} role="status">
                                    Ready to apply {selectedFieldCount} field update(s) to {count} selected{' '}
                                    {count === 1 ? 'activity' : 'activities'}. This cannot be undone.
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className={styles.footer}>
                    <div className={styles.footerEnd}>
                        {confirmStep ? (
                            <>
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={() => setConfirmStep(false)}
                                    disabled={loading}
                                >
                                    Back
                                </button>
                                <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={handleSubmit}
                                    disabled={loading}
                                >
                                    {loading ? (
                                        <>
                                            <FaSpinner className={styles.spinnerSm} aria-hidden="true" />
                                            Updating...
                                        </>
                                    ) : (
                                        `Confirm Update (${count})`
                                    )}
                                </button>
                            </>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    className={styles.secondaryBtn}
                                    onClick={onClose}
                                    disabled={loading}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={handleProceedConfirm}
                                    disabled={loadingMeta || selectedFieldCount === 0}
                                >
                                    Update Activities
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
