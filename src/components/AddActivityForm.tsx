/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect, useRef } from 'react';
import styles from './AddActivityForm.module.css';
import DateInput from './DateInput';

interface SearchResult {
    symbol: string;
    name: string;
    exchange: string;
    type: string;
}

interface AddActivityFormProps {
    onSuccess?: () => void;
    initialData?: any; // Using any for simplicity, ideally should match Activity type
    onCancel?: () => void;
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

export default function AddActivityForm({ onSuccess, initialData, onCancel }: AddActivityFormProps) {
    const [symbol, setSymbol] = useState('');
    const [symbolName, setSymbolName] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [showResults, setShowResults] = useState(false);
    const [loading, setLoading] = useState(false);
    const isSelectionRef = useRef(false);

    // Other form fields
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

    const [platforms, setPlatforms] = useState<{ id: string, name: string }[]>([]);
    const [accounts, setAccounts] = useState<{ id: string, name: string, type: string, platformId: string, currency: string, isActive?: boolean }[]>([]);
    // ... inside component ...
    interface InvestmentType {
        id: string;
        name: string;
        yahooInvestmentType?: { name: string };
    }
    const [investmentTypes, setInvestmentTypes] = useState<InvestmentType[]>([]);
    const [activityTypes, setActivityTypes] = useState<{ id: string, name: string }[]>([]);
    const [users, setUsers] = useState<{ id: string, username: string, name?: string }[]>([]);
    const [isInvestmentTypeLocked, setIsInvestmentTypeLocked] = useState(false);

    useEffect(() => {
        // Fetch platforms, accounts, and types
        Promise.allSettled([
            fetch('/api/platforms').then(res => res.json()),
            fetch('/api/accounts').then(res => res.json()),
            fetch('/api/settings/investment-types').then(res => res.json()),
            fetch('/api/settings/activity-types').then(res => res.json()),
            fetch('/api/users').then(res => res.json())
        ]).then((results) => {
            const [platformsRes, accountsRes, invTypesRes, actTypesRes, usersRes] = results;

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

    // Populate form with initial data when editing
    useEffect(() => {
        if (initialData) {
            setSymbol(initialData.investment.symbol);
            setSymbolName(initialData.investment.name);
            setSymbolType(initialData.investment.type);
            setInvestmentType(initialData.investment.type);
            setCurrency(initialData.investment.currencyCode || 'CAD');

            setType(initialData.type);
            setDate(toLocalDateString(initialData.date));
            setQuantity(initialData.quantity.toString());
            setPrice(initialData.price.toString());
            setFee(initialData.fee ? initialData.fee.toString() : '');

            if (initialData.account) {
                setAccountId(initialData.account.id);
                // Platform is derived from account usually, but we can set it explicitly if available
                // or let the account selection logic handle it. 
                // However, setting it explicitly ensures it matches the record.
                if (initialData.platform) {
                    setPlatformId(initialData.platform.id);
                } else if (initialData.account.platformId) {
                    setPlatformId(initialData.account.platformId);
                }
            } else if (initialData.platform) {
                // Case where only platform is known (unlikely given schema, but possible in legacy data)
                setPlatformId(initialData.platform.id);
            }
        }
    }, [initialData]);

    const handleSelectSymbol = async (result: SearchResult) => {
        isSelectionRef.current = true;
        setSymbol(result.symbol);
        setSymbolName(result.name);
        setSymbolType(result.type);

        // Check if symbol exists in DB to lock Investment Type
        try {
            const res = await fetch(`/api/investments?symbol=${encodeURIComponent(result.symbol)}`);
            const existingInvestments = await res.json();

            if (Array.isArray(existingInvestments) && existingInvestments.length > 0) {
                // Symbol exists! Use its existing type.
                const existingType = existingInvestments[0].type;
                if (existingType) {
                    setInvestmentType(existingType);
                    setIsInvestmentTypeLocked(true);
                }
            } else {
                // New symbol: Auto-detect based on mapping
                setIsInvestmentTypeLocked(false);

                // Find Investment Type where mapped Yahoo Type matches result.type
                // Yahoo types from search are usually uppercase, e.g. "ETF", "EQUITY"
                const yahooType = result.type.toUpperCase();

                const matchedType = investmentTypes.find(
                    it => it.yahooInvestmentType?.name === yahooType
                );

                if (matchedType) {
                    setInvestmentType(matchedType.name);
                } else {
                    // Fallback logic
                    if (yahooType === 'EQUITY' || yahooType === 'ETF' || yahooType === 'MUTUALFUND') {
                        // Try to find "Stock" or "Equity"
                        const stockType = investmentTypes.find(t => t.name === 'Stock' || t.name === 'Equity');
                        if (stockType) setInvestmentType(stockType.name);
                    } else if (investmentTypes.length > 0) {
                        // Default to first if completely unknown
                        // setInvestmentType(investmentTypes[0].name); 
                        // Actually, better to leave it as 'EQUITY' default or whatever the state initialized to, 
                        // or just let user select.
                    }
                }
            }
        } catch (error) {
            console.error('Failed to check existing investment', error);
            setIsInvestmentTypeLocked(false);
        }

        setShowResults(false);

        // Fetch currency and price
        try {
            const res = await fetch(`/api/market-data?symbol=${result.symbol}`);
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

    // Effect for symbol search
    useEffect(() => {
        const delayDebounceFn = setTimeout(async () => {
            if (symbol.length > 1 && !isSelectionRef.current) {
                setLoading(true);
                try {
                    const res = await fetch(`/api/search?q=${encodeURIComponent(symbol)}`);
                    const data = await res.json();
                    setResults(Array.isArray(data) ? data : []);
                    setShowResults(true);
                } catch (error) {
                    console.error('Search failed', error);
                } finally {
                    setLoading(false);
                }
            } else if (symbol.length <= 1) {
                setResults([]);
                setShowResults(false);
            }
            isSelectionRef.current = false; // Reset after potential selection or search
        }, 300); // Debounce time

        return () => clearTimeout(delayDebounceFn);
    }, [symbol]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!platformId) {
            alert('Please select an account (which determines the platform)');
            return;
        }

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
                }),
            });

            if (res.ok) {
                if (!initialData) {
                    // Reset form only if creating
                    setSymbol('');
                    setSymbolName('');
                    setQuantity('');
                    setPrice('');
                    setFee('');
                    setInvestmentType('EQUITY');
                    setCurrency('CAD');
                    // Keep account/platform selected for convenience
                }
                if (onSuccess) onSuccess();
            } else {
                const error = await res.json();
                alert(`Error: ${error.error}`);
            }
        } catch (error) {
            console.error('Submit failed', error);
            alert('Failed to submit activity');
        }
    };

    // Fetch holdings when type changes to DIVIDEND (only for new activities)
    useEffect(() => {
        if (!initialData && type === 'DIVIDEND' && symbol) {
            fetch(`/api/holdings?symbol=${encodeURIComponent(symbol)}`)
                .then(res => res.json())
                .then(data => {
                    if (data.quantity !== undefined) {
                        setQuantity(data.quantity.toString());
                    }
                })
                .catch(err => console.error('Failed to fetch holdings', err));
        }
    }, [type, symbol]);

    const getPriceLabel = () => {
        if (type === 'DIVIDEND') return 'Dividend / Unit';
        return 'Price / Unit';
    };

    return (
        <form className={styles.form} onSubmit={handleSubmit}>
            {/* ... existing fields ... */}

            <div className={styles.grid}>
                {/* ... Symbol, Symbol Type, Investment Type, Currency, Activity Type, Date, Account, Platform ... */}

                <div className={styles.field}>
                    <label htmlFor="symbol">Symbol</label>
                    <div className={styles.autocomplete}>
                        <input
                            type="text"
                            id="symbol"
                            value={symbol}
                            onChange={(e) => setSymbol(e.target.value)}
                            className={styles.input}
                            placeholder="Search symbol (e.g. AAPL)"
                            autoComplete="off"
                            required
                            disabled={!!initialData}
                        />
                        {showResults && results.length > 0 && (
                            <ul className={styles.results}>
                                {results.map((result) => (
                                    <li
                                        key={result.symbol}
                                        onClick={() => handleSelectSymbol(result)}
                                        className={styles.resultItem}
                                    >
                                        <span className={styles.resultSymbol}>{result.symbol}</span>
                                        <span className={styles.resultName}>{result.name}</span>
                                        <span className={styles.resultExchange}>{result.exchange}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>

                <div className={styles.field}>
                    <label htmlFor="symbolType">Symbol Type</label>
                    <input
                        type="text"
                        id="symbolType"
                        value={symbolType}
                        readOnly
                        className={`${styles.input} ${styles.readOnly}`}
                        placeholder="e.g. ETF"
                    />
                </div>

                <div className={styles.field}>
                    <label htmlFor="investmentType">Investment Type</label>
                    <select
                        id="investmentType"
                        value={investmentType}
                        onChange={(e) => setInvestmentType(e.target.value)}
                        className={styles.select}
                        disabled={isInvestmentTypeLocked}
                    >
                        {investmentTypes.map(type => (
                            <option key={type.id} value={type.name}>{type.name}</option>
                        ))}
                    </select>
                </div>

                <div className={styles.field}>
                    <label htmlFor="currency">Currency</label>
                    <input
                        type="text"
                        id="currency"
                        value={currency}
                        readOnly
                        className={`${styles.input} ${styles.readOnly}`}
                    />
                </div>

                <div className={styles.field}>
                    <label htmlFor="type">Activity Type</label>
                    <select
                        id="type"
                        value={type}
                        onChange={(e) => setType(e.target.value)}
                        className={styles.select}
                    >
                        {activityTypes.map(type => (
                            <option key={type.id} value={type.name}>{type.name}</option>
                        ))}
                    </select>
                </div>

                <div className={styles.field}>
                    <DateInput
                        label="Date"
                        id="date"
                        value={date}
                        onChange={setDate}
                        required
                    />
                </div>

                <div className={styles.field}>
                    <label htmlFor="account">Account</label>
                    <select
                        id="account"
                        value={accountId}
                        onChange={(e) => {
                            const newAccountId = e.target.value;
                            setAccountId(newAccountId);
                            const account = accounts.find(a => a.id === newAccountId);
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
                        {accounts
                            .filter(a => a.currency === currency && (a.isActive !== false || a.id === accountId))
                            .map(a => {
                                const user = users.find(u => u.username === a.name);
                                const displayName = user?.name || a.name;
                                const platform = platforms.find(p => p.id === a.platformId);
                                const platformName = platform?.name || '';
                                const label = platformName ? `${displayName} - ${a.type} - ${platformName}` : `${displayName} - ${a.type}`;
                                return (
                                    <option key={a.id} value={a.id}>{label}</option>
                                );
                            })}
                    </select>
                    {accounts.length === 0 && (
                        <p className={styles.hint}>No accounts found. Add one in Settings.</p>
                    )}
                </div>

                <div className={styles.field}>
                    <label htmlFor="platform">Platform (Auto-selected)</label>
                    <select
                        id="platform"
                        value={platformId}
                        disabled
                        className={`${styles.select} ${styles.readOnly}`}
                    >
                        <option value="">Platform</option>
                        {platforms.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                </div>

                <div className={styles.field}>
                    <label htmlFor="quantity">Quantity</label>
                    <input
                        type="number"
                        id="quantity"
                        value={quantity}
                        onChange={(e) => setQuantity(e.target.value)}
                        className={styles.input}
                        step="any"
                        min="0"
                        required
                        onKeyDown={(e) => {
                            if (!/[0-9.]/.test(e.key) && !['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
                                e.preventDefault();
                            }
                        }}
                    />
                </div>

                <div className={styles.field}>
                    <label htmlFor="price">{getPriceLabel()}</label>
                    <input
                        type="number"
                        id="price"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        className={styles.input}
                        step="any"
                        min="0"
                        required
                        onKeyDown={(e) => {
                            if (!/[0-9.]/.test(e.key) && !['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
                                e.preventDefault();
                            }
                        }}
                    />
                </div>

                <div className={styles.field}>
                    <label htmlFor="fee">Platform Fee / Brokerage</label>
                    <input
                        type="number"
                        id="fee"
                        value={fee}
                        onChange={(e) => setFee(e.target.value)}
                        className={styles.input}
                        step="any"
                        min="0"
                        placeholder="0.00"
                        onKeyDown={(e) => {
                            if (!/[0-9.]/.test(e.key) && !['Backspace', 'Delete', 'Tab', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
                                e.preventDefault();
                            }
                        }}
                    />
                </div>

                <div className={styles.field}>
                    <label>Total Amount</label>
                    <div className={styles.totalDisplay}>
                        {currency} {((parseFloat(quantity || '0') * parseFloat(price || '0')) + parseFloat(fee || '0')).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                </div>
            </div>

            <div className={styles.actions}>
                <button type="submit" className={styles.button}>
                    {initialData ? 'Update Activity' : 'Add Activity'}
                </button>
                {onCancel && (
                    <button type="button" onClick={onCancel} className={styles.cancelButton}>
                        Cancel
                    </button>
                )}
            </div>
        </form >
    );
}
