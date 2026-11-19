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
    consumer_services: 'Consumer Cyclical',
    communication_services: 'Communication Services',
    communication: 'Communication Services',
    telecommunications: 'Communication Services',
    telecommunication_services: 'Communication Services',
    telecom_services: 'Communication Services',
    industrials: 'Industrials',
    industrial: 'Industrials',
    industrial_goods: 'Industrials',
    industrial_services: 'Industrials',
    consumer_defensive: 'Consumer Defensive',
    consumer_staples: 'Consumer Defensive',
    consumer_goods: 'Consumer Defensive',
    consumer_non_cyclical: 'Consumer Defensive',
    energy: 'Energy',
    'oil_&_gas': 'Energy',
    oil_and_gas: 'Energy',
    basic_materials: 'Basic Materials',
    materials: 'Basic Materials',
    realestate: 'Real Estate',
    real_estate: 'Real Estate',
    utilities: 'Utilities',
    utility: 'Utilities',
};

const ISO2_COUNTRY_NAMES: Record<string, string> = {
    ae: 'United Arab Emirates',
    ar: 'Argentina',
    at: 'Austria',
    au: 'Australia',
    be: 'Belgium',
    bh: 'Bahrain',
    br: 'Brazil',
    ca: 'Canada',
    ch: 'Switzerland',
    cl: 'Chile',
    cn: 'China',
    co: 'Colombia',
    cy: 'Cyprus',
    cz: 'Czech Republic',
    de: 'Germany',
    dk: 'Denmark',
    ee: 'Estonia',
    eg: 'Egypt',
    es: 'Spain',
    fi: 'Finland',
    fo: 'Faroe Islands',
    fr: 'France',
    gb: 'United Kingdom',
    gr: 'Greece',
    hk: 'Hong Kong',
    hu: 'Hungary',
    id: 'Indonesia',
    ie: 'Ireland',
    il: 'Israel',
    in: 'India',
    is: 'Iceland',
    it: 'Italy',
    jp: 'Japan',
    kr: 'South Korea',
    kw: 'Kuwait',
    li: 'Liechtenstein',
    lt: 'Lithuania',
    lu: 'Luxembourg',
    lv: 'Latvia',
    ma: 'Morocco',
    mt: 'Malta',
    mx: 'Mexico',
    my: 'Malaysia',
    nl: 'Netherlands',
    no: 'Norway',
    nz: 'New Zealand',
    om: 'Oman',
    pa: 'Panama',
    pe: 'Peru',
    ph: 'Philippines',
    pl: 'Poland',
    pr: 'Puerto Rico',
    pt: 'Portugal',
    qa: 'Qatar',
    ro: 'Romania',
    ru: 'Russia',
    sa: 'Saudi Arabia',
    se: 'Sweden',
    sg: 'Singapore',
    si: 'Slovenia',
    sk: 'Slovakia',
    th: 'Thailand',
    tr: 'Turkey',
    tw: 'Taiwan',
    ua: 'Ukraine',
    us: 'United States',
    vn: 'Vietnam',
    za: 'South Africa',
};

