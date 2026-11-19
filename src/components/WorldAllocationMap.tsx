'use client';

import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Search, Sparkles, X } from 'lucide-react';
import { useCurrency } from '@/context/CurrencyContext';
import {
    WORLD_COUNTRY_MARKERS,
    WORLD_COUNTRY_SHAPES,
    WORLD_MAP_VIEWBOX,
} from '@/lib/world-map-data';
import {
    canonicalizeMapCountryName,
    computeChoroplethShade,
    prepareCountryMapData,
    type CountryAllocationItem,
} from '@/lib/world-map';
import styles from './WorldAllocationMap.module.css';

interface DataPoint {
    name: string;
    value: number;
}

interface WorldAllocationMapProps {
    title: string;
    subtitle?: string;
    badgeText?: string;
    embedded?: boolean;
    data: DataPoint[];
    onSelect?: (name: string | null, event?: React.MouseEvent) => void;
    selectedName?: string | null;
    isPreConverted?: boolean;
}

interface HoveredCountryState {
    displayName: string;
    item: CountryAllocationItem | null;
    x: number;
    y: number;
}

const ALWAYS_VISIBLE_MICRO_MARKERS = new Set(['Singapore', 'Hong Kong']);

function subscribeTheme(onStoreChange: () => void): () => void {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
        return () => {};
    }
    const observer = new MutationObserver(onStoreChange);
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
}

function getThemeSnapshot(): boolean {
    if (typeof document === 'undefined') return true;
    return document.documentElement.getAttribute('data-theme') === 'dark';
}

function getThemeServerSnapshot(): boolean {
    return true;
}

