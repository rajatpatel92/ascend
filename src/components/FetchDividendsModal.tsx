/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect, useMemo } from 'react';
import { FaSpinner, FaTimes } from 'react-icons/fa';
import { MdCalendarMonth, MdVisibility, MdVisibilityOff } from 'react-icons/md';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import { useModalBehavior } from '@/hooks/useModalBehavior';
import styles from './ActivitiesModal.module.css';

type DividendStep = 'SELECTION' | 'SCANNING' | 'RESULTS';

interface FoundDividend {
    symbol: string;
    date: string;
    rate: number;
    quantity: number;
    amount: number;
    currency: string;
    accountId: string | null;
    price: number;
    isDuplicate?: boolean;
    existingMatch?: {
        date: string;
        amount: number;
    } | null;
    isHidden?: boolean;
    accountName?: string;
    accountDisplayName?: string;
    accountType?: string;
    platformName?: string;
}

interface FetchDividendsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: (addedCount: number) => void;
}

const getDivKey = (d: FoundDividend) => `${d.symbol}-${d.date}-${d.accountId || 'none'}-${d.amount}`;

export default function FetchDividendsModal({ isOpen, onClose, onSuccess }: FetchDividendsModalProps) {
    const { format } = useCurrency();
    const { formatDate } = useDate();

    const [step, setStep] = useState<DividendStep>('SELECTION');
    const [scanYear, setScanYear] = useState(new Date().getFullYear().toString());
    const [availableSymbols, setAvailableSymbols] = useState<{ symbol: string; name: string }[]>([]);
    const [loadingSymbols, setLoadingSymbols] = useState(false);
    const [symbolQuery, setSymbolQuery] = useState('');
    const [selectedScanSymbols, setSelectedScanSymbols] = useState<Set<string>>(new Set());

    const [foundDividends, setFoundDividends] = useState<FoundDividend[]>([]);
    const [selectedDividends, setSelectedDividends] = useState<Set<string>>(new Set());
    const [reinvestSelection, setReinvestSelection] = useState<Set<string>>(new Set());
    const [showDuplicates, setShowDuplicates] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const [isBulkHiding, setIsBulkHiding] = useState(false);
    const [isAdding, setIsAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isBusy = step === 'SCANNING' || isAdding;

    const { handleOverlayPointerDown, handleOverlayPointerUp } = useModalBehavior({
        isOpen,
        onClose,
        disabled: isBusy
    });

    useEffect(() => {
        if (!isOpen) return;

        setStep('SELECTION');
        setFoundDividends([]);
        setSelectedDividends(new Set());
        setReinvestSelection(new Set());
        setShowDuplicates(false);
        setShowHidden(false);
        setSymbolQuery('');
        setError(null);
        setLoadingSymbols(true);

        fetch('/api/investments')
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Failed to load symbols'))))
            .then((data) => {
                if (Array.isArray(data)) {
                    const sorted = [...data].sort((a, b) => a.symbol.localeCompare(b.symbol));
                    setAvailableSymbols(sorted);
                    setSelectedScanSymbols(new Set(sorted.map((i: { symbol: string }) => i.symbol)));
                }
            })
            .catch((err) => {
                console.error('Failed to fetch investments', err);
                setError('Unable to load portfolio symbols.');
            })
            .finally(() => setLoadingSymbols(false));
    }, [isOpen]);

    const filteredSymbols = useMemo(() => {
        const q = symbolQuery.trim().toLowerCase();
        if (!q) return availableSymbols;
        return availableSymbols.filter(
            (s) => s.symbol.toLowerCase().includes(q) || s.name?.toLowerCase().includes(q)
        );
    }, [availableSymbols, symbolQuery]);

    const displayedDividends = useMemo(() => {
        return foundDividends.filter(
            (d) => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden)
        );
    }, [foundDividends, showDuplicates, showHidden]);

    const duplicateCount = useMemo(
        () => foundDividends.filter((d) => d.isDuplicate).length,
        [foundDividends]
    );

    const hiddenCount = useMemo(
        () => foundDividends.filter((d) => d.isHidden).length,
        [foundDividends]
    );

    if (!isOpen) return null;

    const handleScanDividends = async () => {
        if (selectedScanSymbols.size === 0) return;

        setStep('SCANNING');
        setError(null);
        setFoundDividends([]);
        setReinvestSelection(new Set());
        setSelectedDividends(new Set());

        try {
            const res = await fetch('/api/dividends/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbols: Array.from(selectedScanSymbols),
                    startYear: scanYear
                })
            });

            const data = await res.json();

            if (!res.ok || !Array.isArray(data)) {
                throw new Error(data?.error || 'Failed to scan dividends');
            }

            const sorted: FoundDividend[] = [...data].sort(
                (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
            );
            setFoundDividends(sorted);

            const initialSelection = new Set<string>();
            sorted.forEach((d) => {
                if (!d.isDuplicate && !d.isHidden) {
                    initialSelection.add(getDivKey(d));
                }
            });

            setSelectedDividends(initialSelection);
            setStep('RESULTS');
        } catch (err: any) {
            console.error('Failed to scan dividends', err);
            setError(err?.message || 'Failed to scan dividends.');
            setStep('SELECTION');
        }
    };

    const handleAddDividends = async () => {
        const toAdd = foundDividends
            .filter((div) => selectedDividends.has(getDivKey(div)))
            .map((div) => ({ ...div, reinvest: reinvestSelection.has(getDivKey(div)) }));

        if (toAdd.length === 0) return;

        setIsAdding(true);
        setError(null);
        try {
            const res = await fetch('/api/dividends/batch-add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dividends: toAdd })
            });

            if (!res.ok) {
                const errJson = await res.json().catch(() => ({}));
                throw new Error(errJson.error || 'Failed to add selected dividends.');
            }

            onSuccess(toAdd.length);
            onClose();
        } catch (err: any) {
            console.error('Failed to add dividends', err);
            setError(err?.message || 'Failed to add dividends.');
        } finally {
            setIsAdding(false);
        }
    };

    const toggleDividendSelection = (key: string) => {
        setSelectedDividends((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const toggleReinvestSelection = (key: string) => {
        setReinvestSelection((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const handleToggleHide = async (d: FoundDividend) => {
        const isHidden = !!d.isHidden;
        const method = isHidden ? 'DELETE' : 'POST';

        try {
            const res = await fetch('/api/dividends/hide', {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol: d.symbol, date: d.date, amount: d.amount })
            });

            if (!res.ok) {
                throw new Error('Failed to update hidden status');
            }

            const targetKey = getDivKey(d);
            setFoundDividends((prev) =>
                prev.map((div) =>
                    getDivKey(div) === targetKey ? { ...div, isHidden: !isHidden } : div
                )
            );
            if (!isHidden) {
                setSelectedDividends((prev) => {
                    const next = new Set(prev);
                    next.delete(targetKey);
                    return next;
                });
            }
        } catch (err: any) {
            console.error('Failed to toggle hide', err);
            setError(err?.message || 'Failed to update hidden status.');
        }
    };

    const toggleAllDividends = () => {
        const selectable = displayedDividends.filter((d) => !d.isHidden);
        const keys = selectable.map(getDivKey);
        const allSelected = keys.length > 0 && keys.every((k) => selectedDividends.has(k));

        setSelectedDividends((prev) => {
            const next = new Set(prev);
            if (allSelected) {
                keys.forEach((k) => next.delete(k));
            } else {
                keys.forEach((k) => next.add(k));
            }
            return next;
        });
    };

    const toggleAllReinvest = () => {
        const selectable = displayedDividends.filter((d) => !d.isHidden);
        const keys = selectable.map(getDivKey);
        const allChecked = keys.length > 0 && keys.every((k) => reinvestSelection.has(k));

        setReinvestSelection((prev) => {
            const next = new Set(prev);
            if (allChecked) {
                keys.forEach((k) => next.delete(k));
            } else {
                keys.forEach((k) => next.add(k));
            }
            return next;
        });
    };

    const toggleAllHide = async () => {
        if (isBulkHiding || displayedDividends.length === 0) return;

        const anyVisible = displayedDividends.some((d) => !d.isHidden);
        const itemsToUpdate = displayedDividends.filter((d) => !!d.isHidden !== anyVisible);
        if (itemsToUpdate.length === 0) return;

        setIsBulkHiding(true);
        try {
            await Promise.all(itemsToUpdate.map((d) => handleToggleHide(d)));
        } finally {
            setIsBulkHiding(false);
        }
    };

    const yearOptions = Array.from(
        { length: new Date().getFullYear() - 2019 },
        (_, i) => new Date().getFullYear() - i
    );

    const selectableDisplayed = displayedDividends.filter((d) => !d.isHidden);
    const allDisplayedSelected =
        selectableDisplayed.length > 0 &&
        selectableDisplayed.every((d) => selectedDividends.has(getDivKey(d)));
    const allDisplayedReinvest =
        selectableDisplayed.length > 0 &&
        selectableDisplayed.every((d) => reinvestSelection.has(getDivKey(d)));

    return (
        <div
            className={styles.overlay}
            onPointerDown={handleOverlayPointerDown}
            onPointerUp={handleOverlayPointerUp}
        >
            <div
                className={`${styles.modal} ${step === 'RESULTS' ? styles.modalXl : styles.modalLg}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="fetch-dividends-title"
            >
                <div className={styles.header}>
                    <div className={styles.headerTitleGroup}>
                        <span className={styles.headerIcon} aria-hidden="true">
                            <MdCalendarMonth />
                        </span>
                        <div className={styles.headerText}>
                            <div className={styles.titleRow}>
                                <h2 id="fetch-dividends-title" className={styles.title}>
                                    {step === 'RESULTS' ? 'Review Found Dividends' : 'Fetch Dividends'}
                                </h2>
                                <span className={`${styles.pill} ${styles.pillInfo}`}>
                                    {step === 'SELECTION'
                                        ? `${selectedScanSymbols.size} / ${availableSymbols.length} symbols`
                                        : step === 'SCANNING'
                                            ? `Scanning ${scanYear}`
                                            : `${foundDividends.length} detected`}
                                </span>
                            </div>
                            <p className={styles.subtitle}>
                                {step === 'SELECTION'
                                    ? 'Select symbols and starting year to scan historical ex-date payouts against your holdings.'
                                    : step === 'SCANNING'
                                        ? 'Checking dividend payouts and existing portfolio entries...'
                                        : 'Verify payouts, toggle optional DRIP reinvestment, and import selected dividends.'}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className={styles.closeButton}
                        onClick={onClose}
                        disabled={isBusy}
                        aria-label="Close fetch dividends modal"
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

                    {step === 'SELECTION' && (
                        <>
                            <div className={styles.divToolbar}>
                                <div className={styles.field} style={{ minWidth: '150px' }}>
                                    <label htmlFor="div-scan-year" className={styles.label}>
                                        Scan Year
                                    </label>
                                    <select
                                        id="div-scan-year"
                                        value={scanYear}
                                        onChange={(e) => setScanYear(e.target.value)}
                                        className={styles.select}
                                    >
                                        {yearOptions.map((year) => (
                                            <option key={year} value={year}>
                                                {year}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                <div className={`${styles.field} ${styles.divSearchInput}`}>
                                    <label htmlFor="div-symbol-search" className={styles.label}>
                                        Filter Symbols
                                    </label>
                                    <input
                                        id="div-symbol-search"
                                        type="text"
                                        value={symbolQuery}
                                        onChange={(e) => setSymbolQuery(e.target.value)}
                                        placeholder="Search ticker or company name..."
                                        className={styles.input}
                                    />
                                </div>
                            </div>

                            <div className={styles.divToolbar}>
                                <span className={styles.labelMeta}>
                                    Showing {filteredSymbols.length} of {availableSymbols.length} portfolio symbols
                                </span>
                                <div className={styles.toggleGroup}>
                                    <button
                                        type="button"
                                        className={styles.ghostBtn}
                                        onClick={() =>
                                            setSelectedScanSymbols(new Set(availableSymbols.map((i) => i.symbol)))
                                        }
                                    >
                                        Select All
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.ghostBtn}
                                        onClick={() => setSelectedScanSymbols(new Set())}
                                    >
                                        Deselect All
                                    </button>
                                </div>
                            </div>

                            {loadingSymbols ? (
                                <div className={styles.loadingState}>
                                    <FaSpinner className={styles.spinner} aria-hidden="true" />
                                    <p>Loading symbols...</p>
                                </div>
                            ) : (
                                <div className={styles.symbolGrid}>
                                    {filteredSymbols.map((item) => {
                                        const isChecked = selectedScanSymbols.has(item.symbol);
                                        return (
                                            <label
                                                key={item.symbol}
                                                className={`${styles.symbolOption} ${
                                                    isChecked ? styles.symbolOptionChecked : ''
                                                }`}
                                                title={item.name || item.symbol}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={isChecked}
                                                    onChange={(e) => {
                                                        const next = new Set(selectedScanSymbols);
                                                        if (e.target.checked) next.add(item.symbol);
                                                        else next.delete(item.symbol);
                                                        setSelectedScanSymbols(next);
                                                    }}
                                                />
                                                <span className={styles.symbolCode}>{item.symbol}</span>
                                            </label>
                                        );
                                    })}
                                </div>
                            )}
                        </>
                    )}

                    {step === 'SCANNING' && (
                        <div className={styles.loadingState}>
                            <FaSpinner className={styles.spinner} aria-hidden="true" />
                            <div>
                                <h3 className={styles.title} style={{ marginBottom: '0.35rem' }}>
                                    Scanning {selectedScanSymbols.size} symbols...
                                </h3>
                                <p className={styles.subtitle}>
                                    Comparing {scanYear} dividend payouts against your account holdings on ex-dividend dates.
                                </p>
                            </div>
                        </div>
                    )}

                    {step === 'RESULTS' && (
                        <>
                            <div className={styles.divToolbar}>
                                <div className={styles.toggleGroup}>
                                    <button
                                        type="button"
                                        onClick={() => setShowDuplicates((prev) => !prev)}
                                        className={`${styles.filterChipBtn} ${
                                            showDuplicates ? styles.filterChipActive : ''
                                        }`}
                                    >
                                        Already Added ({duplicateCount})
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setShowHidden((prev) => !prev)}
                                        className={`${styles.filterChipBtn} ${
                                            showHidden ? styles.filterChipActive : ''
                                        }`}
                                    >
                                        Hidden ({hiddenCount})
                                    </button>
                                </div>

                                <div className={styles.toggleGroup}>
                                    <span className={`${styles.pill} ${styles.pillPositive}`}>
                                        {selectedDividends.size} selected to add
                                    </span>
                                </div>
                            </div>

                            {displayedDividends.length === 0 ? (
                                <div className={styles.loadingState}>
                                    <p style={{ margin: 0, fontWeight: 600, color: 'var(--text-primary)' }}>
                                        No visible dividends match your current view.
                                    </p>
                                    <p className={styles.subtitle}>
                                        {duplicateCount > 0 && !showDuplicates
                                            ? `${duplicateCount} already-added dividend(s) hidden. `
                                            : ''}
                                        {hiddenCount > 0 && !showHidden
                                            ? `${hiddenCount} manually hidden dividend(s).`
                                            : ''}
                                        {foundDividends.length === 0 &&
                                            `No dividends were recorded in ${scanYear} for the selected holdings.`}
                                    </p>
                                </div>
                            ) : (
                                <>
                                    {/* Desktop Table */}
                                    <div className={styles.tableWrap}>
                                        <table className={styles.modalTable}>
                                            <thead>
                                                <tr>
                                                    <th>
                                                        <input
                                                            type="checkbox"
                                                            aria-label="Select all visible dividends"
                                                            onChange={toggleAllDividends}
                                                            checked={allDisplayedSelected}
                                                        />
                                                    </th>
                                                    <th>Date</th>
                                                    <th>Symbol</th>
                                                    <th style={{ textAlign: 'right' }}>Amount</th>
                                                    <th>Existing Match</th>
                                                    <th>
                                                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                                                            <input
                                                                type="checkbox"
                                                                aria-label="Toggle reinvest for all visible dividends"
                                                                onChange={toggleAllReinvest}
                                                                checked={allDisplayedReinvest}
                                                            />
                                                            <span>Reinvest</span>
                                                        </label>
                                                    </th>
                                                    <th>Status</th>
                                                    <th>Account</th>
                                                    <th style={{ textAlign: 'right' }}>
                                                        <button
                                                            type="button"
                                                            onClick={toggleAllHide}
                                                            disabled={isBulkHiding}
                                                            className={styles.ghostBtn}
                                                        >
                                                            {displayedDividends.some((d) => !d.isHidden)
                                                                ? 'Hide All'
                                                                : 'Unhide All'}
                                                        </button>
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {displayedDividends.map((div) => {
                                                    const key = getDivKey(div);
                                                    const isHidden = !!div.isHidden;
                                                    return (
                                                        <tr
                                                            key={key}
                                                            className={`${div.isDuplicate ? styles.rowDuplicate : ''} ${
                                                                isHidden ? styles.rowHidden : ''
                                                            }`}
                                                        >
                                                            <td>
                                                                <input
                                                                    type="checkbox"
                                                                    aria-label={`Select ${div.symbol} dividend on ${formatDate(div.date)}`}
                                                                    checked={selectedDividends.has(key)}
                                                                    onChange={() => toggleDividendSelection(key)}
                                                                    disabled={isHidden}
                                                                />
                                                            </td>
                                                            <td>{formatDate(div.date)}</td>
                                                            <td style={{ fontWeight: 700 }}>{div.symbol}</td>
                                                            <td style={{ textAlign: 'right', fontWeight: 600 }}>
                                                                {format(div.amount)} {div.currency}
                                                            </td>
                                                            <td>
                                                                {div.existingMatch ? (
                                                                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                                                        <div>{formatDate(div.existingMatch.date)}</div>
                                                                        <div>~ {format(div.existingMatch.amount)}</div>
                                                                    </div>
                                                                ) : (
                                                                    '—'
                                                                )}
                                                            </td>
                                                            <td>
                                                                <input
                                                                    type="checkbox"
                                                                    aria-label={`Reinvest ${div.symbol} dividend`}
                                                                    checked={reinvestSelection.has(key)}
                                                                    onChange={() => toggleReinvestSelection(key)}
                                                                    disabled={isHidden}
                                                                />
                                                            </td>
                                                            <td>
                                                                {isHidden ? (
                                                                    <span className={`${styles.pill} ${styles.pillNeutral}`}>
                                                                        Hidden
                                                                    </span>
                                                                ) : div.isDuplicate ? (
                                                                    <span className={`${styles.pill} ${styles.pillWarning}`}>
                                                                        Match Found
                                                                    </span>
                                                                ) : (
                                                                    <span className={`${styles.pill} ${styles.pillPositive}`}>
                                                                        New
                                                                    </span>
                                                                )}
                                                            </td>
                                                            <td>
                                                                <div style={{ fontWeight: 600 }}>
                                                                    {div.accountDisplayName || div.accountName || 'Unassigned'}
                                                                    {div.accountType ? ` - ${div.accountType}` : ''}
                                                                </div>
                                                                <div className={styles.labelMeta}>
                                                                    {div.platformName || '—'}
                                                                </div>
                                                            </td>
                                                            <td style={{ textAlign: 'right' }}>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleToggleHide(div)}
                                                                    className={styles.iconActionBtn}
                                                                    title={isHidden ? 'Unhide dividend' : 'Hide dividend'}
                                                                    aria-label={isHidden ? `Unhide ${div.symbol} dividend` : `Hide ${div.symbol} dividend`}
                                                                >
                                                                    {isHidden ? (
                                                                        <MdVisibility size={18} aria-hidden="true" />
                                                                    ) : (
                                                                        <MdVisibilityOff size={18} aria-hidden="true" />
                                                                    )}
                                                                </button>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>

                                    {/* Mobile Cards */}
                                    <div className={styles.mobileCards}>
                                        <div className={styles.divToolbar}>
                                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.8125rem', fontWeight: 600 }}>
                                                <input
                                                    type="checkbox"
                                                    checked={allDisplayedSelected}
                                                    onChange={toggleAllDividends}
                                                />
                                                <span>Select all</span>
                                            </label>
                                            <div className={styles.toggleGroup}>
                                                <button type="button" className={styles.ghostBtn} onClick={toggleAllReinvest}>
                                                    {allDisplayedReinvest ? 'Uncheck DRIP' : 'DRIP All'}
                                                </button>
                                                <button
                                                    type="button"
                                                    className={styles.ghostBtn}
                                                    onClick={toggleAllHide}
                                                    disabled={isBulkHiding}
                                                >
                                                    {displayedDividends.some((d) => !d.isHidden) ? 'Hide All' : 'Unhide All'}
                                                </button>
                                            </div>
                                        </div>

                                        {displayedDividends.map((div) => {
                                            const key = getDivKey(div);
                                            const isHidden = !!div.isHidden;
                                            return (
                                                <div
                                                    key={key}
                                                    className={`${styles.mobileDivCard} ${isHidden ? styles.rowHidden : ''}`}
                                                >
                                                    <div className={styles.mobileDivTop}>
                                                        <div className={styles.mobileDivTitleGroup}>
                                                            <input
                                                                type="checkbox"
                                                                checked={selectedDividends.has(key)}
                                                                onChange={() => toggleDividendSelection(key)}
                                                                disabled={isHidden}
                                                            />
                                                            <div>
                                                                <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{div.symbol}</div>
                                                                <div className={styles.labelMeta}>{formatDate(div.date)}</div>
                                                            </div>
                                                        </div>
                                                        {isHidden ? (
                                                            <span className={`${styles.pill} ${styles.pillNeutral}`}>Hidden</span>
                                                        ) : div.isDuplicate ? (
                                                            <span className={`${styles.pill} ${styles.pillWarning}`}>Match Found</span>
                                                        ) : (
                                                            <span className={`${styles.pill} ${styles.pillPositive}`}>New</span>
                                                        )}
                                                    </div>

                                                    <div className={styles.mobileDivMeta}>
                                                        <div>
                                                            <div className={styles.labelMeta}>Amount</div>
                                                            <div style={{ fontWeight: 700 }}>
                                                                {format(div.amount)} {div.currency}
                                                            </div>
                                                        </div>
                                                        <div>
                                                            <div className={styles.labelMeta}>Account</div>
                                                            <div style={{ fontWeight: 600 }}>
                                                                {div.accountDisplayName || div.accountName || 'Unassigned'}
                                                                {div.accountType ? ` · ${div.accountType}` : ''}
                                                            </div>
                                                        </div>
                                                        {div.existingMatch && (
                                                            <div>
                                                                <div className={styles.labelMeta}>Existing Match</div>
                                                                <div>
                                                                    {formatDate(div.existingMatch.date)} (~{format(div.existingMatch.amount)})
                                                                </div>
                                                            </div>
                                                        )}
                                                        <div>
                                                            <div className={styles.labelMeta}>Platform</div>
                                                            <div>{div.platformName || '—'}</div>
                                                        </div>
                                                    </div>

                                                    <div className={styles.mobileDivBottom}>
                                                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.8125rem', fontWeight: 600 }}>
                                                            <input
                                                                type="checkbox"
                                                                checked={reinvestSelection.has(key)}
                                                                onChange={() => toggleReinvestSelection(key)}
                                                                disabled={isHidden}
                                                            />
                                                            <span>Reinvest (DRIP)</span>
                                                        </label>

                                                        <button
                                                            type="button"
                                                            onClick={() => handleToggleHide(div)}
                                                            className={styles.iconActionBtn}
                                                            aria-label={isHidden ? 'Unhide dividend' : 'Hide dividend'}
                                                        >
                                                            {isHidden ? (
                                                                <MdVisibility size={18} aria-hidden="true" />
                                                            ) : (
                                                                <MdVisibilityOff size={18} aria-hidden="true" />
                                                            )}
                                                        </button>
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

                {step !== 'SCANNING' && (
                    <div className={styles.footer}>
                        {step === 'RESULTS' && (
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => setStep('SELECTION')}
                                disabled={isAdding}
                            >
                                Back
                            </button>
                        )}
                        <div className={styles.footerEnd}>
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={onClose}
                                disabled={isAdding}
                            >
                                Cancel
                            </button>
                            {step === 'SELECTION' ? (
                                <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={handleScanDividends}
                                    disabled={selectedScanSymbols.size === 0 || loadingSymbols}
                                >
                                    Scan for Dividends
                                </button>
                            ) : (
                                foundDividends.length > 0 && (
                                    <button
                                        type="button"
                                        className={styles.primaryBtn}
                                        onClick={handleAddDividends}
                                        disabled={selectedDividends.size === 0 || isAdding}
                                    >
                                        {isAdding ? (
                                            <>
                                                <FaSpinner className={styles.spinnerSm} aria-hidden="true" />
                                                Adding...
                                            </>
                                        ) : (
                                            `Add Selected (${selectedDividends.size})`
                                        )}
                                    </button>
                                )
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