const COUNTRY_NAME_MAP: Record<string, string> = {
    ...ISO2_COUNTRY_NAMES,
    usa: 'United States',
    united_states: 'United States',
    united_states_of_america: 'United States',
    can: 'Canada',
    canada: 'Canada',
    uk: 'United Kingdom',
    united_kingdom: 'United Kingdom',
    united_kingdom_of_great_britain_and_northern_ireland: 'United Kingdom',
    great_britain: 'United Kingdom',
    ind: 'India',
    india: 'India',
    japan: 'Japan',
    germany: 'Germany',
    switzerland: 'Switzerland',
    france: 'France',
    china: 'China',
    "people's_republic_of_china": 'China',
    peoples_republic_of_china: 'China',
    australia: 'Australia',
    netherlands: 'Netherlands',
    south_korea: 'South Korea',
    korea_south: 'South Korea',
    'korea_(south)': 'South Korea',
    republic_of_korea: 'South Korea',
    korea: 'South Korea',
    taiwan: 'Taiwan',
    taiwan_province_of_china: 'Taiwan',
    'taiwan,_province_of_china': 'Taiwan',
    brazil: 'Brazil',
    russia: 'Russia',
    russian_federation: 'Russia',
    hong_kong: 'Hong Kong',
    hong_kong_sar: 'Hong Kong',
    hong_kong_sar_china: 'Hong Kong',
    sweden: 'Sweden',
    spain: 'Spain',
    italy: 'Italy',
    denmark: 'Denmark',
    singapore: 'Singapore',
    ireland: 'Ireland',
    mexico: 'Mexico',
    south_africa: 'South Africa',
    turkey: 'Turkey',
    turkiye: 'Turkey',
    saudi_arabia: 'Saudi Arabia',
    indonesia: 'Indonesia',
    uae: 'United Arab Emirates',
    united_arab_emirates: 'United Arab Emirates',
    czechia: 'Czech Republic',
    czech_republic: 'Czech Republic',
    norway: 'Norway',
    finland: 'Finland',
    belgium: 'Belgium',
    austria: 'Austria',
    israel: 'Israel',
    new_zealand: 'New Zealand',
    portugal: 'Portugal',
    poland: 'Poland',
    greece: 'Greece',
    thailand: 'Thailand',
    malaysia: 'Malaysia',
    philippines: 'Philippines',
    chile: 'Chile',
    colombia: 'Colombia',
    peru: 'Peru',
    hungary: 'Hungary',
    egypt: 'Egypt',
    qatar: 'Qatar',
    kuwait: 'Kuwait',
    luxembourg: 'Luxembourg',
    argentina: 'Argentina',
    vietnam: 'Vietnam',
    viet_nam: 'Vietnam',
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
 * Resolves a strict ISO 3166-1 alpha-2 country code (e.g. ISIN prefix or Bloomberg ISO2)
 * into a canonical country name, returning null for offshore domiciles (KY, BM) or
 * non-geographic issuing codes (XS, EU, ZZ).
 */
export function resolveIso2CountryName(code?: string | null): string | null {
    if (!code) return null;
    const cleaned = code.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(cleaned)) return null;
    return ISO2_COUNTRY_NAMES[cleaned] ?? null;
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
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.01) return [];
    const results: DimensionContribution[] = [];

    if (allocations && Array.isArray(allocations) && allocations.length > 0) {
        const rawEntries: { category: string; weight: number }[] = [];
        let rawSum = 0;

        for (const obj of allocations) {
            if (!obj || typeof obj !== 'object') continue;
            for (const [key, fraction] of Object.entries(obj)) {
                const numFraction = typeof fraction === 'number' ? fraction : Number(fraction);
                if (Number.isFinite(numFraction) && numFraction > 0) {
                    rawEntries.push({ category: normalize(key), weight: numFraction });
                    rawSum += numFraction;
                }
            }
        }

        if (rawEntries.length > 0 && rawSum > 0) {
            // # Reason: Normalize 0..100 percentage inputs (sum > 1.5) to fractions, and renormalize
            // minor rounding drift in [0.99, 1.01] or >1.0 sums so total allocated value stays exact.
            const scaleToFraction = rawSum > 1.5 ? 100 : 1;
            const fractionalSum = rawSum / scaleToFraction;
            const normDivisor = fractionalSum >= 0.99 ? fractionalSum : 1;

            let allocatedWeightSum = 0;
            for (const entry of rawEntries) {
                const numFraction = (entry.weight / scaleToFraction) / normDivisor;
                const allocatedVal = Math.round(value * numFraction * 100) / 100;
                allocatedWeightSum += numFraction;
                if (allocatedVal >= 0.01) {
                    results.push({
                        category: entry.category,
                        allocatedValue: allocatedVal,
                        weightInHolding: numFraction,
                        isLookThrough: true
                    });
                }
            }

            if (fractionalSum < 0.99 && allocatedWeightSum < 1.0) {
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

            if (results.length > 0) {
                return results;
            }
        }
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
