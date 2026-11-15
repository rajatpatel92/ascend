'use client';

import styles from './page.module.css';
import { useTheme } from '@/context/ThemeContext';
import { useDate, type DateFormat } from '@/context/DateContext';
import { useCurrency } from '@/context/CurrencyContext';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { MdDarkMode, MdLightMode, MdTune } from 'react-icons/md';

import BenchmarkSettings from '@/components/settings/BenchmarkSettings';

export default function SettingsHubPage() {
    const { theme, setTheme } = useTheme();
    const { dateFormat, setDateFormat, formatDate } = useDate();
    const { currency, setCurrency, format } = useCurrency();

    const sampleDatePreview = formatDate(new Date());
    const sampleCurrencyPreview = format(12345.67);

    return (
        <div className={styles.settingsGrid}>
            <section className={styles.card} aria-label="General preferences">
                <div className={styles.cardHeader}>
                    <div className={styles.cardTitleGroup}>
                        <h2 className={styles.cardTitle}>
                            <MdTune size={20} aria-hidden="true" />
                            General Preferences
                        </h2>
                        <p className={styles.cardSubheading}>
                            Personalize appearance theme, date formatting, and default portfolio display currency.
                        </p>
                    </div>
                    <span className={`${styles.statusPill} ${styles.statusInfo}`}>{currency}</span>
                </div>

                <div className={styles.grid}>
                    <div className={styles.field}>
                        <span className={styles.label}>
                            <span>Appearance Theme</span>
                            <span className={styles.labelMeta}>{theme === 'dark' ? 'Dark Mode' : 'Light Mode'}</span>
                        </span>
                        <div className={styles.modeToggle} role="group" aria-label="Appearance theme">
                            <button
                                type="button"
                                className={styles.modeBtn}
                                aria-pressed={theme === 'light'}
                                onClick={() => setTheme('light')}
                            >
                                <MdLightMode size={16} aria-hidden="true" />
                                Light
                            </button>
                            <button
                                type="button"
                                className={styles.modeBtn}
                                aria-pressed={theme === 'dark'}
                                onClick={() => setTheme('dark')}
                            >
                                <MdDarkMode size={16} aria-hidden="true" />
                                Dark
                            </button>
                        </div>
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="dateFormatSelect" className={styles.label}>
                            <span>Date Format</span>
                            <span className={styles.labelMeta}>Preview: {sampleDatePreview}</span>
                        </label>
                        <select
                            id="dateFormatSelect"
                            value={dateFormat}
                            onChange={(e) => setDateFormat(e.target.value as DateFormat)}
                            className={styles.select}
                        >
                            <option value="MM/DD/YYYY">MM/DD/YYYY (US)</option>
                            <option value="DD/MM/YYYY">DD/MM/YYYY (UK / India)</option>
                            <option value="YYYY-MM-DD">YYYY-MM-DD (ISO)</option>
                            <option value="MMM DD, YYYY">MMM DD, YYYY (Medium)</option>
                        </select>
                    </div>

                    <div className={styles.field}>
                        <label htmlFor="defaultCurrencySelect" className={styles.label}>
                            <span>Default Currency</span>
                            <span className={styles.labelMeta}>Preview: {sampleCurrencyPreview}</span>
                        </label>
                        <select
                            id="defaultCurrencySelect"
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

                    <div className={styles.previewBox}>
                        <span>Format Summary</span>
                        <strong>{sampleDatePreview} &bull; {sampleCurrencyPreview}</strong>
                    </div>
                </div>
            </section>

            <BenchmarkSettings />
        </div>
    );
}
