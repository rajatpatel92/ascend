import {
    MAX_UNDERLYING_HOLDINGS,
    type UnderlyingHoldingAssetClass,
    type UnderlyingHoldingEntry,
} from './types.ts';

const EXCHANGE_SUFFIX_TO_REGION: Record<string, string> = {
    TO: 'CA',
    V: 'CA',
    NE: 'CA',
    CN: 'CA',
    NS: 'IN',
    BO: 'IN',
    L: 'GB',
    DE: 'DE',
    F: 'DE',
    PA: 'FR',
    AS: 'NL',
    SW: 'CH',
    S: 'CH',
    T: 'JP',
    HK: 'HK',
    AX: 'AU',
    KS: 'KR',
    KQ: 'KR',
    TW: 'TW',
    TWO: 'TW',
    SA: 'BR',
    MX: 'MX',
    ST: 'SE',
    OL: 'NO',
    CO: 'DK',
    HE: 'FI',
    MI: 'IT',
    MC: 'ES',
};

const COUNTRY_NAME_TO_REGION: Record<string, string> = {
    'united states': 'US',
    usa: 'US',
    us: 'US',
    canada: 'CA',
    india: 'IN',
    'united kingdom': 'GB',
    uk: 'GB',
    germany: 'DE',
    france: 'FR',
    netherlands: 'NL',
    switzerland: 'CH',
    japan: 'JP',
    china: 'CN',
    taiwan: 'TW',
    'south korea': 'KR',
    korea: 'KR',
    australia: 'AU',
    'hong kong': 'HK',
    singapore: 'SG',
    sweden: 'SE',
    denmark: 'DK',
    norway: 'NO',
    finland: 'FI',
    italy: 'IT',
    spain: 'ES',
    brazil: 'BR',
    mexico: 'MX',
    ireland: 'IE',
    belgium: 'BE',
    austria: 'AT',
    israel: 'IL',
};

const IGNORED_TICKERS = new Set([
    '',
    '-',
    '--',
    'N/A',
    'NA',
    'NONE',
    'NULL',
    'CASH',
    'USD',
    'CAD',
    'EUR',
    'GBP',
    'JPY',
]);

const LEGAL_SUFFIX_TOKENS = new Set([
    'inc',
    'incorporated',
    'corp',
    'corporation',
    'ltd',
    'limited',
    'plc',
    'sa',
    'ag',
    'se',
    'ab',
    'asa',
    'oyj',
    'kk',
    'spa',
    'nv',
    'bv',
    'co',
    'company',
    'publ',
    'kgaa',
    'gmbh',
    'srl',
    'pty',
    'bhd',
    'tbk',
]);

const SECURITY_DESCRIPTOR_TOKENS = new Set([
    'common',
    'stock',
    'shs',
    'shares',
    'share',
    'ord',
    'ordinary',
    'subordinate',
    'voting',
    'sub',
    'vts',
    'new',
    'reg',
    'registered',
]);

const PLACEHOLDER_BASE_NAMES = new Set([
    '',
    'other',
    'others',
    'cash',
    'common',
    'total',
    'unassigned',
    'unspecified',
    'unknown',
]);

export interface ParsedSecurityIdentity {
    cleanDisplayName: string;
    isin?: string;
    cleanTicker?: string;
    region?: string;
    shareClass?: string;
    isAdr: boolean;
    isinKey?: string;
    tickerKey?: string;
    nameKey?: string;
    matchKeys: string[];
}

export function cleanHoldingDisplayName(rawName: string): string {
    let cleaned = rawName.replace(/\s+/g, ' ').trim();
    if (!cleaned) return '';

    // Normalize noisy broker/TD suffixes like "Apple Inc - Common" -> "Apple Inc",
    // "Alphabet Inc - Common Cl A" -> "Alphabet Inc Cl A"
    cleaned = cleaned.replace(/\s+-\s+Common(?:\s+Stock)?\s*$/i, '');
    cleaned = cleaned.replace(/\s+-\s+Common\s+(Cl\s+[A-Z0-9]+)\s*$/i, ' $1');
    cleaned = cleaned.replace(/\s+-\s+(Cl\s+[A-Z0-9]+)\s*$/i, ' $1');
    return cleaned.replace(/\s+/g, ' ').trim();
}

