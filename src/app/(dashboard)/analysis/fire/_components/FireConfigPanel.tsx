'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    MdAdd,
    MdDeleteOutline,
    MdRestartAlt,
    MdSave
} from 'react-icons/md';
import styles from '../page.module.css';
import type {
    FireCalculationMode,
    FireProfile,
    FireSimulationParams
} from '@/lib/fire-profiles';

const SWR_PRESETS = [3.5, 4.0, 4.5] as const;

interface FireConfigPanelProps {
    isOpen: boolean;
    currency: string;
    params: FireSimulationParams;
    profiles: FireProfile[];
    activeProfileId: string;
    hasUnsavedChanges: boolean;
    isSaving: boolean;
    effectiveFireDate: string;
    isPastDateClamped: boolean;
    formattedEffectiveFireDate: string;
    formattedFutureMonthlyExpense: string;
    formattedRequiredFireNumber: string;
    fireYear: number;
    effectiveSwr: number;
    realReturnPct: number;
    onChangeParam: <K extends keyof FireSimulationParams>(
        key: K,
        value: FireSimulationParams[K]
    ) => void;
    onSelectProfile: (profileId: string) => void;
    onSaveProfile: () => void;
    onSaveAsNewProfile: (name: string) => void;
    onDeleteProfile: (profileId: string) => void;
    onResetToProfile: () => void;
}

