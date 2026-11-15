'use client';

import { useCurrency } from '@/context/CurrencyContext';
import styles from '../page.module.css';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { useEffect, useState } from 'react';
import { getExchangeRate } from '@/lib/currencyCache';
import { MdCurrencyExchange, MdTableChart } from 'react-icons/md';

const QUICK_CURRENCIES = ['USD', 'CAD', 'EUR', 'GBP', 'INR', 'AUD'];

function ExchangeRateCell({ from, to }: { from: string; to: string }) {
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
    }, [from, to]);

    const isSelf = from === to;
    if (rate === null) {
        return <td className={isSelf ? styles.matrixSelfCell : undefined}>{isSelf ? '1.0000' : '—'}</td>;
    }

    return <td className={isSelf ? styles.matrixSelfCell : undefined}>{rate.toFixed(4)}</td>;
}

export default function CurrencySettingsPage() {
    const { currency, setCurrency, format } = useCurrency();
    const activeMeta = SUPPORTED_CURRENCIES.find((c) => c.code === currency);

    return (
        <div className={styles.stack}>
            <section className={styles.card} aria-label="Default reporting currency">
                <div className={styles.cardHeader}>
                    <div className={styles.cardTitleGroup}>
                        <h2 className={styles.cardTitle}>
                            <MdCurrencyExchange size={20} aria-hidden="true" />
                            Base Display Currency
                        </h2>
                        <p className={styles.cardSubheading}>
                            All portfolio totals, analytics charts, and rebalance recommendations normalize into this currency.
                        </p>
                    </div>
                    <span className={`${styles.statusPill} ${styles.statusInfo}`}>
                        {currency} {activeMeta ? `(${activeMeta.symbol})` : ''}
                    </span>
                </div>

                <div className={styles.grid}>
                    <div className={styles.field}>
                        <label htmlFor="defaultCurrency" className={styles.label}>
                            <span>Select Currency</span>
                            <span className={styles.labelMeta}>Sample: {format(10000)}</span>
                        </label>
                        <select
                            id="defaultCurrency"
                            value={currency}
                            onChange={(e) => setCurrency(e.target.value)}
                            className={styles.select}
                        >
                            {SUPPORTED_CURRENCIES.map((c) => (
                                <option key={c.code} value={c.code}>
                                    {c.name} - {c.code} ({c.symbol})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.field}>
                        <span className={styles.label}>Quick Switch</span>
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
                            Cross-currency conversion rates cached across the platform and refreshed every 8 hours.
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
                                        <ExchangeRateCell key={`${from.code}-${to.code}`} from={from.code} to={to.code} />
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
