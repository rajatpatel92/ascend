'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    MdAdd,
    MdAutoFixHigh,
    MdBalance,
    MdDeleteOutline,
    MdDownload,
    MdFastForward,
    MdPlayArrow,
    MdSave
} from 'react-icons/md';
import styles from '../page.module.css';
import type { TargetConfig } from '@/lib/rebalance-planner';
import {
    validateGlidePathSchedule,
    type CategoryTargetConfig,
    type RebalanceDimension,
    type RebalanceProfile
} from '@/lib/rebalance-extensions';

interface SearchSuggestion {
    symbol: string;
    name: string;
}

interface RebalancerConfigPanelProps {
    isOpen: boolean;
    dimension: RebalanceDimension;
    onChangeDimension: (dimension: RebalanceDimension) => void;
    targets: TargetConfig[];
    categoryTargets: CategoryTargetConfig[];
    portfolioSymbols: string[];
    availableInvestmentTypes: string[];
    profiles: RebalanceProfile[];
    activeProfileId: string;
    bindFiltersToProfile: boolean;
    onToggleBindFilters: (bound: boolean) => void;
    onSelectProfile: (profileId: string) => void;
    onSaveAsNewProfile: (name: string) => void;
    onDeleteProfile: (profileId: string) => void;
    isSaving: boolean;
    isApplyingGlide: boolean;
    onChangeTargets: (targets: TargetConfig[]) => void;
    onChangeCategoryTargets: (targets: CategoryTargetConfig[]) => void;
    onSeedFromHoldings: () => void;
    onEqualWeight: () => void;
    onApplyCategoryTemplate: (template: '80_20' | '60_40') => void;
    onNormalizeTargets: () => void;
    onSimulateGlideStep: () => void;
    onApplyGlideStepNow: () => void;
    onSaveTargets: () => void;
}

