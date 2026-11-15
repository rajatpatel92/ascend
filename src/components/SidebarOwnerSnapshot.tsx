'use client';

import { useEffect, useId, useState } from 'react';
import styles from './SidebarOwnerSnapshot.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import {
    OWNER_SNAPSHOT_RANGES,
    RANGE_DISPLAY_LABELS,
    formatSnapshotPointLabel,
    parseSnapshotRange,
    type OwnerSnapshotRange,
    type OwnerSnapshotResponse,
    type SnapshotPoint,
} from '@/lib/owner-snapshot';

const RANGE_STORAGE_KEY = 'ascend_sidebar_snapshot_range';
const COLLAPSED_STORAGE_KEY = 'ascend_sidebar_owners_collapsed';

interface SidebarOwnerSnapshotProps {
    collapsed: boolean;
}

interface SparklineProps {
    points: SnapshotPoint[];
    isPositive: boolean;
    width: number;
    height: number;
    activeIndex?: number | null;
    interactive?: boolean;
    onHoverIndex?: (index: number | null) => void;
    ariaLabel?: string;
}

function SparklineSvg({
    points,
    isPositive,
    width,
    height,
    activeIndex = null,
    interactive = false,
    onHoverIndex,
    ariaLabel,
}: SparklineProps) {
    const gradientId = useId();
    const safePoints = points.length >= 2
        ? points
        : points.length === 1
            ? [points[0], points[0]]
            : [];

    if (safePoints.length < 2) {
        return null;
    }

    const values = safePoints.map((p) => p.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min;
    const pad = interactive ? 3 : 2;
    const innerHeight = Math.max(1, height - pad * 2);
    const stepX = width / (safePoints.length - 1);

    const coords = safePoints.map((p, idx) => ({
        x: idx * stepX,
        y: span === 0
            ? pad + innerHeight / 2
            : pad + innerHeight - ((p.value - min) / span) * innerHeight,
    }));

    const linePath = coords
        .map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
        .join(' ');
    const areaPath = `${linePath} L${width},${height} L0,${height} Z`;
    const strokeColor = isPositive ? 'var(--success)' : 'var(--danger)';

    const clampedActive =
        activeIndex !== null && activeIndex >= 0 && activeIndex < coords.length
            ? activeIndex
            : null;
    const activeCoord = clampedActive !== null ? coords[clampedActive] : coords[coords.length - 1];

    const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
        if (!interactive || !onHoverIndex) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const idx = Math.round(ratio * (safePoints.length - 1));
        onHoverIndex(idx);
    };

    const handlePointerLeave = () => {
        if (!interactive || !onHoverIndex) return;
        onHoverIndex(null);
    };

    return (
        <svg
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            height="100%"
            overflow="visible"
            role={ariaLabel ? 'img' : undefined}
            aria-label={ariaLabel}
            aria-hidden={ariaLabel ? undefined : true}
            onPointerMove={interactive ? handlePointerMove : undefined}
            onPointerLeave={interactive ? handlePointerLeave : undefined}
        >
            <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={strokeColor} stopOpacity="0.24" />
                    <stop offset="100%" stopColor={strokeColor} stopOpacity="0" />
                </linearGradient>
            </defs>
            <line
                x1="0"
                y1={coords[0].y.toFixed(1)}
                x2={width}
                y2={coords[0].y.toFixed(1)}
                stroke="var(--card-border)"
                strokeDasharray="2 2"
                strokeWidth="1"
            />
            <path d={areaPath} fill={`url(#${gradientId})`} />
            <path
                d={linePath}
                fill="none"
                stroke={strokeColor}
                strokeWidth={interactive ? 1.75 : 1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            {clampedActive !== null && interactive && (
                <line
                    x1={activeCoord.x.toFixed(1)}
                    y1={0}
                    x2={activeCoord.x.toFixed(1)}
                    y2={height}
                    stroke="var(--text-tertiary)"
                    strokeWidth="1"
                    strokeDasharray="1.5 1.5"
                />
            )}
            <circle
                cx={activeCoord.x.toFixed(1)}
                cy={activeCoord.y.toFixed(1)}
                r={interactive ? (clampedActive !== null ? 2.6 : 2.1) : 1.8}
                fill={strokeColor}
            />
        </svg>
    );
}

export default function SidebarOwnerSnapshot({ collapsed }: SidebarOwnerSnapshotProps) {
    const { currency, format } = useCurrency();
    const [range, setRange] = useState<OwnerSnapshotRange>('1D');
    const [ownersCollapsed, setOwnersCollapsed] = useState(false);
    const [prefsLoaded, setPrefsLoaded] = useState(false);
    const [data, setData] = useState<OwnerSnapshotResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [hoverState, setHoverState] = useState<{ ownerId: string; index: number } | null>(null);

    // Load saved timeframe & collapse state asynchronously after hydration
    useEffect(() => {
        let active = true;
        Promise.resolve().then(() => {
            if (!active) return;
            try {
                const savedRange = localStorage.getItem(RANGE_STORAGE_KEY);
                if (savedRange) {
                    setRange(parseSnapshotRange(savedRange));
                }
                const savedCollapsed = localStorage.getItem(COLLAPSED_STORAGE_KEY);
                if (savedCollapsed === 'true') {
                    setOwnersCollapsed(true);
                }
            } catch {
                // Ignore localStorage restrictions
            } finally {
                setPrefsLoaded(true);
            }
        });
        return () => {
            active = false;
        };
    }, []);

    // Fetch owner snapshot whenever preferences, range, or display currency change
    useEffect(() => {
        if (!prefsLoaded) return;

        const controller = new AbortController();
        Promise.resolve().then(() => {
            if (!controller.signal.aborted) {
                setLoading(true);
                setHoverState(null);
            }
        });

        fetch(
            `/api/portfolio/owner-snapshot?range=${encodeURIComponent(range)}&currency=${encodeURIComponent(currency)}`,
            { signal: controller.signal }
        )
            .then(async (res) => {
                if (!res.ok) {
                    throw new Error(`Snapshot fetch failed (${res.status})`);
                }
                return (await res.json()) as OwnerSnapshotResponse;
            })
            .then((payload) => {
                if (!controller.signal.aborted) {
                    setData(payload);
                    setLoading(false);
                }
            })
            .catch((err) => {
                if (err instanceof DOMException && err.name === 'AbortError') return;
                if (!controller.signal.aborted) {
                    setLoading(false);
                }
            });

        return () => {
            controller.abort();
        };
    }, [prefsLoaded, range, currency]);

    const handleRangeChange = (nextRange: OwnerSnapshotRange) => {
        setRange(nextRange);
        try {
            localStorage.setItem(RANGE_STORAGE_KEY, nextRange);
        } catch {
            // Ignore localStorage restrictions
        }
    };

    const handleCycleRange = () => {
        const currentIdx = OWNER_SNAPSHOT_RANGES.indexOf(range);
        const nextRange = OWNER_SNAPSHOT_RANGES[(currentIdx + 1) % OWNER_SNAPSHOT_RANGES.length];
        handleRangeChange(nextRange);
    };

    const handleToggleOwnersCollapse = () => {
        setOwnersCollapsed((prev) => {
            const next = !prev;
            try {
                localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next));
            } catch {
                // Ignore localStorage restrictions
            }
            return next;
        });
    };

    const formatMoneyCompact = (val: number): string =>
        format(val, { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    const formatDelta = (delta: number, pct: number): string => {
        const sign = delta >= 0 ? '+' : '-';
        const absDelta = Math.abs(delta);
        const decimals = absDelta > 0 && absDelta < 1 ? 2 : 0;
        const formattedDelta = format(absDelta, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        });
        const pctSign = pct >= 0 ? '+' : '';
        return `${sign}${formattedDelta} (${pctSign}${pct.toFixed(2)}%)`;
    };

    // Hide cleanly if initial load finished with zero recorded owner holdings
    if (!loading && (!data || data.owners.length === 0)) {
        return null;
    }

    if (collapsed) {
        if (!data || data.owners.length === 0) {
            return null;
        }
        const totalPositive = data.total.change >= 0;
        const pctSign = data.total.changePercent >= 0 ? '+' : '';
        const rangeLabel = RANGE_DISPLAY_LABELS[range];
        const tooltipLines = [
            `Total Net Worth (${rangeLabel}): ${formatMoneyCompact(data.total.netWorth)} (${formatDelta(data.total.change, data.total.changePercent)})`,
            ...data.owners.map(
                (o) => `${o.name}: ${formatMoneyCompact(o.netWorth)} (${formatDelta(o.change, o.changePercent)})`
            ),
            'Click to cycle timeframe',
        ];

        return (
            <div className={styles.railWrap}>
                <button
                    type="button"
                    className={styles.railPill}
                    onClick={handleCycleRange}
                    title={tooltipLines.join('\n')}
                    aria-label={`Household net worth ${rangeLabel}: ${formatMoneyCompact(data.total.netWorth)}`}
                >
                    <span className={styles.railRangeTag}>{rangeLabel}</span>
                    <span
                        className={`${styles.railPct} ${totalPositive ? styles.positive : styles.negative}`}
                    >
                        {pctSign}
                        {data.total.changePercent.toFixed(1)}%
                    </span>
                    {data.total.points.length >= 2 && (
                        <div className={styles.railSpark}>
                            <SparklineSvg
                                points={data.total.points}
                                isPositive={totalPositive}
                                width={40}
                                height={14}
                            />
                        </div>
                    )}
                </button>
            </div>
        );
    }

    const showSkeleton = loading && !data;
    const totalPositive = (data?.total.change ?? 0) >= 0;

    return (
        <section
            className={`${styles.wrapper} ${loading && data ? styles.wrapperLoading : ''}`}
            aria-label="Owner net worth snapshot"
        >
            <div className={styles.headerRow}>
                <div className={styles.headerLeft}>
                    <span className={styles.title}>Net Worth</span>
                    <select
                        className={styles.rangeSelect}
                        value={range}
                        onChange={(e) => handleRangeChange(parseSnapshotRange(e.target.value))}
                        aria-label="Net worth snapshot timeframe"
                        title="Snapshot timeframe"
                    >
                        {OWNER_SNAPSHOT_RANGES.map((r) => (
                            <option key={r} value={r}>
                                {RANGE_DISPLAY_LABELS[r]}
                            </option>
                        ))}
                    </select>
                </div>

                {data && (
                    <button
                        type="button"
                        className={styles.totalToggle}
                        onClick={handleToggleOwnersCollapse}
                        aria-expanded={!ownersCollapsed}
                        title={ownersCollapsed ? 'Expand owner breakdown' : 'Collapse owner breakdown'}
                    >
                        <span>{formatMoneyCompact(data.total.netWorth)}</span>
                        <span className={styles.chevron} aria-hidden="true">
                            {ownersCollapsed ? '▸' : '▾'}
                        </span>
                    </button>
                )}
            </div>

            {showSkeleton ? (
                <div className={styles.ownersList} aria-hidden="true">
                    <div className={styles.skeletonCard} />
                    <div className={styles.skeletonCard} />
                </div>
            ) : data && ownersCollapsed ? (
                <div className={styles.collapsedSummaryCard}>
                    <span className={styles.collapsedLabel}>All Owners</span>
                    <span className={totalPositive ? styles.positive : styles.negative}>
                        {formatDelta(data.total.change, data.total.changePercent)}
                    </span>
                </div>
            ) : data ? (
                <div className={styles.ownersList}>
                    {data.owners.map((owner) => {
                        const isPositive = owner.change >= 0;
                        const activeHover =
                            hoverState && hoverState.ownerId === owner.id ? hoverState.index : null;
                        const hoveredPoint =
                            activeHover !== null && owner.points[activeHover]
                                ? owner.points[activeHover]
                                : null;

                        return (
                            <div key={owner.id} className={styles.ownerCard}>
                                <div className={styles.ownerMain}>
                                    <div className={styles.ownerMeta}>
                                        <div className={styles.ownerName} title={owner.name}>
                                            {owner.name}
                                        </div>
                                        <div className={styles.ownerNetWorth}>
                                            {formatMoneyCompact(owner.netWorth)}
                                        </div>
                                    </div>

                                    {owner.points.length >= 2 && (
                                        <div className={styles.sparkWrap}>
                                            <SparklineSvg
                                                points={owner.points}
                                                isPositive={isPositive}
                                                width={66}
                                                height={26}
                                                interactive
                                                activeIndex={activeHover}
                                                onHoverIndex={(idx) =>
                                                    setHoverState(
                                                        idx === null
                                                            ? null
                                                            : { ownerId: owner.id, index: idx }
                                                    )
                                                }
                                                ariaLabel={`${owner.name} ${RANGE_DISPLAY_LABELS[range]} sparkline`}
                                            />
                                        </div>
                                    )}
                                </div>

                                {hoveredPoint ? (
                                    <div className={styles.hoverRow}>
                                        <span className={styles.hoverLabel}>
                                            {formatSnapshotPointLabel(hoveredPoint.date, range)}
                                        </span>
                                        <span>{formatMoneyCompact(hoveredPoint.value)}</span>
                                    </div>
                                ) : (
                                    <div
                                        className={`${styles.deltaRow} ${isPositive ? styles.positive : styles.negative}`}
                                    >
                                        {formatDelta(owner.change, owner.changePercent)}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            ) : null}
        </section>
    );
}
