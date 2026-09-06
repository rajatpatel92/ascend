import { useState, useEffect } from 'react';
import { FaExchangeAlt, FaTimes, FaSpinner } from 'react-icons/fa';
import styles from './BulkUploadModal.module.css'; // Reusing styles

interface TransferAccountsModalProps {
    onClose: () => void;
    onSuccess: () => void;
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

export default function TransferAccountsModal({ onClose, onSuccess }: TransferAccountsModalProps) {
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [sourceAccountId, setSourceAccountId] = useState('');
    const [destinationAccountId, setDestinationAccountId] = useState('');
    const [deactivateSourceAccount, setDeactivateSourceAccount] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetch('/api/accounts')
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data)) setAccounts(data);
            })
            .catch(err => console.error('Failed to fetch accounts:', err));
    }, []);

    const handleTransfer = async () => {
        if (!sourceAccountId || !destinationAccountId) {
            setError('Please select both source and destination accounts.');
            return;
        }

        if (sourceAccountId === destinationAccountId) {
            setError('Source and Destination accounts cannot be the same.');
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

            onSuccess();
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
        <div className={styles.overlay}>
            <div className={styles.modal}>
                <button className={styles.closeButton} onClick={onClose} aria-label="Close">
                    <FaTimes />
                </button>

                <h2 className={styles.title}>
                    <FaExchangeAlt style={{ marginRight: '0.5rem', verticalAlign: 'middle', color: 'var(--primary)' }} />
                    Transfer Accounts
                </h2>
                <p style={{ marginBottom: '1.5rem', color: 'var(--text-secondary)' }}>Transfer all holdings from one account to another.</p>

                <div className={styles.stepContent}>
                    {error && (
                        <div className={styles.error}>
                            <p>{error}</p>
                        </div>
                    )}

                    <div>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600, color: 'var(--text-primary)' }}>Source Account</label>
                        <select
                            value={sourceAccountId}
                            onChange={(e) => setSourceAccountId(e.target.value)}
                            style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--card-border)', background: 'var(--card-bg)', color: 'var(--text-primary)' }}
                        >
                            <option value="">Select Source Account</option>
                            {accounts.map(acc => (
                                <option key={acc.id} value={acc.id}>{acc.name} - {acc.type} - {acc.platform?.name || 'Unknown'}</option>
                            ))}
                        </select>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>All positive holdings will be transferred out of this account.</p>
                    </div>

                    <div>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600, color: 'var(--text-primary)' }}>Destination Account</label>
                        <select
                            value={destinationAccountId}
                            onChange={(e) => setDestinationAccountId(e.target.value)}
                            style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--card-border)', background: 'var(--card-bg)', color: 'var(--text-primary)' }}
                        >
                            <option value="">Select Destination Account</option>
                            {accounts.map(acc => (
                                <option key={acc.id} value={acc.id} disabled={acc.id === sourceAccountId}>{acc.name} - {acc.type} - {acc.platform?.name || 'Unknown'}</option>
                            ))}
                        </select>
                        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>The holdings will be transferred into this account and their average cost will be preserved.</p>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem' }}>
                        <input
                            type="checkbox"
                            id="deactivateSourceAccount"
                            checked={deactivateSourceAccount}
                            onChange={(e) => setDeactivateSourceAccount(e.target.checked)}
                        />
                        <label htmlFor="deactivateSourceAccount" style={{ fontSize: '0.9rem', userSelect: 'none', color: 'var(--text-primary)', fontWeight: 500 }}>
                            Deactivate source account after transfer
                        </label>
                    </div>

                    <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
                        <button className={styles.secondaryButton} onClick={onClose} disabled={loading}>Cancel</button>
                        <button className={styles.primaryButton} onClick={handleTransfer} disabled={loading || !sourceAccountId || !destinationAccountId || sourceAccountId === destinationAccountId}>
                            {loading ? <><FaSpinner className={styles.spinner} style={{ marginRight: '0.5rem', fontSize: '1rem' }} /> Transferring...</> : 'Transfer Accounts'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
