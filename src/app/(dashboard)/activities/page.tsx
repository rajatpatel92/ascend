'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from 'react';
import AddActivityForm from '@/components/AddActivityForm';
import styles from './page.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import { useDate } from '@/context/DateContext';
import { useSession } from 'next-auth/react';
import DateInput from '@/components/DateInput';
import Papa from 'papaparse';
import BulkUploadModal from '@/components/BulkUploadModal';
import BulkEditModal from '@/components/BulkEditModal';
import TransferAccountsModal from '@/components/TransferAccountsModal';
import { formatQuantity } from '@/lib/format';
import { motion, AnimatePresence } from 'framer-motion';

interface Activity {
    id: string;
    type: string;
    date: string;
    quantity: number;
    price: number;
    fee?: number;
    currency?: string;
    investment: {
        symbol: string;
        name: string;
        currencyCode: string;
        type: string;
    };
    platform?: {
        id: string;
        name: string;
    };
    account?: {
        id: string;
        name: string;
        type: string;
    };
}

interface User {
    id: string;
    username: string;
    name?: string;
}

export default function ActivitiesPage() {
    const [activities, setActivities] = useState<Activity[]>([]);
    const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
    const { format, convert, currency } = useCurrency();
    const { formatDate } = useDate();

    const [showFilters, setShowFilters] = useState(false);

    // Modal States
    const [showImportModal, setShowImportModal] = useState(false);
    const [showDividendModal, setShowDividendModal] = useState(false);
    const [showBulkEditModal, setShowBulkEditModal] = useState(false);
    const [showTransferModal, setShowTransferModal] = useState(false);

    // Dividend Fetching States
    type DividendStep = 'SELECTION' | 'SCANNING' | 'RESULTS';
    const [dividendStep, setDividendStep] = useState<DividendStep>('SELECTION');
    const [availableSymbols, setAvailableSymbols] = useState<{ symbol: string, name: string }[]>([]);
    const [selectedScanSymbols, setSelectedScanSymbols] = useState<Set<string>>(new Set());

    // Selection States
    const [selectedDividends, setSelectedDividends] = useState<Set<string>>(new Set());
    const [foundDividends, setFoundDividends] = useState<any[]>([]);
    const [reinvestSelection, setReinvestSelection] = useState<Set<string>>(new Set());
    const [showDuplicates, setShowDuplicates] = useState(false);
    const [showHidden, setShowHidden] = useState(false);
    const [range, setRange] = useState('ALL');
    const [customStart, setCustomStart] = useState('');
    const [customEnd, setCustomEnd] = useState('');
    const RANGES = ['1W', '1M', '3M', '6M', 'YTD', '1Y', '2Y', '3Y', 'ALL'];
    const [scanYear, setScanYear] = useState(new Date().getFullYear().toString());

    const [filterAccount, setFilterAccount] = useState('');
    const [filterAccountType, setFilterAccountType] = useState('');
    const [filterPlatform, setFilterPlatform] = useState('');
    const [filterSymbol, setFilterSymbol] = useState('');
    const [filterType, setFilterType] = useState('');
    const [pageSize, setPageSize] = useState<number | 'ALL'>(20);
    const [currentPage, setCurrentPage] = useState(1);

    const [showAddForm, setShowAddForm] = useState(false);
    const [users, setUsers] = useState<User[]>([]);

    const fetchUsers = async () => {
        try {
            const res = await fetch('/api/users');
            if (res.ok) {
                const data = await res.json();
                setUsers(data);
            }
        } catch (err) {
            console.error('Failed to fetch users', err);
        }
    };

    const fetchActivities = async () => {
        try {
            const res = await fetch('/api/activities');
            const data = await res.json();
            if (Array.isArray(data)) {
                setActivities(data);
            }
        } catch (error) {
            console.error('Failed to fetch activities', error);
        }
    };

    useEffect(() => {
        fetchActivities();
        fetchUsers();
    }, []);

    // Reset page when filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [range, customStart, customEnd, filterAccount, filterAccountType, filterPlatform, filterSymbol, filterType, pageSize]);

    const handleEdit = (activity: Activity) => {
        setEditingActivity(activity);
        setShowAddForm(true);
        // The main content area scrolls, not the window
        document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'smooth' });
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Are you sure you want to delete this activity?')) return;

        try {
            const res = await fetch(`/api/activities/${id}`, {
                method: 'DELETE',
            });
            if (res.ok) {
                fetchActivities();
            } else {
                alert('Failed to delete activity');
            }
        } catch (error) {
            console.error('Delete failed', error);
        }
    };

    const handleSuccess = () => {
        fetchActivities();
        setEditingActivity(null);
        setShowAddForm(false);
    };

    // Derive options for filters
    const accountTypes = Array.from(new Set(activities.map(a => a.account?.type).filter(Boolean))) as string[];
    const platforms = Array.from(new Set(activities.map(a => a.platform?.name).filter(Boolean))) as string[];
    const symbols = Array.from(new Set(activities.map(a => a.investment.symbol))).sort();
    const activityTypes = Array.from(new Set(activities.map(a => a.type))).sort();

    // Derive unique accounts for the filter
    const accountsMap = new Map<string, { id: string, name: string, type: string, displayName: string }>();
    activities.forEach(a => {
        if (a.account) {
            const user = users.find(u => u.username === a.account?.name);
            const displayName = user?.name || a.account.name;
            accountsMap.set(a.account.id, {
                id: a.account.id,
                name: a.account.name,
                type: a.account.type,
                displayName: `${displayName} - ${a.account.type}`
            });
        }
    });
    const accounts = Array.from(accountsMap.values());

    const getFilteredActivities = () => {
        let filtered = activities;

        // Date Range Filter
        if (range !== 'ALL') {
            const now = new Date();
            let startDate = new Date();

            if (range === 'CUSTOM' && customStart && customEnd) {
                startDate = new Date(customStart);
                const endDate = new Date(customEnd);
                endDate.setHours(23, 59, 59, 999);
                filtered = filtered.filter(a => {
                    const date = new Date(a.date);
                    return date >= startDate && date <= endDate;
                });
            } else {
                switch (range) {
                    case '1W': startDate.setDate(now.getDate() - 7); break;
                    case '1M': startDate.setMonth(now.getMonth() - 1); break;
                    case '3M': startDate.setMonth(now.getMonth() - 3); break;
                    case '6M': startDate.setMonth(now.getMonth() - 6); break;
                    case 'YTD': startDate.setMonth(0, 1); break;
                    case '1Y': startDate.setFullYear(now.getFullYear() - 1); break;
                    case '2Y': startDate.setFullYear(now.getFullYear() - 2); break;
                    case '3Y': startDate.setFullYear(now.getFullYear() - 3); break;
                }
                if (range !== 'ALL' && range !== 'CUSTOM') {
                    filtered = filtered.filter(a => new Date(a.date) >= startDate);
                }
            }
        }

        // Account Filter
        if (filterAccount) {
            filtered = filtered.filter(a => a.account?.id === filterAccount);
        }

        // Account Type Filter
        if (filterAccountType) {
            filtered = filtered.filter(a => a.account?.type === filterAccountType);
        }

        // Platform Filter
        if (filterPlatform) {
            filtered = filtered.filter(a => a.platform?.name === filterPlatform);
        }

        // Symbol Filter
        if (filterSymbol) {
            filtered = filtered.filter(a => a.investment.symbol === filterSymbol);
        }

        // Activity Type Filter
        if (filterType) {
            filtered = filtered.filter(a => a.type === filterType);
        }

        return filtered;
    };

    const filteredActivities = getFilteredActivities();

    // Pagination Logic
    const totalItems = filteredActivities.length;
    const totalPages = pageSize === 'ALL' ? 1 : Math.ceil(totalItems / pageSize);
    const paginatedActivities = pageSize === 'ALL'
        ? filteredActivities
        : filteredActivities.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    const { data: session } = useSession();
    const role = (session?.user as any)?.role || 'VIEWER';

    const [loadingDividends, setLoadingDividends] = useState(false);

    const [selectedActivities, setSelectedActivities] = useState<Set<string>>(new Set());
    const [showMenu, setShowMenu] = useState(false);

    const handleBatchDelete = async () => {
        if (selectedActivities.size === 0) return;
        if (!confirm(`Are you sure you want to delete ${selectedActivities.size} activities? This cannot be undone.`)) return;

        try {
            const res = await fetch('/api/activities/batch-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: Array.from(selectedActivities) })
            });

            if (res.ok) {
                const data = await res.json();
                alert(`Successfully deleted ${data.count} activities.`);
                setSelectedActivities(new Set());
                fetchActivities();
            } else {
                alert('Failed to delete activities.');
            }
        } catch (error) {
            console.error('Failed to batch delete', error);
        }
    };

    const toggleActivitySelection = (id: string) => {
        const newSelected = new Set(selectedActivities);
        if (newSelected.has(id)) {
            newSelected.delete(id);
        } else {
            newSelected.add(id);
        }
        setSelectedActivities(newSelected);
    };

    const toggleAllActivities = () => {
        if (selectedActivities.size === paginatedActivities.length) {
            setSelectedActivities(new Set());
        } else {
            setSelectedActivities(new Set(paginatedActivities.map(a => a.id)));
        }
    };

    const fetchAvailableSymbols = async () => {
        try {
            const res = await fetch('/api/investments');
            if (res.ok) {
                const data = await res.json();
                setAvailableSymbols(data);
                // Default select all
                setSelectedScanSymbols(new Set(data.map((i: any) => i.symbol)));
            }
        } catch (error) {
            console.error('Failed to fetch investments', error);
        }
    };

    const getDivKey = (d: any) => `${d.symbol}-${d.date}-${d.amount}`;

    const handleCloseDividendModal = () => {
        setShowDividendModal(false);
        setFoundDividends([]);
        setSelectedDividends(new Set());
        setReinvestSelection(new Set());
        setDividendStep('SELECTION');
        setShowDuplicates(false);
        setShowHidden(false);
    };

    const handleFetchDividends = async () => {
        setDividendStep('SELECTION');
        setShowDividendModal(true);
        setFoundDividends([]);
        setSelectedDividends(new Set());
        setReinvestSelection(new Set());
        fetchAvailableSymbols();
    };

    const handleScanDividends = async () => {
        setDividendStep('SCANNING');
        setFoundDividends([]);
        setReinvestSelection(new Set());
        setSelectedDividends(new Set());

        try {
            const res = await fetch('/api/dividends/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbols: Array.from(selectedScanSymbols),
                    startYear: scanYear
                })
            });

            const data = await res.json();
            console.log('SCAN RESULTS:', data);

            if (Array.isArray(data)) {
                // Sort by date descending
                data.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
                setFoundDividends(data);

                // Select only non-duplicates and non-hidden by default
                const initialSelection = new Set<string>();
                data.forEach((d: any, index: number) => {
                    const isDup = !!d.isDuplicate;
                    const isHidden = !!d.isHidden;
                    if (!isDup && !isHidden) {
                        initialSelection.add(getDivKey(d));
                    }
                });

                setSelectedDividends(initialSelection);
                setDividendStep('RESULTS');
            } else {
                alert('Failed to scan dividends');
                setDividendStep('SELECTION');
            }
        } catch (error) {
            console.error('Failed to fetch dividends', error);
            setDividendStep('SELECTION');
        }
    };

    const handleAddDividends = async () => {
        const toAdd = foundDividends
            .filter(div => selectedDividends.has(getDivKey(div)))
            .map(div => ({ ...div, reinvest: reinvestSelection.has(getDivKey(div)) }));

        if (toAdd.length === 0) return;

        try {
            const res = await fetch('/api/dividends/batch-add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dividends: toAdd })
            });

            if (res.ok) {
                handleCloseDividendModal();
                fetchActivities();
                alert(`Successfully added ${toAdd.length} dividend activities.`);
            } else {
                alert('Failed to add dividends.');
            }
        } catch (error) {
            console.error('Failed to add dividends', error);
        }
    };

    const toggleDividendSelection = (key: string) => {
        const newSelected = new Set(selectedDividends);
        if (newSelected.has(key)) {
            newSelected.delete(key);
        } else {
            newSelected.add(key);
        }
        setSelectedDividends(newSelected);
    };

    const toggleReinvestSelection = (key: string) => {
        const newReinvest = new Set(reinvestSelection);
        if (newReinvest.has(key)) {
            newReinvest.delete(key);
        } else {
            newReinvest.add(key);
        }
        setReinvestSelection(newReinvest);
    };

    const handleToggleHide = async (d: any) => {
        const isHidden = !!d.isHidden;
        const method = isHidden ? 'DELETE' : 'POST';

        try {
            const res = await fetch('/api/dividends/hide', {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol: d.symbol, date: d.date, amount: d.amount })
            });

            if (res.ok) {
                // Update local state
                setFoundDividends(prev => prev.map(div => {
                    if (getDivKey(div) === getDivKey(d)) {
                        return { ...div, isHidden: !isHidden };
                    }
                    return div;
                }));
                // Deselect if hidden
                if (!isHidden) {
                    const newSelected = new Set(selectedDividends);
                    newSelected.delete(getDivKey(d));
                    setSelectedDividends(newSelected);
                }
            } else {
                alert('Failed to update hidden status');
            }
        } catch (error) {
            console.error('Failed to toggle hide', error);
        }
    };

    const toggleAllDividends = () => {
        const displayedDividends = foundDividends.filter(d => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden));
        const displayedKeys = displayedDividends.map(getDivKey);
        const allSelected = displayedKeys.length > 0 && displayedKeys.every(k => selectedDividends.has(k));

        const newSelected = new Set(selectedDividends);
        if (allSelected) {
            displayedKeys.forEach(k => newSelected.delete(k));
        } else {
            displayedKeys.forEach(k => newSelected.add(k));
        }
        setSelectedDividends(newSelected);
    };

    const toggleAllReinvest = () => {
        const displayedDividends = foundDividends.filter(d => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden));
        const displayedKeys = displayedDividends.map(getDivKey);
        // Only consider items strictly, or just all visible?
        // Logic: If all visible are checked -> Uncheck all. Else -> Check all.
        const allChecked = displayedKeys.length > 0 && displayedKeys.every(k => reinvestSelection.has(k));

        const newReinvest = new Set(reinvestSelection);
        if (allChecked) {
            displayedKeys.forEach(k => newReinvest.delete(k));
        } else {
            displayedKeys.forEach(k => newReinvest.add(k));
        }
        setReinvestSelection(newReinvest);
    };

    const [isBulkHiding, setIsBulkHiding] = useState(false);
    const toggleAllHide = async () => {
        if (isBulkHiding) return;
        const displayedDividends = foundDividends.filter(d => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden));
        if (displayedDividends.length === 0) return;

        // Determine target state:
        // If ANY are NOT hidden (visible) -> Hide All.
        // If ALL are hidden -> Unhide All.
        const anyVisible = displayedDividends.some(d => !d.isHidden);
        const targetIsHidden = anyVisible; // If any are visible, we want to hide them (set isHidden=true)

        // Filter items that need changing
        const itemsToUpdate = displayedDividends.filter(d => !!d.isHidden !== targetIsHidden);

        if (itemsToUpdate.length === 0) return;

        setIsBulkHiding(true);
        try {
            await Promise.all(itemsToUpdate.map(d => handleToggleHide(d)));
        } finally {
            setIsBulkHiding(false);
        }
    };


    const handleExport = () => {
        // Determine which activities to export
        let dataToExport = filteredActivities;
        if (selectedActivities.size > 0) {
            dataToExport = filteredActivities.filter(a => selectedActivities.has(a.id));
        }

        if (dataToExport.length === 0) {
            alert('No activities to export.');
            return;
        }

        // Map to CSV Schema
        // Map to CSV Schema
        const csvData = dataToExport.map(a => ({
            Date: a.date.split('T')[0], // YYYY-MM-DD
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

        // Generate CSV
        const csv = Papa.unparse(csvData);

        // Trigger Download
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `activities_export_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();

        document.body.removeChild(link);
    };

    const [showDesktopMenu, setShowDesktopMenu] = useState(false);
    const [showMobileMenu, setShowMobileMenu] = useState(false);

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <h1 className={styles.title}>Activities</h1>
                {role !== 'VIEWER' && (
                    <>
                        {/* Desktop Actions */}
                        <div className={styles.desktopActions}>
                            {selectedActivities.size > 0 && (
                                <>
                                    <button
                                        onClick={() => setShowBulkEditModal(true)}
                                        style={{
                                            background: 'var(--primary)',
                                            color: 'white',
                                            border: 'none',
                                            padding: '0.75rem 1.5rem',
                                            borderRadius: '0.5rem',
                                            fontWeight: 600,
                                            cursor: 'pointer'
                                        }}
                                    >
                                        Edit Selected ({selectedActivities.size})
                                    </button>
                                    <button
                                        onClick={handleBatchDelete}
                                        style={{
                                            background: 'var(--danger)',
                                            color: 'white',
                                            border: 'none',
                                            padding: '0.75rem 1.5rem',
                                            borderRadius: '0.5rem',
                                            fontWeight: 600,
                                            cursor: 'pointer'
                                        }}
                                    >
                                        Delete Selected ({selectedActivities.size})
                                    </button>
                                </>
                            )}
                            <button
                                onClick={handleFetchDividends}
                                style={{
                                    background: 'var(--card-bg)',
                                    color: 'var(--text-primary)',
                                    border: '1px solid var(--card-border)',
                                    padding: '0.75rem 1.5rem',
                                    borderRadius: '0.5rem',
                                    fontWeight: 600,
                                    cursor: 'pointer'
                                }}
                            >
                                Fetch Dividends
                            </button>
                            <button
                                onClick={() => {
                                    setEditingActivity(null);
                                    setShowAddForm(!showAddForm);
                                }}
                                style={{
                                    background: 'var(--primary)',
                                    color: 'white',
                                    border: 'none',
                                    padding: '0.75rem 1.5rem',
                                    borderRadius: '0.5rem',
                                    fontWeight: 600,
                                    cursor: 'pointer'
                                }}
                            >
                                {showAddForm ? 'Close Form' : '+ Add Activity'}
                            </button>
                            <div style={{ position: 'relative' }}>
                                <button
                                    onClick={() => setShowDesktopMenu(!showDesktopMenu)}
                                    style={{
                                        background: 'var(--card-bg)',
                                        color: 'var(--text-primary)',
                                        border: '1px solid var(--card-border)',
                                        padding: '0.75rem',
                                        borderRadius: '0.5rem',
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        width: '42px',
                                        height: '42px'
                                    }}
                                >
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="1" />
                                        <circle cx="12" cy="5" r="1" />
                                        <circle cx="12" cy="19" r="1" />
                                    </svg>
                                </button>

                                {showDesktopMenu && (
                                    <>
                                        <div
                                            style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                                            onClick={() => setShowDesktopMenu(false)}
                                        />
                                        <div style={{
                                            position: 'absolute',
                                            top: '100%',
                                            right: 0,
                                            marginTop: '0.5rem',
                                            background: 'var(--card-bg)',
                                            border: '1px solid var(--card-border)',
                                            borderRadius: '0.5rem',
                                            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                                            zIndex: 20,
                                            minWidth: '160px',
                                            overflow: 'hidden'
                                        }}>
                                            <button
                                                onClick={() => {
                                                    handleExport();
                                                    setShowDesktopMenu(false);
                                                }}
                                                style={{
                                                    display: 'block',
                                                    width: '100%',
                                                    textAlign: 'left',
                                                    padding: '0.75rem 1rem',
                                                    background: 'transparent',
                                                    border: 'none',
                                                    color: 'var(--text-primary)',
                                                    cursor: 'pointer',
                                                    fontSize: '0.875rem'
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-secondary)'}
                                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                            >
                                                Export CSV
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setShowImportModal(true);
                                                    setShowDesktopMenu(false);
                                                }}
                                                style={{
                                                    display: 'block',
                                                    width: '100%',
                                                    textAlign: 'left',
                                                    padding: '0.75rem 1rem',
                                                    background: 'transparent',
                                                    border: 'none',
                                                    color: 'var(--text-primary)',
                                                    cursor: 'pointer',
                                                    fontSize: '0.875rem',
                                                    borderTop: '1px solid var(--card-border)'
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-secondary)'}
                                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                            >
                                                Import CSV
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setShowTransferModal(true);
                                                    setShowDesktopMenu(false);
                                                }}
                                                style={{
                                                    display: 'block',
                                                    width: '100%',
                                                    textAlign: 'left',
                                                    padding: '0.75rem 1rem',
                                                    background: 'transparent',
                                                    border: 'none',
                                                    color: 'var(--text-primary)',
                                                    cursor: 'pointer',
                                                    fontSize: '0.875rem',
                                                    borderTop: '1px solid var(--card-border)'
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-secondary)'}
                                                onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                            >
                                                Transfer Accounts
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>

                        {/* Mobile Actions */}
                        <div className={styles.mobileActions} style={{ position: 'relative' }}>
                            <button
                                onClick={() => setShowMobileMenu(!showMobileMenu)}
                                style={{
                                    background: 'var(--primary)',
                                    color: 'white',
                                    border: 'none',
                                    padding: '0.5rem 1rem',
                                    borderRadius: '0.5rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.5rem'
                                }}
                            >
                                <span>Actions</span>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M6 9l6 6 6-6" />
                                </svg>
                            </button>

                            {showMobileMenu && (
                                <>
                                    <div
                                        style={{ position: 'fixed', inset: 0, zIndex: 10 }}
                                        onClick={() => setShowMobileMenu(false)}
                                    />
                                    <div style={{
                                        position: 'absolute',
                                        top: '100%',
                                        right: 0,
                                        marginTop: '0.5rem',
                                        background: 'var(--card-bg)',
                                        border: '1px solid var(--card-border)',
                                        borderRadius: '0.5rem',
                                        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                                        zIndex: 20,
                                        minWidth: '200px',
                                        overflow: 'hidden'
                                    }}>
                                        <button
                                            onClick={() => {
                                                setEditingActivity(null);
                                                setShowAddForm(true);
                                                setShowMobileMenu(false);
                                            }}
                                            style={{
                                                display: 'block',
                                                width: '100%',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                background: 'transparent',
                                                border: 'none',
                                                color: 'var(--primary)',
                                                fontWeight: 600,
                                                cursor: 'pointer',
                                                fontSize: '0.875rem'
                                            }}
                                        >
                                            + Add Activity
                                        </button>
                                        <button
                                            onClick={() => {
                                                handleFetchDividends();
                                                setShowMobileMenu(false);
                                            }}
                                            style={{
                                                display: 'block',
                                                width: '100%',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                background: 'transparent',
                                                border: 'none',
                                                color: 'var(--text-primary)',
                                                cursor: 'pointer',
                                                fontSize: '0.875rem',
                                                borderTop: '1px solid var(--card-border)'
                                            }}
                                        >
                                            Fetch Dividends
                                        </button>
                                        <button
                                            onClick={() => {
                                                handleExport();
                                                setShowMobileMenu(false);
                                            }}
                                            style={{
                                                display: 'block',
                                                width: '100%',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                background: 'transparent',
                                                border: 'none',
                                                color: 'var(--text-primary)',
                                                cursor: 'pointer',
                                                fontSize: '0.875rem',
                                                borderTop: '1px solid var(--card-border)'
                                            }}
                                        >
                                            Export CSV
                                        </button>
                                        <button
                                            onClick={() => {
                                                setShowImportModal(true);
                                                setShowMobileMenu(false);
                                            }}
                                            style={{
                                                display: 'block',
                                                width: '100%',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                background: 'transparent',
                                                border: 'none',
                                                color: 'var(--text-primary)',
                                                cursor: 'pointer',
                                                fontSize: '0.875rem',
                                                borderTop: '1px solid var(--card-border)'
                                            }}
                                        >
                                            Import CSV
                                        </button>
                                        <button
                                            onClick={() => {
                                                setShowTransferModal(true);
                                                setShowMobileMenu(false);
                                            }}
                                            style={{
                                                display: 'block',
                                                width: '100%',
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                background: 'transparent',
                                                border: 'none',
                                                color: 'var(--text-primary)',
                                                cursor: 'pointer',
                                                fontSize: '0.875rem',
                                                borderTop: '1px solid var(--card-border)'
                                            }}
                                        >
                                            Transfer Accounts
                                        </button>
                                    </div>
                                </>
                            )}
                        </div>
                    </>
                )}
            </header>

            {/* Dividend Modal */}
            {showDividendModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
                    <div style={{ background: 'var(--card-bg)', padding: '2rem', borderRadius: '1rem', maxWidth: '1200px', width: '95%', maxHeight: '90vh', overflowY: 'auto' }}>

                        {dividendStep === 'SELECTION' && (
                            <>
                                <h2 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1rem' }}>Select Symbols to Scan</h2>

                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ marginRight: '0.5rem', fontWeight: 600, color: 'var(--text-primary)' }}>Scan From Year:</label>
                                    <select
                                        value={scanYear}
                                        onChange={(e) => setScanYear(e.target.value)}
                                        className={styles.select}
                                        style={{ width: 'auto', display: 'inline-block' }}
                                    >
                                        {Array.from({ length: new Date().getFullYear() - 2019 }, (_, i) => new Date().getFullYear() - i).map(year => (
                                            <option key={year} value={year}>{year}</option>
                                        ))}
                                    </select>
                                </div>

                                <div style={{ marginBottom: '1rem', maxHeight: '400px', overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.5rem' }}>
                                    {availableSymbols.map(item => (
                                        <label key={item.symbol} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem', border: '1px solid var(--card-border)', borderRadius: '0.25rem', cursor: 'pointer', background: selectedScanSymbols.has(item.symbol) ? 'var(--bg-secondary)' : 'transparent' }}>
                                            <input
                                                type="checkbox"
                                                checked={selectedScanSymbols.has(item.symbol)}
                                                onChange={(e) => {
                                                    const newSet = new Set(selectedScanSymbols);
                                                    if (e.target.checked) newSet.add(item.symbol);
                                                    else newSet.delete(item.symbol);
                                                    setSelectedScanSymbols(newSet);
                                                }}
                                            />
                                            <span style={{ fontWeight: 600 }}>{item.symbol}</span>
                                        </label>
                                    ))}
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div>
                                        <button
                                            onClick={() => setSelectedScanSymbols(new Set(availableSymbols.map(i => i.symbol)))}
                                            style={{ background: 'transparent', border: 'none', color: 'var(--primary)', cursor: 'pointer', marginRight: '1rem' }}
                                        >
                                            Select All
                                        </button>
                                        <button
                                            onClick={() => setSelectedScanSymbols(new Set())}
                                            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
                                        >
                                            Deselect All
                                        </button>
                                    </div>
                                    <div style={{ display: 'flex', gap: '1rem' }}>
                                        <button onClick={handleCloseDividendModal} style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid var(--card-border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }}>Cancel</button>
                                        <button
                                            onClick={handleScanDividends}
                                            style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem', background: 'var(--primary)', color: 'white', border: 'none', cursor: 'pointer', opacity: selectedScanSymbols.size === 0 ? 0.5 : 1 }}
                                            disabled={selectedScanSymbols.size === 0}
                                        >
                                            Scan for Dividends
                                        </button>
                                    </div>
                                </div>
                            </>
                        )}

                        {dividendStep === 'SCANNING' && (
                            <div style={{ textAlign: 'center', padding: '2rem' }}>
                                <div style={{ display: 'inline-block', width: '2rem', height: '2rem', border: '3px solid var(--primary)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }}></div>
                                <h3 style={{ marginTop: '1rem', fontSize: '1.25rem' }}>Scanning for Dividends...</h3>
                                <p style={{ color: 'var(--text-secondary)' }}>This may take a few moments depending on the number of symbols.</p>
                                <style jsx>{`
                                    @keyframes spin {
                                        to { transform: rotate(360deg); }
                                    }
                                `}</style>
                            </div>
                        )}

                        {dividendStep === 'RESULTS' && (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                    <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Found Dividends</h2>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        <button
                                            onClick={() => setShowDuplicates(!showDuplicates)}
                                            style={{
                                                background: showDuplicates ? 'var(--primary)' : 'transparent',
                                                color: showDuplicates ? 'white' : 'var(--text-secondary)',
                                                border: `1px solid ${showDuplicates ? 'var(--primary)' : 'var(--card-border)'}`,
                                                padding: '0.25rem 0.75rem',
                                                borderRadius: '1rem',
                                                fontSize: '0.75rem',
                                                cursor: 'pointer',
                                                transition: 'all 0.2s'
                                            }}
                                        >
                                            Show Already Added
                                        </button>
                                        <button
                                            onClick={() => setShowHidden(!showHidden)}
                                            style={{
                                                background: showHidden ? 'var(--primary)' : 'transparent',
                                                color: showHidden ? 'white' : 'var(--text-secondary)',
                                                border: `1px solid ${showHidden ? 'var(--primary)' : 'var(--card-border)'}`,
                                                padding: '0.25rem 0.75rem',
                                                borderRadius: '1rem',
                                                fontSize: '0.75rem',
                                                cursor: 'pointer',
                                                transition: 'all 0.2s'
                                            }}
                                        >
                                            Show Hidden
                                        </button>
                                    </div>
                                </div>
                                {foundDividends.filter(d => showDuplicates || !d.isDuplicate).length === 0 ? (
                                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>
                                        No new dividends found for the selected symbols in the last year.
                                        {!showDuplicates && foundDividends.length > 0 && (
                                            <div style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
                                                {foundDividends.filter(d => d.isDuplicate).length} already added dividends hidden.
                                            </div>
                                        )}
                                        {!showHidden && foundDividends.filter(d => d.isHidden).length > 0 && (
                                            <div style={{ marginTop: '0.5rem', fontSize: '0.875rem' }}>
                                                {foundDividends.filter(d => d.isHidden).length} hidden dividends.
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ overflowX: 'auto', marginBottom: '1rem' }}>
                                        <table className={styles.table}>
                                            <thead>
                                                <tr>
                                                    <th>
                                                        <input
                                                            type="checkbox"
                                                            onChange={toggleAllDividends}
                                                            checked={foundDividends.filter(d => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden)).length > 0 && foundDividends.filter(d => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden)).every(d => selectedDividends.has(getDivKey(d)))}
                                                        />
                                                    </th>
                                                    <th>Date</th>
                                                    <th>Symbol</th>
                                                    <th>Amount</th>
                                                    <th>Existing Match</th>
                                                    <th>
                                                        Reinvest?
                                                        <input
                                                            type="checkbox"
                                                            onChange={toggleAllReinvest}
                                                            checked={foundDividends.filter(d => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden)).length > 0 && foundDividends.filter(d => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden)).every(d => reinvestSelection.has(getDivKey(d)))}
                                                            style={{ marginLeft: '0.5rem', verticalAlign: 'middle' }}
                                                        />
                                                    </th>
                                                    <th>Status</th>
                                                    <th>Account</th>
                                                    <th>
                                                        <button
                                                            onClick={toggleAllHide}
                                                            disabled={isBulkHiding}
                                                            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '0.75rem', textDecoration: 'underline' }}
                                                        >
                                                            {foundDividends.filter(d => (showDuplicates || !d.isDuplicate) && (showHidden || !d.isHidden)).some(d => !d.isHidden) ? 'Hide All' : 'Unhide All'}
                                                        </button>
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {foundDividends
                                                    .filter(div => (showDuplicates || !div.isDuplicate) && (showHidden || !div.isHidden))
                                                    .map((div, i) => {
                                                        const key = getDivKey(div);
                                                        const isHidden = !!div.isHidden;
                                                        return (
                                                            <tr key={key} style={{ opacity: isHidden ? 0.5 : 1, background: div.isDuplicate ? 'var(--bg-secondary)' : 'transparent' }}>
                                                                <td>
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={selectedDividends.has(key)}
                                                                        onChange={() => toggleDividendSelection(key)}
                                                                        disabled={isHidden}
                                                                    />
                                                                </td>
                                                                <td>{formatDate(div.date)}</td>
                                                                <td>{div.symbol}</td>
                                                                <td>{format(div.amount)} {div.currency}</td>
                                                                <td>
                                                                    {div.existingMatch ? (
                                                                        <div style={{ fontSize: '0.85rem', color: 'var(--warning-dark)' }}>
                                                                            <div>{formatDate(div.existingMatch.date)}</div>
                                                                            <div>~ {format(div.existingMatch.amount)}</div>
                                                                        </div>
                                                                    ) : '-'}
                                                                </td>
                                                                <td><input type="checkbox" checked={reinvestSelection.has(key)} onChange={() => toggleReinvestSelection(key)} disabled={isHidden} /></td>
                                                                <td>
                                                                    {isHidden ? (
                                                                        <span style={{ fontSize: '0.75rem', background: 'var(--text-secondary)', color: 'white', padding: '0.25rem 0.5rem', borderRadius: '1rem' }}>Hidden</span>
                                                                    ) : div.isDuplicate ? (
                                                                        <span style={{ fontSize: '0.75rem', background: 'var(--warning-light)', color: 'var(--warning-dark)', padding: '0.25rem 0.5rem', borderRadius: '1rem' }}>Match Found</span>
                                                                    ) : (
                                                                        <span style={{ fontSize: '0.75rem', background: 'var(--success-light)', color: 'var(--success-dark)', padding: '0.25rem 0.5rem', borderRadius: '1rem' }}>New</span>
                                                                    )}
                                                                </td>
                                                                <td>
                                                                    <div style={{ fontWeight: 600 }}>{div.accountDisplayName || div.accountName} - {div.accountType}</div>
                                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{div.platformName}</div>
                                                                </td>
                                                                <td>
                                                                    <button
                                                                        onClick={() => handleToggleHide(div)}
                                                                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary)' }}
                                                                        title={isHidden ? "Unhide" : "Hide"}
                                                                    >
                                                                        {isHidden ? (
                                                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                                                                <circle cx="12" cy="12" r="3"></circle>
                                                                            </svg>
                                                                        ) : (
                                                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                                                                                <line x1="1" y1="1" x2="23" y2="23"></line>
                                                                            </svg>
                                                                        )}
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
                                    <button onClick={() => setDividendStep('SELECTION')} style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid var(--card-border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }}>Back</button>
                                    <button onClick={handleCloseDividendModal} style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid var(--card-border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }}>Cancel</button>
                                    {foundDividends.length > 0 && (
                                        <button
                                            onClick={handleAddDividends}
                                            style={{
                                                padding: '0.5rem 1rem',
                                                borderRadius: '0.5rem',
                                                background: 'var(--primary)',
                                                color: 'white',
                                                border: 'none',
                                                cursor: selectedDividends.size === 0 ? 'not-allowed' : 'pointer',
                                                opacity: selectedDividends.size === 0 ? 0.5 : 1
                                            }}
                                            disabled={selectedDividends.size === 0}
                                        >
                                            Add Selected {selectedDividends.size > 0 && `(${selectedDividends.size})`}
                                        </button>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            {showImportModal && (
                <BulkUploadModal
                    onClose={() => setShowImportModal(false)}
                    onSuccess={() => {
                        fetchActivities();
                        setShowImportModal(false);
                    }}
                />
            )}

            {showTransferModal && (
                <TransferAccountsModal
                    onClose={() => setShowTransferModal(false)}
                    onSuccess={() => {
                        fetchActivities();
                        setShowTransferModal(false);
                    }}
                />
            )}

            {/* Form Wrapper */}
            <div className={`${styles.formWrapper} ${showAddForm ? styles.open : ''}`}>
                <div className={styles.formInner}>
                    <AddActivityForm
                        onSuccess={() => {
                            fetchActivities();
                            setShowAddForm(false);
                            setEditingActivity(null);
                        }}
                        initialData={editingActivity}
                        onCancel={() => {
                            setShowAddForm(false);
                            setEditingActivity(null);
                        }}
                    />
                </div>
            </div>

            <button
                className={styles.mobileFilterToggle}
                onClick={() => setShowFilters(!showFilters)}
            >
                <span>Filters & Options</span>
                <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{
                        transform: showFilters ? 'rotate(180deg)' : 'rotate(0deg)',
                        transition: 'transform 0.2s'
                    }}
                >
                    <path d="M6 9l6 6 6-6" />
                </svg>
            </button>

            <div className={styles.activitiesGrid}>
                {/* Sidebar Filters */}
                <aside className={`${styles.sidebar} ${showFilters ? styles.open : ''}`}>
                    {/* ... (Filters unchanged) ... */}
                    <h2 className={styles.sidebarTitle}>Filters</h2>

                    <div className={styles.filterGroup}>
                        <label className={styles.filterLabel}>Time Range</label>
                        <div className={styles.rangeGrid}>
                            {RANGES.map(r => (
                                <button
                                    key={r}
                                    onClick={() => setRange(r)}
                                    className={`${styles.rangeButton} ${range === r ? styles.active : ''}`}
                                >
                                    {r}
                                </button>
                            ))}
                            <button
                                onClick={() => setRange('CUSTOM')}
                                className={`${styles.rangeButton} ${range === 'CUSTOM' ? styles.active : ''}`}
                            >
                                Custom
                            </button>
                        </div>
                        {range === 'CUSTOM' && (
                            <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div className={styles.dateInputs}>
                                    <DateInput
                                        value={customStart}
                                        onChange={setCustomStart}
                                        className={styles.dateInput}
                                    />
                                    <span className={styles.separator}>to</span>
                                    <DateInput
                                        value={customEnd}
                                        onChange={setCustomEnd}
                                        className={styles.dateInput}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className={styles.filterGroup}>
                        <label className={styles.filterLabel}>Account</label>
                        <select
                            value={filterAccount}
                            onChange={(e) => setFilterAccount(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Accounts</option>
                            {accounts.map(account => (
                                <option key={account.id} value={account.id}>
                                    {account.displayName}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.filterGroup}>
                        <label className={styles.filterLabel}>Account Type</label>
                        <select
                            value={filterAccountType}
                            onChange={(e) => setFilterAccountType(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Account Types</option>
                            {accountTypes.map(type => (
                                <option key={type} value={type}>{type}</option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.filterGroup}>
                        <label className={styles.filterLabel}>Platform</label>
                        <select
                            value={filterPlatform}
                            onChange={(e) => setFilterPlatform(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Platforms</option>
                            {platforms.map(platform => (
                                <option key={platform} value={platform}>{platform}</option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.filterGroup}>
                        <label className={styles.filterLabel}>Symbol</label>
                        <select
                            value={filterSymbol}
                            onChange={(e) => setFilterSymbol(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Symbols</option>
                            {symbols.map(symbol => (
                                <option key={symbol} value={symbol}>{symbol}</option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.filterGroup}>
                        <label className={styles.filterLabel}>Activity Type</label>
                        <select
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value)}
                            className={styles.select}
                        >
                            <option value="">All Types</option>
                            {activityTypes.map(type => (
                                <option key={type} value={type}>{type}</option>
                            ))}
                        </select>
                    </div>
                </aside>

                {/* Main Content */}
                <main className={styles.main}>
                    <div className={styles.listHeader}>
                        <h2 className={styles.listTitle}>Activity Log</h2>
                        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                            {totalItems} entries found
                        </div>
                    </div>

                    <div className={styles.tableContainer}>
                        <table className={styles.table}>
                            <thead>
                                <tr>
                                    <th>
                                        <input
                                            type="checkbox"
                                            checked={paginatedActivities.length > 0 && selectedActivities.size === paginatedActivities.length}
                                            onChange={toggleAllActivities}
                                        />
                                    </th>
                                    <th>Date</th>
                                    <th>Symbol</th>
                                    <th>Type</th>
                                    <th style={{ textAlign: 'right' }}>Qty</th>
                                    <th style={{ textAlign: 'right' }}>Price ({currency})</th>
                                    <th style={{ textAlign: 'right' }}>Total</th>
                                    <th>Account</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedActivities.length === 0 ? (
                                    <tr>
                                        <td colSpan={9} style={{ textAlign: 'center', padding: '2rem' }}>
                                            No activities found.
                                        </td>
                                    </tr>
                                ) : (
                                    <AnimatePresence mode="popLayout">
                                        {paginatedActivities.map((activity) => {
                                            const fromCurrency = activity.investment.currencyCode || 'USD';
                                            const convertedPrice = convert(activity.price, fromCurrency);

                                            let total = activity.quantity * activity.price;
                                            if (activity.type === 'BUY') {
                                                total += (activity.fee || 0);
                                            } else if (activity.type === 'SELL') {
                                                total -= (activity.fee || 0);
                                            }

                                            const convertedTotal = convert(total, fromCurrency);

                                            return (
                                                <motion.tr
                                                    key={activity.id}
                                                    layout
                                                    initial={{ opacity: 0, scale: 0.95 }}
                                                    animate={{ opacity: 1, scale: 1 }}
                                                    exit={{ opacity: 0, transition: { duration: 0.05 } }}
                                                    transition={{ duration: 0.2 }}
                                                    className={styles.row}
                                                    onClick={() => role !== 'VIEWER' && handleEdit(activity)}
                                                    style={{ cursor: role !== 'VIEWER' ? 'pointer' : 'default' }}
                                                >
                                                    <td onClick={(e) => e.stopPropagation()}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedActivities.has(activity.id)}
                                                            onChange={() => toggleActivitySelection(activity.id)}
                                                        />
                                                    </td>
                                                    <td>{formatDate(activity.date)}</td>
                                                    <td>
                                                        <div style={{ fontWeight: 600 }}>{activity.investment.symbol}</div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{activity.investment.name}</div>
                                                    </td>
                                                    <td>
                                                        <span className={`${styles.badge} ${styles[activity.type]}`}>
                                                            {activity.type}
                                                        </span>
                                                    </td>
                                                    <td style={{ textAlign: 'right' }}>{formatQuantity(activity.quantity)}</td>
                                                    <td style={{ textAlign: 'right' }}>{format(convertedPrice)}</td>
                                                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{format(convertedTotal)}</td>
                                                    <td>
                                                        <div style={{ fontWeight: 600 }}>
                                                            {activity.account ?
                                                                `${(users.find(u => u.username === activity.account?.name)?.name || activity.account.name)} - ${activity.account.type}`
                                                                : '-'
                                                            }
                                                        </div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{activity.platform?.name || '-'}</div>
                                                    </td>
                                                    <td style={{ textAlign: 'center' }}>
                                                        {role !== 'VIEWER' && (
                                                            <button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleDelete(activity.id);
                                                                }}
                                                                style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: '1.25rem' }}
                                                            >
                                                                &times;
                                                            </button>
                                                        )}
                                                    </td>
                                                </motion.tr>
                                            );
                                        })}
                                    </AnimatePresence>
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    <div className={styles.pagination}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Rows per page:</span>
                            <select
                                value={pageSize}
                                onChange={(e) => {
                                    const val = e.target.value;
                                    setPageSize(val === 'ALL' ? 'ALL' : Number(val));
                                }}
                                className={styles.select}
                                style={{ width: 'auto' }}
                            >
                                <option value={10}>10</option>
                                <option value={20}>20</option>
                                <option value={30}>30</option>
                                <option value={50}>50</option>
                                <option value={100}>100</option>
                                <option value="ALL">All</option>
                            </select>
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                disabled={currentPage === 1 || pageSize === 'ALL'}
                                className={styles.pageButton}
                            >
                                Previous
                            </button>
                            <button
                                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                disabled={currentPage === totalPages || pageSize === 'ALL'}
                                className={styles.pageButton}
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </main>
            </div>
        </div >
    );
}

