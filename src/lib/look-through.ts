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

/**
 * Calculates look-through sector and country allocations across a collection of portfolio constituents.
 */
export function calculateLookThrough(constituents: LookThroughConstituent[]): LookThroughResult {
    const activeConstituents = constituents.filter(c => c && typeof c.value === 'number' && c.value > 0);
    const totalValue = activeConstituents.reduce((sum, c) => sum + c.value, 0);

    // Map for Sector -> Contributor Map
    const sectorMap = new Map<string, {
        value: number;
        contributors: Map<string, {
            symbol: string;
            name: string;
            allocatedValue: number;
            holdingValue: number;
            weightInHolding: number;
            isLookThrough: boolean;
        }>;
    }>();

    // Map for Country -> Contributor Map
    const countryMap = new Map<string, {
        value: number;
        contributors: Map<string, {
            symbol: string;
            name: string;
            allocatedValue: number;
            holdingValue: number;
            weightInHolding: number;
            isLookThrough: boolean;
        }>;
    }>();

    const addSectorContribution = (
        sector: string,
        c: LookThroughConstituent,
        allocatedVal: number,
        weightInHolding: number,
        isLookThrough: boolean
    ) => {
        if (allocatedVal <= 0) return;
        let entry = sectorMap.get(sector);
        if (!entry) {
            entry = { value: 0, contributors: new Map() };
            sectorMap.set(sector, entry);
        }
        entry.value += allocatedVal;

        const existingContrib = entry.contributors.get(c.symbol);
        if (existingContrib) {
            existingContrib.allocatedValue += allocatedVal;
            existingContrib.weightInHolding += weightInHolding;
        } else {
            entry.contributors.set(c.symbol, {
                symbol: c.symbol,
                name: c.name || c.symbol,
                allocatedValue: allocatedVal,
                holdingValue: c.value,
                weightInHolding,
                isLookThrough
            });
        }
    };

    const addCountryContribution = (
        country: string,
        c: LookThroughConstituent,
        allocatedVal: number,
        weightInHolding: number,
        isLookThrough: boolean
    ) => {
        if (allocatedVal <= 0) return;
        let entry = countryMap.get(country);
        if (!entry) {
            entry = { value: 0, contributors: new Map() };
            countryMap.set(country, entry);
        }
        entry.value += allocatedVal;

        const existingContrib = entry.contributors.get(c.symbol);
        if (existingContrib) {
            existingContrib.allocatedValue += allocatedVal;
            existingContrib.weightInHolding += weightInHolding;
        } else {
            entry.contributors.set(c.symbol, {
                symbol: c.symbol,
                name: c.name || c.symbol,
                allocatedValue: allocatedVal,
                holdingValue: c.value,
                weightInHolding,
                isLookThrough
            });
        }
    };

    for (const c of activeConstituents) {
        // --- 1. Sector Allocation Decomposition ---
        if (c.sectorAllocations && Array.isArray(c.sectorAllocations) && c.sectorAllocations.length > 0) {
            let allocatedWeightSum = 0;
            for (const sectorObj of c.sectorAllocations) {
                if (!sectorObj || typeof sectorObj !== 'object') continue;
                for (const [key, fraction] of Object.entries(sectorObj)) {
                    const numFraction = typeof fraction === 'number' ? fraction : Number(fraction);
                    if (!isNaN(numFraction) && numFraction > 0) {
                        const normSector = normalizeSectorName(key);
                        const allocatedVal = Math.round(c.value * numFraction * 100) / 100;
                        allocatedWeightSum += numFraction;
                        addSectorContribution(normSector, c, allocatedVal, numFraction, true);
                    }
                }
            }

            // If ETF has residual weight not assigned to any sector (e.g. 3% cash reserves)
            if (allocatedWeightSum < 0.99 && allocatedWeightSum >= 0) {
                const remainingFraction = Math.max(0, 1.0 - allocatedWeightSum);
                const remainingValue = Math.round(c.value * remainingFraction * 100) / 100;
                addSectorContribution('Cash & Reserves', c, remainingValue, remainingFraction, true);
            }
        } else if (c.sector && c.sector.trim()) {
            // Direct Equity / Stock with known sector
            const normSector = normalizeSectorName(c.sector);
            addSectorContribution(normSector, c, c.value, 1.0, false);
        } else {
            // Fallback based on asset type
            let normSector = 'Other / Unclassified';
            const upperType = c.type?.toUpperCase() || '';
            if (upperType === 'CRYPTO') normSector = 'Crypto / Digital Assets';
            else if (upperType === 'CASH') normSector = 'Cash & Equivalents';
            addSectorContribution(normSector, c, c.value, 1.0, false);
        }

        // --- 2. Country / Geographic Decomposition ---
        if (c.countryAllocations && Array.isArray(c.countryAllocations) && c.countryAllocations.length > 0) {
            let allocatedWeightSum = 0;
            for (const countryObj of c.countryAllocations) {
                if (!countryObj || typeof countryObj !== 'object') continue;
                for (const [key, fraction] of Object.entries(countryObj)) {
                    const numFraction = typeof fraction === 'number' ? fraction : Number(fraction);
                    if (!isNaN(numFraction) && numFraction > 0) {
                        const normCountry = normalizeCountryName(key);
                        const allocatedVal = Math.round(c.value * numFraction * 100) / 100;
                        allocatedWeightSum += numFraction;
                        addCountryContribution(normCountry, c, allocatedVal, numFraction, true);
                    }
                }
            }
            if (allocatedWeightSum < 0.99 && allocatedWeightSum >= 0) {
                const remainingFraction = Math.max(0, 1.0 - allocatedWeightSum);
                const remainingValue = Math.round(c.value * remainingFraction * 100) / 100;
                addCountryContribution('Global / Other', c, remainingValue, remainingFraction, true);
            }
        } else if (c.country && c.country.trim()) {
            const normCountry = normalizeCountryName(c.country);
            addCountryContribution(normCountry, c, c.value, 1.0, false);
        } else {
            let normCountry = 'Unspecified';
            const upperType = c.type?.toUpperCase() || '';
            if (upperType === 'CRYPTO') {
                normCountry = 'Global / Decentralized';
            } else if (c.currency === 'USD') {
                normCountry = 'United States';
            } else if (c.currency === 'CAD') {
                normCountry = 'Canada';
            } else if (c.currency === 'INR') {
                normCountry = 'India';
            } else if (c.currency === 'EUR') {
                normCountry = 'Europe';
            } else if (c.currency === 'GBP') {
                normCountry = 'United Kingdom';
            }
            addCountryContribution(normCountry, c, c.value, 1.0, false);
        }
    }

    // Build Sector Details
    const sectorDetails: SectorBreakdown[] = Array.from(sectorMap.entries())
        .map(([name, data]) => {
            const contributors: SectorContributor[] = Array.from(data.contributors.values())
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

    // Build Country Details
    const countryDetails: CountryBreakdown[] = Array.from(countryMap.entries())
        .map(([name, data]) => {
            const contributors: CountryContributor[] = Array.from(data.contributors.values())
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
    if (constituent.sector && normalizeSectorName(constituent.sector) === targetSector) {
        return true;
    }
    if (constituent.sectorAllocations && Array.isArray(constituent.sectorAllocations)) {
        for (const sectorObj of constituent.sectorAllocations) {
            if (!sectorObj || typeof sectorObj !== 'object') continue;
            for (const [key, fraction] of Object.entries(sectorObj)) {
                if (normalizeSectorName(key) === targetSector && Number(fraction) > 0) {
                    return true;
                }
            }
        }
    }
    const upperType = constituent.type?.toUpperCase() || '';
    if (targetSector === 'Crypto / Digital Assets' && upperType === 'CRYPTO') return true;
    if (targetSector === 'Cash & Equivalents' && upperType === 'CASH') return true;
    return false;
}

/**
 * Checks whether a constituent has direct or look-through exposure to a given country.
 */
export function constituentHasCountryExposure(constituent: LookThroughConstituent, targetCountry: string): boolean {
    if (!targetCountry) return true;
    if (constituent.country && normalizeCountryName(constituent.country) === targetCountry) {
        return true;
    }
    if (constituent.countryAllocations && Array.isArray(constituent.countryAllocations)) {
        for (const countryObj of constituent.countryAllocations) {
            if (!countryObj || typeof countryObj !== 'object') continue;
            for (const [key, fraction] of Object.entries(countryObj)) {
                if (normalizeCountryName(key) === targetCountry && Number(fraction) > 0) {
                    return true;
                }
            }
        }
    }
    if (targetCountry === 'United States' && constituent.currency === 'USD') return true;
    if (targetCountry === 'Canada' && constituent.currency === 'CAD') return true;
    if (targetCountry === 'India' && constituent.currency === 'INR') return true;
    if (targetCountry === 'Europe' && constituent.currency === 'EUR') return true;
    if (targetCountry === 'United Kingdom' && constituent.currency === 'GBP') return true;
    if (targetCountry === 'Global / Decentralized' && constituent.type?.toUpperCase() === 'CRYPTO') return true;
    return false;
}
