'use client';

import { useEffect, useMemo, useState } from 'react';
import { FaCheckCircle, FaSpinner, FaTimes } from 'react-icons/fa';
import { MdAutorenew } from 'react-icons/md';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import { useModalBehavior } from '@/hooks/useModalBehavior';
import { ClientCache } from '@/lib/client-cache';
import { formatQuantity } from '@/lib/format';
import type { DripConfidence, DripMatchCandidate, DripScanSummary } from '@/lib/drip-migration';
import modalStyles from './ActivitiesModal.module.css';
import styles from './DripMigrationModal.module.css';

interface DripMigrationModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: (migratedCount: number) => void;
}

type ConfidenceFilter = 'ALL' | DripConfidence;

function formatInCurrency(amount: number, currencyCode: string): string {
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currencyCode || 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(amount);
    } catch {
        return `${currencyCode} ${amount.toFixed(2)}`;
    }
}

export default function DripMigrationModal({
    isOpen,
    onClose,
    onSuccess
}: DripMigrationModalProps) {
    const { convert, format } = useCurrency();
    const { formatDate } = useDate();

    const [isScanning, setIsScanning] = useState(false);
    const [isMigrating, setIsMigrating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [candidates, setCandidates] = useState<DripMatchCandidate[]>([]);
    const [summary, setSummary] = useState<DripScanSummary | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>('ALL');
    const [searchQuery, setSearchQuery] = useState('');

    const isBusy = isScanning || isMigrating;

    const { handleOverlayPointerDown, handleOverlayPointerUp } = useModalBehavior({
        isOpen,
        onClose,
        disabled: isBusy
    });

    useEffect(() => {
        if (!isOpen) return;

        let cancelled = false;
        setIsScanning(true);
        setError(null);
        setCandidates([]);
        setSummary(null);
        setSelectedIds(new Set());
        setConfidenceFilter('ALL');
        setSearchQuery('');

        fetch('/api/activities/migrate-drip')
            .then(async (res) => {
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || 'Failed to scan activities.');
                }
                return res.json();
            })
            .then((data) => {
                if (cancelled) return;
                const list: DripMatchCandidate[] = Array.isArray(data.candidates) ? data.candidates : [];
                setCandidates(list);
                setSummary(data.summary ?? null);
                // Pre-select High confidence matches; leave Medium unchecked for manual review
                setSelectedIds(
                    new Set(list.filter((c) => c.confidence === 'HIGH').map((c) => c.buyId))
                );
            })
            .catch((err) => {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : 'Unable to scan activities.');
            })
            .finally(() => {
                if (!cancelled) setIsScanning(false);
            });

        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    const filteredCandidates = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return candidates.filter((c) => {
            if (confidenceFilter !== 'ALL' && c.confidence !== confidenceFilter) {
                return false;
            }
            if (!q) return true;
            return (
                c.symbol.toLowerCase().includes(q) ||
                c.investmentName.toLowerCase().includes(q) ||
                c.accountName.toLowerCase().includes(q) ||
                c.platformName.toLowerCase().includes(q)
            );
        });
    }, [candidates, confidenceFilter, searchQuery]);

    const allVisibleSelected =
        filteredCandidates.length > 0 &&
        filteredCandidates.every((c) => selectedIds.has(c.buyId));

    const totals = useMemo(() => {
        let highTotal = 0;
        let mediumTotal = 0;
        let selectedTotal = 0;

        for (const c of candidates) {
            const converted = convert(c.buyCost, c.currency);
            if (c.confidence === 'HIGH') highTotal += converted;
            else mediumTotal += converted;
            if (selectedIds.has(c.buyId)) selectedTotal += converted;
        }

        return { highTotal, mediumTotal, selectedTotal };
    }, [candidates, convert, selectedIds]);

    const toggleOne = (buyId: string) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(buyId)) next.delete(buyId);
            else next.add(buyId);
            return next;
        });
    };

    const toggleAllVisible = () => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (allVisibleSelected) {
                filteredCandidates.forEach((c) => next.delete(c.buyId));
            } else {
                filteredCandidates.forEach((c) => next.add(c.buyId));
            }
            return next;
        });
    };

    const selectHighOnly = () => {
        setSelectedIds(
            new Set(candidates.filter((c) => c.confidence === 'HIGH').map((c) => c.buyId))
        );
    };

    const handleMigrate = async () => {
        if (selectedIds.size === 0) return;

        setIsMigrating(true);
        setError(null);

        try {
            const res = await fetch('/api/activities/migrate-drip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: Array.from(selectedIds) })
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || 'Failed to migrate selected activities.');
            }

            ClientCache.clearPortfolioCaches();
            onSuccess(data.updatedCount ?? selectedIds.size);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Migration failed.');
        } finally {
            setIsMigrating(false);
        }
    };

    if (!isOpen) return null;

    const highCount = summary?.highCount ?? candidates.filter((c) => c.confidence === 'HIGH').length;
    const mediumCount = summary?.mediumCount ?? candidates.filter((c) => c.confidence === 'MEDIUM').length;

    return (
        <div
            className={modalStyles.overlay}
            onPointerDown={handleOverlayPointerDown}
            onPointerUp={handleOverlayPointerUp}
        >
            <div
                className={`${modalStyles.modal} ${modalStyles.modalXl}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="drip-migration-title"
            >
                <div className={modalStyles.header}>
                    <div className={modalStyles.headerTitleGroup}>
                        <span className={`${modalStyles.headerIcon} ${styles.headerIconTeal}`} aria-hidden="true">
                            <MdAutorenew />
                        </span>
                        <div className={modalStyles.headerText}>
                            <h2 id="drip-migration-title" className={modalStyles.title}>
                                Migrate Existing DRIPs
                            </h2>
                            <p className={modalStyles.subtitle}>
                                Review historical BUY entries paired with same-account DIVIDEND payouts (±1 day &amp; exact cost matches).
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className={modalStyles.closeButton}
                        onClick={onClose}
                        disabled={isBusy}
                        aria-label="Close DRIP migration modal"
                    >
                        <FaTimes aria-hidden="true" />
                    </button>
                </div>

                <div className={modalStyles.body}>
                    {error && (
                        <div className={modalStyles.errorBanner} role="alert">
                            {error}
                        </div>
                    )}

                    {isScanning ? (
                        <div className={modalStyles.loadingState}>
                            <FaSpinner className={modalStyles.spinner} aria-hidden="true" />
                            <p style={{ margin: 0 }}>
                                Scanning {summary?.totalScannedBuys ?? 'historical'} BUY and DIVIDEND pairs...
                            </p>
                        </div>
                    ) : candidates.length === 0 ? (
                        <div className={modalStyles.loadingState}>
                            <FaCheckCircle
                                style={{ fontSize: '2.1rem', color: '#0d9488' }}
                                aria-hidden="true"
                            />
                            <p style={{ margin: 0, fontWeight: 700, color: 'var(--text-primary)' }}>
                                No Unmigrated DRIP Candidates Found
                            </p>
                            <p style={{ margin: 0, maxWidth: '460px', fontSize: '0.84375rem' }}>
                                Scanned {summary?.totalScannedBuys ?? 0} BUY activities alongside{' '}
                                {summary?.existingDripCount ?? 0} existing DRIP entries. Any remaining buys can still be converted via Bulk Edit.
                            </p>
                        </div>
                    ) : (
                        <>
                            <div className={styles.summaryStrip}>
                                <div className={styles.summaryCard}>
                                    <span className={styles.summaryLabel}>High Confidence (±1d)</span>
                                    <span className={styles.summaryValue}>{highCount}</span>
                                    <span className={styles.summarySub}>{format(totals.highTotal)} pre-selected</span>
                                </div>
                                <div className={styles.summaryCard}>
                                    <span className={styles.summaryLabel}>Medium Confidence</span>
                                    <span className={styles.summaryValue}>{mediumCount}</span>
                                    <span className={styles.summarySub}>{format(totals.mediumTotal)} for review</span>
                                </div>
                                <div className={styles.summaryCard}>
                                    <span className={styles.summaryLabel}>Existing DRIPs</span>
                                    <span className={styles.summaryValue}>{summary?.existingDripCount ?? 0}</span>
                                    <span className={styles.summarySub}>
                                        {summary?.totalScannedBuys ?? 0} total BUY rows scanned
                                    </span>
                                </div>
                            </div>

                            <div className={modalStyles.divToolbar}>
                                <input
                                    type="search"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Filter by symbol, account, or platform..."
                                    className={`${modalStyles.input} ${modalStyles.divSearchInput}`}
                                    aria-label="Filter candidate transactions"
                                />

                                <div className={modalStyles.toggleGroup}>
                                    <button
                                        type="button"
                                        className={`${modalStyles.filterChipBtn} ${
                                            confidenceFilter === 'ALL' ? modalStyles.filterChipActive : ''
                                        }`}
                                        onClick={() => setConfidenceFilter('ALL')}
                                    >
                                        All ({candidates.length})
                                    </button>
                                    <button
                                        type="button"
                                        className={`${modalStyles.filterChipBtn} ${
                                            confidenceFilter === 'HIGH' ? modalStyles.filterChipActive : ''
                                        }`}
                                        onClick={() => setConfidenceFilter('HIGH')}
                                    >
                                        High ({highCount})
                                    </button>
                                    <button
                                        type="button"
                                        className={`${modalStyles.filterChipBtn} ${
                                            confidenceFilter === 'MEDIUM' ? modalStyles.filterChipActive : ''
                                        }`}
                                        onClick={() => setConfidenceFilter('MEDIUM')}
                                    >
                                        Medium ({mediumCount})
                                    </button>
                                </div>

                                <div className={styles.quickActions}>
                                    <button
                                        type="button"
                                        className={modalStyles.ghostBtn}
                                        onClick={selectHighOnly}
                                        disabled={highCount === 0}
                                    >
                                        Select High
                                    </button>
                                    <button
                                        type="button"
                                        className={modalStyles.ghostBtn}
                                        onClick={() => setSelectedIds(new Set())}
                                        disabled={selectedIds.size === 0}
                                    >
                                        Clear
                                    </button>
                                </div>
                            </div>

                            {filteredCandidates.length === 0 ? (
                                <div className={modalStyles.infoBanner}>
                                    No candidate matches current filter criteria.
                                </div>
                            ) : (
                                <>
                                    {/* Desktop Table */}
                                    <div className={modalStyles.tableWrap}>
                                        <table className={modalStyles.modalTable}>
                                            <thead>
                                                <tr>
                                                    <th style={{ width: '40px' }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={allVisibleSelected}
                                                            onChange={toggleAllVisible}
                                                            aria-label="Select all visible candidates"
                                                        />
                                                    </th>
                                                    <th>Asset &amp; Account</th>
                                                    <th>Dividend Leg</th>
                                                    <th>Candidate BUY</th>
                                                    <th>Confidence &amp; Signals</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {filteredCandidates.map((cand) => {
                                                    const isChecked = selectedIds.has(cand.buyId);
                                                    return (
                                                        <tr key={cand.buyId}>
                                                            <td>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={isChecked}
                                                                    onChange={() => toggleOne(cand.buyId)}
                                                                    aria-label={`Select ${cand.symbol} BUY on ${formatDate(cand.buyDate)}`}
                                                                />
                                                            </td>
                                                            <td>
                                                                <div style={{ fontWeight: 700 }}>{cand.symbol}</div>
                                                                <div className={styles.rowSub}>
                                                                    {cand.accountName}
                                                                    {cand.accountType ? ` · ${cand.accountType}` : ''}
                                                                    {cand.platformName ? ` · ${cand.platformName}` : ''}
                                                                </div>
                                                            </td>
                                                            <td>
                                                                <div style={{ fontWeight: 600 }}>
                                                                    {formatInCurrency(cand.dividendAmount, cand.currency)}
                                                                </div>
                                                                <div className={styles.rowSub}>
                                                                    {formatDate(cand.dividendDate)} · {formatQuantity(cand.dividendQuantity)} sh @{' '}
                                                                    {formatInCurrency(cand.dividendRate, cand.currency)}
                                                                </div>
                                                            </td>
                                                            <td>
                                                                <div style={{ fontWeight: 700 }}>
                                                                    {formatInCurrency(cand.buyCost, cand.currency)}
                                                                </div>
                                                                <div className={styles.rowSub}>
                                                                    {formatDate(cand.buyDate)} · {formatQuantity(cand.buyQuantity)} sh @{' '}
                                                                    {formatInCurrency(cand.buyPrice, cand.currency)}
                                                                    {cand.buyFee > 0 ? ` (+${formatInCurrency(cand.buyFee, cand.currency)} fee)` : ''}
                                                                    {' · '}
                                                                    <span className={styles.diffBadge}>
                                                                        Δ {formatInCurrency(cand.amountDiff, cand.currency)}
                                                                    </span>
                                                                </div>
                                                            </td>
                                                            <td>
                                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', alignItems: 'flex-start' }}>
                                                                    <span
                                                                        className={`${modalStyles.pill} ${
                                                                            cand.confidence === 'HIGH'
                                                                                ? styles.pillHigh
                                                                                : modalStyles.pillWarning
                                                                        }`}
                                                                    >
                                                                        {cand.confidence === 'HIGH' ? 'High Confidence' : 'Medium Confidence'}
                                                                    </span>
                                                                    <div className={styles.reasonList}>
                                                                        {cand.reasons.map((reason) => (
                                                                            <span
                                                                                key={reason}
                                                                                className={`${styles.reasonChip} ${
                                                                                    reason === 'Exact Cost Match' ? styles.reasonChipExact : ''
                                                                                }`}
                                                                            >
                                                                                {reason}
                                                                            </span>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* Mobile Cards */}
                                    <div className={modalStyles.mobileCards}>
                                        {filteredCandidates.map((cand) => {
                                            const isChecked = selectedIds.has(cand.buyId);
                                            return (
                                                <div key={cand.buyId} className={modalStyles.mobileDivCard}>
                                                    <div className={modalStyles.mobileDivTop}>
                                                        <label className={modalStyles.mobileDivTitleGroup}>
                                                            <input
                                                                type="checkbox"
                                                                checked={isChecked}
                                                                onChange={() => toggleOne(cand.buyId)}
                                                            />
                                                            <div>
                                                                <div style={{ fontWeight: 700 }}>{cand.symbol}</div>
                                                                <div className={styles.rowSub}>
                                                                    {cand.accountName}
                                                                    {cand.accountType ? ` · ${cand.accountType}` : ''}
                                                                </div>
                                                            </div>
                                                        </label>
                                                        <span
                                                            className={`${modalStyles.pill} ${
                                                                cand.confidence === 'HIGH'
                                                                    ? styles.pillHigh
                                                                    : modalStyles.pillWarning
                                                            }`}
                                                        >
                                                            {cand.confidence}
                                                        </span>
                                                    </div>

                                                    <div className={modalStyles.mobileDivMeta}>
                                                        <div>
                                                            <span className={styles.summaryLabel}>Dividend</span>
                                                            <div style={{ fontWeight: 600 }}>
                                                                {formatInCurrency(cand.dividendAmount, cand.currency)}
                                                            </div>
                                                            <div className={styles.rowSub}>{formatDate(cand.dividendDate)}</div>
                                                        </div>
                                                        <div>
                                                            <span className={styles.summaryLabel}>BUY Cost</span>
                                                            <div style={{ fontWeight: 700 }}>
                                                                {formatInCurrency(cand.buyCost, cand.currency)}
                                                            </div>
                                                            <div className={styles.rowSub}>
                                                                {formatDate(cand.buyDate)} · {formatQuantity(cand.buyQuantity)} sh
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className={styles.reasonList}>
                                                        {cand.reasons.map((reason) => (
                                                            <span
                                                                key={reason}
                                                                className={`${styles.reasonChip} ${
                                                                    reason === 'Exact Cost Match' ? styles.reasonChipExact : ''
                                                                }`}
                                                            >
                                                                {reason}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </div>

                <div className={modalStyles.footer}>
                    <span className={styles.footerMeta}>
                        {selectedIds.size > 0
                            ? `${selectedIds.size} selected · ${format(totals.selectedTotal)}`
                            : 'Select candidates to convert to DRIP'}
                    </span>
                    <div className={modalStyles.footerEnd}>
                        <button
                            type="button"
                            className={modalStyles.secondaryBtn}
                            onClick={onClose}
                            disabled={isBusy}
                        >
                            Cancel
                        </button>
                        {candidates.length > 0 && (
                            <button
                                type="button"
                                className={modalStyles.primaryBtn}
                                onClick={handleMigrate}
                                disabled={isBusy || selectedIds.size === 0}
                            >
                                {isMigrating ? (
                                    <>
                                        <FaSpinner className={modalStyles.spinnerSm} aria-hidden="true" />
                                        Converting...
                                    </>
                                ) : (
                                    `Convert ${selectedIds.size} to DRIP`
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