export function normalizeCleanTicker(rawTicker?: string | null, rawCountry?: string | null): {
    cleanTicker?: string;
    region?: string;
    tickerShareClass?: string;
} {
    if (!rawTicker || typeof rawTicker !== 'string') {
        const region = rawCountry ? COUNTRY_NAME_TO_REGION[rawCountry.trim().toLowerCase()] : undefined;
        return { region };
    }

    let upper = rawTicker.trim().toUpperCase().replace(/\s+/g, '');
    if (IGNORED_TICKERS.has(upper) || /^[0-9/=-]+$/.test(upper) && upper.length > 8) {
        const region = rawCountry ? COUNTRY_NAME_TO_REGION[rawCountry.trim().toLowerCase()] : undefined;
        return { region };
    }

    let region: string | undefined;
    const suffixMatch = upper.match(/^(.+)\.([A-Z]{1,3})$/);
    if (suffixMatch && EXCHANGE_SUFFIX_TO_REGION[suffixMatch[2]]) {
        region = EXCHANGE_SUFFIX_TO_REGION[suffixMatch[2]];
        upper = suffixMatch[1];
    }

    // Normalize class hyphen to dot (e.g. BRK-B -> BRK.B, CTC-A -> CTC.A)
    upper = upper.replace(/^([A-Z0-9]+)-([A-Z])$/, '$1.$2');
    // Remove leading/trailing punctuation
    upper = upper.replace(/^\.+|\.+$/g, '');

    if (!upper || IGNORED_TICKERS.has(upper)) {
        const fallbackRegion = rawCountry
            ? COUNTRY_NAME_TO_REGION[rawCountry.trim().toLowerCase()]
            : undefined;
        return { region: region ?? fallbackRegion };
    }

    if (!region && rawCountry) {
        region = COUNTRY_NAME_TO_REGION[rawCountry.trim().toLowerCase()];
    }

    const classMatch = upper.match(/\.([A-Z])$/);
    const tickerShareClass = classMatch ? classMatch[1].toLowerCase() : undefined;

    return {
        cleanTicker: upper,
        region,
        tickerShareClass,
    };
}

