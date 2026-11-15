'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
    MdAccountBalance,
    MdCurrencyExchange,
    MdGroup,
    MdStorage,
    MdTune
} from 'react-icons/md';
import styles from './layout.module.css';

interface NavItem {
    name: string;
    description: string;
    href: string;
    icon: React.ReactNode;
    minRole?: 'EDITOR' | 'ADMIN';
}

const navItems: NavItem[] = [
    {
        name: 'General',
        description: 'Theme, dates, AI & benchmarks',
        href: '/settings',
        icon: <MdTune size={18} aria-hidden="true" />
    },
    {
        name: 'Currency & FX',
        description: 'Base currency & live rate matrix',
        href: '/settings/currency',
        icon: <MdCurrencyExchange size={18} aria-hidden="true" />
    },
    {
        name: 'Accounts',
        description: 'Platforms & investment accounts',
        href: '/settings/accounts',
        icon: <MdAccountBalance size={18} aria-hidden="true" />,
        minRole: 'EDITOR'
    },
    {
        name: 'Users',
        description: 'Members, roles & AI permissions',
        href: '/settings/users',
        icon: <MdGroup size={18} aria-hidden="true" />
    },
    {
        name: 'Master Data',
        description: 'Types, mappings & market sync',
        href: '/settings/data',
        icon: <MdStorage size={18} aria-hidden="true" />,
        minRole: 'ADMIN'
    }
];

interface SessionUser {
    name?: string | null;
    username?: string;
    role?: string;
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const { data: session } = useSession();
    const user = session?.user as SessionUser | undefined;
    const role = user?.role || 'VIEWER';
    const displayName = user?.name || user?.username;

    const visibleNavItems = navItems.filter((item) => {
        if (!item.minRole) return true;
        if (item.minRole === 'EDITOR') return role === 'ADMIN' || role === 'EDITOR';
        if (item.minRole === 'ADMIN') return role === 'ADMIN';
        return true;
    });

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <h1 className={styles.title}>Settings</h1>
                    <p className={styles.subtitle}>
                        Configure workspace preferences, reporting currency, investment accounts, users, and system data.
                    </p>
                </div>

                {session?.user && (
                    <div className={styles.headerMeta}>
                        <div className={styles.userBadge}>
                            {displayName && <span>{displayName}</span>}
                            <span className={styles.rolePill}>{role}</span>
                        </div>
                    </div>
                )}
            </header>

            <div className={styles.settingsGrid}>
                <nav className={styles.sidebar} aria-label="Settings sections">
                    {visibleNavItems.map((item) => {
                        const isActive = pathname === item.href;
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                aria-current={isActive ? 'page' : undefined}
                                className={`${styles.link} ${isActive ? styles.active : ''}`}
                            >
                                <span className={styles.linkIcon}>{item.icon}</span>
                                <span className={styles.linkText}>
                                    <span className={styles.linkLabel}>{item.name}</span>
                                    <span className={styles.linkDesc}>{item.description}</span>
                                </span>
                            </Link>
                        );
                    })}
                </nav>
                <div className={styles.content}>{children}</div>
            </div>
        </div>
    );
}
