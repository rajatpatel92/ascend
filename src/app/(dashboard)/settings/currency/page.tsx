'use client';

import { useCurrency } from '@/context/CurrencyContext';
import styles from '../page.module.css';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { useEffect, useState } from 'react';
import { getExchangeRate } from '@/lib/currencyCache';
import { useLiveSync } from '@/hooks/useLiveSync';
import { MdTableChart } from 'react-icons/md';

const QUICK_CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'INR', 'AUD'];

function ExchangeRateCell({ from, to, refreshToken }: { from: string; to: string; refreshToken: number }) {
    const [rate, setRate] = useState<number | null>(null);

    useEffect(() => {
        let mounted = true;

        getExchangeRate(from, to).then((fetchedRate) => {
            if (mounted && fetchedRate !== null) {
                setRate(fetchedRate);
            }
        });

        return () => {
            mounted = false;
        };
    }, [from, to, refreshToken]);

    const isSelf = from === to;
    if (rate === null) {
        return <td className={isSelf ? styles.matrixSelfCell : undefined}>{isSelf ? '1.0000' : '—'}</td>;
    }

    return <td className={isSelf ? styles.matrixSelfCell : undefined}>{rate.toFixed(4)}</td>;
}

export default function CurrencySettingsPage() {
    const { currency, setCurrency, format } = useCurrency();
    const [refreshToken, setRefreshToken] = useState(0);

    useLiveSync({
        events: ['MARKET_SYNCED'],
        revalidateIntervalMs: 10 * 60 * 1000,
        onSync: () => setRefreshToken((n) => n + 1),
    });

    return (
        <div className={styles.stack}>
            <section className={styles.rowListCard} aria-label="Default reporting currency">
                <div className={styles.rowItem}>
                    <div className={styles.rowLabelCol}>
                        <label htmlFor="defaultCurrency" className={styles.rowTitle}>
                            Reporting Currency
                        </label>
                        <span className={styles.rowHint}>
                            Portfolio totals &amp; charts normalize into this currency · Sample:{' '}
                            <span className={styles.rowPreviewValue}>{format(10000)}</span>
                        </span>
                    </div>
                    <div className={styles.rowControl}>
                        <select
                            id="defaultCurrency"
                            value={currency}
                            onChange={(e) => setCurrency(e.target.value)}
                            className={styles.rowSelect}
                        >
                            {SUPPORTED_CURRENCIES.map((c) => (
                                <option key={c.code} value={c.code}>
                                    {c.code} ({c.symbol}) · {c.name}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                <div className={styles.rowItem}>
                    <div className={styles.rowLabelCol}>
                        <span className={styles.rowTitle}>Quick Switch</span>
                        <span className={styles.rowHint}>One-tap toggle for common reporting currencies</span>
                    </div>
                    <div className={styles.rowControl}>
                        <div className={styles.chipRow} role="group" aria-label="Quick currency switcher">
                            {QUICK_CURRENCIES.filter((code) => SUPPORTED_CURRENCIES.some((c) => c.code === code)).map((code) => (
                                <button
                                    key={code}
                                    type="button"
                                    className={styles.chipBtn}
                                    aria-pressed={currency === code}
                                    onClick={() => setCurrency(code)}
                                >
                                    {code}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            <section className={styles.card} aria-label="Live exchange rates matrix">
                <div className={styles.cardHeader}>
                    <div className={styles.cardTitleGroup}>
                        <h2 className={styles.cardTitle}>
                            <MdTableChart size={20} aria-hidden="true" />
                            Exchange Rate Matrix
                        </h2>
                        <p className={styles.cardSubheading}>
                            Cross-currency conversion rates updated via 2-minute server FX sync and 10-minute client cache.
                        </p>
                    </div>
                    <span className={`${styles.statusPill} ${styles.statusPositive}`}>
                        Highlighted: {currency}
                    </span>
                </div>

                <div className={styles.tableResponsive}>
                    <table className={styles.matrixTable}>
                        <thead>
                            <tr>
                                <th>From \ To</th>
                                {SUPPORTED_CURRENCIES.map((c) => (
                                    <th
                                        key={c.code}
                                        className={c.code === currency ? styles.matrixActiveHeader : undefined}
                                    >
                                        {c.code}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {SUPPORTED_CURRENCIES.map((from) => (
                                <tr
                                    key={from.code}
                                    className={from.code === currency ? styles.matrixActiveRow : undefined}
                                >
                                    <td>{from.code}</td>
                                    {SUPPORTED_CURRENCIES.map((to) => (
                                        <ExchangeRateCell
                                            key={`${from.code}-${to.code}`}
                                            from={from.code}
                                            to={to.code}
                                            refreshToken={refreshToken}
                                        />
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
