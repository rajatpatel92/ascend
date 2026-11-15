'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MdAdd, MdAutoFixHigh, MdDeleteOutline, MdDownload, MdSave } from 'react-icons/md';
import styles from '../page.module.css';
import type { TargetConfig } from '@/lib/rebalance-planner';

interface SearchSuggestion {
    symbol: string;
    name: string;
}

interface RebalancerConfigPanelProps {
    isOpen: boolean;
    targets: TargetConfig[];
    portfolioSymbols: string[];
    isSaving: boolean;
    onChangeTargets: (targets: TargetConfig[]) => void;
    onSeedFromHoldings: () => void;
    onNormalizeTargets: () => void;
    onSaveTargets: () => void;
}

export default function RebalancerConfigPanel({
    isOpen,
    targets,
    portfolioSymbols,
    isSaving,
    onChangeTargets,
    onSeedFromHoldings,
    onNormalizeTargets,
    onSaveTargets
}: RebalancerConfigPanelProps) {
    const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchSuggestion[]>([]);

    useEffect(() => {
        if (searchQuery.trim().length <= 1) {
            return;
        }

        const controller = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery.trim())}`, {
                    signal: controller.signal
                });
                const data = await res.json();
                if (Array.isArray(data)) {
                    setSearchResults(data.slice(0, 5));
                }
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Symbol search failed:', err);
            }
        }, 300);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [searchQuery]);

    const visibleSearchResults = searchQuery.trim().length > 1 ? searchResults : [];

    const totalTargetPercent = useMemo(
        () => targets.reduce((sum, t) => sum + (Number.isFinite(t.targetPercentage) ? t.targetPercentage : 0), 0),
        [targets]
    );

    const duplicateSymbols = useMemo(() => {
        const seen = new Set<string>();
        const dupes = new Set<string>();
        for (const t of targets) {
            const sym = t.symbol.trim().toUpperCase();
            if (!sym) continue;
            if (seen.has(sym)) dupes.add(sym);
            seen.add(sym);
        }
        return Array.from(dupes);
    }, [targets]);

    const getFilteredPortfolioSymbols = (query: string) => {
        if (!query) return portfolioSymbols;
        const q = query.toLowerCase();
        return portfolioSymbols.filter((sym) => sym.toLowerCase().includes(q));
    };

    const handleTargetChange = (index: number, field: keyof TargetConfig, value: string) => {
        const next = targets.map((item, i) => {
            if (i !== index) return item;
            if (field === 'symbol') {
                return { ...item, symbol: value.toUpperCase() };
            }
            if (field === 'targetPercentage') {
                const num = parseFloat(value);
                return { ...item, targetPercentage: Number.isNaN(num) ? 0 : Math.max(0, num) };
            }
            const num = parseFloat(value);
            return { ...item, yearlyDriftAdjustment: value.trim() === '' || Number.isNaN(num) ? null : num };
        });
        onChangeTargets(next);
    };

    const addTargetRow = () => {
        onChangeTargets([...targets, { symbol: '', targetPercentage: 0, yearlyDriftAdjustment: null }]);
    };

    const removeTargetRow = (index: number) => {
        onChangeTargets(targets.filter((_, i) => i !== index));
    };

    const isSumValid = Math.abs(totalTargetPercent - 100) < 0.05;
    const hasTargets = targets.some((t) => t.symbol.trim() !== '');

    return (
        <AnimatePresence initial={false}>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.25, ease: 'easeInOut' }}
                    style={{ overflow: 'hidden' }}
                >
                    <section className={styles.panelCard} aria-label="Target and glide path studio">
                        <div className={styles.studioHeader}>
                            <div>
                                <h2 className={styles.panelHeading}>Target &amp; Glide Path Studio</h2>
                                <p className={styles.panelSubheading}>
                                    Assign target portfolio percentages and optional annual glide-path adjustments.
                                </p>
                            </div>

                            <div className={styles.studioActions}>
                                <span
                                    className={`${styles.statusPill} ${
                                        isSumValid
                                            ? styles.statusPositive
                                            : totalTargetPercent === 0
                                                ? styles.statusNeutral
                                                : styles.statusWarning
                                    }`}
                                >
                                    Allocated: {totalTargetPercent.toFixed(1)}%
                                </span>

                                <button
                                    type="button"
                                    className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                    onClick={onSeedFromHoldings}
                                    disabled={portfolioSymbols.length === 0}
                                    title="Populate targets from your current portfolio weights"
                                >
                                    <MdDownload size={16} aria-hidden="true" />
                                    Seed from Holdings
                                </button>

                                {!isSumValid && totalTargetPercent > 0 && (
                                    <button
                                        type="button"
                                        className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                        onClick={onNormalizeTargets}
                                        title="Proportionally scale targets so they sum to 100%"
                                    >
                                        <MdAutoFixHigh size={16} aria-hidden="true" />
                                        Normalize to 100%
                                    </button>
                                )}

                                <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={onSaveTargets}
                                    disabled={isSaving || duplicateSymbols.length > 0}
                                >
                                    <MdSave size={18} aria-hidden="true" />
                                    {isSaving ? 'Saving...' : 'Save & Recalculate'}
                                </button>
                            </div>
                        </div>

                        {duplicateSymbols.length > 0 && (
                            <div role="alert" className={styles.errorBanner} style={{ marginBottom: 0 }}>
                                Duplicate symbols detected ({duplicateSymbols.join(', ')}). Merge or remove duplicates before saving.
                            </div>
                        )}

                        {hasTargets && !isSumValid && duplicateSymbols.length === 0 && (
                            <div className={styles.warningBanner}>
                                <span>
                                    Target allocations currently sum to <strong>{totalTargetPercent.toFixed(1)}%</strong> instead of 100%. Use <strong>Normalize to 100%</strong> or adjust weights manually.
                                </span>
                            </div>
                        )}

                        <div className={styles.tableResponsive}>
                            <table className={styles.table}>
                                <thead>
                                    <tr>
                                        <th>Symbol</th>
                                        <th>Target Allocation (%)</th>
                                        <th>Glide Path (%/yr)*</th>
                                        <th style={{ width: '52px' }} aria-label="Remove row" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {targets.length === 0 ? (
                                        <tr>
                                            <td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '1.75rem 1rem' }}>
                                                No target allocations defined yet. Click <strong>Seed from Holdings</strong> or <strong>+ Add Asset</strong> to get started.
                                            </td>
                                        </tr>
                                    ) : (
                                        targets.map((t, i) => {
                                            const filteredPortSymbols = getFilteredPortfolioSymbols(t.symbol);
                                            return (
                                                <tr key={i}>
                                                    <td>
                                                        <div className={styles.autocompleteWrap}>
                                                            <input
                                                                className={styles.input}
                                                                value={t.symbol}
                                                                placeholder="e.g. VFV.TO"
                                                                aria-label={`Symbol row ${i + 1}`}
                                                                onChange={(e) => {
                                                                    handleTargetChange(i, 'symbol', e.target.value);
                                                                    setSearchQuery(e.target.value);
                                                                }}
                                                                onFocus={() => {
                                                                    setActiveSearchIndex(i);
                                                                    setSearchQuery(t.symbol);
                                                                }}
                                                                onBlur={() => {
                                                                    setTimeout(() => {
                                                                        setActiveSearchIndex((curr) => (curr === i ? null : curr));
                                                                    }, 180);
                                                                }}
                                                            />
                                                            {activeSearchIndex === i && (
                                                                <div className={styles.autocompleteMenu}>
                                                                    {filteredPortSymbols.length > 0 && (
                                                                        <div>
                                                                            <div className={styles.autocompleteSectionTitle}>
                                                                                Portfolio Symbols
                                                                            </div>
                                                                            {filteredPortSymbols.map((sym) => (
                                                                                <button
                                                                                    key={sym}
                                                                                    type="button"
                                                                                    className={styles.autocompleteOption}
                                                                                    onMouseDown={(e) => {
                                                                                        e.preventDefault();
                                                                                        handleTargetChange(i, 'symbol', sym);
                                                                                        setActiveSearchIndex(null);
                                                                                    }}
                                                                                >
                                                                                    <strong>{sym}</strong>
                                                                                    <span className={styles.autocompleteName}>Held</span>
                                                                                </button>
                                                                            ))}
                                                                        </div>
                                                                    )}

                                                                    {visibleSearchResults.length > 0 && (
                                                                        <div>
                                                                            <div className={styles.autocompleteSectionTitle}>
                                                                                Global Search
                                                                            </div>
                                                                            {visibleSearchResults.map((res) => (
                                                                                <button
                                                                                    key={res.symbol}
                                                                                    type="button"
                                                                                    className={styles.autocompleteOption}
                                                                                    onMouseDown={(e) => {
                                                                                        e.preventDefault();
                                                                                        handleTargetChange(i, 'symbol', res.symbol);
                                                                                        setActiveSearchIndex(null);
                                                                                    }}
                                                                                >
                                                                                    <strong>{res.symbol}</strong>
                                                                                    <span className={styles.autocompleteName}>{res.name}</span>
                                                                                </button>
                                                                            ))}
                                                                        </div>
                                                                    )}

                                                                    {filteredPortSymbols.length === 0 && visibleSearchResults.length === 0 && (
                                                                        <div style={{ padding: '0.6rem', fontSize: '0.82rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
                                                                            No matching symbols
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td>
                                                        <input
                                                            type="number"
                                                            min={0}
                                                            max={100}
                                                            step="0.1"
                                                            className={styles.input}
                                                            value={t.targetPercentage}
                                                            aria-label={`Target percentage for ${t.symbol || `row ${i + 1}`}`}
                                                            onChange={(e) => handleTargetChange(i, 'targetPercentage', e.target.value)}
                                                        />
                                                    </td>
                                                    <td>
                                                        <input
                                                            type="number"
                                                            step="0.1"
                                                            className={styles.input}
                                                            value={t.yearlyDriftAdjustment ?? ''}
                                                            placeholder="e.g. -0.5"
                                                            aria-label={`Yearly glide path adjustment for ${t.symbol || `row ${i + 1}`}`}
                                                            onChange={(e) => handleTargetChange(i, 'yearlyDriftAdjustment', e.target.value)}
                                                        />
                                                    </td>
                                                    <td>
                                                        <button
                                                            type="button"
                                                            className={styles.iconDeleteBtn}
                                                            onClick={() => removeTargetRow(i)}
                                                            aria-label={`Remove ${t.symbol || `row ${i + 1}`}`}
                                                            title="Remove asset"
                                                        >
                                                            <MdDeleteOutline size={20} aria-hidden="true" />
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>

                        <div className={styles.studioFooter}>
                            <button
                                type="button"
                                className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                onClick={addTargetRow}
                            >
                                <MdAdd size={18} aria-hidden="true" />
                                Add Asset
                            </button>
                            <small className={styles.fieldHint}>
                                *Glide path shifts each target automatically each year via the scheduled adjustment job.
                            </small>
                        </div>
                    </section>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