export function parseSecurityIdentity(input: {
    name: string;
    ticker?: string | null;
    isin?: string | null;
    country?: string | null;
}): ParsedSecurityIdentity {
    const cleanDisplayName = cleanHoldingDisplayName(input.name || '');

    const rawIsin = typeof input.isin === 'string' ? input.isin.trim().toUpperCase() : '';
    const isin = /^[A-Z]{2}[A-Z0-9]{10}$/.test(rawIsin) ? rawIsin : undefined;

    const tickerInfo = normalizeCleanTicker(input.ticker, input.country);
    const countryRegion = input.country
        ? COUNTRY_NAME_TO_REGION[input.country.trim().toLowerCase()]
        : undefined;
    const isinRegion = isin ? isin.slice(0, 2) : undefined;
    const bareTickerFallbackRegion =
        !tickerInfo.region && !countryRegion && !isinRegion && tickerInfo.cleanTicker
            ? 'US'
            : undefined;
    const region = tickerInfo.region ?? countryRegion ?? isinRegion ?? bareTickerFallbackRegion;

    // Normalize raw name while keeping share-class clues intact
    let working = (input.name || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let nameShareClass: string | undefined;
    working = working.replace(/\b(?:cl|class|ser|series)\s+([a-z0-9]{1,2})\b/g, (_m, cls: string) => {
        if (!nameShareClass) nameShareClass = cls;
        return ' ';
    });
    working = working.replace(/\bcl([abc])\b/g, (_m, cls: string) => {
        if (!nameShareClass) nameShareClass = cls;
        return ' ';
    });

    let isAdr = false;
    working = working.replace(/\b(?:adr|ads|gdr)\b/g, () => {
        isAdr = true;
        return ' ';
    });

    const tokens = working.split(/\s+/).filter(Boolean);
    const filteredTokens: string[] = [];
    for (const token of tokens) {
        if (SECURITY_DESCRIPTOR_TOKENS.has(token)) continue;
        filteredTokens.push(token);
    }

    // Strip trailing corporate legal suffixes while keeping distinct middle words like "Holdings" or "Group"
    while (filteredTokens.length > 1 && LEGAL_SUFFIX_TOKENS.has(filteredTokens[filteredTokens.length - 1])) {
        filteredTokens.pop();
    }

    const baseName = filteredTokens.join(' ').trim();
    const effectiveShareClass = nameShareClass ?? tickerInfo.tickerShareClass;

    const isinKey = isin ? `isin:${isin}` : undefined;
    const tickerKey = tickerInfo.cleanTicker
        ? region
            ? `ticker:${region}:${tickerInfo.cleanTicker}`
            : `ticker:*:${tickerInfo.cleanTicker}`
        : undefined;
    const nameKey =
        baseName.length >= 2 && !PLACEHOLDER_BASE_NAMES.has(baseName)
            ? `name:${baseName}${effectiveShareClass ? `|cl:${effectiveShareClass}` : ''}${isAdr ? '|adr' : ''}`
            : undefined;

    const matchKeys: string[] = [];
    if (isinKey) matchKeys.push(isinKey);
    if (tickerKey) matchKeys.push(tickerKey);
    if (nameKey) matchKeys.push(nameKey);

    return {
        cleanDisplayName: cleanDisplayName || tickerInfo.cleanTicker || input.name,
        isin,
        cleanTicker: tickerInfo.cleanTicker,
        region,
        shareClass: effectiveShareClass,
        isAdr,
        isinKey,
        tickerKey,
        nameKey,
        matchKeys,
    };
}

export function scoreHoldingDisplayName(name: string): number {
    if (!name) return -100;
    let score = 0;
    if (/[a-z]/.test(name) && /[A-Z]/.test(name)) score += 10; // Prefer Title Case over ALL CAPS
    if (name.length >= 4 && name.length <= 45) score += 4;
    if (!/-\s*common$/i.test(name)) score += 3;
    return score;
}

export function roundHoldingWeight(weight: number): number {
    return Math.round(weight * 1_000_000) / 1_000_000;
}

/**
 * Union-Find clustering over parsed security identities that NEVER merges two clusters
 * when both declare distinct ISINs, distinct bare tickers in the same region, or distinct share classes.
 */
export function clusterBySecurityIdentity(identities: ParsedSecurityIdentity[]): number[] {
    const n = identities.length;
    if (n === 0) return [];

    const parent: number[] = Array.from({ length: n }, (_, i) => i);
    const bucketMeta = identities.map((id) => ({
        isins: new Set(id.isin ? [id.isin] : []),
        tickerKeys: new Set(id.tickerKey ? [id.tickerKey] : []),
        cleanTickers: new Set(id.cleanTicker ? [id.cleanTicker] : []),
        shareClasses: new Set(id.shareClass ? [id.shareClass] : []),
    }));

    const find = (i: number): number => {
        let root = i;
        while (parent[root] !== root) root = parent[root];
        let curr = i;
        while (curr !== root) {
            const next = parent[curr];
            parent[curr] = root;
            curr = next;
        }
        return root;
    };

    const setsConflict = (a: Set<string>, b: Set<string>): boolean => {
        if (a.size === 0 || b.size === 0) return false;
        for (const v of a) {
            if (b.has(v)) return false;
        }
        return true;
    };

    const tryUnion = (a: number, b: number, matchType: 'isin' | 'ticker' | 'name'): void => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;

        const ma = bucketMeta[ra];
        const mb = bucketMeta[rb];

        // Even for same ticker/name, conflicting ISINs or share classes indicate distinct share classes
        if (setsConflict(ma.isins, mb.isins)) return;
        if (matchType !== 'isin') {
            if (setsConflict(ma.shareClasses, mb.shareClasses)) return;
        }
        if (matchType === 'name') {
            if (setsConflict(ma.tickerKeys, mb.tickerKeys)) return;
            if (setsConflict(ma.cleanTickers, mb.cleanTickers)) return;
        }

        parent[rb] = ra;
        for (const v of mb.isins) ma.isins.add(v);
        for (const v of mb.tickerKeys) ma.tickerKeys.add(v);
        for (const v of mb.cleanTickers) ma.cleanTickers.add(v);
        for (const v of mb.shareClasses) ma.shareClasses.add(v);
    };

    // Match strongest tier first (ISIN -> Ticker -> Name)
    const isinToIndices = new Map<string, number[]>();
    const tickerToIndices = new Map<string, number[]>();
    const nameToIndices = new Map<string, number[]>();

    for (let i = 0; i < n; i++) {
        const id = identities[i];
        if (id.isinKey) {
            const list = isinToIndices.get(id.isinKey);
            if (list) list.push(i);
            else isinToIndices.set(id.isinKey, [i]);
        }
        if (id.tickerKey) {
            const list = tickerToIndices.get(id.tickerKey);
            if (list) list.push(i);
            else tickerToIndices.set(id.tickerKey, [i]);
        }
        if (id.nameKey) {
            const list = nameToIndices.get(id.nameKey);
            if (list) list.push(i);
            else nameToIndices.set(id.nameKey, [i]);
        }
    }

    for (const indices of isinToIndices.values()) {
        for (let j = 1; j < indices.length; j++) {
            tryUnion(indices[0], indices[j], 'isin');
        }
    }
    for (const indices of tickerToIndices.values()) {
        for (let j = 1; j < indices.length; j++) {
            tryUnion(indices[0], indices[j], 'ticker');
        }
    }
    for (const indices of nameToIndices.values()) {
        for (let j = 1; j < indices.length; j++) {
            tryUnion(indices[0], indices[j], 'name');
        }
    }

    return parent.map((_, idx) => find(idx));
}

