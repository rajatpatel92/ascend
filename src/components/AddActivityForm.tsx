/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { FaSpinner } from 'react-icons/fa';
import styles from './AddActivityForm.module.css';
import DateInput from './DateInput';
import { filterSelectableAccounts, type SelectableAccount } from '@/lib/activity-accounts';
import { computeActivityNetAmount } from '@/lib/activities-filters';

interface SearchResult {
    symbol: string;
    name: string;
    exchange: string;
    type: string;
}

interface AddActivityFormProps {
    onSuccess?: () => void;
    initialData?: any;
    onCancel?: () => void;
    accountsRefreshKey?: number;
    inModal?: boolean;
}

interface InvestmentType {
    id: string;
    name: string;
    yahooInvestmentType?: { name: string };
}

function toLocalDateString(d: Date | string): string {
    if (!d) return '';
    if (typeof d === 'string') {
        const trimmed = d.trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
            return trimmed.split('T')[0];
        }
        const parsed = new Date(trimmed);
        if (!isNaN(parsed.getTime())) {
            const pad = (n: number) => n.toString().padStart(2, '0');
            return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
        }
        return '';
    }
    if (d instanceof Date && !isNaN(d.getTime())) {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    return '';
}

function handleNumericKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (
        !/[0-9.]/.test(e.key) &&
        !['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(e.key)
    ) {
        e.preventDefault();
    }
}

