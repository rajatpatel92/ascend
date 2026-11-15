export const ACTIVE_QUANTITY_EPSILON = 0.00001;

const DRIP_ALIASES = new Set([
    'DRIP',
    'REINVEST',
    'REINVESTMENT',
    'REINVESTED',
    'DIVIDEND REINVEST',
    'DIVIDEND REINVESTMENT',
    'DIVIDEND REINV',
    'DIV REINVEST',
    'DIV REINVESTMENT',
    'DIV REINV',
    'REINVEST DIVIDEND',
    'REINVESTED DIVIDEND',
    'DIVIDEND REINVESTING'
]);

const STANDARD_TYPE_ALIASES: Record<string, string> = {
    'DIV': 'DIVIDEND',
    'DIVIDENDS': 'DIVIDEND',
    'CASH DIVIDEND': 'DIVIDEND',
    'STOCK SPLIT': 'STOCK_SPLIT',
    'TRANSFER IN': 'TRANSFER_IN',
    'TRANSFER OUT': 'TRANSFER_OUT'
};

/**
 * Normalizes raw activity type labels (e.g. from brokerage CSV imports)
 * into Ascend's canonical activity type names.
 */
export function normalizeActivityType(rawType: unknown): string {
    const trimmed = String(rawType ?? '').trim();
    if (!trimmed) return '';

    const upper = trimmed.toUpperCase();
    // Collapse underscores, hyphens, and repeated whitespace so variants like
    // "Dividend_Reinvest" or "DIVIDEND-REINVESTMENT" normalize uniformly.
    const spaced = upper.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

    if (DRIP_ALIASES.has(spaced)) {
        return 'DRIP';
    }

    if (STANDARD_TYPE_ALIASES[spaced]) {
        return STANDARD_TYPE_ALIASES[spaced];
    }

    return upper;
}

/**
 * Returns true when a raw type string is a non-canonical alias that maps to DRIP.
 */
export function isDripAlias(rawType: unknown): boolean {
    const rawUpper = String(rawType ?? '').trim().toUpperCase();
    return rawUpper !== 'DRIP' && normalizeActivityType(rawType) === 'DRIP';
}

/**
 * Builds a complete activity-type-to-behavior map with standard defaults.
 */
export function buildBehaviorMap(activityTypes: Array<{ name: string; behavior: string }> = []): Map<string, string> {
    const behaviorMap = new Map<string, string>();
    for (const t of activityTypes) {
        behaviorMap.set(t.name, t.behavior);
    }

    if (!behaviorMap.has('BUY')) behaviorMap.set('BUY', 'ADD');
    if (!behaviorMap.has('DRIP')) behaviorMap.set('DRIP', 'ADD');
    if (!behaviorMap.has('SELL')) behaviorMap.set('SELL', 'REMOVE');
    if (!behaviorMap.has('DIVIDEND')) behaviorMap.set('DIVIDEND', 'NEUTRAL');
    if (!behaviorMap.has('STOCK_SPLIT')) behaviorMap.set('STOCK_SPLIT', 'SPLIT');
    if (!behaviorMap.has('SPLIT')) behaviorMap.set('SPLIT', 'SPLIT');
    if (!behaviorMap.has('TRANSFER_IN')) behaviorMap.set('TRANSFER_IN', 'ADD');
    if (!behaviorMap.has('TRANSFER_OUT')) behaviorMap.set('TRANSFER_OUT', 'REMOVE');

    return behaviorMap;
}
