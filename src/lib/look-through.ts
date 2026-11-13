/**
 * Look-Through Allocation Engine
 * Decomposes ETF/Fund sector and geographic weightings alongside direct stock holdings
 * to provide a unified "Portfolio X-Ray" view.
 */

export interface LookThroughConstituent {
    symbol: string;
    name?: string;
    type?: string;
    value: number; // Value in target/base currency
    currency?: string;
    sector?: string | null;
    country?: string | null;
    sectorAllocations?: Array<{ [key: string]: number }> | null;
    countryAllocations?: Array<{ [key: string]: number }> | null;
}

export interface SectorContributor {
    symbol: string;
    name: string;
    allocatedValue: number;
    holdingValue: number;
    weightInHolding: number;
    weightInSector: number;
    isLookThrough: boolean;
}

export interface SectorBreakdown {
    name: string;
    value: number;
    percentage: number;
    contributors: SectorContributor[];
}

export interface CountryContributor {
    symbol: string;
    name: string;
    allocatedValue: number;
    holdingValue: number;
    weightInHolding: number;
    weightInSector: number;
    isLookThrough: boolean;
}

export interface CountryBreakdown {
    name: string;
    value: number;
    percentage: number;
    contributors: CountryContributor[];
}

export interface LookThroughResult {
    bySector: { name: string; value: number }[];
    byCountry: { name: string; value: number }[];
    sectorDetails: SectorBreakdown[];
    countryDetails: CountryBreakdown[];
    totalValue: number;
}

const SECTOR_NAME_MAP: Record<string, string> = {
    technology: 'Technology',
    information_technology: 'Technology',
    tech: 'Technology',
    financial_services: 'Financial Services',
    financials: 'Financial Services',
    financial: 'Financial Services',
    healthcare: 'Healthcare',
    health_care: 'Healthcare',
    consumer_cyclical: 'Consumer Cyclical',
    consumer_discretionary: 'Consumer Cyclical',
    communication_services: 'Communication Services',
    communication: 'Communication Services',
    telecommunications: 'Communication Services',
    industrials: 'Industrials',
    industrial: 'Industrials',
    consumer_defensive: 'Consumer Defensive',
    consumer_staples: 'Consumer Defensive',
    energy: 'Energy',
    basic_materials: 'Basic Materials',
    materials: 'Basic Materials',
    realestate: 'Real Estate',
    real_estate: 'Real Estate',
    utilities: 'Utilities',
    utility: 'Utilities',
};

const COUNTRY_NAME_MAP: Record<string, string> = {
    us: 'United States',
    usa: 'United States',
    united_states: 'United States',
    united_states_of_america: 'United States',
    ca: 'Canada',
    can: 'Canada',
    canada: 'Canada',
    uk: 'United Kingdom',
    gb: 'United Kingdom',
    united_kingdom: 'United Kingdom',
    great_britain: 'United Kingdom',
    in: 'India',
    ind: 'India',
    india: 'India',
    jp: 'Japan',
    japan: 'Japan',
    de: 'Germany',
    germany: 'Germany',
    ch: 'Switzerland',
    switzerland: 'Switzerland',
    fr: 'France',
    france: 'France',
    cn: 'China',
    china: 'China',
    au: 'Australia',
    australia: 'Australia',
    nl: 'Netherlands',
    netherlands: 'Netherlands',
    kr: 'South Korea',
    south_korea: 'South Korea',
    tw: 'Taiwan',
    taiwan: 'Taiwan',
    br: 'Brazil',
    brazil: 'Brazil',
};

/**
 * Normalizes Yahoo Finance snake_case or raw sector names into standard GICS title-case.
 */
export function normalizeSectorName(rawSector?: string | null): string {
    if (!rawSector || !rawSector.trim()) return 'Other / Unclassified';
    const cleaned = rawSector.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (SECTOR_NAME_MAP[cleaned]) {
        return SECTOR_NAME_MAP[cleaned];
    }
    // Title case fallback
    return rawSector
        .replace(/_/g, ' ')
        .split(' ')
        .map(w => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''))
        .filter(Boolean)
        .join(' ');
}

