'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
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
    const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});

    // Available Options
    const [availableAccTypes, setAvailableAccTypes] = useState<string[]>([]);
    const [availableInvTypes, setAvailableInvTypes] = useState<string[]>([]);

    // Selected Options
    const [selectedAccTypes, setSelectedAccTypes] = useState<string[]>(initialFilters?.accountTypes || []);
    const [selectedInvTypes, setSelectedInvTypes] = useState<string[]>(initialFilters?.investmentTypes || []);
    const [prevInitialFilters, setPrevInitialFilters] = useState<FilterOptions | undefined>(initialFilters);

    const containerRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const onChangeRef = useRef(onChange);
    const hasInitialFiltersOnMount = useRef(Boolean(initialFilters));

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    // Sync local selections when initialFilters prop updates from parent state
    if (initialFilters !== prevInitialFilters) {
        setPrevInitialFilters(initialFilters);
        if (initialFilters) {
            setSelectedAccTypes(initialFilters.accountTypes);
            setSelectedInvTypes(initialFilters.investmentTypes);
        }
    }

    useEffect(() => {
        const controller = new AbortController();

        Promise.all([
            fetch('/api/settings/account-types', { signal: controller.signal }).then(res => res.json()),
            fetch('/api/settings/investment-types', { signal: controller.signal }).then(res => res.json())
        ])
            .then(([accs, invs]) => {
                if (controller.signal.aborted) return;

                const accTypes = (accs as { name: string }[]).map(a => a.name);
                const invTypes = (invs as { name: string }[]).map(i => i.name);

                setAvailableAccTypes(accTypes);
                setAvailableInvTypes(invTypes);

                if (!hasInitialFiltersOnMount.current) {
                    setSelectedAccTypes(accTypes);
                    setSelectedInvTypes(invTypes);
                    onChangeRef.current?.({ accountTypes: accTypes, investmentTypes: invTypes });
                }
            })
            .catch((err: unknown) => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                console.error('Failed to load filter options:', err);
            });

        return () => controller.abort();
    }, []);

    const computePopoverStyle = useCallback((): React.CSSProperties => {
        const containerEl = containerRef.current;
        const triggerEl = buttonRef.current ?? containerEl;
        if (!containerEl || !triggerEl || typeof window === 'undefined') {
            return {};
        }

        const anchorRect = containerEl.getBoundingClientRect();
        const triggerRect = triggerEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const margin = 12;
        const gap = 8;
        const popoverWidth = Math.min(320, Math.max(220, vw - margin * 2));

        // Align left edge when trigger is in the left half (e.g., wrapped on mobile),
        // align right edge when trigger is in the right half, and clamp strictly within viewport.
        const isLeftHalf = triggerRect.left + triggerRect.width / 2 < vw / 2;
        const idealLeft = isLeftHalf ? triggerRect.left : triggerRect.right - popoverWidth;
        const clampedLeft = Math.max(margin, Math.min(idealLeft, vw - popoverWidth - margin));

        const spaceBelow = vh - triggerRect.bottom - gap - margin;
        const spaceAbove = triggerRect.top - gap - margin;
        const flipUp = spaceBelow < 260 && spaceAbove > spaceBelow;
        const availableVertical = flipUp ? spaceAbove : spaceBelow;
        const maxHeight = Math.min(480, Math.max(200, availableVertical));

        return {
            width: `${popoverWidth}px`,
            left: `${clampedLeft - anchorRect.left}px`,
            right: 'auto',
            top: flipUp ? 'auto' : `calc(100% + ${gap}px)`,
            bottom: flipUp ? `calc(100% + ${gap}px)` : 'auto',
            maxHeight: `${maxHeight}px`
        };
    }, []);

    useEffect(() => {
        if (!isOpen) return;

        const handleResize = () => {
            setPopoverStyle(computePopoverStyle());
        };

        const handleOutside = (event: MouseEvent | TouchEvent) => {
            const target = event.target as Node | null;
            if (target && containerRef.current && !containerRef.current.contains(target)) {
                setIsOpen(false);
            }
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsOpen(false);
                buttonRef.current?.focus();
            }
        };

        window.addEventListener('resize', handleResize);
        document.addEventListener('mousedown', handleOutside);
        document.addEventListener('touchstart', handleOutside);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('resize', handleResize);
            document.removeEventListener('mousedown', handleOutside);
            document.removeEventListener('touchstart', handleOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, computePopoverStyle]);

    const handleToggle = () => {
        if (!isOpen) {
            setPopoverStyle(computePopoverStyle());
            setIsOpen(true);
        } else {
            setIsOpen(false);
        }
    };

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
        <div
            ref={containerRef}
            className={`${styles.container} ${isOpen ? styles.containerOpen : ''}`}
        >
            <button
                ref={buttonRef}
                type="button"
                className={styles.filterBtn}
                onClick={handleToggle}
                aria-expanded={isOpen}
            >
                <div className={styles.iconWrap}>
                    <MdFilterList size={20} aria-hidden="true" />
                    {isFilterActive && <span className={styles.activeDot} aria-hidden="true" />}
                </div>
                <span>Filters</span>
            </button>

            {isOpen && (
                <div className={styles.popover} style={popoverStyle}>
                    <div className={styles.header}>
                        <h3>Filter Analysis</h3>
                        <button
                            type="button"
                            className={styles.closeBtn}
                            onClick={() => setIsOpen(false)}
                            aria-label="Close filters"
                        >
                            <MdClose aria-hidden="true" />
                        </button>
                    </div>

                    <div className={styles.section}>
                        <div className={styles.sectionHead}>
                            <h4>Account Types</h4>
                            <button type="button" onClick={invertAcc} className={styles.linkBtn}>
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
                                    <span>{type}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className={styles.section}>
                        <div className={styles.sectionHead}>
                            <h4>Investment Types</h4>
                            <button type="button" onClick={invertInv} className={styles.linkBtn}>
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
                                    <span>{type}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className={styles.actions}>
                        <button type="button" className={styles.applyBtn} onClick={handleApply}>
                            Apply Filters
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