export default function AddActivityForm({
    onSuccess,
    initialData,
    onCancel,
    accountsRefreshKey,
    inModal = false
}: AddActivityFormProps) {
    const [symbol, setSymbol] = useState('');
    const [symbolName, setSymbolName] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [showResults, setShowResults] = useState(false);
    const [searching, setSearching] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const isSelectionRef = useRef(false);
    const wasEditingRef = useRef(false);
    const autocompleteRef = useRef<HTMLDivElement>(null);

    const [type, setType] = useState('BUY');
    const [date, setDate] = useState(toLocalDateString(new Date()));
    const [quantity, setQuantity] = useState('');
    const [price, setPrice] = useState('');
    const [fee, setFee] = useState('');
    const [platformId, setPlatformId] = useState('');
    const [accountId, setAccountId] = useState('');
    const [investmentType, setInvestmentType] = useState('EQUITY');
    const [symbolType, setSymbolType] = useState('');
    const [currency, setCurrency] = useState('CAD');

    const [platforms, setPlatforms] = useState<{ id: string; name: string }[]>([]);
    const [accounts, setAccounts] = useState<SelectableAccount[]>([]);
    const [investmentTypes, setInvestmentTypes] = useState<InvestmentType[]>([]);
    const [activityTypes, setActivityTypes] = useState<{ id: string; name: string }[]>([]);
    const [users, setUsers] = useState<{ id: string; username: string; name?: string }[]>([]);
    const [isInvestmentTypeLocked, setIsInvestmentTypeLocked] = useState(false);

    const fetchAccounts = useCallback(async () => {
        try {
            const res = await fetch('/api/accounts?includeInactive=true');
            const data = await res.json();
            if (Array.isArray(data)) {
                setAccounts(data);
            }
        } catch (error) {
            console.error('Failed to fetch accounts', error);
        }
    }, []);

    useEffect(() => {
        Promise.allSettled([
            fetch('/api/platforms').then((res) => res.json()),
            fetch('/api/accounts?includeInactive=true').then((res) => res.json()),
            fetch('/api/settings/investment-types').then((res) => res.json()),
            fetch('/api/settings/activity-types').then((res) => res.json()),
            fetch('/api/users').then((res) => res.json())
        ]).then((settled) => {
            const [platformsRes, accountsRes, invTypesRes, actTypesRes, usersRes] = settled;

            if (platformsRes.status === 'fulfilled' && Array.isArray(platformsRes.value)) {
                setPlatforms(platformsRes.value);
            }
            if (accountsRes.status === 'fulfilled' && Array.isArray(accountsRes.value)) {
                setAccounts(accountsRes.value);
            }
            if (invTypesRes.status === 'fulfilled' && Array.isArray(invTypesRes.value)) {
                setInvestmentTypes(invTypesRes.value);
            }
            if (actTypesRes.status === 'fulfilled' && Array.isArray(actTypesRes.value)) {
                setActivityTypes(actTypesRes.value);
            }
            if (usersRes.status === 'fulfilled' && Array.isArray(usersRes.value)) {
                setUsers(usersRes.value);
            }
        });
    }, []);

    useEffect(() => {
        if (accountsRefreshKey) {
            fetchAccounts();
        }
    }, [accountsRefreshKey, fetchAccounts]);

    useEffect(() => {
        const handleOutside = (event: MouseEvent) => {
            if (autocompleteRef.current && !autocompleteRef.current.contains(event.target as Node)) {
                setShowResults(false);
            }
        };
        document.addEventListener('mousedown', handleOutside);
        return () => document.removeEventListener('mousedown', handleOutside);
    }, []);

    useEffect(() => {
        setFormError(null);
        if (initialData) {
            wasEditingRef.current = true;
            setSymbol(initialData.investment.symbol);
            setSymbolName(initialData.investment.name);
            setSymbolType(initialData.investment.type);
            setInvestmentType(initialData.investment.type);
            setCurrency(initialData.currency || initialData.investment.currencyCode || 'CAD');

            setType(initialData.type);
            setDate(toLocalDateString(initialData.date));
            setQuantity(initialData.quantity.toString());
            setPrice(initialData.price.toString());
            setFee(initialData.fee ? initialData.fee.toString() : '');
            setIsInvestmentTypeLocked(true);

            if (initialData.account) {
                setAccountId(initialData.account.id);
                if (initialData.platform) {
                    setPlatformId(initialData.platform.id);
                } else if (initialData.account.platformId) {
                    setPlatformId(initialData.account.platformId);
                }
            } else if (initialData.platform) {
                setPlatformId(initialData.platform.id);
                setAccountId('');
            } else {
                setAccountId('');
                setPlatformId('');
            }
        } else if (wasEditingRef.current) {
            wasEditingRef.current = false;
            setSymbol('');
            setSymbolName('');
            setSymbolType('');
            setInvestmentType('EQUITY');
            setCurrency('CAD');
            setType('BUY');
            setDate(toLocalDateString(new Date()));
            setQuantity('');
            setPrice('');
            setFee('');
            setPlatformId('');
            setAccountId('');
            setIsInvestmentTypeLocked(false);
            setResults([]);
            setShowResults(false);
        }
    }, [initialData]);

    const handleSelectSymbol = async (result: SearchResult) => {
        isSelectionRef.current = true;
        setSymbol(result.symbol);
        setSymbolName(result.name);
        setSymbolType(result.type);
        setFormError(null);

        try {
            const res = await fetch(`/api/investments?symbol=${encodeURIComponent(result.symbol)}`);
            const existingInvestments = await res.json();

            if (Array.isArray(existingInvestments) && existingInvestments.length > 0) {
                const existingType = existingInvestments[0].type;
                if (existingType) {
                    setInvestmentType(existingType);
                    setIsInvestmentTypeLocked(true);
                }
            } else {
                setIsInvestmentTypeLocked(false);
                const yahooType = result.type.toUpperCase();
                const matchedType = investmentTypes.find(
                    (it) => it.yahooInvestmentType?.name === yahooType
                );

                if (matchedType) {
                    setInvestmentType(matchedType.name);
                } else if (yahooType === 'EQUITY' || yahooType === 'ETF' || yahooType === 'MUTUALFUND') {
                    const stockType = investmentTypes.find((t) => t.name === 'Stock' || t.name === 'Equity');
                    if (stockType) setInvestmentType(stockType.name);
                }
            }
        } catch (error) {
            console.error('Failed to check existing investment', error);
            setIsInvestmentTypeLocked(false);
        }

        setShowResults(false);

        try {
            const res = await fetch(`/api/market-data?symbol=${encodeURIComponent(result.symbol)}`);
            const data = await res.json();
            if (data.currency) {
                setCurrency(data.currency);
            }
            if (data.price) {
                setPrice(data.price.toString());
            }
        } catch (error) {
            console.error('Failed to fetch currency/price', error);
        }
    };

    useEffect(() => {
        if (initialData) return;

        const delayDebounceFn = setTimeout(async () => {
            if (symbol.length > 1 && !isSelectionRef.current) {
                setSearching(true);
                try {
                    const res = await fetch(`/api/search?q=${encodeURIComponent(symbol)}`);
                    const data = await res.json();
                    setResults(Array.isArray(data) ? data : []);
                    setShowResults(true);
                } catch (error) {
                    console.error('Search failed', error);
                } finally {
                    setSearching(false);
                }
            } else if (symbol.length <= 1) {
                setResults([]);
                setShowResults(false);
            }
            isSelectionRef.current = false;
        }, 300);

        return () => clearTimeout(delayDebounceFn);
    }, [symbol, initialData]);

    useEffect(() => {
        if (!initialData && type === 'DIVIDEND' && symbol) {
            fetch(`/api/holdings?symbol=${encodeURIComponent(symbol)}`)
                .then((res) => res.json())
                .then((data) => {
                    if (data.quantity !== undefined) {
                        setQuantity(data.quantity.toString());
                    }
                })
                .catch((err) => console.error('Failed to fetch holdings', err));
        }
    }, [type, symbol, initialData]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setFormError(null);

        if (!platformId) {
            setFormError('Please select an account (which automatically links the platform).');
            return;
        }

        setSubmitting(true);
        try {
            const url = initialData ? `/api/activities/${initialData.id}` : '/api/activities';
            const method = initialData ? 'PUT' : 'POST';

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol,
                    name: symbolName,
                    type,
                    date,
                    quantity,
                    price,
                    fee,
                    platformId,
                    accountId,
                    investmentType,
                    currency
                })
            });

            if (res.ok) {
                if (!initialData) {
                    setSymbol('');
                    setSymbolName('');
                    setSymbolType('');
                    setQuantity('');
                    setPrice('');
                    setFee('');
                    setInvestmentType('EQUITY');
                    setCurrency('CAD');
                    setIsInvestmentTypeLocked(false);
                }
                if (onSuccess) onSuccess();
            } else {
                const errJson = await res.json().catch(() => ({}));
                setFormError(errJson.error || 'Failed to save activity. Please check your entries.');
            }
        } catch (error) {
            console.error('Submit failed', error);
            setFormError('Unable to reach server. Please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    const isSplit = type === 'STOCK_SPLIT' || type === 'SPLIT';
    const quantityLabel = isSplit ? 'Split Ratio' : 'Quantity';
    const priceLabel = type === 'DIVIDEND' ? 'Dividend / Unit' : isSplit ? 'Price / Unit (0 for split)' : 'Price / Unit';

    const parsedQty = parseFloat(quantity || '0') || 0;
    const parsedPrice = parseFloat(price || '0') || 0;
    const parsedFee = parseFloat(fee || '0') || 0;
    const netAmount = computeActivityNetAmount({
        type,
        quantity: parsedQty,
        price: parsedPrice,
        fee: parsedFee
    });

    const selectableAccounts = filterSelectableAccounts(
        accounts,
        currency,
        initialData?.account?.id ?? initialData?.accountId
    );

    const formContent = (
        <>
            {formError && (
                <div className={styles.errorBanner} role="alert">
                    {formError}
                </div>
            )}

            <div className={styles.sectionBlock}>
                <h3 className={styles.sectionTitle}>Security &amp; Classification</h3>
                <div className={styles.gridTwo}>
                    <div className={styles.field}>
                        <label htmlFor="activity-symbol" className={styles.fieldLabel}>
                            <span>Symbol</span>
                            {searching && <span className={styles.labelHint}>Searching...</span>}
                        </label>
                        <div className={styles.autocomplete} ref={autocompleteRef}>
                            <input
                                type="text"
                                id="activity-symbol"
                                value={symbol}
                                onChange={(e) => setSymbol(e.target.value)}
                                className={`${styles.input} ${initialData ? styles.readOnly : ''}`}
                                placeholder="Search symbol (e.g. AAPL, VFV.TO)"
                                autoComplete="off"
                                required
                                disabled={!!initialData}
                            />
                            {showResults && results.length > 0 && (
                                <ul className={styles.results} role="listbox" aria-label="Symbol suggestions">
                                    {results.map((result) => (
                                        <li key={result.symbol}>
                                            <button
                                                type="button"
                                                onClick={() => handleSelectSymbol(result)}
                                                className={styles.resultItem}
                                            >
                                                <span className={styles.resultSymbol}>{result.symbol}</span>
                                                <span className={styles.resultName}>{result.name}</span>
                                                <span className={styles.resultExchange}>{result.exchange}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="activity-investment-type" className={styles.fieldLabel}>
                            <span>Investment Type</span>
                            {isInvestmentTypeLocked && <span className={styles.labelHint}>Locked to symbol</span>}
                        </label>
                        <select
                            id="activity-investment-type"
                            value={investmentType}
                            onChange={(e) => setInvestmentType(e.target.value)}
                            className={`${styles.select} ${isInvestmentTypeLocked ? styles.readOnly : ''}`}
                            disabled={isInvestmentTypeLocked}
                        >
                            {investmentTypes.map((invType) => (
                                <option key={invType.id} value={invType.name}>
                                    {invType.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="activity-symbol-type" className={styles.fieldLabel}>
                            <span>Security Name / Class</span>
                        </label>
                        <input
                            type="text"
                            id="activity-symbol-type"
                            value={symbolName ? `${symbolName}${symbolType ? ` (${symbolType})` : ''}` : symbolType}
                            readOnly
                            className={`${styles.input} ${styles.readOnly}`}
                            placeholder="Auto-filled on selection"
                        />
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="activity-currency" className={styles.fieldLabel}>
                            <span>Currency</span>
                        </label>
                        <input
                            type="text"
                            id="activity-currency"
                            value={currency}
                            readOnly
                            className={`${styles.input} ${styles.readOnly}`}
                        />
                    </div>
                </div>
            </div>

            <div className={styles.sectionBlock}>
                <h3 className={styles.sectionTitle}>Transaction &amp; Account</h3>
                <div className={styles.gridTwo}>
                    <div className={styles.field}>
                        <label htmlFor="activity-type" className={styles.fieldLabel}>
                            <span>Activity Type</span>
                        </label>
                        <select
                            id="activity-type"
                            value={type}
                            onChange={(e) => setType(e.target.value)}
                            className={styles.select}
                        >
                            {activityTypes.map((actType) => (
                                <option key={actType.id} value={actType.name}>
                                    {actType.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.field}>
                        <DateInput
                            label="Date"
                            id="activity-date"
                            value={date}
                            onChange={setDate}
                            required
                        />
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="activity-account" className={styles.fieldLabel}>
                            <span>Account</span>
                        </label>
                        <select
                            id="activity-account"
                            value={accountId}
                            onChange={(e) => {
                                const newAccountId = e.target.value;
                                setAccountId(newAccountId);
                                const account = accounts.find((a) => a.id === newAccountId);
                                if (account) {
                                    setPlatformId(account.platformId);
                                } else {
                                    setPlatformId('');
                                }
                            }}
                            className={styles.select}
                            required
                        >
                            <option value="">Select Account</option>
                            {selectableAccounts.map((a) => {
                                const user = users.find((u) => u.username === a.name);
                                const displayName = user?.name || a.name;
                                const platform = platforms.find((p) => p.id === a.platformId);
                                const platformName = platform?.name || '';
                                const label = platformName
                                    ? `${displayName} - ${a.type} - ${platformName}`
                                    : `${displayName} - ${a.type}`;
                                return (
                                    <option key={a.id} value={a.id}>
                                        {label}
                                    </option>
                                );
                            })}
                        </select>
                        {accounts.length === 0 && (
                            <p className={styles.hint}>No accounts found. Add one in Settings.</p>
                        )}
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="activity-platform" className={styles.fieldLabel}>
                            <span>Platform</span>
                            <span className={styles.labelHint}>Auto-linked</span>
                        </label>
                        <select
                            id="activity-platform"
                            value={platformId}
                            disabled
                            className={`${styles.select} ${styles.readOnly}`}
                        >
                            <option value="">Platform</option>
                            {platforms.map((p) => (
                                <option key={p.id} value={p.id}>
                                    {p.name}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            <div className={styles.sectionBlock}>
                <h3 className={styles.sectionTitle}>Execution Details</h3>
                <div className={styles.gridThree}>
                    <div className={styles.field}>
                        <label htmlFor="activity-quantity" className={styles.fieldLabel}>
                            <span>{quantityLabel}</span>
                        </label>
                        <input
                            type="number"
                            id="activity-quantity"
                            value={quantity}
                            onChange={(e) => setQuantity(e.target.value)}
                            className={styles.input}
                            step="any"
                            min="0"
                            placeholder={isSplit ? 'e.g. 4' : '0'}
                            required
                            onKeyDown={handleNumericKeyDown}
                        />
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="activity-price" className={styles.fieldLabel}>
                            <span>{priceLabel}</span>
                        </label>
                        <input
                            type="number"
                            id="activity-price"
                            value={price}
                            onChange={(e) => setPrice(e.target.value)}
                            className={styles.input}
                            step="any"
                            min="0"
                            placeholder="0.00"
                            required
                            onKeyDown={handleNumericKeyDown}
                        />
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="activity-fee" className={styles.fieldLabel}>
                            <span>Fee / Brokerage</span>
                        </label>
                        <input
                            type="number"
                            id="activity-fee"
                            value={fee}
                            onChange={(e) => setFee(e.target.value)}
                            className={styles.input}
                            step="any"
                            min="0"
                            placeholder="0.00"
                            onKeyDown={handleNumericKeyDown}
                        />
                    </div>
                </div>

                <div className={styles.totalCard}>
                    <div className={styles.totalMeta}>
                        <span className={styles.totalLabel}>
                            {isSplit ? 'Split Multiplier' : 'Estimated Net Amount'}
                        </span>
                        <span className={styles.totalSub}>
                            {isSplit
                                ? 'Multiplies shares held across the account on split date'
                                : type === 'DRIP'
                                    ? 'Reinvested dividend cost basis (gross + fee; excluded from out-of-pocket inflows)'
                                    : ['SELL', 'REMOVE', 'WITHDRAWAL', 'TRANSFER_OUT', 'DIVIDEND', 'INTEREST'].includes(type)
                                        ? 'Gross amount minus brokerage fee'
                                        : 'Gross amount plus brokerage fee'}
                        </span>
                    </div>
                    <div className={styles.totalValue}>
                        {isSplit
                            ? `${quantity || '0'}:1 Split`
                            : `${currency} ${netAmount.toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2
                            })}`}
                    </div>
                </div>
            </div>
        </>
    );

    if (inModal) {
        return (
            <form className={styles.modalForm} onSubmit={handleSubmit}>
                <div className={styles.modalBody}>{formContent}</div>
                <div className={styles.modalFooter}>
                    {onCancel && (
                        <button
                            type="button"
                            onClick={onCancel}
                            className={styles.cancelButton}
                            disabled={submitting}
                        >
                            Cancel
                        </button>
                    )}
                    <button type="submit" className={styles.button} disabled={submitting}>
                        {submitting ? (
                            <>
                                <FaSpinner className={styles.spinner} aria-hidden="true" />
                                Saving...
                            </>
                        ) : initialData ? (
                            'Update Activity'
                        ) : (
                            'Add Activity'
                        )}
                    </button>
                </div>
            </form>
        );
    }

    return (
        <form className={styles.form} onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                {formContent}
            </div>
            <div className={styles.actions}>
                {onCancel && (
                    <button
                        type="button"
                        onClick={onCancel}
                        className={styles.cancelButton}
                        disabled={submitting}
                    >
                        Cancel
                    </button>
                )}
                <button type="submit" className={styles.button} disabled={submitting}>
                    {submitting ? (
                        <>
                            <FaSpinner className={styles.spinner} aria-hidden="true" />
                            Saving...
                        </>
                    ) : initialData ? (
                        'Update Activity'
                    ) : (
                        'Add Activity'
                    )}
                </button>
            </div>
        </form>
    );
}
