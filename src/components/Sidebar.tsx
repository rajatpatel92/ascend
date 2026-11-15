'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession, signOut } from 'next-auth/react';
import styles from './Sidebar.module.css';
import AscendLogo from './AscendLogo';
import { useCurrency } from '@/context/CurrencyContext';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { useTheme } from '@/context/ThemeContext';
import {
    MdDashboard,
    MdFormatListBulleted,
    MdSettings,
    MdMenu,
    MdClose,
    MdDarkMode,
    MdLightMode,
    MdLogout,
    MdPieChart,
    MdCompareArrows,
    MdCalculate,
    MdBarChart,
    MdBalance,
    MdChevronLeft,
    MdChevronRight,
} from 'react-icons/md';

interface NavItem {
    name: string;
    href: string;
    icon: React.ReactNode;
    exact?: boolean;
}

interface NavSection {
    title: string;
    items: NavItem[];
}

interface SessionUser {
    id?: string;
    name?: string | null;
    username?: string | null;
    email?: string | null;
    role?: string;
}

const SIDEBAR_COLLAPSE_KEY = 'ascend_sidebar_collapsed';
const emptySubscribe = () => () => {};

function getInitials(displayName: string): string {
    const parts = displayName.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'U';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export default function Sidebar() {
    const pathname = usePathname();
    const { currency, setCurrency } = useCurrency();
    const { theme, toggleTheme } = useTheme();
    const [isOpen, setIsOpen] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);
    const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

    useEffect(() => {
        try {
            const saved = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
            if (saved === 'true') {
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setIsCollapsed(true);
            }
        } catch {
            // Ignore localStorage access errors in restricted contexts
        }
    }, []);

    const toggleCollapse = () => {
        setIsCollapsed((prev) => {
            const next = !prev;
            try {
                localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(next));
            } catch {
                // Ignore localStorage errors
            }
            return next;
        });
    };

    const { data: session } = useSession();
    const user = (session?.user as SessionUser | undefined) ?? undefined;
    const role = user?.role || 'VIEWER';
    const displayName = user?.name || user?.username || user?.email || 'Account';
    const initials = getInitials(displayName);
    const roleLabel = role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();

    const sections: NavSection[] = [
        {
            title: 'Overview',
            items: [
                { name: 'Dashboard', href: '/', icon: <MdDashboard size={19} />, exact: true },
                { name: 'Activities', href: '/activities', icon: <MdFormatListBulleted size={19} /> },
            ],
        },
        {
            title: 'Analytics',
            items: [
                { name: 'Allocation', href: '/analysis/allocation', icon: <MdPieChart size={19} /> },
                { name: 'Evolution', href: '/analysis/evolution', icon: <MdBarChart size={19} /> },
                { name: 'Comparison', href: '/analysis/comparison', icon: <MdCompareArrows size={19} /> },
                { name: 'FIRE', href: '/analysis/fire', icon: <MdCalculate size={19} /> },
                { name: 'Rebalancer', href: '/rebalancer', icon: <MdBalance size={19} /> },
            ],
        },
    ];

    if (role === 'ADMIN' || role === 'EDITOR') {
        sections.push({
            title: 'System',
            items: [{ name: 'Settings', href: '/settings', icon: <MdSettings size={19} /> }],
        });
    }

    // Mark <main> inert and allow Escape dismissal while the mobile drawer is open
    useEffect(() => {
        const mainEl = document.querySelector('main');
        if (!mainEl) return;

        const syncModality = () => {
            mainEl.inert = isOpen && window.innerWidth <= 768;
        };

        syncModality();
        window.addEventListener('resize', syncModality);

        const handleKeyDown = (e: KeyboardEvent) => {
            if (isOpen && e.key === 'Escape') {
                setIsOpen(false);
            }
        };
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            mainEl.inert = false;
            window.removeEventListener('resize', syncModality);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen]);

    const collapsedDesktop = mounted && isCollapsed;

    return (
        <>
            {/* Mobile Toggle Button */}
            <button
                type="button"
                className={styles.mobileToggle}
                onClick={() => setIsOpen(true)}
                aria-label="Open Menu"
                aria-expanded={isOpen}
            >
                <MdMenu size={22} />
            </button>

            {/* Overlay */}
            {isOpen && (
                <div
                    className={styles.overlay}
                    onClick={() => setIsOpen(false)}
                    aria-hidden="true"
                />
            )}

            <aside
                className={`${styles.sidebar} ${isOpen ? styles.open : ''} ${collapsedDesktop ? styles.collapsed : ''}`}
            >
                <div className={styles.brandHeader}>
                    <Link
                        href="/"
                        className={styles.brandLink}
                        onClick={() => setIsOpen(false)}
                        aria-label="Ascend Dashboard"
                        title="Ascend Portfolio"
                    >
                        <AscendLogo compact={collapsedDesktop} size="md" />
                    </Link>

                    <button
                        type="button"
                        className={styles.collapseBtn}
                        onClick={toggleCollapse}
                        aria-label={collapsedDesktop ? 'Expand sidebar' : 'Collapse sidebar'}
                        title={collapsedDesktop ? 'Expand sidebar' : 'Collapse sidebar'}
                    >
                        {collapsedDesktop ? <MdChevronRight size={18} /> : <MdChevronLeft size={18} />}
                    </button>

                    <button
                        type="button"
                        className={styles.closeButton}
                        onClick={() => setIsOpen(false)}
                        aria-label="Close Menu"
                    >
                        <MdClose size={22} />
                    </button>
                </div>

                <nav className={styles.nav} aria-label="Main navigation">
                    {sections.map((section) => (
                        <div key={section.title} className={styles.navSection}>
                            <div className={styles.sectionTitle}>{section.title}</div>
                            {section.items.map((item) => {
                                const isActive = item.exact
                                    ? pathname === item.href
                                    : pathname === item.href || Boolean(pathname?.startsWith(`${item.href}/`));

                                return (
                                    <Link
                                        key={item.href}
                                        href={item.href}
                                        className={`${styles.link} ${isActive ? styles.active : ''}`}
                                        onClick={() => setIsOpen(false)}
                                        title={collapsedDesktop ? item.name : undefined}
                                        aria-current={isActive ? 'page' : undefined}
                                    >
                                        <span className={styles.iconWrapper}>{item.icon}</span>
                                        <span className={styles.linkLabel}>{item.name}</span>
                                    </Link>
                                );
                            })}
                        </div>
                    ))}
                </nav>

                <div className={styles.footer}>
                    <div className={styles.controls}>
                        <select
                            className={styles.currencySelect}
                            value={currency}
                            onChange={(e) => setCurrency(e.target.value)}
                            aria-label="Display Currency"
                            title="Display Currency"
                        >
                            {SUPPORTED_CURRENCIES.map((c) => (
                                <option key={c.code} value={c.code}>
                                    {collapsedDesktop ? c.code : `${c.code} (${c.symbol})`}
                                </option>
                            ))}
                        </select>

                        <button
                            type="button"
                            className={styles.themeToggle}
                            onClick={toggleTheme}
                            aria-label={mounted && theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                            title={mounted && theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                        >
                            {mounted ? (
                                theme === 'light' ? <MdDarkMode size={18} /> : <MdLightMode size={18} />
                            ) : (
                                <div style={{ width: 18, height: 18 }} />
                            )}
                        </button>
                    </div>

                    <div className={styles.userCard}>
                        <div className={styles.userIdentity} title={`${displayName} (${roleLabel})`}>
                            <div className={styles.avatar} aria-hidden="true">
                                {initials}
                            </div>
                            <div className={styles.userMeta}>
                                <span className={styles.userName}>{displayName}</span>
                                <span className={styles.userRole}>{roleLabel}</span>
                            </div>
                        </div>

                        <button
                            type="button"
                            className={styles.logoutButton}
                            onClick={async () => {
                                await signOut({ redirect: false });
                                window.location.href = '/login';
                            }}
                            aria-label="Logout"
                            title="Sign out"
                        >
                            <MdLogout size={18} />
                        </button>
                    </div>
                </div>
            </aside>
        </>
    );
}
