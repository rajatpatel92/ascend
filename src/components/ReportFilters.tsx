
'use client';

import { useState, useEffect } from 'react';
import styles from './ReportFilters.module.css';
import { MdFilterList, MdClose } from 'react-icons/md';

export interface FilterOptions {
    accountTypes: string[];
    investmentTypes: string[];
}

interface ReportFiltersProps {
    onChange: (filters: FilterOptions) => void;
    initialFilters?: FilterOptions;
}

export default function ReportFilters({ onChange, initialFilters }: ReportFiltersProps) {
    const [isOpen, setIsOpen] = useState(false);

    // Available Options
    const [availableAccTypes, setAvailableAccTypes] = useState<string[]>([]);
    const [availableInvTypes, setAvailableInvTypes] = useState<string[]>([]);

    // Selected Options
    const [selectedAccTypes, setSelectedAccTypes] = useState<string[]>(initialFilters?.accountTypes || []);
    const [selectedInvTypes, setSelectedInvTypes] = useState<string[]>(initialFilters?.investmentTypes || []);

    useEffect(() => {
        if (initialFilters) {
            setSelectedAccTypes(initialFilters.accountTypes);
            setSelectedInvTypes(initialFilters.investmentTypes);
        }
    }, [initialFilters]);

    useEffect(() => {
        // Fetch Metadata to populate filters
        // Parallel fetch for types
        Promise.all([
            fetch('/api/settings/account-types').then(res => res.json()),
            fetch('/api/settings/investment-types').then(res => res.json())
        ]).then(([accs, invs]) => {
            const accTypes = (accs as { name: string }[]).map(a => a.name);
            const invTypes = (invs as { name: string }[]).map(i => i.name);

            setAvailableAccTypes(accTypes);
            setAvailableInvTypes(invTypes);

            // Default select all ONLY if no initial filters provided (or meaningless empty)
            // But we should respect empty array if it means "none selected" - though usually we want all.
            // A truly "fresh" state usually means Select All.
            if (!initialFilters) {
                setSelectedAccTypes(accTypes);
                setSelectedInvTypes(invTypes);

                // Initial notify only if we are setting defaults
                if (onChange) onChange({ accountTypes: accTypes, investmentTypes: invTypes });
            }
        });
    }, []); // Run once on mount

    const handleApply = () => {
        onChange({
            accountTypes: selectedAccTypes,
            investmentTypes: selectedInvTypes
        });
        setIsOpen(false);
    };

    const toggleAcc = (type: string) => {
        setSelectedAccTypes(prev =>
            prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
        );
    };

    const toggleInv = (type: string) => {
        setSelectedInvTypes(prev =>
            prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
        );
    };

    const invertAcc = () => {
        setSelectedAccTypes(prev => availableAccTypes.filter(t => !prev.includes(t)));
    };

    const invertInv = () => {
        setSelectedInvTypes(prev => availableInvTypes.filter(t => !prev.includes(t)));
    };

    const isFilterActive = 
        (availableAccTypes.length > 0 && selectedAccTypes.length < availableAccTypes.length) ||
        (availableInvTypes.length > 0 && selectedInvTypes.length < availableInvTypes.length);

    return (
        <div className={styles.container}>
            <button className={styles.filterBtn} onClick={() => setIsOpen(!isOpen)}>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <MdFilterList size={20} />
                    {isFilterActive && (
                        <span style={{
                            position: 'absolute',
                            top: '-2px',
                            right: '-2px',
                            width: '8px',
                            height: '8px',
                            backgroundColor: '#3b82f6', // primary blue
                            borderRadius: '50%',
                            border: '1px solid var(--card-bg)'
                        }} />
                    )}
                </div>
                <span>Filters</span>
            </button>

            {isOpen && (
                <div className={styles.popover}>
                    <div className={styles.header}>
                        <h3>Filter Analysis</h3>
                        <button onClick={() => setIsOpen(false)}><MdClose /></button>
                    </div>

                    <div className={styles.section}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <h4>Account Types</h4>
                            <button onClick={invertAcc} className={styles.linkBtn} style={{ fontSize: '0.8rem', color: 'var(--primary-color)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                                Inverse
                            </button>
                        </div>
                        <div className={styles.grid}>
                            {availableAccTypes.map(type => (
                                <label key={type} className={styles.checkbox}>
                                    <input
                                        type="checkbox"
                                        checked={selectedAccTypes.includes(type)}
                                        onChange={() => toggleAcc(type)}
                                    />
                                    {type}
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className={styles.section}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                            <h4>Investment Types</h4>
                            <button onClick={invertInv} className={styles.linkBtn} style={{ fontSize: '0.8rem', color: 'var(--primary-color)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                                Inverse
                            </button>
                        </div>
                        <div className={styles.grid}>
                            {availableInvTypes.map(type => (
                                <label key={type} className={styles.checkbox}>
                                    <input
                                        type="checkbox"
                                        checked={selectedInvTypes.includes(type)}
                                        onChange={() => toggleInv(type)}
                                    />
                                    {type}
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className={styles.actions}>
                        <button className={styles.applyBtn} onClick={handleApply}>Apply Filters</button>
                    </div>
                </div>
            )}
        </div>
    );
}
