import { normalizeCountryName } from './look-through.ts';

export interface CountryAllocationItem {
    name: string;
    canonicalName: string;
    value: number;
    percent: number;
}

const MAP_EXTRA_ALIASES: Record<string, string> = {
    united_states_of_america: 'United States',
    czechia: 'Czech Republic',
    czech_republic: 'Czech Republic',
    turkiye: 'Turkey',
    turkey: 'Turkey',
    russian_federation: 'Russia',
    korea_south: 'South Korea',
    'korea_(south)': 'South Korea',
    republic_of_korea: 'South Korea',
    south_korea: 'South Korea',
    taiwan_province_of_china: 'Taiwan',
    'taiwan,_province_of_china': 'Taiwan',
    hong_kong_sar: 'Hong Kong',
    hong_kong_sar_china: 'Hong Kong',
    bahamas: 'The Bahamas',
    the_bahamas: 'The Bahamas',
    "côte_d'ivoire": 'Ivory Coast',
    "cote_d'ivoire": 'Ivory Coast',
    ivory_coast: 'Ivory Coast',
    republic_of_serbia: 'Serbia',
    united_republic_of_tanzania: 'Tanzania',
    north_macedonia: 'North Macedonia',
    viet_nam: 'Vietnam',
    brunei_darussalam: 'Brunei',
};

/**
 * Canonicalizes country names from portfolio holdings / issuer CSVs / Natural Earth
 * so map geometry keys match portfolio data entries reliably.
 */
export function canonicalizeMapCountryName(rawName?: string | null): string {
    if (!rawName || !rawName.trim()) return 'Unspecified';
    const normalized = normalizeCountryName(rawName);
    const key = normalized.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return MAP_EXTRA_ALIASES[key] ?? normalized;
}

function interpolateHex(hexA: string, hexB: string, t: number): string {
    const clamped = Math.min(1, Math.max(0, t));
    const a = Number.parseInt(hexA.slice(1), 16);
    const b = Number.parseInt(hexB.slice(1), 16);
    const r1 = (a >> 16) & 255;
    const g1 = (a >> 8) & 255;
    const b1 = a & 255;
    const r2 = (b >> 16) & 255;
    const g2 = (b >> 8) & 255;
    const b2 = b & 255;
    const r = Math.round(r1 + (r2 - r1) * clamped);
    const g = Math.round(g1 + (g2 - g1) * clamped);
    const bl = Math.round(b1 + (b2 - b1) * clamped);
    return `rgb(${r}, ${g}, ${bl})`;
}

/**
 * Computes a perceptual sqrt choropleth color from invested amount.
 * Uses Dark -> Bright luminous blue ramp in dark mode so 0% is dark slate
 * and higher exposures glow brighter.
 */
export function computeChoroplethShade(value: number, maxValue: number, isDark = true): string {
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(maxValue) || maxValue <= 0) {
        return isDark ? '#161f2e' : '#e2e8f0';
    }

    // # Reason: Sqrt scaling preserves visual contrast across skewed portfolios (e.g. 43% vs 2%).
    const t = Math.min(1, Math.max(0.08, Math.sqrt(value / maxValue)));

    if (isDark) {
        if (t <= 0.45) {
            return interpolateHex('#1d3557', '#2563eb', t / 0.45);
        }
        return interpolateHex('#2563eb', '#38bdf8', (t - 0.45) / 0.55);
    }

    if (t <= 0.5) {
        return interpolateHex('#93c5fd', '#2563eb', t / 0.5);
    }
    return interpolateHex('#2563eb', '#1e3a8a', (t - 0.5) / 0.5);
}

/**
 * Normalizes, converts, sorts, and indexes country allocation entries for map + list rendering.
 */
export function prepareCountryMapData(
    entries: Array<{ name: string; value: number }>,
    options: { isPreConverted?: boolean; convert?: (amount: number, fromCurrency: string) => number } = {}
): {
    items: CountryAllocationItem[];
    byCanonicalName: Map<string, CountryAllocationItem>;
    totalValue: number;
    maxValue: number;
} {
    const { isPreConverted = true, convert } = options;

    const rawItems = entries
        .map((entry) => {
            const converted =
                isPreConverted || !convert ? entry.value : convert(entry.value, 'USD');
            return {
                name: entry.name,
                canonicalName: canonicalizeMapCountryName(entry.name),
                value: converted,
            };
        })
        .filter((entry) => Number.isFinite(entry.value) && entry.value >= 0.01)
        .sort((a, b) => b.value - a.value);

    const totalValue = rawItems.reduce((sum, entry) => sum + entry.value, 0);
    const maxValue = rawItems.length > 0 ? rawItems[0].value : 0;

    const items: CountryAllocationItem[] = rawItems.map((entry) => ({
        ...entry,
        percent: totalValue > 0 ? (entry.value / totalValue) * 100 : 0,
    }));

    const byCanonicalName = new Map<string, CountryAllocationItem>();
    for (const item of items) {
        const existing = byCanonicalName.get(item.canonicalName);
        if (!existing) {
            byCanonicalName.set(item.canonicalName, item);
        } else {
            const combinedVal = existing.value + item.value;
            byCanonicalName.set(item.canonicalName, {
                name: existing.name,
                canonicalName: item.canonicalName,
                value: combinedVal,
                percent: totalValue > 0 ? (combinedVal / totalValue) * 100 : 0,
            });
        }
    }

    return { items, byCanonicalName, totalValue, maxValue };
}
