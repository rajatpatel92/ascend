'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { getExchangeRate, invalidateCurrencyCache } from '@/lib/currencyCache';
import { useLiveSync } from '@/hooks/useLiveSync';

type CurrencyCode = string;

interface CurrencyContextType {
    currency: CurrencyCode;
    setCurrency: (code: CurrencyCode) => void;
    convert: (amount: number, fromCurrency: string) => number;
    format: (amount: number, options?: Intl.NumberFormatOptions) => string;
    refreshRates: (force?: boolean) => Promise<void>;
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
    const [loadedCurrency, setLoadedCurrency] = useState<CurrencyCode | null>(null);
    const activeCurrencyRef = useRef<CurrencyCode>(currency);
    const requestSeqRef = useRef(0);

    useEffect(() => {
        activeCurrencyRef.current = currency;
        try {
            localStorage.setItem('portfolio_currency', currency);
        } catch {
            // Ignore private-mode or restricted storage errors
        }
    }, [currency]);

    const loadRates = useCallback(
        async (targetCurrency: CurrencyCode, options?: { force?: boolean }) => {
            const seq = ++requestSeqRef.current;
            const forceRefresh = Boolean(options?.force);

            if (forceRefresh) {
                invalidateCurrencyCache();
            }

            const newRates: Record<string, number> = { [targetCurrency]: 1 };
            const currenciesToFetch = SUPPORTED_CURRENCIES.map(c => c.code).filter(c => c !== targetCurrency);

            await Promise.all(
                currenciesToFetch.map(async (from) => {
                    const rate = await getExchangeRate(from, targetCurrency, { forceRefresh });
                    if (rate !== null && Number.isFinite(rate) && rate > 0) {
                        newRates[from] = rate;
                    }
                })
            );

            if (requestSeqRef.current === seq && activeCurrencyRef.current === targetCurrency) {
                setRates(newRates);
                setLoadedCurrency(targetCurrency);
            }
        },
        []
    );

    useEffect(() => {
        let active = true;
        const run = async () => {
            await Promise.resolve();
            if (active) {
                await loadRates(currency, { force: false });
            }
        };
        void run();
        return () => {
            active = false;
        };
    }, [currency, loadRates]);

    const refreshRates = useCallback(
        async (force = true): Promise<void> => {
            await loadRates(activeCurrencyRef.current, { force });
        },
        [loadRates]
    );

    const loading = loadedCurrency !== currency;

    useLiveSync({
        events: ['MARKET_SYNCED'],
        revalidateIntervalMs: 10 * 60 * 1000,
        onSync: (_reason, event) => {
            if (!event) {
                invalidateCurrencyCache();
            }
            void loadRates(activeCurrencyRef.current, { force: false });
        },
    });

    const convert = useCallback(
        (amount: number, fromCurrency: string): number => {
            if (!Number.isFinite(amount)) return 0;
            const normalizedFrom = (fromCurrency || '').trim().toUpperCase();
            const normalizedTo = currency.trim().toUpperCase();
            if (!normalizedFrom || normalizedFrom === normalizedTo) {
                return Object.is(amount, -0) ? 0 : amount;
            }
            const rate = rates[normalizedFrom];
            const result = rate && rate > 0 ? amount * rate : amount; // Fallback to 1:1 if rate missing
            return Object.is(result, -0) ? 0 : result;
        },
        [currency, rates]
    );

    const format = useCallback(
        (amount: number, options?: Intl.NumberFormatOptions): string => {
            const safeAmount = !Number.isFinite(amount) || Math.abs(amount) < 1e-9 ? 0 : amount;
            return new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: currency,
                ...options
            }).format(safeAmount);
        },
        [currency]
    );

    return (
        <CurrencyContext.Provider value={{ currency, setCurrency, convert, format, refreshRates, rates, loading }}>
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
