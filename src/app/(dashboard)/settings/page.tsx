'use client';

import styles from './page.module.css';
import { useTheme } from '@/context/ThemeContext';
import { useDate, type DateFormat } from '@/context/DateContext';
import { useCurrency } from '@/context/CurrencyContext';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { MdDarkMode, MdLightMode } from 'react-icons/md';

import BenchmarkSettings from '@/components/settings/BenchmarkSettings';

export default function SettingsHubPage() {
    const { theme, setTheme } = useTheme();
    const { dateFormat, setDateFormat, formatDate } = useDate();
    const { currency, setCurrency, format } = useCurrency();

    const sampleDatePreview = formatDate(new Date());
    const sampleCurrencyPreview = format(12345.67);

    return (
        <div className={styles.stack}>
            <section className={styles.rowListCard} aria-label="General preferences">
                <div className={styles.rowItem}>
                    <div className={styles.rowLabelCol}>
                        <span className={styles.rowTitle}>Appearance</span>
                        <span className={styles.rowHint}>Interface color theme across all dashboards</span>
                    </div>
                    <div className={styles.rowControl}>
                        <div className={styles.rowToggle} role="group" aria-label="Appearance theme">
                            <button
                                type="button"
                                className={styles.modeBtn}
                                aria-pressed={theme === 'light'}
                                onClick={() => setTheme('light')}
                            >
                                <MdLightMode size={15} aria-hidden="true" />
                                Light
                            </button>
                            <button
                                type="button"
                                className={styles.modeBtn}
                                aria-pressed={theme === 'dark'}
                                onClick={() => setTheme('dark')}
                            >
                                <MdDarkMode size={15} aria-hidden="true" />
                                Dark
                            </button>
                        </div>
                    </div>
                </div>

                <div className={styles.rowItem}>
                    <div className={styles.rowLabelCol}>
                        <label htmlFor="dateFormatSelect" className={styles.rowTitle}>
                            Date Format
                        </label>
                        <span className={styles.rowHint}>
                            Preview: <span className={styles.rowPreviewValue}>{sampleDatePreview}</span>
                        </span>
                    </div>
                    <div className={styles.rowControl}>
                        <select
                            id="dateFormatSelect"
                            value={dateFormat}
                            onChange={(e) => setDateFormat(e.target.value as DateFormat)}
                            className={styles.rowSelect}
                        >
                            <option value="MM/DD/YYYY">MM/DD/YYYY (US)</option>
                            <option value="DD/MM/YYYY">DD/MM/YYYY (UK / India)</option>
                            <option value="YYYY-MM-DD">YYYY-MM-DD (ISO)</option>
                            <option value="MMM DD, YYYY">MMM DD, YYYY (Medium)</option>
                        </select>
                    </div>
                </div>

                <div className={styles.rowItem}>
                    <div className={styles.rowLabelCol}>
                        <label htmlFor="defaultCurrencySelect" className={styles.rowTitle}>
                            Default Display Currency
                        </label>
                        <span className={styles.rowHint}>
                            Preview: <span className={styles.rowPreviewValue}>{sampleCurrencyPreview}</span>
                        </span>
                    </div>
                    <div className={styles.rowControl}>
                        <select
                            id="defaultCurrencySelect"
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
            </section>

            <BenchmarkSettings />
        </div>
    );
}