export default function RebalancerConfigPanel({
    isOpen,
    dimension,
    onChangeDimension,
    targets,
    categoryTargets,
    portfolioSymbols,
    availableInvestmentTypes,
    profiles,
    activeProfileId,
    bindFiltersToProfile,
    onToggleBindFilters,
    onSelectProfile,
    onSaveAsNewProfile,
    onDeleteProfile,
    isSaving,
    isApplyingGlide,
    onChangeTargets,
    onChangeCategoryTargets,
    onSeedFromHoldings,
    onEqualWeight,
    onApplyCategoryTemplate,
    onNormalizeTargets,
    onSimulateGlideStep,
    onApplyGlideStepNow,
    onSaveTargets
}: RebalancerConfigPanelProps) {
    const [activeSearchIndex, setActiveSearchIndex] = useState<number | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchSuggestion[]>([]);
    const [isCreatingProfile, setIsCreatingProfile] = useState(false);
    const [newProfileName, setNewProfileName] = useState('');

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

    const totalTickerPercent = useMemo(
        () => targets.reduce((sum, t) => sum + (Number.isFinite(t.targetPercentage) ? t.targetPercentage : 0), 0),
        [targets]
    );

    const totalCategoryPercent = useMemo(
        () => categoryTargets.reduce((sum, t) => sum + (Number.isFinite(t.targetPercentage) ? t.targetPercentage : 0), 0),
        [categoryTargets]
    );

    const activeTotalPercent = dimension === 'CATEGORY' ? totalCategoryPercent : totalTickerPercent;

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

    const duplicateCategories = useMemo(() => {
        const seen = new Set<string>();
        const dupes = new Set<string>();
        for (const ct of categoryTargets) {
            const key = ct.investmentType.trim().toUpperCase();
            if (!key) continue;
            if (seen.has(key)) dupes.add(ct.investmentType.trim());
            seen.add(key);
        }
        return Array.from(dupes);
    }, [categoryTargets]);

    const activeDuplicates = dimension === 'CATEGORY' ? duplicateCategories : duplicateSymbols;

    const glideReport = useMemo(() => validateGlidePathSchedule(targets), [targets]);

    const mergedInvestmentTypes = useMemo(() => {
        const set = new Set<string>(availableInvestmentTypes);
        categoryTargets.forEach((ct) => {
            if (ct.investmentType.trim()) set.add(ct.investmentType.trim());
        });
        if (set.size === 0) {
            ['ETF', 'Stock', 'Bond', 'Cash'].forEach((t) => set.add(t));
        }
        return Array.from(set).sort();
    }, [availableInvestmentTypes, categoryTargets]);

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

    const handleCategoryChange = (index: number, field: keyof CategoryTargetConfig, value: string) => {
        const next = categoryTargets.map((item, i) => {
            if (i !== index) return item;
            if (field === 'investmentType') {
                return { ...item, investmentType: value };
            }
            const num = parseFloat(value);
            return { ...item, targetPercentage: Number.isNaN(num) ? 0 : Math.max(0, num) };
        });
        onChangeCategoryTargets(next);
    };

    const addTargetRow = () => {
        onChangeTargets([...targets, { symbol: '', targetPercentage: 0, yearlyDriftAdjustment: null }]);
    };

    const removeTargetRow = (index: number) => {
        onChangeTargets(targets.filter((_, i) => i !== index));
    };

    const addCategoryRow = () => {
        const unused = mergedInvestmentTypes.find(
            (typeName) => !categoryTargets.some((ct) => ct.investmentType.toUpperCase() === typeName.toUpperCase())
        );
        onChangeCategoryTargets([
            ...categoryTargets,
            { investmentType: unused || mergedInvestmentTypes[0] || 'ETF', targetPercentage: 0 }
        ]);
    };

    const removeCategoryRow = (index: number) => {
        onChangeCategoryTargets(categoryTargets.filter((_, i) => i !== index));
    };

    const submitNewProfile = () => {
        const trimmed = newProfileName.trim();
        if (!trimmed) return;
        onSaveAsNewProfile(trimmed);
        setNewProfileName('');
        setIsCreatingProfile(false);
    };

    const isSumValid = Math.abs(activeTotalPercent - 100) < 0.05;
    const hasActiveRows = dimension === 'CATEGORY'
        ? categoryTargets.some((c) => c.investmentType.trim() !== '')
        : targets.some((t) => t.symbol.trim() !== '');

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
                                    Manage saved strategy profiles, assign ticker or asset-class targets, and preview annual glide shifts.
                                </p>
                            </div>

                            <div className={styles.studioActions}>
                                <div className={styles.modeToggle} role="group" aria-label="Target editing dimension" style={{ minWidth: '210px' }}>
                                    <button
                                        type="button"
                                        className={styles.modeBtn}
                                        aria-pressed={dimension === 'TICKER'}
                                        onClick={() => onChangeDimension('TICKER')}
                                    >
                                        By Ticker
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.modeBtn}
                                        aria-pressed={dimension === 'CATEGORY'}
                                        onClick={() => onChangeDimension('CATEGORY')}
                                    >
                                        By Asset Type
                                    </button>
                                </div>

                                <span
                                    className={`${styles.statusPill} ${
                                        isSumValid
                                            ? styles.statusPositive
                                            : activeTotalPercent === 0
                                                ? styles.statusNeutral
                                                : styles.statusWarning
                                    }`}
                                >
                                    Allocated: {activeTotalPercent.toFixed(1)}%
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

                                <button
                                    type="button"
                                    className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                    onClick={onEqualWeight}
                                    disabled={portfolioSymbols.length === 0 && !hasActiveRows}
                                    title="Split 100% equally across active rows or current holdings"
                                >
                                    <MdBalance size={16} aria-hidden="true" />
                                    Equal Weight
                                </button>

                                {dimension === 'CATEGORY' && (
                                    <>
                                        <button
                                            type="button"
                                            className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                            onClick={() => onApplyCategoryTemplate('80_20')}
                                            title="Apply classic 80% Equities / 20% Fixed Income & Cash template"
                                        >
                                            80/20 Growth
                                        </button>
                                        <button
                                            type="button"
                                            className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                            onClick={() => onApplyCategoryTemplate('60_40')}
                                            title="Apply balanced 60% Equities / 40% Fixed Income & Cash template"
                                        >
                                            60/40 Balanced
                                        </button>
                                    </>
                                )}

                                {!isSumValid && activeTotalPercent > 0 && (
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
                                    disabled={isSaving || activeDuplicates.length > 0}
                                >
                                    <MdSave size={18} aria-hidden="true" />
                                    {isSaving ? 'Saving...' : 'Save Profile'}
                                </button>
                            </div>
                        </div>

                        {/* Profile Switcher & Account Filter Binding Bar */}
                        <div className={styles.profileBar}>
                            <div className={styles.profileBarLeft}>
                                <label htmlFor="studio-profile-select" className={styles.profileLabel}>
                                    Active Profile
                                </label>
                                <select
                                    id="studio-profile-select"
                                    className={styles.profileSelect}
                                    value={activeProfileId}
                                    onChange={(e) => onSelectProfile(e.target.value)}
                                >
                                    {profiles.map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name} ({p.dimension === 'CATEGORY' ? 'Asset Type' : 'Ticker'})
                                        </option>
                                    ))}
                                </select>

                                {!isCreatingProfile ? (
                                    <button
                                        type="button"
                                        className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                        onClick={() => setIsCreatingProfile(true)}
                                    >
                                        <MdAdd size={16} aria-hidden="true" />
                                        Save as New Profile
                                    </button>
                                ) : (
                                    <div className={styles.newProfileForm}>
                                        <input
                                            type="text"
                                            className={styles.compactInput}
                                            value={newProfileName}
                                            placeholder="e.g. TFSA Growth"
                                            aria-label="New profile name"
                                            onChange={(e) => setNewProfileName(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    submitNewProfile();
                                                }
                                            }}
                                        />
                                        <button
                                            type="button"
                                            className={`${styles.primaryBtn} ${styles.compactBtn}`}
                                            onClick={submitNewProfile}
                                            disabled={!newProfileName.trim() || isSaving}
                                        >
                                            Create
                                        </button>
                                        <button
                                            type="button"
                                            className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                            onClick={() => {
                                                setIsCreatingProfile(false);
                                                setNewProfileName('');
                                            }}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                )}

                                {profiles.length > 1 && (
                                    <button
                                        type="button"
                                        className={styles.iconDeleteBtn}
                                        onClick={() => onDeleteProfile(activeProfileId)}
                                        disabled={isSaving}
                                        title="Delete selected profile"
                                        aria-label="Delete selected profile"
                                    >
                                        <MdDeleteOutline size={18} aria-hidden="true" />
                                    </button>
                                )}
                            </div>

                            <label className={styles.bindFilterCheck}>
                                <input
                                    type="checkbox"
                                    checked={bindFiltersToProfile}
                                    onChange={(e) => onToggleBindFilters(e.target.checked)}
                                />
                                <span>Bind current Account &amp; Investment filters to this profile</span>
                            </label>
                        </div>

                        {activeDuplicates.length > 0 && (
                            <div role="alert" className={styles.errorBanner} style={{ marginBottom: 0 }}>
                                Duplicate entries detected ({activeDuplicates.join(', ')}). Merge or remove duplicates before saving.
                            </div>
                        )}

                        {hasActiveRows && !isSumValid && activeDuplicates.length === 0 && (
                            <div className={styles.warningBanner}>
                                <span>
                                    Target allocations currently sum to <strong>{activeTotalPercent.toFixed(1)}%</strong> instead of 100%. Use <strong>Normalize to 100%</strong> or adjust weights manually.
                                </span>
                            </div>
                        )}

                        {dimension === 'TICKER' && glideReport.activeCount > 0 && (
                            <div className={styles.glideStatusStrip}>
                                <div className={styles.glideStatusMeta}>
                                    <span className={`${styles.statusPill} ${styles.statusNeutral}`}>
                                        {glideReport.activeCount} Active Glide Rule{glideReport.activeCount === 1 ? '' : 's'}
                                    </span>
                                    <span className={styles.glideMetaItem}>
                                        Last Adjusted: <strong>{glideReport.lastAdjustedDate ?? 'Initial Baseline'}</strong>
                                    </span>
                                    <span className={styles.glideMetaItem}>
                                        Next Scheduled Shift: <strong>{glideReport.nextAdjustmentDate ?? 'After First Save'}</strong>
                                    </span>
                                    {glideReport.hasNetDriftWarning ? (
                                        <span className={`${styles.statusPill} ${styles.statusWarning}`}>
                                            Net Glide Shift: {glideReport.netAnnualDrift > 0 ? '+' : ''}{glideReport.netAnnualDrift}%/yr (target total will drift from 100%)
                                        </span>
                                    ) : (
                                        <span className={`${styles.statusPill} ${styles.statusPositive}`}>
                                            Net Glide Shift: 0.0%/yr (Balanced)
                                        </span>
                                    )}
                                </div>

                                <div className={styles.glideStatusActions}>
                                    <button
                                        type="button"
                                        className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                        onClick={onSimulateGlideStep}
                                        title="Preview a +1 year glide-path shift in the editor without saving"
                                    >
                                        <MdFastForward size={16} aria-hidden="true" />
                                        Simulate +1 Yr Step
                                    </button>
                                    <button
                                        type="button"
                                        className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                        onClick={onApplyGlideStepNow}
                                        disabled={isApplyingGlide}
                                        title="Apply a +1 year glide-path shift to saved targets immediately"
                                    >
                                        <MdPlayArrow size={16} aria-hidden="true" />
                                        {isApplyingGlide ? 'Applying...' : 'Apply +1 Yr Now'}
                                    </button>
                                </div>
                            </div>
                        )}

                        {dimension === 'TICKER' ? (
                            <>
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
                                                        No ticker targets defined yet. Click <strong>Seed from Holdings</strong> or <strong>+ Add Asset</strong> to get started.
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
                            </>
                        ) : (
                            <>
                                <div className={styles.tableResponsive}>
                                    <table className={styles.table}>
                                        <thead>
                                            <tr>
                                                <th>Asset Type</th>
                                                <th>Target Allocation (%)</th>
                                                <th style={{ width: '52px' }} aria-label="Remove row" />
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {categoryTargets.length === 0 ? (
                                                <tr>
                                                    <td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '1.75rem 1rem' }}>
                                                        No Asset Type targets defined yet. Click <strong>Seed from Holdings</strong>, <strong>80/20 Growth</strong>, or <strong>+ Add Asset Type</strong>.
                                                    </td>
                                                </tr>
                                            ) : (
                                                categoryTargets.map((ct, i) => (
                                                    <tr key={i}>
                                                        <td>
                                                            <select
                                                                className={styles.input}
                                                                value={ct.investmentType}
                                                                aria-label={`Asset type row ${i + 1}`}
                                                                onChange={(e) => handleCategoryChange(i, 'investmentType', e.target.value)}
                                                            >
                                                                {mergedInvestmentTypes.map((typeName) => (
                                                                    <option key={typeName} value={typeName}>
                                                                        {typeName}
                                                                    </option>
                                                                ))}
                                                            </select>
                                                        </td>
                                                        <td>
                                                            <input
                                                                type="number"
                                                                min={0}
                                                                max={100}
                                                                step="0.1"
                                                                className={styles.input}
                                                                value={ct.targetPercentage}
                                                                aria-label={`Target percentage for ${ct.investmentType || `row ${i + 1}`}`}
                                                                onChange={(e) => handleCategoryChange(i, 'targetPercentage', e.target.value)}
                                                            />
                                                        </td>
                                                        <td>
                                                            <button
                                                                type="button"
                                                                className={styles.iconDeleteBtn}
                                                                onClick={() => removeCategoryRow(i)}
                                                                aria-label={`Remove ${ct.investmentType || `row ${i + 1}`}`}
                                                                title="Remove asset type"
                                                            >
                                                                <MdDeleteOutline size={20} aria-hidden="true" />
                                                            </button>
                                                        </td>
                                                    </tr>
                                                ))
                                            )}
                                        </tbody>
                                    </table>
                                </div>

                                <div className={styles.studioFooter}>
                                    <button
                                        type="button"
                                        className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                        onClick={addCategoryRow}
                                    >
                                        <MdAdd size={18} aria-hidden="true" />
                                        Add Asset Type
                                    </button>
                                    <small className={styles.fieldHint}>
                                        Asset Type targets group all holdings sharing the same Investment Type and distribute trades pro-rata across constituent tickers.
                                    </small>
                                </div>
                            </>
                        )}
                    </section>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
