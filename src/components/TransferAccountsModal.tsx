'use client';

import { useState, useEffect } from 'react';
import { FaArrowDown, FaExchangeAlt, FaTimes, FaSpinner } from 'react-icons/fa';
import { useModalBehavior } from '@/hooks/useModalBehavior';
import styles from './ActivitiesModal.module.css';

interface TransferAccountsModalProps {
    onClose: () => void;
    onSuccess: (transferredCount?: number) => void;
}

interface Account {
    id: string;
    name: string;
    type: string;
    platformId: string;
    currency: string;
    platform?: {
        name: string;
    };
}

interface UserOption {
    id: string;
    username: string;
    name?: string | null;
}

export default function TransferAccountsModal({ onClose, onSuccess }: TransferAccountsModalProps) {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [users, setUsers] = useState<UserOption[]>([]);
    const [loadingAccounts, setLoadingAccounts] = useState(true);
    const [sourceAccountId, setSourceAccountId] = useState('');
    const [destinationAccountId, setDestinationAccountId] = useState('');
    const [deactivateSourceAccount, setDeactivateSourceAccount] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const { handleOverlayPointerDown, handleOverlayPointerUp } = useModalBehavior({
        isOpen: true,
        onClose,
        disabled: loading
    });

    useEffect(() => {
        Promise.allSettled([
            fetch('/api/accounts').then((res) => res.json()),
            fetch('/api/users').then((res) => res.json())
        ])
            .then(([accRes, userRes]) => {
                if (accRes.status === 'fulfilled' && Array.isArray(accRes.value)) {
                    setAccounts(accRes.value);
                }
                if (userRes.status === 'fulfilled' && Array.isArray(userRes.value)) {
                    setUsers(userRes.value);
                }
            })
            .catch((err) => console.error('Failed to fetch accounts:', err))
            .finally(() => setLoadingAccounts(false));
    }, []);

    const formatAccountLabel = (acc: Account) => {
        const user = users.find((u) => u.username === acc.name);
        const ownerName = user?.name?.trim() || acc.name;
        const platformName = acc.platform?.name || 'Unknown Platform';
        return `${ownerName} - ${acc.type} - ${platformName} (${acc.currency})`;
    };

    const handleTransfer = async () => {
        if (!sourceAccountId || !destinationAccountId) {
            setError('Please select both source and destination accounts.');
            return;
        }

        if (sourceAccountId === destinationAccountId) {
            setError('Source and destination accounts cannot be the same.');
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const res = await fetch('/api/accounts/transfer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceAccountId, destinationAccountId, deactivateSourceAccount })
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Failed to transfer accounts.');
            }

            onSuccess(data.transferredHoldingsCount);
        } catch (err: unknown) {
            if (err instanceof Error) {
                setError(err.message);
            } else {
                setError('An unexpected error occurred.');
            }
            setLoading(false);
        }
    };

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
                aria-labelledby="transfer-accounts-title"
            >
                <div className={styles.header}>
                    <div className={styles.headerTitleGroup}>
                        <span className={styles.headerIcon} aria-hidden="true">
                            <FaExchangeAlt />
                        </span>
                        <div className={styles.headerText}>
                            <h2 id="transfer-accounts-title" className={styles.title}>
                                Transfer Accounts
                            </h2>
                            <p className={styles.subtitle}>
                                Move all positive holdings from one account to another while preserving average cost basis.
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className={styles.closeButton}
                        onClick={onClose}
                        disabled={loading}
                        aria-label="Close transfer accounts modal"
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

                    {loadingAccounts ? (
                        <div className={styles.loadingState}>
                            <FaSpinner className={styles.spinner} aria-hidden="true" />
                            <p style={{ margin: 0 }}>Loading accounts...</p>
                        </div>
                    ) : (
                        <>
                            <div className={styles.accountBlock}>
                                <div className={styles.field}>
                                    <label htmlFor="transfer-source-account" className={styles.label}>
                                        <span>Source Account</span>
                                        <span className={styles.labelMeta}>From</span>
                                    </label>
                                    <select
                                        id="transfer-source-account"
                                        className={styles.select}
                                        value={sourceAccountId}
                                        onChange={(e) => {
                                            setSourceAccountId(e.target.value);
                                            setError(null);
                                        }}
                                    >
                                        <option value="">Select Source Account</option>
                                        {accounts.map((acc) => (
                                            <option key={acc.id} value={acc.id}>
                                                {formatAccountLabel(acc)}
                                            </option>
                                        ))}
                                    </select>
                                    <p className={styles.fieldHint}>
                                        Generates matching TRANSFER_OUT entries for all positive holdings.
                                    </p>
                                </div>
                            </div>

                            <div className={styles.transferArrow} aria-hidden="true">
                                <FaArrowDown />
                            </div>

                            <div className={styles.accountBlock}>
                                <div className={styles.field}>
                                    <label htmlFor="transfer-dest-account" className={styles.label}>
                                        <span>Destination Account</span>
                                        <span className={styles.labelMeta}>To</span>
                                    </label>
                                    <select
                                        id="transfer-dest-account"
                                        className={styles.select}
                                        value={destinationAccountId}
                                        onChange={(e) => {
                                            setDestinationAccountId(e.target.value);
                                            setError(null);
                                        }}
                                    >
                                        <option value="">Select Destination Account</option>
                                        {accounts.map((acc) => (
                                            <option
                                                key={acc.id}
                                                value={acc.id}
                                                disabled={acc.id === sourceAccountId}
                                            >
                                                {formatAccountLabel(acc)}
                                            </option>
                                        ))}
                                    </select>
                                    <p className={styles.fieldHint}>
                                        Generates matching TRANSFER_IN entries preserving average cost per share.
                                    </p>
                                </div>
                            </div>

                            <label className={styles.checkboxCard} htmlFor="deactivateSourceAccount">
                                <input
                                    type="checkbox"
                                    id="deactivateSourceAccount"
                                    checked={deactivateSourceAccount}
                                    onChange={(e) => setDeactivateSourceAccount(e.target.checked)}
                                />
                                <div>
                                    <div className={styles.checkboxTitle}>
                                        Deactivate source account after transfer
                                    </div>
                                    <div className={styles.checkboxDesc}>
                                        Hides the old account from new activity dropdowns while preserving history.
                                    </div>
                                </div>
                            </label>
                        </>
                    )}
                </div>

                <div className={styles.footer}>
                    <div className={styles.footerEnd}>
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
                            onClick={handleTransfer}
                            disabled={
                                loadingAccounts ||
                                loading ||
                                !sourceAccountId ||
                                !destinationAccountId ||
                                sourceAccountId === destinationAccountId
                            }
                        >
                            {loading ? (
                                <>
                                    <FaSpinner className={styles.spinnerSm} aria-hidden="true" />
                                    Transferring...
                                </>
                            ) : (
                                'Transfer Holdings'
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
