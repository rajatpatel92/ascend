/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import Papa from 'papaparse';
import { motion, AnimatePresence } from 'framer-motion';
import {
    MdAdd,
    MdCalendarMonth,
    MdClose,
    MdDeleteOutline,
    MdDownload,
    MdEdit,
    MdExpandMore,
    MdFilterList,
    MdMoreVert,
    MdSwapHoriz,
    MdUploadFile
} from 'react-icons/md';
import { FaSpinner } from 'react-icons/fa';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import DateInput from '@/components/DateInput';
import ActivityFormModal from '@/components/ActivityFormModal';
import FetchDividendsModal from '@/components/FetchDividendsModal';
import BulkUploadModal from '@/components/BulkUploadModal';
import BulkEditModal from '@/components/BulkEditModal';
import TransferAccountsModal from '@/components/TransferAccountsModal';
import ConfirmDialog from '@/components/ConfirmDialog';
import { formatQuantity } from '@/lib/format';
import {
    computeActivitiesSummary,
    computeActivityNetAmount,
    deriveActivityFilterOptions,
    filterActivities,
    resolveActivityOwner,
    type ActivityRecord,
    type ActivityUser
} from '@/lib/activities-filters';
import styles from './page.module.css';

const RANGES = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', 'ALL'];

export default function ActivitiesPage() {
    const [activities, setActivities] = useState<ActivityRecord[]>([]);
    const [users, setUsers] = useState<ActivityUser[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    const { format, convert, currency } = useCurrency();
    const { formatDate } = useDate();
    const { data: session } = useSession();
    const role = (session?.user as any)?.role || 'VIEWER';
    const canEdit = role !== 'VIEWER';

    // Banners
    const [errorBanner, setErrorBanner] = useState<string | null>(null);
    const [successBanner, setSuccessBanner] = useState<string | null>(null);

    // Modals & Menus
    const [showFilters, setShowFilters] = useState(false);
    const [showActivityModal, setShowActivityModal] = useState(false);
    const [editingActivity, setEditingActivity] = useState<ActivityRecord | null>(null);
    const [showDividendModal, setShowDividendModal] = useState(false);
    const [showImportModal, setShowImportModal] = useState(false);
    const [showBulkEditModal, setShowBulkEditModal] = useState(false);
    const [showTransferModal, setShowTransferModal] = useState(false);
    const [showOverflowMenu, setShowOverflowMenu] = useState(false);
    const [showMobileMenu, setShowMobileMenu] = useState(false);
    const [accountsRefreshKey, setAccountsRefreshKey] = useState(0);

    // Confirm Dialog states
    const [deleteTarget, setDeleteTarget] = useState<ActivityRecord | null>(null);
    const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    // Filters
    const [range, setRange] = useState('ALL');
    const [customStart, setCustomStart] = useState('');
    const [customEnd, setCustomEnd] = useState('');
    const [filterOwner, setFilterOwner] = useState('');
    const [filterAccountType, setFilterAccountType] = useState('');
    const [filterPlatform, setFilterPlatform] = useState('');
    const [filterSymbol, setFilterSymbol] = useState('');
    const [filterType, setFilterType] = useState('');

    // Pagination & Selection
    const [pageSize, setPageSize] = useState<number | 'ALL'>(20);
    const [currentPage, setCurrentPage] = useState(1);
    const [selectedActivities, setSelectedActivities] = useState<Set<string>>(new Set());

    const fetchUsers = useCallback(async () => {
        try {
            const res = await fetch('/api/users');
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) setUsers(data);
            }
        } catch (err) {
            console.error('Failed to fetch users', err);
        }
    }, []);

    const fetchActivities = useCallback(async () => {
        try {
            const res = await fetch('/api/activities');
            if (!res.ok) {
                throw new Error(`Failed to fetch activities (HTTP ${res.status})`);
            }
            const data = await res.json();
            if (Array.isArray(data)) {
                setActivities(data);
            }
        } catch (error) {
            console.error('Failed to fetch activities', error);
            setErrorBanner('Unable to load activities. Please refresh and try again.');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchActivities();
        fetchUsers();
    }, [fetchActivities, fetchUsers]);

    useEffect(() => {
        setCurrentPage(1);
    }, [range, customStart, customEnd, filterOwner, filterAccountType, filterPlatform, filterSymbol, filterType, pageSize]);

    useEffect(() => {
        if (!showOverflowMenu && !showMobileMenu) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setShowOverflowMenu(false);
                setShowMobileMenu(false);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [showOverflowMenu, showMobileMenu]);

    const filterOptions = useMemo(
        () => deriveActivityFilterOptions(activities, users),
        [activities, users]
    );

    const filteredActivities = useMemo(
        () =>
            filterActivities(activities, {
                range,
                customStart,
                customEnd,
                owner: filterOwner,
                accountType: filterAccountType,
                platform: filterPlatform,
                symbol: filterSymbol,
                type: filterType
            }),
        [
            activities,
            range,
            customStart,
            customEnd,
            filterOwner,
            filterAccountType,
            filterPlatform,
            filterSymbol,
            filterType
        ]
    );

    const summary = useMemo(
        () => computeActivitiesSummary(filteredActivities, convert),
        [filteredActivities, convert]
    );

    const activeFilterCount = useMemo(() => {
        let count = 0;
        if (range !== 'ALL') count++;
        if (filterOwner) count++;
        if (filterAccountType) count++;
        if (filterPlatform) count++;
        if (filterSymbol) count++;
        if (filterType) count++;
        return count;
    }, [range, filterOwner, filterAccountType, filterPlatform, filterSymbol, filterType]);

    const resetFilters = () => {
        setRange('ALL');
        setCustomStart('');
        setCustomEnd('');
        setFilterOwner('');
        setFilterAccountType('');
        setFilterPlatform('');
        setFilterSymbol('');
        setFilterType('');
    };

    // Pagination Logic
    const totalItems = filteredActivities.length;
    const totalPages = pageSize === 'ALL' ? 1 : Math.max(1, Math.ceil(totalItems / pageSize));
    const safePage = Math.min(currentPage, totalPages);
    const paginatedActivities = useMemo(() => {
        if (pageSize === 'ALL') return filteredActivities;
        return filteredActivities.slice((safePage - 1) * pageSize, safePage * pageSize);
    }, [filteredActivities, pageSize, safePage]);

    const startIndex = totalItems === 0 ? 0 : pageSize === 'ALL' ? 1 : (safePage - 1) * pageSize + 1;
    const endIndex = totalItems === 0 ? 0 : pageSize === 'ALL' ? totalItems : Math.min(safePage * pageSize, totalItems);

    const selectedUniqueSymbolsCount = useMemo(() => {
        return new Set(
            activities
                .filter((a) => selectedActivities.has(a.id))
                .map((a) => a.investment.symbol)
        ).size;
    }, [activities, selectedActivities]);

    const handleOpenAdd = () => {
        setEditingActivity(null);
        setShowActivityModal(true);
        setShowMobileMenu(false);
    };

    const handleEdit = (activity: ActivityRecord) => {
        setEditingActivity(activity);
        setShowActivityModal(true);
    };

    const handleConfirmSingleDelete = async () => {
        if (!deleteTarget) return;
        setIsDeleting(true);
        setErrorBanner(null);

        try {
            const res = await fetch(`/api/activities/${deleteTarget.id}`, {
                method: 'DELETE'
            });

            if (!res.ok) {
                throw new Error('Failed to delete activity.');
            }

            setSelectedActivities((prev) => {
                if (!prev.has(deleteTarget.id)) return prev;
                const next = new Set(prev);
                next.delete(deleteTarget.id);
                return next;
            });
            setDeleteTarget(null);
            setSuccessBanner('Activity deleted.');
            await fetchActivities();
        } catch (error) {
            console.error('Delete failed', error);
            setErrorBanner('Failed to delete activity. Please try again.');
            setDeleteTarget(null);
        } finally {
            setIsDeleting(false);
        }
    };

    const handleConfirmBatchDelete = async () => {
        if (selectedActivities.size === 0) return;
        setIsDeleting(true);
        setErrorBanner(null);

        try {
            const res = await fetch('/api/activities/batch-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: Array.from(selectedActivities) })
            });

            if (!res.ok) {
                throw new Error('Failed to delete selected activities.');
            }

            const data = await res.json();
            const deletedCount = data.count ?? selectedActivities.size;
            setSelectedActivities(new Set());
            setConfirmBatchDelete(false);
            setSuccessBanner(`Deleted ${deletedCount} ${deletedCount === 1 ? 'activity' : 'activities'}.`);
            await fetchActivities();
        } catch (error) {
            console.error('Failed to batch delete', error);
            setErrorBanner('Failed to delete selected activities.');
            setConfirmBatchDelete(false);
        } finally {
            setIsDeleting(false);
        }
    };

    const toggleActivitySelection = (id: string) => {
        setSelectedActivities((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const allPageSelected =
        paginatedActivities.length > 0 &&
        paginatedActivities.every((a) => selectedActivities.has(a.id));

    const toggleAllOnPage = () => {
        setSelectedActivities((prev) => {
            const next = new Set(prev);
            if (allPageSelected) {
                paginatedActivities.forEach((a) => next.delete(a.id));
            } else {
                paginatedActivities.forEach((a) => next.add(a.id));
            }
            return next;
        });
    };

    const handleExport = () => {
        let dataToExport = filteredActivities;
        if (selectedActivities.size > 0) {
            dataToExport = filteredActivities.filter((a) => selectedActivities.has(a.id));
        }

        if (dataToExport.length === 0) {
            setErrorBanner('No activities match the current selection to export.');
            return;
        }

        const csvData = dataToExport.map((a) => ({
            Date: a.date.split('T')[0],
            Type: a.type,
            Symbol: a.investment.symbol,
            'Investment Type': a.investment.type,
            Quantity: a.quantity,
            Price: a.price,
            Fee: a.fee || 0,
            Currency: a.currency || a.investment.currencyCode || 'USD',
            Username: a.account?.name || '',
            'Account Type': a.account?.type || '',
            Platform: a.platform?.name || ''
        }));

        const csv = Papa.unparse(csvData);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `activities_export_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const formatAccountDisplay = (activity: ActivityRecord) => {
        if (!activity.account) return '—';
        const owner = resolveActivityOwner(activity.account, users);
        return `${owner.label} - ${activity.account.type}`;
    };

    return (
        <div className={styles.container}>
            {/* Header */}
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Activities</h1>
                    <p className={styles.subtitle}>
                        Review, filter, and manage transactions across all owners and accounts.
                    </p>
                </div>

                {/* Desktop Actions */}
                <div className={styles.headerActions}>
                    {canEdit && (
                        <>
                            <button
                                type="button"
                                className={styles.secondaryBtn}
                                onClick={() => setShowDividendModal(true)}
                            >
                                <MdCalendarMonth size={18} aria-hidden="true" />
                                Fetch Dividends
                            </button>
                            <button
                                type="button"
                                className={styles.primaryBtn}
                                onClick={handleOpenAdd}
                            >
                                <MdAdd size={19} aria-hidden="true" />
                                Add Activity
                            </button>
                        </>
                    )}

                    <div className={styles.menuWrap}>
                        <button
                            type="button"
                            className={styles.iconMenuBtn}
                            onClick={() => setShowOverflowMenu((prev) => !prev)}
                            aria-label="More activity actions"
                            aria-expanded={showOverflowMenu}
                        >
                            <MdMoreVert size={20} aria-hidden="true" />
                        </button>

                        {showOverflowMenu && (
                            <>
                                <div
                                    className={styles.menuBackdrop}
                                    onClick={() => setShowOverflowMenu(false)}
                                />
                                <div className={styles.dropdownMenu} role="menu">
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className={styles.menuItem}
                                        onClick={() => {
                                            handleExport();
                                            setShowOverflowMenu(false);
                                        }}
                                    >
                                        <MdDownload size={18} aria-hidden="true" />
                                        Export CSV
                                    </button>
                                    {canEdit && (
                                        <>
                                            <button
                                                type="button"
                                                role="menuitem"
                                                className={styles.menuItem}
                                                onClick={() => {
                                                    setShowImportModal(true);
                                                    setShowOverflowMenu(false);
                                                }}
                                            >
                                                <MdUploadFile size={18} aria-hidden="true" />
                                                Import CSV
                                            </button>
                                            <button
                                                type="button"
                                                role="menuitem"
                                                className={styles.menuItem}
                                                onClick={() => {
                                                    setShowTransferModal(true);
                                                    setShowOverflowMenu(false);
                                                }}
                                            >
                                                <MdSwapHoriz size={18} aria-hidden="true" />
                                                Transfer Accounts
                                            </button>
                                        </>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Mobile Actions */}
                <div className={styles.mobileActions}>
                    {canEdit && (
                        <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={handleOpenAdd}
                        >
                            <MdAdd size={18} aria-hidden="true" />
                            Add
                        </button>
                    )}

                    <div className={styles.menuWrap}>
                        <button
                            type="button"
                            className={styles.secondaryBtn}
                            onClick={() => setShowMobileMenu((prev) => !prev)}
                            aria-expanded={showMobileMenu}
                            aria-label="Open actions menu"
                        >
                            <span>Actions</span>
                            <MdExpandMore size={18} aria-hidden="true" />
                        </button>

                        {showMobileMenu && (
                            <>
                                <div
                                    className={styles.menuBackdrop}
                                    onClick={() => setShowMobileMenu(false)}
                                />
                                <div className={styles.dropdownMenu} role="menu">
                                    {canEdit && (
                                        <button
                                            type="button"
                                            role="menuitem"
                                            className={styles.menuItem}
                                            onClick={() => {
                                                setShowDividendModal(true);
                                                setShowMobileMenu(false);
                                            }}
                                        >
                                            <MdCalendarMonth size={18} aria-hidden="true" />
                                            Fetch Dividends
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        className={styles.menuItem}
                                        onClick={() => {
                                            handleExport();
                                            setShowMobileMenu(false);
                                        }}
                                    >
                                        <MdDownload size={18} aria-hidden="true" />
                                        Export CSV
                                    </button>
                                    {canEdit && (
                                        <>
                                            <button
                                                type="button"
                                                role="menuitem"
                                                className={styles.menuItem}
                                                onClick={() => {
                                                    setShowImportModal(true);
                                                    setShowMobileMenu(false);
                                                }}
                                            >
                                                <MdUploadFile size={18} aria-hidden="true" />
                                                Import CSV
                                            </button>
                                            <button
                                                type="button"
                                                role="menuitem"
                                                className={styles.menuItem}
                                                onClick={() => {
                                                    setShowTransferModal(true);
                                                    setShowMobileMenu(false);
                                                }}
                                            >
                                                <MdSwapHoriz size={18} aria-hidden="true" />
                                                Transfer Accounts
                                            </button>
                                        </>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </header>

            {/* Feedback Banners */}
            {errorBanner && (
                <div className={styles.errorBanner} role="alert">
                    <span>{errorBanner}</span>
                    <button
                        type="button"
                        className={styles.bannerDismiss}
                        onClick={() => setErrorBanner(null)}
                        aria-label="Dismiss error"
                    >
                        <MdClose size={18} aria-hidden="true" />
                    </button>
                </div>
            )}

            {successBanner && (
                <div className={styles.successBanner} role="status">
                    <span>{successBanner}</span>
                    <button
                        type="button"
                        className={styles.bannerDismiss}
                        onClick={() => setSuccessBanner(null)}
                        aria-label="Dismiss notification"
                    >
                        <MdClose size={18} aria-hidden="true" />
                    </button>
                </div>
            )}

            {/* Tier 1 Summary KPI Strip */}
            <section className={styles.kpiStrip} aria-label="Filtered activity summary">
                <div className={styles.kpiCard}>
                    <div className={styles.kpiHeader}>
                        <span className={styles.kpiLabel}>Filtered Entries</span>
                        <span className={styles.kpiTag}>{summary.uniqueSymbolsCount} symbols</span>
                    </div>
                    <div className={styles.kpiValue}>{summary.totalCount}</div>
                    <div className={styles.kpiSub}>
                        {activeFilterCount > 0
                            ? `${activeFilterCount} active filter(s) applied`
                            : 'Showing all recorded transactions'}
                    </div>
                </div>

                <div className={styles.kpiCard}>
                    <div className={styles.kpiHeader}>
                        <span className={styles.kpiLabel}>Invested Capital</span>
                        <span className={styles.kpiTag}>{currency}</span>
                    </div>
                    <div className={styles.kpiValue}>{format(summary.totalInvested)}</div>
                    <div className={styles.kpiSub}>Buys, additions &amp; transfers in</div>
                </div>

                <div className={styles.kpiCard}>
                    <div className={styles.kpiHeader}>
                        <span className={styles.kpiLabel}>Proceeds</span>
                        <span className={styles.kpiTag}>{currency}</span>
                    </div>
                    <div className={styles.kpiValue}>{format(summary.totalProceeds)}</div>
                    <div className={styles.kpiSub}>Sells, removals &amp; transfers out</div>
                </div>

                <div className={styles.kpiCard}>
                    <div className={styles.kpiHeader}>
                        <span className={styles.kpiLabel}>Dividends &amp; Interest</span>
                        <span className={styles.kpiTag}>Income</span>
                    </div>
                    <div className={`${styles.kpiValue} ${summary.totalIncome > 0 ? styles.kpiValuePositive : ''}`}>
                        {format(summary.totalIncome)}
                    </div>
                    <div className={styles.kpiSub}>Net cash distributions received</div>
                </div>
            </section>

            {/* Contextual Bulk Selection Bar (Desktop + Mobile) */}
            {selectedActivities.size > 0 && (
                <div className={styles.selectionBar} role="region" aria-label="Selected activities actions">
                    <div className={styles.selectionInfo}>
                        <span>
                            {selectedActivities.size}{' '}
                            {selectedActivities.size === 1 ? 'activity' : 'activities'} selected
                        </span>
                        <button
                            type="button"
                            className={styles.selectionClearBtn}
                            onClick={() => setSelectedActivities(new Set())}
                        >
                            Clear selection
                        </button>
                    </div>
                    <div className={styles.selectionActions}>
                        <button
                            type="button"
                            className={styles.secondaryBtn}
                            onClick={handleExport}
                        >
                            <MdDownload size={17} aria-hidden="true" />
                            Export ({selectedActivities.size})
                        </button>
                        {canEdit && (
                            <>
                                <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={() => setShowBulkEditModal(true)}
                                >
                                    <MdEdit size={17} aria-hidden="true" />
                                    Edit Selected
                                </button>
                                <button
                                    type="button"
                                    className={styles.dangerBtn}
                                    onClick={() => setConfirmBatchDelete(true)}
                                >
                                    <MdDeleteOutline size={18} aria-hidden="true" />
                                    Delete Selected
                                </button>
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Mobile Filter Drawer Toggle */}
            <button
                type="button"
                className={styles.mobileFilterToggle}
                onClick={() => setShowFilters((prev) => !prev)}
                aria-expanded={showFilters}
            >
                <span className={styles.mobileFilterLeft}>
                    <MdFilterList size={19} aria-hidden="true" />
                    <span>Filters &amp; Options</span>
                    {activeFilterCount > 0 && (
                        <span className={styles.activeBadge}>{activeFilterCount}</span>
                    )}
                </span>
                <MdExpandMore
                    size={20}
                    aria-hidden="true"
                    style={{
                        transform: showFilters ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s'
                    }}
                />
            </button>

            <div className={styles.activitiesGrid}>
                {/* Sidebar Filters */}
                <aside className={`${styles.sidebar} ${showFilters ? styles.open : ''}`} aria-label="Activity filters">
                    <div className={styles.sidebarHeader}>
                        <div className={styles.sidebarTitleGroup}>
                            <h2 className={styles.sidebarTitle}>Filters</h2>
                            {activeFilterCount > 0 && (
                                <span className={styles.activeBadge}>{activeFilterCount}</span>
                            )}
                        </div>
                        {activeFilterCount > 0 && (
                            <button
                                type="button"
                                className={styles.resetFiltersBtn}
                                onClick={resetFilters}
                            >
                                Reset
                            </button>
                        )}
                    </div>

                    <div className={styles.filterGroup}>
                        <span className={styles.filterLabel}>Time Range</span>
                        <div className={styles.rangeGrid}>
                            {RANGES.map((r) => (
                                <button
                                    key={r}
                                    type="button"
                                    onClick={() => setRange(r)}
                                    className={`${styles.rangeButton} ${range === r ? styles.active : ''}`}
                                >
                                    {r}
                                </button>
                            ))}
                            <button
                                type="button"
                                onClick={() => setRange('CUSTOM')}
                                className={`${styles.rangeButton} ${range === 'CUSTOM' ? styles.active : ''}`}
                            >
                                Custom
                            </button>
                        </div>
                        {range === 'CUSTOM' && (
                            <div className={styles.dateInputs}>
                                <DateInput
                                    value={customStart}
                                    onChange={setCustomStart}
                                    ariaLabel="Start date"
                                />
                                <span className={styles.separator}>to</span>
                                <DateInput
                                    value={customEnd}
                                    onChange={setCustomEnd}
                                    ariaLabel="End date"
                                />
                            </div>
                        )}
                    </div>

                    <div className={styles.filterGroup}>
                        <label htmlFor="filter-owner" className={styles.filterLabel}>
                            Owner
                        </label>
                        <select
                            id="filter-owner"
                            value={filterOwner}
                            onChange={(e) => setFilterOwner(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Owners</option>
                            {filterOptions.owners.map((owner) => (
                                <option key={owner.value} value={owner.value}>
                                    {owner.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.filterGroup}>
                        <label htmlFor="filter-account-type" className={styles.filterLabel}>
                            Account Type
                        </label>
                        <select
                            id="filter-account-type"
                            value={filterAccountType}
                            onChange={(e) => setFilterAccountType(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Account Types</option>
                            {filterOptions.accountTypes.map((t) => (
                                <option key={t} value={t}>
                                    {t}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.filterGroup}>
                        <label htmlFor="filter-platform" className={styles.filterLabel}>
                            Platform
                        </label>
                        <select
                            id="filter-platform"
                            value={filterPlatform}
                            onChange={(e) => setFilterPlatform(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Platforms</option>
                            {filterOptions.platforms.map((p) => (
                                <option key={p} value={p}>
                                    {p}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.filterGroup}>
                        <label htmlFor="filter-symbol" className={styles.filterLabel}>
                            Symbol
                        </label>
                        <select
                            id="filter-symbol"
                            value={filterSymbol}
                            onChange={(e) => setFilterSymbol(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Symbols</option>
                            {filterOptions.symbols.map((s) => (
                                <option key={s} value={s}>
                                    {s}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.filterGroup}>
                        <label htmlFor="filter-activity-type" className={styles.filterLabel}>
                            Activity Type
                        </label>
                        <select
                            id="filter-activity-type"
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Types</option>
                            {filterOptions.activityTypes.map((t) => (
                                <option key={t} value={t}>
                                    {t}
                                </option>
                            ))}
                        </select>
                    </div>
                </aside>

                {/* Main Activity Log */}
                <main className={styles.main}>
                    <div className={styles.listHeader}>
                        <div className={styles.listTitleGroup}>
                            <h2 className={styles.listTitle}>Activity Log</h2>
                            <span className={styles.entryCount}>
                                {totalItems === 0
                                    ? '0 entries'
                                    : `Showing ${startIndex}–${endIndex} of ${totalItems}`}
                            </span>
                        </div>

                        {paginatedActivities.length > 0 && (
                            <label className={styles.mobileSelectAllLabel}>
                                <input
                                    type="checkbox"
                                    className={styles.checkboxInput}
                                    checked={allPageSelected}
                                    onChange={toggleAllOnPage}
                                />
                                <span>Select page</span>
                            </label>
                        )}
                    </div>

                    {isLoading ? (
                        <div className={styles.emptyState}>
                            <FaSpinner className={styles.spinner} aria-hidden="true" />
                            <p className={styles.emptyDesc}>Loading activities...</p>
                        </div>
                    ) : paginatedActivities.length === 0 ? (
                        <div className={styles.emptyState}>
                            <p className={styles.emptyTitle}>No activities found</p>
                            <p className={styles.emptyDesc}>
                                {activeFilterCount > 0
                                    ? 'No transactions match your active filter criteria.'
                                    : 'Add your first buy, sell, dividend, or transfer activity to get started.'}
                            </p>
                            {activeFilterCount > 0 ? (
                                <button type="button" className={styles.secondaryBtn} onClick={resetFilters}>
                                    Reset Filters
                                </button>
                            ) : (
                                canEdit && (
                                    <button type="button" className={styles.primaryBtn} onClick={handleOpenAdd}>
                                        <MdAdd size={18} aria-hidden="true" />
                                        Add Activity
                                    </button>
                                )
                            )}
                        </div>
                    ) : (
                        <>
                            {/* Desktop Table */}
                            <div className={styles.tableContainer}>
                                <table className={styles.table}>
                                    <thead>
                                        <tr>
                                            <th style={{ width: '44px' }}>
                                                <input
                                                    type="checkbox"
                                                    className={styles.checkboxInput}
                                                    aria-label="Select all activities on this page"
                                                    checked={allPageSelected}
                                                    onChange={toggleAllOnPage}
                                                />
                                            </th>
                                            <th>Date</th>
                                            <th>Symbol</th>
                                            <th>Type</th>
                                            <th className={styles.alignRight}>Qty</th>
                                            <th className={styles.alignRight}>Price ({currency})</th>
                                            <th className={styles.alignRight}>Total</th>
                                            <th>Account</th>
                                            {canEdit && <th className={styles.alignRight}>Actions</th>}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <AnimatePresence mode="popLayout">
                                            {paginatedActivities.map((activity) => {
                                                const fromCurrency =
                                                    activity.currency || activity.investment.currencyCode || 'USD';
                                                const isSplit =
                                                    activity.type === 'STOCK_SPLIT' || activity.type === 'SPLIT';
                                                const convertedPrice = convert(activity.price, fromCurrency);
                                                const netNative = computeActivityNetAmount(activity);
                                                const convertedTotal = convert(netNative, fromCurrency);
                                                const isSelected = selectedActivities.has(activity.id);

                                                return (
                                                    <motion.tr
                                                        key={activity.id}
                                                        layout
                                                        initial={{ opacity: 0 }}
                                                        animate={{ opacity: 1 }}
                                                        exit={{ opacity: 0, transition: { duration: 0.08 } }}
                                                        transition={{ duration: 0.16 }}
                                                        className={`${styles.row} ${
                                                            canEdit ? styles.rowInteractive : ''
                                                        } ${isSelected ? styles.rowSelected : ''}`}
                                                        onClick={() => canEdit && handleEdit(activity)}
                                                    >
                                                        <td onClick={(e) => e.stopPropagation()}>
                                                            <input
                                                                type="checkbox"
                                                                className={styles.checkboxInput}
                                                                aria-label={`Select ${activity.investment.symbol} ${activity.type} on ${formatDate(activity.date)}`}
                                                                checked={isSelected}
                                                                onChange={() => toggleActivitySelection(activity.id)}
                                                            />
                                                        </td>
                                                        <td style={{ whiteSpace: 'nowrap' }}>{formatDate(activity.date)}</td>
                                                        <td>
                                                            <div>
                                                                <Link
                                                                    href={`/analysis/${encodeURIComponent(activity.investment.symbol)}?from=activities`}
                                                                    className={styles.symbolCellLink}
                                                                    onClick={(e) => e.stopPropagation()}
                                                                >
                                                                    {activity.investment.symbol}
                                                                </Link>
                                                            </div>
                                                            <div className={styles.cellSubtext} title={activity.investment.name}>
                                                                {activity.investment.name}
                                                            </div>
                                                        </td>
                                                        <td>
                                                            <span className={`${styles.badge} ${styles[activity.type] || ''}`}>
                                                                {activity.type}
                                                            </span>
                                                        </td>
                                                        <td className={styles.numCell}>
                                                            {isSplit
                                                                ? `${formatQuantity(activity.quantity)}:1`
                                                                : formatQuantity(activity.quantity)}
                                                        </td>
                                                        <td className={styles.numCell}>
                                                            {isSplit ? '—' : format(convertedPrice)}
                                                        </td>
                                                        <td className={`${styles.numCell} ${styles.strongCell}`}>
                                                            {isSplit ? '—' : format(convertedTotal)}
                                                        </td>
                                                        <td>
                                                            <div className={styles.accountPrimary}>
                                                                {formatAccountDisplay(activity)}
                                                            </div>
                                                            <div className={styles.cellSubtext}>
                                                                {activity.platform?.name || '—'}
                                                            </div>
                                                        </td>
                                                        {canEdit && (
                                                            <td
                                                                className={styles.alignRight}
                                                                onClick={(e) => e.stopPropagation()}
                                                            >
                                                                <div className={styles.rowActions}>
                                                                    <button
                                                                        type="button"
                                                                        className={styles.rowIconBtn}
                                                                        onClick={() => handleEdit(activity)}
                                                                        title="Edit activity"
                                                                        aria-label={`Edit ${activity.investment.symbol} activity`}
                                                                    >
                                                                        <MdEdit size={17} aria-hidden="true" />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        className={styles.rowDeleteBtn}
                                                                        onClick={() => setDeleteTarget(activity)}
                                                                        title="Delete activity"
                                                                        aria-label={`Delete ${activity.investment.symbol} activity`}
                                                                    >
                                                                        <MdDeleteOutline size={18} aria-hidden="true" />
                                                                    </button>
                                                                </div>
                                                            </td>
                                                        )}
                                                    </motion.tr>
                                                );
                                            })}
                                        </AnimatePresence>
                                    </tbody>
                                </table>
                            </div>

                            {/* Mobile Cards */}
                            <div className={styles.mobileList}>
                                {paginatedActivities.map((activity) => {
                                    const fromCurrency =
                                        activity.currency || activity.investment.currencyCode || 'USD';
                                    const isSplit =
                                        activity.type === 'STOCK_SPLIT' || activity.type === 'SPLIT';
                                    const convertedPrice = convert(activity.price, fromCurrency);
                                    const convertedTotal = convert(computeActivityNetAmount(activity), fromCurrency);
                                    const isSelected = selectedActivities.has(activity.id);

                                    return (
                                        <article
                                            key={activity.id}
                                            className={`${styles.mobileCard} ${isSelected ? styles.rowSelected : ''}`}
                                        >
                                            <div className={styles.mobileCardTop}>
                                                <div className={styles.mobileCardTitleWrap}>
                                                    <input
                                                        type="checkbox"
                                                        className={styles.checkboxInput}
                                                        style={{ marginTop: '0.2rem' }}
                                                        aria-label={`Select ${activity.investment.symbol} activity`}
                                                        checked={isSelected}
                                                        onChange={() => toggleActivitySelection(activity.id)}
                                                    />
                                                    <div className={styles.mobileCardSymbolGroup}>
                                                        <Link
                                                            href={`/analysis/${encodeURIComponent(activity.investment.symbol)}?from=activities`}
                                                            className={styles.symbolCellLink}
                                                        >
                                                            {activity.investment.symbol}
                                                        </Link>
                                                        <span className={styles.cellSubtext}>
                                                            {activity.investment.name}
                                                        </span>
                                                    </div>
                                                </div>
                                                <span className={`${styles.badge} ${styles[activity.type] || ''}`}>
                                                    {activity.type}
                                                </span>
                                            </div>

                                            <div className={styles.mobileCardGrid}>
                                                <div className={styles.mobileMetric}>
                                                    <span className={styles.mobileMetricLabel}>Date</span>
                                                    <span className={styles.mobileMetricValue}>
                                                        {formatDate(activity.date)}
                                                    </span>
                                                </div>
                                                <div className={styles.mobileMetric}>
                                                    <span className={styles.mobileMetricLabel}>
                                                        {isSplit ? 'Split Ratio' : 'Quantity'}
                                                    </span>
                                                    <span className={styles.mobileMetricValue}>
                                                        {isSplit
                                                            ? `${formatQuantity(activity.quantity)}:1`
                                                            : formatQuantity(activity.quantity)}
                                                    </span>
                                                </div>
                                                <div className={styles.mobileMetric}>
                                                    <span className={styles.mobileMetricLabel}>Price ({currency})</span>
                                                    <span className={styles.mobileMetricValue}>
                                                        {isSplit ? '—' : format(convertedPrice)}
                                                    </span>
                                                </div>
                                                <div className={styles.mobileMetric}>
                                                    <span className={styles.mobileMetricLabel}>Total</span>
                                                    <span className={`${styles.mobileMetricValue} ${styles.strongCell}`}>
                                                        {isSplit ? '—' : format(convertedTotal)}
                                                    </span>
                                                </div>
                                            </div>

                                            <div className={styles.mobileCardFooter}>
                                                <div className={styles.mobileAccountMeta}>
                                                    <span className={styles.accountPrimary}>
                                                        {formatAccountDisplay(activity)}
                                                    </span>
                                                    <span className={styles.cellSubtext}>
                                                        {activity.platform?.name || '—'}
                                                    </span>
                                                </div>
                                                {canEdit && (
                                                    <div className={styles.mobileCardBtns}>
                                                        <button
                                                            type="button"
                                                            className={styles.mobileEditBtn}
                                                            onClick={() => handleEdit(activity)}
                                                        >
                                                            <MdEdit size={15} aria-hidden="true" />
                                                            Edit
                                                        </button>
                                                        <button
                                                            type="button"
                                                            className={styles.mobileDeleteBtn}
                                                            onClick={() => setDeleteTarget(activity)}
                                                        >
                                                            <MdDeleteOutline size={16} aria-hidden="true" />
                                                            Delete
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        </>
                    )}

                    {/* Pagination */}
                    <div className={styles.pagination}>
                        <div className={styles.pageSizeWrap}>
                            <label htmlFor="rows-per-page">Rows per page:</label>
                            <select
                                id="rows-per-page"
                                value={pageSize}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    setPageSize(val === 'ALL' ? 'ALL' : Number(val));
                                }}
                                className={`${styles.select} ${styles.pageSelect}`}
                            >
                                <option value={10}>10</option>
                                <option value={20}>20</option>
                                <option value={30}>30</option>
                                <option value={50}>50</option>
                                <option value={100}>100</option>
                                <option value="ALL">All</option>
                            </select>
                        </div>

                        <div className={styles.pageControls}>
                            <span className={styles.pageIndicator}>
                                Page {safePage} of {totalPages}
                            </span>
                            <button
                                type="button"
                                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                disabled={safePage <= 1 || pageSize === 'ALL'}
                                className={styles.pageButton}
                            >
                                Previous
                            </button>
                            <button
                                type="button"
                                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                disabled={safePage >= totalPages || pageSize === 'ALL'}
                                className={styles.pageButton}
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </main>
            </div>

            {/* Modals */}
            <ActivityFormModal
                isOpen={showActivityModal}
                initialData={editingActivity}
                accountsRefreshKey={accountsRefreshKey}
                onClose={() => {
                    setShowActivityModal(false);
                    setEditingActivity(null);
                }}
                onSuccess={(isEdit) => {
                    setShowActivityModal(false);
                    setEditingActivity(null);
                    setSuccessBanner(isEdit ? 'Activity updated successfully.' : 'Activity added successfully.');
                    fetchActivities();
                }}
            />

            <FetchDividendsModal
                isOpen={showDividendModal}
                onClose={() => setShowDividendModal(false)}
                onSuccess={(addedCount) => {
                    setSuccessBanner(`Added ${addedCount} dividend ${addedCount === 1 ? 'activity' : 'activities'}.`);
                    fetchActivities();
                }}
            />

            {showImportModal && (
                <BulkUploadModal
                    onClose={() => setShowImportModal(false)}
                    onSuccess={(importedCount) => {
                        setShowImportModal(false);
                        setSuccessBanner(
                            importedCount
                                ? `Imported ${importedCount} ${importedCount === 1 ? 'activity' : 'activities'}.`
                                : 'Activities imported successfully.'
                        );
                        fetchActivities();
                    }}
                />
            )}

            {showBulkEditModal && (
                <BulkEditModal
                    count={selectedActivities.size}
                    selectedIds={Array.from(selectedActivities)}
                    uniqueSymbolsCount={selectedUniqueSymbolsCount}
                    onClose={() => setShowBulkEditModal(false)}
                    onSuccess={(updatedCount) => {
                        setShowBulkEditModal(false);
                        setSelectedActivities(new Set());
                        setSuccessBanner(
                            `Updated ${updatedCount ?? selectedActivities.size} ${(updatedCount ?? selectedActivities.size) === 1 ? 'activity' : 'activities'}.`
                        );
                        fetchActivities();
                    }}
                />
            )}

            {showTransferModal && (
                <TransferAccountsModal
                    onClose={() => setShowTransferModal(false)}
                    onSuccess={(transferredCount) => {
                        setShowTransferModal(false);
                        setAccountsRefreshKey((prev) => prev + 1);
                        setSuccessBanner(
                            transferredCount
                                ? `Transferred ${transferredCount} ${transferredCount === 1 ? 'holding' : 'holdings'} successfully.`
                                : 'Account transfer completed successfully.'
                        );
                        fetchActivities();
                    }}
                />
            )}

            <ConfirmDialog
                isOpen={Boolean(deleteTarget)}
                title="Delete Activity"
                description="This transaction will be permanently removed from your portfolio ledger."
                detail={
                    deleteTarget
                        ? `${deleteTarget.type} ${formatQuantity(deleteTarget.quantity)} ${deleteTarget.investment.symbol} on ${formatDate(deleteTarget.date)}`
                        : undefined
                }
                confirmLabel="Delete Activity"
                tone="danger"
                loading={isDeleting}
                onCancel={() => setDeleteTarget(null)}
                onConfirm={handleConfirmSingleDelete}
            />

            <ConfirmDialog
                isOpen={confirmBatchDelete}
                title={`Delete ${selectedActivities.size} Selected Activities`}
                description="All selected transactions will be permanently removed from your portfolio ledger."
                detail="This action cannot be undone and may recalculate portfolio holdings and history."
                confirmLabel={`Delete ${selectedActivities.size} Activities`}
                tone="danger"
                loading={isDeleting}
                onCancel={() => setConfirmBatchDelete(false)}
                onConfirm={handleConfirmBatchDelete}
            />
        </div>
    );
}
