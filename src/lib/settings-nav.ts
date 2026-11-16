export type SettingsSectionId = 'general' | 'currency' | 'accounts' | 'users' | 'data';

export interface SettingsSectionMeta {
    id: SettingsSectionId;
    name: string;
    description: string;
    href: string;
    minRole?: 'EDITOR' | 'ADMIN';
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
    {
        id: 'general',
        name: 'General',
        description: 'Theme, date formatting, default currency, and benchmarks',
        href: '/settings',
    },
    {
        id: 'currency',
        name: 'Currency & FX',
        description: 'Base reporting currency and cached spot rate matrix',
        href: '/settings/currency',
    },
    {
        id: 'accounts',
        name: 'Accounts',
        description: 'Brokerage platforms and investment accounts',
        href: '/settings/accounts',
        minRole: 'EDITOR',
    },
    {
        id: 'users',
        name: 'Users',
        description: 'Household members, roles, and access permissions',
        href: '/settings/users',
    },
    {
        id: 'data',
        name: 'Master Data',
        description: 'Investment types, activity types, and market sync',
        href: '/settings/data',
        minRole: 'ADMIN',
    },
] as const;

export function isSettingsPath(pathname: string | null | undefined): boolean {
    if (!pathname) return false;
    return pathname === '/settings' || pathname.startsWith('/settings/');
}

export function getVisibleSettingsSections(role?: string | null): SettingsSectionMeta[] {
    const normalized = (role || 'VIEWER').toUpperCase();
    return SETTINGS_SECTIONS.filter((item) => {
        if (!item.minRole) return true;
        if (item.minRole === 'EDITOR') {
            return normalized === 'ADMIN' || normalized === 'EDITOR';
        }
        if (item.minRole === 'ADMIN') {
            return normalized === 'ADMIN';
        }
        return true;
    });
}

export function getActiveSettingsSection(pathname: string | null | undefined): SettingsSectionMeta {
    if (!pathname) return SETTINGS_SECTIONS[0];
    const exact = SETTINGS_SECTIONS.find((s) => s.href === pathname);
    if (exact) return exact;
    const prefix = SETTINGS_SECTIONS.find(
        (s) => s.href !== '/settings' && pathname.startsWith(`${s.href}/`)
    );
    return prefix || SETTINGS_SECTIONS[0];
}