export default function FireConfigPanel({
    isOpen,
    currency,
    params,
    profiles,
    activeProfileId,
    hasUnsavedChanges,
    isSaving,
    isPastDateClamped,
    formattedEffectiveFireDate,
    formattedFutureMonthlyExpense,
    formattedRequiredFireNumber,
    fireYear,
    effectiveSwr,
    realReturnPct,
    onChangeParam,
    onSelectProfile,
    onSaveProfile,
    onSaveAsNewProfile,
    onDeleteProfile,
    onResetToProfile
}: FireConfigPanelProps) {
    const [isCreatingProfile, setIsCreatingProfile] = useState(false);
    const [newProfileName, setNewProfileName] = useState('');

    const activeProfile = profiles.find((p) => p.id === activeProfileId);

    const submitNewProfile = () => {
        const trimmed = newProfileName.trim();
        if (!trimmed) return;
        onSaveAsNewProfile(trimmed);
        setNewProfileName('');
        setIsCreatingProfile(false);
    };

    const handleModeChange = (mode: FireCalculationMode) => {
        onChangeParam('calculationMode', mode);
    };

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
                    <section
                        className={styles.panelCard}
                        aria-label="FIRE simulation parameters and saved profiles"
                    >
                        <div className={styles.studioHeader}>
                            <div>
                                <h2 id="fire-params-heading" className={styles.panelHeading}>
                                    Simulation Parameters
                                </h2>
                                <p className={styles.panelSubheading}>
                                    Tune growth assumptions, retirement expenses, and withdrawal rules across saved FIRE profiles.
                                </p>
                            </div>

                            <div className={styles.studioActions}>
                                {profiles.length > 0 && (
                                    <span
                                        className={`${styles.statusPill} ${
                                            hasUnsavedChanges ? styles.statusWarning : styles.statusPositive
                                        }`}
                                    >
                                        {hasUnsavedChanges
                                            ? 'Unsaved Changes'
                                            : `Saved (${activeProfile?.currency || currency})`}
                                    </span>
                                )}

                                {hasUnsavedChanges && activeProfile && (
                                    <button
                                        type="button"
                                        className={`${styles.secondaryBtn} ${styles.compactBtn}`}
                                        onClick={onResetToProfile}
                                        disabled={isSaving}
                                        title="Discard unsaved edits and restore saved profile parameters"
                                    >
                                        <MdRestartAlt size={16} aria-hidden="true" />
                                        Reset
                                    </button>
                                )}

                                <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={onSaveProfile}
                                    disabled={isSaving}
                                >
                                    <MdSave size={18} aria-hidden="true" />
                                    {isSaving ? 'Saving...' : 'Save Profile'}
                                </button>
                            </div>
                        </div>

                        {/* Profile Switcher & Creation Bar */}
                        <div className={styles.profileBar}>
                            <div className={styles.profileBarLeft}>
                                <label htmlFor="fire-studio-profile-select" className={styles.profileLabel}>
                                    Active Profile
                                </label>
                                <select
                                    id="fire-studio-profile-select"
                                    className={styles.profileSelect}
                                    value={activeProfileId}
                                    onChange={(e) => onSelectProfile(e.target.value)}
                                    disabled={profiles.length === 0}
                                >
                                    {profiles.length === 0 ? (
                                        <option value="default">Default FIRE Plan ({currency})</option>
                                    ) : (
                                        profiles.map((p) => (
                                            <option key={p.id} value={p.id}>
                                                {p.name} ({p.currency})
                                            </option>
                                        ))
                                    )}
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
                                            placeholder="e.g. Coast FIRE 2038"
                                            aria-label="New FIRE profile name"
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

                            <div className={styles.profileMetaSummary}>
                                <span>
                                    Target: <strong>{formattedEffectiveFireDate}</strong>
                                </span>
                                <span>
                                    Real Return: <strong>{realReturnPct.toFixed(2)}%</strong>
                                </span>
                            </div>
                        </div>

                        <form
                            className={styles.paramGrid}
                            onSubmit={(e) => e.preventDefault()}
                            aria-labelledby="fire-params-heading"
                        >
                            {/* Group 1: Accumulation & Growth */}
                            <fieldset className={styles.fieldset}>
                                <legend className={styles.legend}>Accumulation &amp; Growth</legend>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="fire-target-date">
                                        Target FIRE Date
                                    </label>
                                    <input
                                        id="fire-target-date"
                                        name="fireDate"
                                        type="month"
                                        className={styles.input}
                                        value={params.fireDate}
                                        aria-describedby={isPastDateClamped ? 'fire-date-hint' : undefined}
                                        onChange={(e) => onChangeParam('fireDate', e.target.value)}
                                    />
                                    {isPastDateClamped && (
                                        <p id="fire-date-hint" className={styles.fieldHint}>
                                            Adjusted to {formattedEffectiveFireDate} for forward simulation.
                                        </p>
                                    )}
                                </div>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="fire-monthly-contribution">
                                        Monthly Contribution ({currency})
                                    </label>
                                    <input
                                        id="fire-monthly-contribution"
                                        name="monthlyContribution"
                                        type="number"
                                        min={0}
                                        step={100}
                                        className={styles.input}
                                        value={params.monthlyContribution}
                                        onChange={(e) => onChangeParam('monthlyContribution', Number(e.target.value))}
                                    />
                                </div>

                                <div className={styles.fieldRow}>
                                    <div className={styles.field}>
                                        <label className={styles.label} htmlFor="fire-expected-return">
                                            Return (%)
                                        </label>
                                        <input
                                            id="fire-expected-return"
                                            name="expectedReturn"
                                            type="number"
                                            min={0}
                                            max={25}
                                            step={0.1}
                                            className={styles.input}
                                            value={params.expectedReturn}
                                            onChange={(e) => onChangeParam('expectedReturn', Number(e.target.value))}
                                        />
                                    </div>

                                    <div className={styles.field}>
                                        <label className={styles.label} htmlFor="fire-inflation-rate">
                                            Inflation (%)
                                        </label>
                                        <input
                                            id="fire-inflation-rate"
                                            name="inflationRate"
                                            type="number"
                                            min={0}
                                            max={15}
                                            step={0.1}
                                            className={styles.input}
                                            value={params.inflationRate}
                                            onChange={(e) => onChangeParam('inflationRate', Number(e.target.value))}
                                        />
                                    </div>
                                </div>
                            </fieldset>

                            {/* Group 2: Retirement Lifestyle */}
                            <fieldset className={styles.fieldset}>
                                <legend className={styles.legend}>Retirement Lifestyle</legend>

                                <div className={styles.field}>
                                    <label className={styles.label} htmlFor="fire-monthly-expense">
                                        Monthly Expenses Today ({currency})
                                    </label>
                                    <input
                                        id="fire-monthly-expense"
                                        name="currentMonthlyExpense"
                                        type="number"
                                        min={0}
                                        step={100}
                                        className={styles.input}
                                        value={params.currentMonthlyExpense}
                                        onChange={(e) => onChangeParam('currentMonthlyExpense', Number(e.target.value))}
                                        aria-describedby="fire-expense-hint"
                                    />
                                    <p id="fire-expense-hint" className={styles.fieldHint}>
                                        Inflation-adjusted at FIRE ({fireYear}):{' '}
                                        <strong className={styles.kpiStrong}>
                                            {formattedFutureMonthlyExpense}/mo
                                        </strong>
                                    </p>
                                </div>

                                <div className={styles.lifestyleCallout}>
                                    <span className={styles.lifestyleCalloutLabel}>
                                        Required Capital in {fireYear}
                                    </span>
                                    <strong className={styles.lifestyleCalloutValue}>
                                        {formattedRequiredFireNumber}
                                    </strong>
                                    <span className={styles.fieldHint}>
                                        Based on {effectiveSwr.toFixed(2)}% withdrawal rate and {params.inflationRate.toFixed(1)}% annual inflation.
                                    </span>
                                </div>
                            </fieldset>

                            {/* Group 3: Withdrawal Strategy */}
                            <fieldset className={styles.fieldset}>
                                <legend className={styles.legend}>Withdrawal Strategy</legend>

                                <div className={styles.modeToggle} role="group" aria-label="Withdrawal calculation mode">
                                    <button
                                        type="button"
                                        className={styles.modeBtn}
                                        aria-pressed={params.calculationMode === 'FIXED_RATE'}
                                        onClick={() => handleModeChange('FIXED_RATE')}
                                    >
                                        Fixed Rate (SWR)
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.modeBtn}
                                        aria-pressed={params.calculationMode === 'FIXED_HORIZON'}
                                        onClick={() => handleModeChange('FIXED_HORIZON')}
                                    >
                                        Fixed Horizon
                                    </button>
                                </div>

                                {params.calculationMode === 'FIXED_RATE' ? (
                                    <div className={styles.field}>
                                        <label className={styles.label} htmlFor="fire-swr-input">
                                            Safe Withdrawal Rate (%)
                                        </label>
                                        <input
                                            id="fire-swr-input"
                                            name="withdrawalRate"
                                            type="number"
                                            min={0.5}
                                            max={15}
                                            step={0.1}
                                            className={styles.input}
                                            value={params.withdrawalRate}
                                            onChange={(e) => onChangeParam('withdrawalRate', Number(e.target.value))}
                                        />
                                        <div className={styles.presetRow} role="group" aria-label="Common safe withdrawal rate presets">
                                            {SWR_PRESETS.map((preset) => (
                                                <button
                                                    key={preset}
                                                    type="button"
                                                    className={styles.presetChip}
                                                    aria-pressed={Math.abs(params.withdrawalRate - preset) < 0.05}
                                                    onClick={() => onChangeParam('withdrawalRate', preset)}
                                                >
                                                    {preset.toFixed(1)}%
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <div className={styles.field}>
                                        <label className={styles.label} htmlFor="fire-horizon-input">
                                            Retirement Duration (Years)
                                        </label>
                                        <input
                                            id="fire-horizon-input"
                                            name="withdrawalDuration"
                                            type="number"
                                            min={5}
                                            max={80}
                                            step={1}
                                            className={styles.input}
                                            value={params.withdrawalDuration}
                                            onChange={(e) => onChangeParam('withdrawalDuration', Number(e.target.value))}
                                            aria-describedby="fire-horizon-hint"
                                        />
                                        <p id="fire-horizon-hint" className={styles.fieldHint}>
                                            Implied starting SWR:{' '}
                                            <strong className={styles.kpiStrong}>
                                                {effectiveSwr.toFixed(2)}%
                                            </strong>
                                        </p>
                                    </div>
                                )}
                            </fieldset>
                        </form>
                    </section>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