/**
 * Normalizes country strings or codes into standard country names.
 */
export function normalizeCountryName(rawCountry?: string | null): string {
    if (!rawCountry || !rawCountry.trim()) return 'Unspecified';
    const cleaned = rawCountry.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (COUNTRY_NAME_MAP[cleaned]) {
        return COUNTRY_NAME_MAP[cleaned];
    }
    return rawCountry.trim();
}

const CURRENCY_COUNTRY_MAP: Record<string, string> = {
    USD: 'United States',
    CAD: 'Canada',
    INR: 'India',
    EUR: 'Europe',
    GBP: 'United Kingdom'
};

interface DimensionContribution {
    category: string;
    allocatedValue: number;
    weightInHolding: number;
    isLookThrough: boolean;
}

interface InternalContributor {
    symbol: string;
    name: string;
    allocatedValue: number;
    holdingValue: number;
    weightInHolding: number;
    isLookThrough: boolean;
}

type DimensionMap = Map<string, {
    value: number;
    contributors: Map<string, InternalContributor>;
}>;

function decomposeDimension(
    value: number,
    allocations: Array<{ [key: string]: number }> | null | undefined,
    directLabel: string | null | undefined,
    normalize: (raw?: string | null) => string,
    residualLabel: string,
    getFallbackLabel: () => string
): DimensionContribution[] {
    if (typeof value !== 'number' || value < 0.01) return [];
    const results: DimensionContribution[] = [];

    if (allocations && Array.isArray(allocations) && allocations.length > 0) {
        let allocatedWeightSum = 0;
        for (const obj of allocations) {
            if (!obj || typeof obj !== 'object') continue;
            for (const [key, fraction] of Object.entries(obj)) {
                const numFraction = typeof fraction === 'number' ? fraction : Number(fraction);
                if (!isNaN(numFraction) && numFraction > 0) {
                    const allocatedVal = Math.round(value * numFraction * 100) / 100;
                    allocatedWeightSum += numFraction;
                    if (allocatedVal >= 0.01) {
                        results.push({
                            category: normalize(key),
                            allocatedValue: allocatedVal,
                            weightInHolding: numFraction,
                            isLookThrough: true
                        });
                    }
                }
            }
        }

        if (allocatedWeightSum < 0.99 && allocatedWeightSum >= 0) {
            const remainingFraction = Math.max(0, 1.0 - allocatedWeightSum);
            const remainingValue = Math.round(value * remainingFraction * 100) / 100;
            if (remainingValue >= 0.01) {
                results.push({
                    category: residualLabel,
                    allocatedValue: remainingValue,
                    weightInHolding: remainingFraction,
                    isLookThrough: true
                });
            }
        }
        return results;
    }

    if (directLabel && directLabel.trim()) {
        results.push({
            category: normalize(directLabel),
            allocatedValue: value,
            weightInHolding: 1.0,
            isLookThrough: false
        });
        return results;
    }

    results.push({
        category: getFallbackLabel(),
        allocatedValue: value,
        weightInHolding: 1.0,
        isLookThrough: false
    });
    return results;
}

function getConstituentSectorContributions(c: LookThroughConstituent): DimensionContribution[] {
    if (!c) return [];
    return decomposeDimension(
        c.value,
        c.sectorAllocations,
        c.sector,
        normalizeSectorName,
        'Cash & Reserves',
        () => {
            const upperType = c.type?.toUpperCase() || '';
            if (upperType === 'CRYPTO') return 'Crypto / Digital Assets';
            if (upperType === 'CASH') return 'Cash & Equivalents';
            return 'Other / Unclassified';
        }
    );
}

