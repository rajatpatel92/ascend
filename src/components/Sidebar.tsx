/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './Sidebar.module.css';
import { useCurrency } from '@/context/CurrencyContext';
import { SUPPORTED_CURRENCIES } from '@/lib/currencies';
import { useTheme } from '@/context/ThemeContext';
import {
    MdDashboard,
    MdFormatListBulleted,
    MdShowChart,
    MdSettings,
    MdMenu,
    MdClose,
    MdDarkMode,
    MdLightMode,
    MdLogout,
    MdPieChart,
    MdCompareArrows,
    MdExpandMore,
    MdCalculate,
    MdBarChart,
    MdAutoAwesome,
    MdBalance
} from 'react-icons/md';
import { signOut } from 'next-auth/react';

interface NavItem {
    name: string;
    href: string;
    icon: React.ReactNode;
    children?: NavItem[];
}

export default function Sidebar({ aiEnabled }: { aiEnabled?: boolean }) {
    const pathname = usePathname();
    const { currency, setCurrency } = useCurrency();
    const { theme, toggleTheme } = useTheme();
    const [isOpen, setIsOpen] = useState(false);
    const [mounted, setMounted] = useState(false);
    const [expandedMenus, setExpandedMenus] = useState<string[]>([]);

    const [isAIEnabled, setIsAIEnabled] = useState(aiEnabled ?? false);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setMounted(true);

        // If prop is provided, sync state (handled by initial state mostly, but good for updates)
        if (aiEnabled !== undefined) {
            setIsAIEnabled(aiEnabled);
            return;
        }

        // Fallback to fetch if not provided (e.g. standalone usage)
        fetch('/api/ai/config')
            .then(res => res.json())
            .then(data => setIsAIEnabled(data.isAIEnabled))
            .catch(() => setIsAIEnabled(false));
    }, [aiEnabled]);

    const { data: session } = useSession();
    const role = (session?.user as any)?.role || 'VIEWER';

    const navItems: NavItem[] = [
        { name: 'Dashboard', href: '/', icon: <MdDashboard size={20} /> },
        {
            name: 'Analysis',
            href: '/analysis', // acts as ID for partial match
            icon: <MdShowChart size={20} />,
            children: [
                { name: 'Allocation', href: '/analysis/allocation', icon: <MdPieChart size={20} /> },
                { name: 'Comparison', href: '/analysis/comparison', icon: <MdCompareArrows size={20} /> },
                { name: 'Evolution', href: '/analysis/evolution', icon: <MdBarChart size={20} /> },
                { name: 'FIRE', href: '/analysis/fire', icon: <MdCalculate size={20} /> }
            ]
        },
        { name: 'Activities', href: '/activities', icon: <MdFormatListBulleted size={20} /> },
        { name: 'Rebalancer', href: '/rebalancer', icon: <MdBalance size={20} /> },
    ];

    if (isAIEnabled) {
        navItems.push({ name: 'AI Analysis', href: '/ai-analysis', icon: <MdAutoAwesome size={20} /> });
    }

    if (role === 'ADMIN' || role === 'EDITOR') {
        navItems.push({ name: 'Settings', href: '/settings', icon: <MdSettings size={20} /> });
    }


    // Auto-expand menu if active child
    useEffect(() => {
        navItems.forEach(item => {
            if (item.children) {
                const isChildActive = item.children.some(child => pathname === child.href || pathname?.startsWith(child.href));
                if (isChildActive) {
                    setExpandedMenus(prev => prev.includes(item.name) ? prev : [...prev, item.name]);
                }
            }
        });
    }, [pathname]);

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

    const toggleMenu = (name: string) => {
        setExpandedMenus(prev =>
            prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
        );
    };

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
                <MdMenu size={24} />
            </button>

            {/* Overlay */}
            {isOpen && (
                <div
                    className={styles.overlay}
                    onClick={() => setIsOpen(false)}
                    aria-hidden="true"
                />
            )}

            <aside className={`${styles.sidebar} ${isOpen ? styles.open : ''}`}>
                <div className={styles.logo}>
                    <div style={{ display: 'flex', alignItems: 'center', overflow: 'hidden', width: '200px', height: '80px' }}>
                        <img
                            src="/logo.png"
                            alt="Ascend"
                            style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center', transform: 'scale(1.2)' }}
                        />
                    </div>
                    <button
                        className={styles.closeButton}
                        onClick={() => setIsOpen(false)}
                        aria-label="Close Menu"
                    >
                        <MdClose size={24} />
                    </button>
                </div>

                <nav className={styles.nav}>
                    {navItems.map((item) => {
                        const isActive = pathname === item.href;
                        // Removed auto-active logic for parent to reduce clutter
                        const isChildActive = item.children?.some(c => pathname === c.href || pathname?.startsWith(c.href));
                        const isExpanded = expandedMenus.includes(item.name);

                        if (item.children) {
                            return (
                                <div key={item.name}>
                                    <div
                                        className={`${styles.link} ${isExpanded ? styles.expanded : ''}`} // Separate class for expanded state if needed, or just plain
                                        onClick={() => toggleMenu(item.name)}
                                        style={{
                                            cursor: 'pointer',
                                            justifyContent: 'space-between',
                                            color: isChildActive ? 'var(--primary-color)' : undefined // Subtle highlight if child active
                                        }}
                                    >
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                            <span className={styles.iconWrapper}>{item.icon}</span>
                                            {item.name}
                                        </div>
                                        <motion.div
                                            animate={{ rotate: isExpanded ? 180 : 0 }}
                                            transition={{ duration: 0.2 }}
                                        >
                                            <MdExpandMore size={20} />
                                        </motion.div>
                                    </div>

                                    <AnimatePresence initial={false}>
                                        {isExpanded && (
                                            <motion.div
                                                initial="collapsed"
                                                animate="open"
                                                exit="collapsed"
                                                variants={{
                                                    open: { opacity: 1, height: "auto" },
                                                    collapsed: { opacity: 0, height: 0 }
                                                }}
                                                transition={{ duration: 0.3, ease: 'easeInOut' }}
                                                style={{ overflow: 'hidden' }}
                                            >
                                                <div style={{ paddingLeft: '1rem', display: 'flex', flexDirection: 'column', gap: '0.25rem', paddingBottom: '0.5rem' }}>
                                                    {item.children.map(child => (
                                                        <Link
                                                            key={child.href}
                                                            href={child.href}
                                                            className={`${styles.link} ${pathname === child.href ? styles.active : ''}`}
                                                            onClick={() => setIsOpen(false)}
                                                            style={{ fontSize: '0.9rem' }}
                                                        >
                                                            <span className={styles.iconWrapper}>{child.icon}</span>
                                                            {child.name}
                                                        </Link>
                                                    ))}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            );
                        }

                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`${styles.link} ${isActive ? styles.active : ''}`}
                                onClick={() => setIsOpen(false)} // Close on navigation
                            >
                                <span className={styles.iconWrapper}>{item.icon}</span>
                                {item.name}
                            </Link>
                        );
                    })}
                </nav>

                <div className={styles.footer}>
                    <div className={styles.controls}>
                        <select
                            className={styles.currencySelect}
                            value={currency}
                            onChange={(e) => setCurrency(e.target.value as any)}
                        >
                            {SUPPORTED_CURRENCIES.map(c => (
                                <option key={c.code} value={c.code}>
                                    {c.code} ({c.symbol})
                                </option>
                            ))}
                        </select>



                        <button
                            className={styles.themeToggle}
                            onClick={toggleTheme}
                            aria-label="Toggle Dark Mode"
                        >
                            {mounted && (theme === 'light' ? <MdDarkMode size={20} /> : <MdLightMode size={20} />)}
                            {!mounted && <div style={{ width: 20, height: 20 }} />} {/* Placeholder to prevent layout shift */}
                        </button>

                        <button
                            className={styles.logoutButton}
                            onClick={async () => {
                                await signOut({ redirect: false });
                                window.location.href = '/login';
                            }}
                            aria-label="Logout"
                            style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--text-secondary)',
                                cursor: 'pointer',
                                padding: '0.5rem',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'color 0.2s'
                            }}
                        >
                            <MdLogout size={20} />
                        </button>
                    </div>
                </div>
            </aside>
        </>
    );
}
