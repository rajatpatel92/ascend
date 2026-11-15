'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { getExchangeRate } from '@/lib/currencyCache';

type CurrencyCode = string;

interface CurrencyContextType {
    currency: CurrencyCode;
    setCurrency: (code: CurrencyCode) => void;
    convert: (amount: number, fromCurrency: string) => number;
    format: (amount: number, options?: Intl.NumberFormatOptions) => string;
    rates: Record<string, number>;
    loading: boolean;
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined);

export function CurrencyProvider({ children }: { children: React.ReactNode }) {
    const [currency, setCurrency] = useState<CurrencyCode>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('portfolio_currency');
            if (saved && SUPPORTED_CURRENCIES.some(c => c.code === saved)) {
                return saved;
            }
        }
        return 'CAD';
    });
    const [rates, setRates] = useState<Record<string, number>>({});
    const [loading, setLoading] = useState(true);

    // Save to localStorage when changed
    useEffect(() => {
        localStorage.setItem('portfolio_currency', currency);
    }, [currency]);

    // Fetch rates when target currency changes
    useEffect(() => {
        let cancelled = false;

        const fetchRates = async () => {
            setLoading(true);
            const newRates: Record<string, number> = { [currency]: 1 };
            const currenciesToFetch = SUPPORTED_CURRENCIES.map(c => c.code).filter(c => c !== currency);

            // Fetch in parallel using the cached utility
            await Promise.all(currenciesToFetch.map(async (from) => {
                const rate = await getExchangeRate(from, currency);
                if (rate !== null && Number.isFinite(rate) && rate > 0) {
                    newRates[from] = rate;
                }
            }));

            if (!cancelled) {
                setRates(newRates);
                setLoading(false);
            }
        };

        fetchRates();
        return () => {
            cancelled = true;
        };
    }, [currency]);

    const convert = (amount: number, fromCurrency: string): number => {
        if (!Number.isFinite(amount)) return 0;
        const normalizedFrom = (fromCurrency || '').trim().toUpperCase();
        const normalizedTo = currency.trim().toUpperCase();
        if (!normalizedFrom || normalizedFrom === normalizedTo) {
            return Object.is(amount, -0) ? 0 : amount;
        }
        const rate = rates[normalizedFrom];
        const result = rate && rate > 0 ? amount * rate : amount; // Fallback to 1:1 if rate missing
        return Object.is(result, -0) ? 0 : result;
    };

    const format = (amount: number, options?: Intl.NumberFormatOptions): string => {
        const safeAmount = !Number.isFinite(amount) || Math.abs(amount) < 1e-9 ? 0 : amount;
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currency,
            ...options
        }).format(safeAmount);
    };

    return (
        <CurrencyContext.Provider value={{ currency, setCurrency, convert, format, rates, loading }}>
            {children}
        </CurrencyContext.Provider>
    );
}

export function useCurrency() {
    const context = useContext(CurrencyContext);
    if (context === undefined) {
        throw new Error('useCurrency must be used within a CurrencyProvider');
    }
    return context;
}