export default function WorldAllocationMap(props: WorldAllocationMapProps) {
    const {
        title,
        subtitle,
        badgeText,
        embedded = false,
        data,
        onSelect,
        selectedName,
        isPreConverted = true,
    } = props;

    const { format, convert } = useCurrency();
    const [searchQuery, setSearchQuery] = useState('');
    const [hovered, setHovered] = useState<HoveredCountryState | null>(null);
    const isDark = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);
    const viewportRef = useRef<HTMLDivElement | null>(null);

    const { items, byCanonicalName, totalValue, maxValue } = useMemo(
        () => prepareCountryMapData(data, { isPreConverted, convert }),
        [data, isPreConverted, convert]
    );

    const selectedCanonical = useMemo(
        () => (selectedName ? canonicalizeMapCountryName(selectedName) : null),
        [selectedName]
    );

    const selectedEntry = useMemo(
        () => (selectedCanonical ? byCanonicalName.get(selectedCanonical) ?? null : null),
        [byCanonicalName, selectedCanonical]
    );

    const hasActiveSelection = Boolean(selectedEntry);

    const filteredItems = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return items;
        return items.filter(
            (item) =>
                item.name.toLowerCase().includes(q) ||
                item.canonicalName.toLowerCase().includes(q)
        );
    }, [items, searchQuery]);

    const visibleMarkers = useMemo(() => {
        return WORLD_COUNTRY_MARKERS.filter((marker) => {
            const canon = canonicalizeMapCountryName(marker.name);
            return byCanonicalName.has(canon) || ALWAYS_VISIBLE_MICRO_MARKERS.has(canon);
        });
    }, [byCanonicalName]);

    const handleSelectCountry = (rawName: string, event?: React.MouseEvent) => {
        if (!onSelect) return;
        onSelect(rawName === selectedName ? null : rawName, event);
    };

    const handleMouseMove = (
        e: React.MouseEvent<SVGElement>,
        displayName: string,
        item: CountryAllocationItem | null
    ) => {
        const box = viewportRef.current?.getBoundingClientRect();
        if (!box) return;
        const rawX = e.clientX - box.left + 12;
        const rawY = e.clientY - box.top - 54;
        const clampedX = Math.max(8, Math.min(box.width - 185, rawX));
        const clampedY = Math.max(8, Math.min(box.height - 74, rawY));
        setHovered({ displayName, item, x: clampedX, y: clampedY });
    };

    const emptyStroke = isDark ? '#0b1019' : '#ffffff';
    const selectedStroke = isDark ? '#f8fafc' : '#0f172a';

    return (
        <section
            className={`${styles.container} ${embedded ? styles.embedded : ''}`}
            aria-label={title}
        >
            <div className={styles.cardHeader}>
                <div className={styles.titleBlock}>
                    <div className={styles.titleRow}>
                        <h2 className={styles.title}>{title}</h2>
                        {badgeText && (
                            <span className={styles.xrayBadge}>
                                <Sparkles size={12} aria-hidden="true" />
                                {badgeText}
                            </span>
                        )}
                    </div>
                    {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
                </div>

                <div className={styles.headerMeta}>
                    {items.length > 0 && (
                        <div className={styles.totalSummary}>
                            <span className={styles.totalLabel}>
                                {selectedEntry ? selectedEntry.name : 'Total Allocation'}
                            </span>
                            <div className={styles.totalValueRow}>
                                <span className={styles.totalValue}>
                                    {format(selectedEntry ? selectedEntry.value : totalValue)}
                                </span>
                                <span className={styles.totalCount}>
                                    &middot;{' '}
                                    {selectedEntry
                                        ? `${selectedEntry.percent.toFixed(1)}% of Portfolio`
                                        : `${items.length} ${items.length === 1 ? 'Country' : 'Countries'}`}
                                </span>
                            </div>
                        </div>
                    )}

                    {selectedEntry && onSelect && (
                        <button
                            type="button"
                            className={styles.clearSelectionBtn}
                            onClick={(e) => onSelect(null, e)}
                        >
                            Reset selection
                        </button>
                    )}
                </div>
            </div>

            {items.length === 0 ? (
                <div className={styles.empty}>No geographic allocation data available for current filters.</div>
            ) : (
                <div className={styles.masterDetail}>
                    {/* Left Pane: Interactive Choropleth World Map */}
                    <div className={styles.mapCard}>
                        <div
                            ref={viewportRef}
                            className={styles.mapViewport}
                            onMouseLeave={() => setHovered(null)}
                        >
                            <svg
                                viewBox={WORLD_MAP_VIEWBOX}
                                className={styles.worldSvg}
                                role="img"
                                aria-label="World map shaded by invested amount per country"
                            >
                                <line x1="16" y1="264" x2="944" y2="264" className={styles.equatorGuide} />

                                <g>
                                    {WORLD_COUNTRY_SHAPES.map((shape) => {
                                        const canon = canonicalizeMapCountryName(shape.name);
                                        const matched = byCanonicalName.get(canon) ?? null;
                                        const isSelected = Boolean(
                                            selectedCanonical && canon === selectedCanonical
                                        );
                                        const isDimmed = Boolean(hasActiveSelection && !isSelected && matched);
                                        const fill = computeChoroplethShade(
                                            matched?.value ?? 0,
                                            maxValue,
                                            isDark
                                        );

                                        return (
                                            <path
                                                key={shape.name}
                                                d={shape.d}
                                                fill={fill}
                                                stroke={isSelected ? selectedStroke : emptyStroke}
                                                strokeWidth={isSelected ? 1.5 : 0.65}
                                                opacity={isDimmed ? 0.32 : 1}
                                                className={`${styles.countryShape} ${
                                                    matched ? styles.countryInteractive : ''
                                                }`}
                                                onMouseMove={(e) =>
                                                    handleMouseMove(e, matched?.name ?? shape.name, matched)
                                                }
                                                onClick={(e) => {
                                                    if (matched) handleSelectCountry(matched.name, e);
                                                }}
                                            />
                                        );
                                    })}
                                </g>

                                <g>
                                    {visibleMarkers.map((marker) => {
                                        const canon = canonicalizeMapCountryName(marker.name);
                                        const matched = byCanonicalName.get(canon) ?? null;
                                        const isSelected = Boolean(
                                            selectedCanonical && canon === selectedCanonical
                                        );
                                        const isDimmed = Boolean(hasActiveSelection && !isSelected && matched);
                                        const fill = computeChoroplethShade(
                                            matched?.value ?? 0,
                                            maxValue,
                                            isDark
                                        );

                                        return (
                                            <circle
                                                key={`marker-${marker.name}`}
                                                cx={marker.cx}
                                                cy={marker.cy}
                                                r={isSelected ? 5.2 : matched ? 4.2 : 2.8}
                                                fill={fill}
                                                stroke={isSelected ? selectedStroke : emptyStroke}
                                                strokeWidth={isSelected ? 1.5 : 1}
                                                opacity={isDimmed ? 0.35 : 1}
                                                className={`${styles.countryShape} ${
                                                    matched ? styles.countryInteractive : ''
                                                }`}
                                                onMouseMove={(e) =>
                                                    handleMouseMove(e, matched?.name ?? marker.name, matched)
                                                }
                                                onClick={(e) => {
                                                    if (matched) handleSelectCountry(matched.name, e);
                                                }}
                                            />
                                        );
                                    })}
                                </g>
                            </svg>

                            {hovered && (
                                <div
                                    className={styles.tooltip}
                                    style={{ left: `${hovered.x}px`, top: `${hovered.y}px` }}
                                >
                                    <div className={styles.tooltipTitle}>{hovered.displayName}</div>
                                    <div className={styles.tooltipAmount}>
                                        {hovered.item
                                            ? `${format(hovered.item.value)} (${hovered.item.percent.toFixed(1)}%)`
                                            : `${format(0)} (0.0%)`}
                                    </div>
                                    {hovered.item && (
                                        <div className={styles.tooltipHint}>
                                            Click to filter holdings &amp; X-Ray
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        <div className={styles.mapFooter}>
                            <p className={styles.interactionHint}>
                                Click any country or row to filter holdings
                                {badgeText ? ' & inspect X-Ray decomposition' : ''}.
                            </p>
                            <div className={styles.legendWrap} aria-label="Exposure shade scale">
                                <span>{format(0)}</span>
                                <span className={styles.legendBar} />
                                <span className={styles.legendMax}>{format(maxValue)}</span>
                            </div>
                        </div>
                    </div>

                    {/* Right Pane: Compact Searchable & Scrollable Country List */}
                    <div className={styles.listPane}>
                        <div className={styles.searchWrap}>
                            <Search size={14} className={styles.searchIcon} aria-hidden="true" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder={`Filter ${items.length} ${items.length === 1 ? 'country' : 'countries'}...`}
                                aria-label="Filter countries"
                                className={styles.searchInput}
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    className={styles.clearSearchBtn}
                                    aria-label="Clear country search"
                                    onClick={() => setSearchQuery('')}
                                >
                                    <X size={13} aria-hidden="true" />
                                </button>
                            )}
                        </div>

                        {filteredItems.length === 0 ? (
                            <div className={styles.noMatch}>No matching countries for &ldquo;{searchQuery}&rdquo;.</div>
                        ) : (
                            <ul className={styles.countryList} aria-label={`${title} countries`}>
                                {filteredItems.map((item) => {
                                    const isSelected = Boolean(
                                        selectedCanonical && item.canonicalName === selectedCanonical
                                    );
                                    const isDimmed = hasActiveSelection && !isSelected;
                                    const color = computeChoroplethShade(item.value, maxValue, isDark);

                                    return (
                                        <li key={item.name}>
                                            <button
                                                type="button"
                                                aria-pressed={isSelected}
                                                className={`${styles.countryRow} ${
                                                    isSelected ? styles.rowSelected : ''
                                                } ${isDimmed ? styles.rowDimmed : ''}`}
                                                onClick={(e) => handleSelectCountry(item.name, e)}
                                            >
                                                <span className={styles.rowIdentity}>
                                                    <span
                                                        className={styles.swatch}
                                                        style={{ backgroundColor: color }}
                                                        aria-hidden="true"
                                                    />
                                                    <span className={styles.countryName}>{item.name}</span>
                                                </span>

                                                <span className={styles.barTrack} aria-hidden="true">
                                                    <span
                                                        className={styles.barFill}
                                                        style={{
                                                            width: `${Math.max(item.percent, 1.5)}%`,
                                                            backgroundColor: color,
                                                        }}
                                                    />
                                                </span>

                                                <span className={styles.rowMetrics}>
                                                    <span className={styles.rowValue}>{format(item.value)}</span>
                                                    <span className={styles.rowPercent}>
                                                        {item.percent.toFixed(1)}%
                                                    </span>
                                                </span>
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            )}
        </section>
    );
}
