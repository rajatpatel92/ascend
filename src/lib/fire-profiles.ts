import { SUPPORTED_CURRENCIES } from './currencies.ts';

export type FireCalculationMode = 'FIXED_RATE' | 'FIXED_HORIZON';

export interface FireSimulationParams {
    fireDate: string; // YYYY-MM
    monthlyContribution: number;
    expectedReturn: number; // Annual %
    inflationRate: number; // Annual %
    currentMonthlyExpense: number;
    calculationMode: FireCalculationMode;
    withdrawalRate: number; // Annual %
    withdrawalDuration: number; // Years
}

export interface FireProfile {
    id: string;
    name: string;
    currency: string;
    params: FireSimulationParams;
    updatedAt: string;
}

export interface FireProfileStore {
    activeProfileId: string;
    profiles: FireProfile[];
}

const SUPPORTED_CURRENCY_SET = new Set(SUPPORTED_CURRENCIES.map((c) => c.code));

function finiteOr(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function normalizeFireCurrency(code: unknown, fallback = 'CAD'): string {
    if (typeof code === 'string') {
        const upper = code.trim().toUpperCase();
        if (SUPPORTED_CURRENCY_SET.has(upper)) {
            return upper;
        }
    }
    const upperFallback = fallback.trim().toUpperCase();
    return SUPPORTED_CURRENCY_SET.has(upperFallback) ? upperFallback : 'CAD';
}

export function getDefaultFireDate(referenceDate: Date = new Date()): string {
    const y = referenceDate.getFullYear() + 10;
    const m = String(referenceDate.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

export function sanitizeFireDate(value: unknown, referenceDate: Date = new Date()): string {
    if (typeof value !== 'string') {
        return getDefaultFireDate(referenceDate);
    }
    const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
    if (!match) {
        return getDefaultFireDate(referenceDate);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const maxYear = referenceDate.getFullYear() + 80;
    if (!Number.isInteger(year) || !Number.isInteger(month) || year < 1900 || year > maxYear || month < 1 || month > 12) {
        return getDefaultFireDate(referenceDate);
    }
    return `${year}-${String(month).padStart(2, '0')}`;
}

export function sanitizeFireParams(
    raw: Partial<FireSimulationParams> | null | undefined,
    referenceDate: Date = new Date()
): FireSimulationParams {
    return {
        fireDate: sanitizeFireDate(raw?.fireDate, referenceDate),
        monthlyContribution: Math.max(0, Math.round(finiteOr(raw?.monthlyContribution, 2000) * 100) / 100),
        expectedReturn: clamp(Math.round(finiteOr(raw?.expectedReturn, 7.0) * 100) / 100, -99, 50),
        inflationRate: clamp(Math.round(finiteOr(raw?.inflationRate, 2.5) * 100) / 100, -99, 30),
        currentMonthlyExpense: Math.max(0, Math.round(finiteOr(raw?.currentMonthlyExpense, 2000) * 100) / 100),
        calculationMode: raw?.calculationMode === 'FIXED_HORIZON' ? 'FIXED_HORIZON' : 'FIXED_RATE',
        withdrawalRate: clamp(Math.round(finiteOr(raw?.withdrawalRate, 4.0) * 100) / 100, 0.1, 25),
        withdrawalDuration: Math.round(clamp(finiteOr(raw?.withdrawalDuration, 30), 1, 80))
    };
}

export function createDefaultFireProfile(
    currency = 'CAD',
    referenceDate: Date = new Date()
): FireProfile {
    return {
        id: 'default',
        name: 'Default FIRE Plan',
        currency: normalizeFireCurrency(currency),
        params: sanitizeFireParams(undefined, referenceDate),
        updatedAt: referenceDate.toISOString()
    };
}

export function sanitizeFireProfile(
    raw: Partial<FireProfile> | null | undefined,
    fallbackCurrency = 'CAD',
    referenceDate: Date = new Date()
): FireProfile {
    const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : `fire-${referenceDate.getTime()}`;
    const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : 'Untitled FIRE Plan';
    const currency = normalizeFireCurrency(raw?.currency, fallbackCurrency);
    const params = sanitizeFireParams(raw?.params, referenceDate);
    const updatedAt =
        typeof raw?.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
            ? raw.updatedAt
            : referenceDate.toISOString();

    return {
        id,
        name,
        currency,
        params,
        updatedAt
    };
}

export function buildFireProfileSlugId(name: string, now: number = Date.now()): string {
    const slug =
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'custom';
    return `${slug}-${now.toString(36)}`;
}

/**
 * Checks whether the in-editor simulation parameters diverge from the currently selected saved profile
 * (converting profile monetary values into activeCurrency for apples-to-apples comparison).
 */
export function hasFireProfileChanges(
    profile: FireProfile | undefined,
    currentParams: FireSimulationParams,
    activeCurrency: string,
    convertAmount: (amount: number, fromCurrency: string) => number
): boolean {
    if (!profile) return false;

    const saved = profile.params;
    if (saved.fireDate !== currentParams.fireDate) return true;
    if (saved.calculationMode !== currentParams.calculationMode) return true;
    if (Math.abs(saved.expectedReturn - currentParams.expectedReturn) > 0.005) return true;
    if (Math.abs(saved.inflationRate - currentParams.inflationRate) > 0.005) return true;

    if (currentParams.calculationMode === 'FIXED_RATE') {
        if (Math.abs(saved.withdrawalRate - currentParams.withdrawalRate) > 0.005) return true;
    } else if (Math.abs(saved.withdrawalDuration - currentParams.withdrawalDuration) > 0) {
        return true;
    }

    const sameCurrency = normalizeFireCurrency(profile.currency) === normalizeFireCurrency(activeCurrency);
    const expectedContribution = sameCurrency
        ? saved.monthlyContribution
        : Math.round(convertAmount(saved.monthlyContribution, profile.currency));
    const expectedExpense = sameCurrency
        ? saved.currentMonthlyExpense
        : Math.round(convertAmount(saved.currentMonthlyExpense, profile.currency));

    // Allow $1 rounding tolerance when FX conversion is involved
    const moneyTolerance = sameCurrency ? 0.01 : 1;
    if (Math.abs(expectedContribution - currentParams.monthlyContribution) > moneyTolerance) return true;
    if (Math.abs(expectedExpense - currentParams.currentMonthlyExpense) > moneyTolerance) return true;

    return false;
}