/**
 * Merges duplicate security rows within a fund (preserving dual-class shares),
 * sorts descending by weight, filters dust, and caps at `limit` (default MAX_UNDERLYING_HOLDINGS).
 */
export function mergeAndCapHoldings(
    entries: UnderlyingHoldingEntry[],
    limit: number = MAX_UNDERLYING_HOLDINGS
): UnderlyingHoldingEntry[] {
    if (!Array.isArray(entries) || entries.length === 0) return [];

    interface GroupBucket {
        name: string;
        nameScore: number;
        ticker?: string;
        isin?: string;
        sector?: string;
        country?: string;
        assetClass?: UnderlyingHoldingAssetClass;
        weight: number;
        source?: string;
    }

    const parsedItems = entries
        .filter((e) => e && typeof e.weight === 'number' && Number.isFinite(e.weight) && e.weight > 0)
        .map((e) => ({
            entry: e,
            identity: parseSecurityIdentity({
                name: e.name || e.ticker || e.isin || '',
                ticker: e.ticker,
                isin: e.isin,
                country: e.country,
            }),
        }))
        .filter((item) => item.identity.cleanDisplayName.length > 0);

    if (parsedItems.length === 0) return [];

    const roots = clusterBySecurityIdentity(parsedItems.map((item) => item.identity));

    const groups = new Map<number, GroupBucket>();
    for (let i = 0; i < parsedItems.length; i++) {
        const root = roots[i];
        const { entry, identity } = parsedItems[i];
        const candidateName = identity.cleanDisplayName;
        const candidateScore = scoreHoldingDisplayName(candidateName);
        const rawTickerUpper =
            typeof entry.ticker === 'string' && !IGNORED_TICKERS.has(entry.ticker.trim().toUpperCase())
                ? entry.ticker.trim().toUpperCase()
                : undefined;
        const candidateTicker = rawTickerUpper ?? identity.cleanTicker;
        const existing = groups.get(root);

        if (!existing) {
            groups.set(root, {
                name: candidateName,
                nameScore: candidateScore,
                ticker: candidateTicker,
                isin: identity.isin,
                sector: entry.sector || undefined,
                country: entry.country || undefined,
                assetClass: entry.assetClass,
                weight: entry.weight,
                source: entry.source,
            });
        } else {
            existing.weight += entry.weight;
            if (candidateScore > existing.nameScore) {
                existing.name = candidateName;
                existing.nameScore = candidateScore;
            }
            if (
                candidateTicker &&
                (!existing.ticker || (candidateTicker.includes('.') && !existing.ticker.includes('.')))
            ) {
                existing.ticker = candidateTicker;
            }
            if (!existing.isin && identity.isin) existing.isin = identity.isin;
            if (!existing.sector && entry.sector) existing.sector = entry.sector;
            if (!existing.country && entry.country) existing.country = entry.country;
            if (!existing.assetClass && entry.assetClass) existing.assetClass = entry.assetClass;
            if (!existing.source && entry.source) existing.source = entry.source;
        }
    }

    return Array.from(groups.values())
        .map((g): UnderlyingHoldingEntry => {
            const out: UnderlyingHoldingEntry = {
                name: g.name,
                weight: roundHoldingWeight(g.weight),
            };
            if (g.ticker) out.ticker = g.ticker;
            if (g.isin) out.isin = g.isin;
            if (g.sector) out.sector = g.sector;
            if (g.country) out.country = g.country;
            if (g.assetClass) out.assetClass = g.assetClass;
            if (g.source) out.source = g.source;
            return out;
        })
        .filter((item) => item.weight >= 1e-6)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, limit);
}