function getConstituentCountryContributions(c: LookThroughConstituent): DimensionContribution[] {
    if (!c) return [];
    return decomposeDimension(
        c.value,
        c.countryAllocations,
        c.country,
        normalizeCountryName,
        'Global / Other',
        () => {
            const upperType = c.type?.toUpperCase() || '';
            if (upperType === 'CRYPTO') return 'Global / Decentralized';
            if (c.currency && CURRENCY_COUNTRY_MAP[c.currency]) {
                return CURRENCY_COUNTRY_MAP[c.currency];
            }
            return 'Unspecified';
        }
    );
}

function recordContribution(targetMap: DimensionMap, c: LookThroughConstituent, contrib: DimensionContribution) {
    if (contrib.allocatedValue < 0.01) return;
    let entry = targetMap.get(contrib.category);
    if (!entry) {
        entry = { value: 0, contributors: new Map() };
        targetMap.set(contrib.category, entry);
    }
    entry.value += contrib.allocatedValue;

    const existing = entry.contributors.get(c.symbol);
    if (existing) {
        existing.allocatedValue += contrib.allocatedValue;
        existing.weightInHolding += contrib.weightInHolding;
    } else {
        entry.contributors.set(c.symbol, {
            symbol: c.symbol,
            name: c.name || c.symbol,
            allocatedValue: contrib.allocatedValue,
            holdingValue: c.value,
            weightInHolding: contrib.weightInHolding,
            isLookThrough: contrib.isLookThrough
        });
    }
}

function buildBreakdownDetails(targetMap: DimensionMap, totalValue: number): SectorBreakdown[] {
    return Array.from(targetMap.entries())
        .map(([name, data]) => {
            const contributors = Array.from(data.contributors.values())
                .map(contrib => ({
                    ...contrib,
                    weightInSector: data.value > 0 ? (contrib.allocatedValue / data.value) * 100 : 0
                }))
                .sort((a, b) => b.allocatedValue - a.allocatedValue);

            return {
                name,
                value: data.value,
                percentage: totalValue > 0 ? (data.value / totalValue) * 100 : 0,
                contributors
            };
        })
        .sort((a, b) => b.value - a.value);
}

/**
 * Calculates look-through sector and country allocations across a collection of portfolio constituents.
 */
export function calculateLookThrough(constituents: LookThroughConstituent[]): LookThroughResult {
    const activeConstituents = constituents.filter(c => c && typeof c.value === 'number' && c.value >= 0.01);
    const totalValue = activeConstituents.reduce((sum, c) => sum + c.value, 0);

    const sectorMap: DimensionMap = new Map();
    const countryMap: DimensionMap = new Map();

    for (const c of activeConstituents) {
        for (const contrib of getConstituentSectorContributions(c)) {
            recordContribution(sectorMap, c, contrib);
        }
        for (const contrib of getConstituentCountryContributions(c)) {
            recordContribution(countryMap, c, contrib);
        }
    }

    const sectorDetails: SectorBreakdown[] = buildBreakdownDetails(sectorMap, totalValue);
    const countryDetails: CountryBreakdown[] = buildBreakdownDetails(countryMap, totalValue);

    const bySector = sectorDetails.map(s => ({ name: s.name, value: s.value }));
    const byCountry = countryDetails.map(c => ({ name: c.name, value: c.value }));

    return {
        bySector,
        byCountry,
        sectorDetails,
        countryDetails,
        totalValue
    };
}

/**
 * Checks whether a constituent has direct or look-through exposure to a given sector.
 */
export function constituentHasSectorExposure(constituent: LookThroughConstituent, targetSector: string): boolean {
    if (!targetSector) return true;
    return getConstituentSectorContributions(constituent).some(item => item.category === targetSector);
}

/**
 * Checks whether a constituent has direct or look-through exposure to a given country.
 */
export function constituentHasCountryExposure(constituent: LookThroughConstituent, targetCountry: string): boolean {
    if (!targetCountry) return true;
    return getConstituentCountryContributions(constituent).some(item => item.category === targetCountry);
}
