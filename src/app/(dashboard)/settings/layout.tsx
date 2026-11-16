'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
    MdAccountBalance,
    MdCheck,
    MdCurrencyExchange,
    MdExpandMore,
    MdGroup,
    MdStorage,
    MdTune,
} from 'react-icons/md';
import {
    getActiveSettingsSection,
    getVisibleSettingsSections,
    type SettingsSectionId,
} from '@/lib/settings-nav';
import styles from './layout.module.css';

interface SessionUser {
    name?: string | null;
    username?: string;
    role?: string;
}

const SECTION_ICONS: Record<SettingsSectionId, React.ReactNode> = {
    general: <MdTune size={17} aria-hidden="true" />,
    currency: <MdCurrencyExchange size={17} aria-hidden="true" />,
    accounts: <MdAccountBalance size={17} aria-hidden="true" />,
    users: <MdGroup size={17} aria-hidden="true" />,
    data: <MdStorage size={17} aria-hidden="true" />,
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const { data: session } = useSession();
    const [sheetOpen, setSheetOpen] = useState(false);

    const user = session?.user as SessionUser | undefined;
    const role = user?.role || 'VIEWER';
    const displayName = user?.name || user?.username;

    const visibleSections = getVisibleSettingsSections(role);
    const activeSection = getActiveSettingsSection(pathname);

    useEffect(() => {
        if (!sheetOpen) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setSheetOpen(false);
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [sheetOpen]);

    return (
        <div className={styles.container}>
            <header className={styles.header}>
                <div className={styles.headerLeft}>
                    <span className={styles.eyebrow}>Settings</span>
                    <h1 className={styles.title}>{activeSection.name}</h1>
                    <p className={styles.subtitle}>{activeSection.description}</p>
                </div>

                <div className={styles.headerRight}>
                    {session?.user && (
                        <div className={styles.userBadge}>
                            {displayName && <span>{displayName}</span>}
                            <span className={styles.rolePill}>{role}</span>
                        </div>
                    )}

                    <button
                        type="button"
                        className={styles.mobileSectionsBtn}
                        onClick={() => setSheetOpen(true)}
                        aria-haspopup="dialog"
                        aria-expanded={sheetOpen}
                    >
                        <span>Sections</span>
                        <MdExpandMore size={18} aria-hidden="true" />
                    </button>
                </div>
            </header>

            <div className={styles.content}>{children}</div>

            {sheetOpen && (
                <div
                    className={styles.sheetBackdrop}
                    onClick={() => setSheetOpen(false)}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Settings sections"
                >
                    <div
                        className={styles.sheetPanel}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className={styles.sheetHeader}>
                            <span className={styles.sheetTitle}>Settings Sections</span>
                            <button
                                type="button"
                                className={styles.sheetCloseBtn}
                                onClick={() => setSheetOpen(false)}
                            >
                                Done
                            </button>
                        </div>

                        <nav className={styles.sheetList} aria-label="Settings section picker">
                            {visibleSections.map((section) => {
                                const isActive = section.id === activeSection.id;
                                return (
                                    <Link
                                        key={section.href}
                                        href={section.href}
                                        className={`${styles.sheetItem} ${isActive ? styles.sheetItemActive : ''}`}
                                        aria-current={isActive ? 'page' : undefined}
                                        onClick={() => setSheetOpen(false)}
                                    >
                                        <div className={styles.sheetItemLeft}>
                                            <span className={styles.sheetItemIcon}>
                                                {SECTION_ICONS[section.id]}
                                            </span>
                                            <span className={styles.sheetItemText}>
                                                <span className={styles.sheetItemName}>{section.name}</span>
                                                <span className={styles.sheetItemDesc}>{section.description}</span>
                                            </span>
                                        </div>
                                        {isActive && <MdCheck size={18} className={styles.sheetCheck} aria-hidden="true" />}
                                    </Link>
                                );
                            })}
                        </nav>
                    </div>
                </div>
            )}
        </div>
    );
}