/**
 * Validates and normalizes persisted `topHoldings` JSON arrays (used by API routes and cache mappers).
 */
export function sanitizeStoredHoldings(
    raw: unknown,
    limit: number = MAX_UNDERLYING_HOLDINGS
): UnderlyingHoldingEntry[] {
    if (!Array.isArray(raw)) return [];

    const parsedRaw: Array<{ rec: Record<string, unknown>; rawName: string; rawWeight: number }> = [];
    let rawSum = 0;
    let maxWeight = 0;

    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        const rawName = typeof rec.name === 'string' ? rec.name.trim() : '';
        const rawWeight = typeof rec.weight === 'number' ? rec.weight : Number(rec.weight);
        if (!rawName || !Number.isFinite(rawWeight) || rawWeight <= 0) continue;
        parsedRaw.push({ rec, rawName, rawWeight });
        rawSum += rawWeight;
        if (rawWeight > maxWeight) maxWeight = rawWeight;
    }

    if (parsedRaw.length === 0) return [];

    // # Reason: Detect 0..100 percentage arrays uniformly across all items so values near 1% (<= 1.5)
    // aren't left as 100% while larger siblings get divided by 100.
    const divisor = rawSum > 1.5 || maxWeight > 1.5 ? 100 : 1;

    const valid: UnderlyingHoldingEntry[] = [];
    for (const { rec, rawName, rawWeight } of parsedRaw) {
        const normalizedWeight = rawWeight / divisor;
        if (normalizedWeight <= 0 || normalizedWeight > 1.5) continue;

        const out: UnderlyingHoldingEntry = {
            name: cleanHoldingDisplayName(rawName) || rawName,
            weight: roundHoldingWeight(normalizedWeight),
        };
        if (typeof rec.ticker === 'string' && rec.ticker.trim()) {
            out.ticker = rec.ticker.trim().toUpperCase();
        }
        if (typeof rec.isin === 'string' && rec.isin.trim()) {
            out.isin = rec.isin.trim().toUpperCase();
        }
        if (typeof rec.sector === 'string' && rec.sector.trim()) {
            out.sector = rec.sector.trim();
        }
        if (typeof rec.country === 'string' && rec.country.trim()) {
            out.country = rec.country.trim();
        }
        if (rec.assetClass === 'EQUITY' || rec.assetClass === 'BOND') {
            out.assetClass = rec.assetClass;
        }
        if (typeof rec.source === 'string' && rec.source.trim()) {
            out.source = rec.source.trim();
        }
        valid.push(out);
    }

    return valid.sort((a, b) => b.weight - a.weight).slice(0, limit);
}

/**
 * Extracts Yahoo Finance `quoteSummary.topHoldings.holdings` as a fallback list (capped at MAX_UNDERLYING_HOLDINGS).
 */
export function extractYahooTopHoldings(rawYahooHoldings: unknown): UnderlyingHoldingEntry[] {
    if (!Array.isArray(rawYahooHoldings) || rawYahooHoldings.length === 0) return [];

    const mapped: UnderlyingHoldingEntry[] = [];
    for (const row of rawYahooHoldings) {
        if (!row || typeof row !== 'object') continue;
        const rec = row as Record<string, unknown>;
        const rawName =
            typeof rec.holdingName === 'string' && rec.holdingName.trim()
                ? rec.holdingName.trim()
                : typeof rec.symbol === 'string' && rec.symbol.trim()
                  ? rec.symbol.trim()
                  : '';
        const rawPct =
            typeof rec.holdingPercent === 'number'
                ? rec.holdingPercent
                : Number(rec.holdingPercent);
        if (!rawName || !Number.isFinite(rawPct) || rawPct <= 0) continue;

        const weight = rawPct > 1.5 ? rawPct / 100 : rawPct;
        const rawTicker = typeof rec.symbol === 'string' ? rec.symbol.trim() : undefined;

        mapped.push({
            name: rawName,
            ticker: rawTicker && !IGNORED_TICKERS.has(rawTicker.toUpperCase()) ? rawTicker.toUpperCase() : undefined,
            weight,
            assetClass: 'EQUITY',
            source: 'yahoo',
        });
    }

    return mergeAndCapHoldings(mapped, MAX_UNDERLYING_HOLDINGS);
}
