import {
    normalizeCountryName,
    normalizeSectorName,
    resolveIso2CountryName,
} from '../look-through.ts';
import {
    createIssuerRequester,
    emitIssuerDiagnostic,
    type IssuerRequestOptions,
} from './http.ts';
import { mergeAndCapHoldings } from './holdings.ts';
import {
    MAX_UNDERLYING_HOLDINGS,
    type AllocationWeightEntry,
    type EtfIssuerAdapter,
    type IssuerAllocationResult,
    type IssuerLookupContext,
    type UnderlyingHoldingEntry,
} from './types.ts';

type VanguardRegion = 'ca' | 'us';
type RequesterFn = (url: string, opts?: IssuerRequestOptions) => Promise<Response>;

const VANGUARD_CA_GRAPHQL_URL = 'https://www.vanguard.ca/gpx/graphql';
const VANGUARD_CA_PRODUCT_MODEL_URL = 'https://www.vanguard.ca/en/product.model.json';

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const VANGUARD_CA_HEADERS: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-consumer-id': 'ca0',
    'apollographql-client-name': 'gpx',
    Origin: 'https://www.vanguard.ca',
    Referer: 'https://www.vanguard.ca/',
    'User-Agent': DEFAULT_USER_AGENT,
};

const VANGUARD_US_HEADERS: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://investor.vanguard.com/',
    'User-Agent': DEFAULT_USER_AGENT,
};

// Verified Vanguard Canada TSX/NEO ETF portId mapping
export const KNOWN_VANGUARD_CA_PORT_IDS: Record<string, string> = {
    VEQT: '9692',
    VGRO: '9579',
    VBAL: '9578',
    VCNS: '9577',
    VCIP: '9691',
    VRIF: '9870',
    VUN: '9557',
    VUS: '9551',
    VFV: '9563',
    VSP: '9562',
    VGG: '9566',
    VGH: '9564',
    VCN: '9561',
    VCE: '9554',
    VDY: '9560',
    VRE: '9559',
    VIU: '9569',
    VI: '9570',
    VDU: '9558',
    VEF: '9555',
    VA: '9550',
    VE: '9549',
    VIDY: '9742',
    VEE: '9556',
    VXC: '9548',
    VVO: '9828',
    VMO: '9835',
    VVL: '9795',
    VAB: '9552',
    VSB: '9553',
    VSC: '9565',
    VLB: '1811',
    VGV: '1817',
    VCB: '1936',
    VBU: '9567',
    VBG: '9568',
    VGAB: '9841',
    VVSG: 'D003',
    VUDV: 'D018',
    VUDH: 'D019',
    VIGG: 'D020',
    VCOR: 'D021',
};

const CA_FUND_ALLOCATIONS_QUERY = `
query FundAllocations($portIds: [String!]) {
  funds(portIds: $portIds) {
    profile {
      portId
      fundFullName
      assetClassificationLevel1
      marketOfDomicile
      primaryMarketEquityClassification
      primarySectorEquityClassification
    }
    marketAllocation {
      portId
      date
      countryCode
      countryName
      fundMktPercent
      holdingStatCode
      regionCode
      regionName
    }
    sectorDiversification {
      sectorCode
      date
      sectorName
      fundPercent
    }
  }
}
`;

const CA_FUND_CATALOGUE_QUERY = `
query FundCatalogue($portIds: [String!]) {
  funds(portIds: $portIds) {
    portId
    profile {
      portId
      fundFullName
      listings {
        stockExchangeMarketIdentifierCode
        identifiers(altIds: ["Ticker - Canada", "Ticker"]) {
          altId
          altIdValue
        }
      }
    }
  }
}
`;

const CA_BOR_HOLDINGS_QUERY = `
query BorHoldings($portIds: [String!], $lastItemKey: String) {
  borHoldings(portIds: $portIds) {
    holdings(limit: 1500, lastItemKey: $lastItemKey) {
      items {
        ticker
        isin
        issuerName
        securityLongDescription
        marketValuePercentage
        effectiveDate
        gicsSectorDescription
        bloombergIsoCountry
        securityType
        marketValueBaseCurrency
      }
      totalHoldings
      lastItemKey
    }
  }
}
`;

const IGNORED_BUCKET_LABELS = new Set([
    '-',
    '--',
    'n/a',
    'na',
    'none',
    'null',
    'other',
    'others',
    'unassigned',
    'unspecified',
    'not available',
    'total',
    'cash',
    'cash and cash equivalents',
    'short-term reserves',
]);

let cachedCaCatalogueMap: Map<string, string> | null = null;

function warnDiagnostic(ctx: IssuerLookupContext, msg: string): void {
    emitIssuerDiagnostic(ctx, msg);
}

function roundWeight(weight: number): number {
    return Math.round(weight * 1_000_000) / 1_000_000;
}

function parseNumericPercent(raw: unknown): number | undefined {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? raw : undefined;
    }
    if (typeof raw === 'string') {
        const cleaned = raw.replace(/[%,$\s]/g, '');
        if (!cleaned || cleaned === '-' || cleaned === '--') return undefined;
        const parsed = Number(cleaned);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

export function resolveVanguardRegionAndTicker(symbol: string): {
    region: VanguardRegion;
    searchTerms: string[];
} | null {
    const trimmed = symbol.trim().toUpperCase();
    if (!trimmed || trimmed.endsWith('=X') || trimmed.startsWith('^')) {
        return null;
    }

    if (/\.(TO|NE|V|CN)$/.test(trimmed)) {
        const base = trimmed.replace(/\.(TO|NE|V|CN)$/, '');
        const terms = [base];
        if (/([.-]U)$/.test(base)) {
            terms.push(base.replace(/([.-]U)$/, ''));
        }
        return { region: 'ca', searchTerms: Array.from(new Set(terms)) };
    }

    if (!trimmed.includes('.')) {
        return { region: 'us', searchTerms: [trimmed] };
    }

    return null;
}

function normalizePercentEntries(
    totals: Map<string, number>,
    sumOfEntries: number
): AllocationWeightEntry[] {
    if (totals.size === 0 || sumOfEntries <= 0) return [];
    const denominator = sumOfEntries >= 98 ? sumOfEntries : 100;
    return Array.from(totals.entries())
        .map(([name, val]) => ({ name, weight: roundWeight(val / denominator) }))
        .filter((e) => e.weight >= 1e-6)
        .sort((a, b) => b.weight - a.weight)
        .map((e) => ({ [e.name]: e.weight }));
}

function resolveCountryFromMarketEntry(countryCode: unknown, countryName: unknown): string | null {
    if (typeof countryCode === 'string' && countryCode.trim()) {
        const byCode = resolveIso2CountryName(countryCode);
        if (byCode) return byCode;
    }
    if (typeof countryName === 'string' && countryName.trim()) {
        const lower = countryName.trim().toLowerCase();
        if (IGNORED_BUCKET_LABELS.has(lower)) return null;
        const normalized = normalizeCountryName(countryName);
        if (normalized !== 'Unspecified') return normalized;
    }
    return null;
}

interface CaMarketEntry {
    date?: unknown;
    countryCode?: unknown;
    countryName?: unknown;
    fundMktPercent?: unknown;
    holdingStatCode?: unknown;
}

interface CaSectorEntry {
    date?: unknown;
    sectorName?: unknown;
    fundPercent?: unknown;
}

interface CaFundData {
    profile?: {
        portId?: unknown;
        fundFullName?: unknown;
        assetClassificationLevel1?: unknown;
        primaryMarketEquityClassification?: unknown;
    };
    marketAllocation?: CaMarketEntry[];
    sectorDiversification?: CaSectorEntry[];
}

export function parseVanguardCaFundAggregations(fund: CaFundData): {
    countryAllocations: AllocationWeightEntry[];
    sectorAllocations: AllocationWeightEntry[];
    asOfDate?: string;
    isFixedIncome: boolean;
} {
    const assetClass =
        typeof fund.profile?.assetClassificationLevel1 === 'string'
            ? fund.profile.assetClassificationLevel1
            : '';
    const isFixedIncome = /\b(fixed income|bond)\b/i.test(assetClass);
    const primaryMarketClass =
        typeof fund.profile?.primaryMarketEquityClassification === 'string'
            ? fund.profile.primaryMarketEquityClassification.toUpperCase()
            : '';

    const marketRows = Array.isArray(fund.marketAllocation) ? fund.marketAllocation : [];
    const statGroups = new Map<
        string,
        { totals: Map<string, number>; sum: number; asOfDate?: string }
    >();

    for (const row of marketRows) {
        if (!row || typeof row !== 'object') continue;
        const pct = parseNumericPercent(row.fundMktPercent);
        if (pct === undefined || pct <= 0) continue;

        const country = resolveCountryFromMarketEntry(row.countryCode, row.countryName);
        if (!country) continue;

        const statCode =
            typeof row.holdingStatCode === 'string' && row.holdingStatCode.trim()
                ? row.holdingStatCode.trim().toUpperCase()
                : 'DEFAULT';

        let group = statGroups.get(statCode);
        if (!group) {
            group = { totals: new Map(), sum: 0 };
            statGroups.set(statCode, group);
        }
        group.totals.set(country, (group.totals.get(country) ?? 0) + pct);
        group.sum += pct;
        if (!group.asOfDate && typeof row.date === 'string' && row.date.trim()) {
            group.asOfDate = row.date.trim();
        }
    }

    let selectedGroup: { totals: Map<string, number>; sum: number; asOfDate?: string } | undefined;
    if (statGroups.size > 0) {
        const preferredCodes = isFixedIncome
            ? ['CNTRYEMUG', 'MSCTYATPCS', 'FTCTYATPCS']
            : primaryMarketClass.includes('FTSE')
              ? ['FTCTYATPCS', 'MSCTYATPCS']
              : ['MSCTYATPCS', 'FTCTYATPCS', 'CNTRYEMUG'];

        for (const code of preferredCodes) {
            const candidate = statGroups.get(code);
            if (candidate && candidate.totals.size > 0) {
                selectedGroup = candidate;
                break;
            }
        }
        if (!selectedGroup) {
            for (const candidate of statGroups.values()) {
                if (!selectedGroup || candidate.sum > selectedGroup.sum) {
                    selectedGroup = candidate;
                }
            }
        }
    }

    const countryAllocations = selectedGroup
        ? normalizePercentEntries(selectedGroup.totals, selectedGroup.sum)
        : [];

    let asOfDate = selectedGroup?.asOfDate;
    const sectorTotals = new Map<string, number>();
    let sectorSum = 0;

    if (!isFixedIncome) {
        const sectorRows = Array.isArray(fund.sectorDiversification)
            ? fund.sectorDiversification
            : [];
        for (const row of sectorRows) {
            if (!row || typeof row !== 'object') continue;
            const pct = parseNumericPercent(row.fundPercent);
            if (pct === undefined || pct <= 0) continue;
            const rawSector = typeof row.sectorName === 'string' ? row.sectorName.trim() : '';
            if (!rawSector || IGNORED_BUCKET_LABELS.has(rawSector.toLowerCase())) continue;

            const normalized = normalizeSectorName(rawSector);
            if (normalized === 'Other / Unclassified') continue;

            sectorTotals.set(normalized, (sectorTotals.get(normalized) ?? 0) + pct);
            sectorSum += pct;
            if (!asOfDate && typeof row.date === 'string' && row.date.trim()) {
                asOfDate = row.date.trim();
            }
        }
    }

    const sectorAllocations = !isFixedIncome
        ? normalizePercentEntries(sectorTotals, sectorSum)
        : [];

    return {
        countryAllocations,
        sectorAllocations,
        asOfDate,
        isFixedIncome,
    };
}

function collectPortIdsFromModel(node: unknown, out: Set<string>): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) {
            collectPortIdsFromModel(item, out);
        }
        return;
    }

    const record = node as Record<string, unknown>;
    if (typeof record.portIds === 'string' && record.portIds.trim()) {
        for (const id of record.portIds.split(',')) {
            const trimmed = id.trim();
            if (trimmed) out.add(trimmed);
        }
    }
    for (const val of Object.values(record)) {
        if (val && typeof val === 'object') {
            collectPortIdsFromModel(val, out);
        }
    }
}

async function discoverVanguardCaCatalogue(
    ctx: IssuerLookupContext,
    requester: RequesterFn
): Promise<Map<string, string>> {
    if (!ctx.fetchFn && cachedCaCatalogueMap && cachedCaCatalogueMap.size > 0) {
        return cachedCaCatalogueMap;
    }

    const modelRes = await requester(VANGUARD_CA_PRODUCT_MODEL_URL, {
        headers: {
            Accept: 'application/json',
            'User-Agent': DEFAULT_USER_AGENT,
        },
    });
    if (!modelRes.ok) {
        await modelRes.body?.cancel().catch(() => {});
        return new Map();
    }

    const modelJson = (await modelRes.json().catch(() => null)) as unknown;
    const portIds = new Set<string>();
    collectPortIdsFromModel(modelJson, portIds);
    if (portIds.size === 0) {
        return new Map();
    }

    const catalogueRes = await requester(VANGUARD_CA_GRAPHQL_URL, {
        method: 'POST',
        headers: VANGUARD_CA_HEADERS,
        body: JSON.stringify({
            query: CA_FUND_CATALOGUE_QUERY,
            variables: { portIds: Array.from(portIds) },
        }),
    });
    if (!catalogueRes.ok) {
        await catalogueRes.body?.cancel().catch(() => {});
        return new Map();
    }

    const catJson = (await catalogueRes.json().catch(() => null)) as {
        data?: {
            funds?: Array<{
                portId?: unknown;
                profile?: {
                    portId?: unknown;
                    listings?: Array<{
                        stockExchangeMarketIdentifierCode?: unknown;
                        identifiers?: Array<{ altId?: unknown; altIdValue?: unknown }>;
                    }>;
                };
            }>;
        };
    } | null;

    const funds = Array.isArray(catJson?.data?.funds) ? catJson.data.funds : [];
    const discovered = new Map<string, string>();
    const preferredMic = new Set(['XTSE', 'NEOE']);

    for (const fund of funds) {
        const pid =
            (typeof fund.portId === 'string' && fund.portId.trim()) ||
            (typeof fund.profile?.portId === 'string' && fund.profile.portId.trim()) ||
            '';
        if (!pid) continue;

        const listings = Array.isArray(fund.profile?.listings) ? fund.profile.listings : [];
        const orderedListings = [
            ...listings.filter(
                (l) =>
                    typeof l.stockExchangeMarketIdentifierCode === 'string' &&
                    preferredMic.has(l.stockExchangeMarketIdentifierCode.toUpperCase())
            ),
            ...listings.filter(
                (l) =>
                    typeof l.stockExchangeMarketIdentifierCode !== 'string' ||
                    !preferredMic.has(l.stockExchangeMarketIdentifierCode.toUpperCase())
            ),
        ];

        for (const listing of orderedListings) {
            const ids = Array.isArray(listing.identifiers) ? listing.identifiers : [];
            for (const ident of ids) {
                if (typeof ident.altIdValue !== 'string') continue;
                const altId = typeof ident.altId === 'string' ? ident.altId : '';
                if (altId && altId !== 'Ticker - Canada' && altId !== 'Ticker') continue;

                const tickerClean = ident.altIdValue
                    .trim()
                    .toUpperCase()
                    .replace(/\.(TO|NE|V|CN)$/, '');
                if (tickerClean && !discovered.has(tickerClean)) {
                    discovered.set(tickerClean, pid);
                }
            }
        }
    }

    if (!ctx.fetchFn && discovered.size > 0) {
        cachedCaCatalogueMap = discovered;
    }

    return discovered;
}

interface CaBorHoldingItem {
    ticker?: unknown;
    isin?: unknown;
    issuerName?: unknown;
    securityLongDescription?: unknown;
    marketValuePercentage?: unknown;
    effectiveDate?: unknown;
    gicsSectorDescription?: unknown;
    bloombergIsoCountry?: unknown;
    securityType?: unknown;
    marketValueBaseCurrency?: unknown;
}

function resolveVanguardCaTickerToPortId(
    rawTicker: unknown,
    catalogue?: Map<string, string>
): string | null {
    if (typeof rawTicker !== 'string' || !rawTicker.trim()) return null;
    const clean = rawTicker
        .trim()
        .toUpperCase()
        .replace(/\.(TO|NE|V|CN)$/, '')
        .split(/\s+/)[0];
    return KNOWN_VANGUARD_CA_PORT_IDS[clean] ?? catalogue?.get(clean) ?? null;
}

async function fetchCaFundGraphQl(
    requester: RequesterFn,
    portId: string
): Promise<CaFundData | null> {
    const res = await requester(VANGUARD_CA_GRAPHQL_URL, {
        method: 'POST',
        headers: VANGUARD_CA_HEADERS,
        body: JSON.stringify({
            query: CA_FUND_ALLOCATIONS_QUERY,
            variables: { portIds: [portId] },
        }),
    });
    if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
    }
    const payload = (await res.json().catch(() => null)) as {
        data?: { funds?: CaFundData[] };
    } | null;
    return payload?.data?.funds?.[0] ?? null;
}

async function fetchCaBorHoldings(
    requester: RequesterFn,
    portId: string
): Promise<CaBorHoldingItem[]> {
    const allItems: CaBorHoldingItem[] = [];
    let lastItemKey: string | null = null;

    for (let page = 0; page < 8; page++) {
        const res = await requester(VANGUARD_CA_GRAPHQL_URL, {
            method: 'POST',
            headers: VANGUARD_CA_HEADERS,
            body: JSON.stringify({
                query: CA_BOR_HOLDINGS_QUERY,
                variables: { portIds: [portId], lastItemKey },
            }),
        });
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            break;
        }
        const json = (await res.json().catch(() => null)) as {
            data?: {
                borHoldings?: Array<{
                    holdings?: {
                        items?: CaBorHoldingItem[];
                        lastItemKey?: string | null;
                    };
                }>;
            };
        } | null;

        const holdingsBlock = json?.data?.borHoldings?.[0]?.holdings;
        const pageItems = Array.isArray(holdingsBlock?.items) ? holdingsBlock.items : [];
        if (pageItems.length === 0) break;

        allItems.push(...pageItems);
        const nextKey = typeof holdingsBlock?.lastItemKey === 'string' ? holdingsBlock.lastItemKey : '';
        if (!nextKey || nextKey === lastItemKey) break;
        lastItemKey = nextKey;
    }

    return allItems;
}

export async function aggregateCaBorHoldings(
    items: CaBorHoldingItem[],
    options: {
        resolveUnderlying?: (ticker: string) => Promise<IssuerAllocationResult | null>;
        maxTopHoldings?: number;
    } = {}
): Promise<{
    countryAllocations: AllocationWeightEntry[];
    sectorAllocations: AllocationWeightEntry[];
    topHoldings: UnderlyingHoldingEntry[];
    asOfDate?: string;
    holdingsCount: number;
}> {
    let totalMv = 0;
    let totalPct = 0;

    const isDerivative = (secType: string, desc: string): boolean =>
        secType.startsWith('CT.') ||
        secType.startsWith('DE.') ||
        /\b(fx forward|currency forward|forward contract)\b/i.test(desc);

    for (const item of items) {
        const secType = typeof item.securityType === 'string' ? item.securityType.trim().toUpperCase() : '';
        const desc = typeof item.securityLongDescription === 'string' ? item.securityLongDescription : '';
        if (isDerivative(secType, desc)) continue;

        const mv = parseNumericPercent(item.marketValueBaseCurrency);
        const pct = parseNumericPercent(item.marketValuePercentage);
        if (mv !== undefined && mv > 0) totalMv += mv;
        if (pct !== undefined && pct > 0) totalPct += pct;
    }

    const useMarketValue = totalMv > 0;
    if (!useMarketValue && totalPct <= 0) {
        return { countryAllocations: [], sectorAllocations: [], topHoldings: [], holdingsCount: 0 };
    }

    const countryTotals = new Map<string, number>();
    const sectorTotals = new Map<string, number>();
    const rawEquityHoldings: UnderlyingHoldingEntry[] = [];
    const rawBondHoldings: UnderlyingHoldingEntry[] = [];
    let totalPositivePortfolioWeight = 0;
    let countryAllocatedSum = 0;
    let sectorAllocatedSum = 0;
    let fixedIncomeWeight = 0;
    let asOfDate: string | undefined;

    for (const item of items) {
        const secType = typeof item.securityType === 'string' ? item.securityType.trim().toUpperCase() : '';
        const desc = typeof item.securityLongDescription === 'string' ? item.securityLongDescription : '';
        if (isDerivative(secType, desc)) continue;

        const rawWeight = useMarketValue
            ? parseNumericPercent(item.marketValueBaseCurrency)
            : parseNumericPercent(item.marketValuePercentage);
        if (rawWeight === undefined || rawWeight <= 0) continue;

        totalPositivePortfolioWeight += rawWeight;
        if (!asOfDate && typeof item.effectiveDate === 'string' && item.effectiveDate.trim()) {
            asOfDate = item.effectiveDate.trim();
        }

        const isCash =
            secType.startsWith('MM.') ||
            secType === 'CRNY' ||
            /\b(cash|money market)\b/i.test(desc);
        if (isCash) continue;

        const isBond = secType.startsWith('FI.');
        if (isBond) {
            fixedIncomeWeight += rawWeight;
        }

        const isUnderlyingFund =
            secType === 'EQ.ETF' || secType.startsWith('MF.');
        if (isUnderlyingFund && typeof item.ticker === 'string' && options.resolveUnderlying) {
            const subResult = await options.resolveUnderlying(item.ticker);
            if (subResult && subResult.countryAllocations.length > 0) {
                for (const entry of subResult.countryAllocations) {
                    for (const [country, w] of Object.entries(entry)) {
                        const weighted = rawWeight * w;
                        countryTotals.set(country, (countryTotals.get(country) ?? 0) + weighted);
                        countryAllocatedSum += weighted;
                    }
                }
                for (const entry of subResult.sectorAllocations ?? []) {
                    for (const [sector, w] of Object.entries(entry)) {
                        const weighted = rawWeight * w;
                        sectorTotals.set(sector, (sectorTotals.get(sector) ?? 0) + weighted);
                        sectorAllocatedSum += weighted;
                    }
                }
                for (const h of subResult.topHoldings ?? []) {
                    const weightedHolding: UnderlyingHoldingEntry = {
                        ...h,
                        weight: rawWeight * h.weight,
                        source: h.source ?? 'vanguard',
                    };
                    if (h.assetClass === 'BOND') {
                        rawBondHoldings.push(weightedHolding);
                    } else {
                        rawEquityHoldings.push(weightedHolding);
                    }
                }
                continue;
            }
        }

        const country =
            resolveIso2CountryName(typeof item.bloombergIsoCountry === 'string' ? item.bloombergIsoCountry : null) ??
            resolveIso2CountryName(typeof item.isin === 'string' ? item.isin.slice(0, 2) : null);
        if (country) {
            countryTotals.set(country, (countryTotals.get(country) ?? 0) + rawWeight);
            countryAllocatedSum += rawWeight;
        }

        const rawSector = typeof item.gicsSectorDescription === 'string' ? item.gicsSectorDescription.trim() : '';
        let normalizedSector: string | undefined;
        if (rawSector && !IGNORED_BUCKET_LABELS.has(rawSector.toLowerCase())) {
            const sector = normalizeSectorName(rawSector);
            if (sector !== 'Other / Unclassified') {
                sectorTotals.set(sector, (sectorTotals.get(sector) ?? 0) + rawWeight);
                sectorAllocatedSum += rawWeight;
                normalizedSector = sector;
            }
        }

        const issuerName = typeof item.issuerName === 'string' ? item.issuerName.trim() : '';
        const ticker = typeof item.ticker === 'string' ? item.ticker.trim() : '';
        const trimmedDesc = desc.trim();
        const hasClassHint = /\b(?:cl|class|ser|series)\s+[a-z0-9]/i.test(trimmedDesc);
        const displayName = isBond || hasClassHint
            ? trimmedDesc || issuerName || ticker
            : issuerName || trimmedDesc || ticker;
        const isin = typeof item.isin === 'string' ? item.isin.trim().toUpperCase() : undefined;

        if (!isUnderlyingFund && displayName) {
            const holdingEntry: UnderlyingHoldingEntry = {
                name: displayName,
                ticker: ticker || undefined,
                isin: isin || undefined,
                sector: !isBond ? normalizedSector : undefined,
                country: country ?? undefined,
                assetClass: isBond ? 'BOND' : 'EQUITY',
                weight: rawWeight,
                source: 'vanguard',
            };
            if (isBond) {
                rawBondHoldings.push(holdingEntry);
            } else {
                rawEquityHoldings.push(holdingEntry);
            }
        }
    }

    const countryDenominator =
        countryAllocatedSum > 0 && totalPositivePortfolioWeight > 0
            ? countryAllocatedSum / totalPositivePortfolioWeight >= 0.98
                ? countryAllocatedSum
                : totalPositivePortfolioWeight
            : countryAllocatedSum;

    const countryAllocations: AllocationWeightEntry[] =
        countryDenominator > 0
            ? Array.from(countryTotals.entries())
                  .map(([country, val]) => ({ country, weight: roundWeight(val / countryDenominator) }))
                  .filter((e) => e.weight >= 1e-6)
                  .sort((a, b) => b.weight - a.weight)
                  .map((e) => ({ [e.country]: e.weight }))
            : [];

    const isPredominantlyFixedIncome =
        totalPositivePortfolioWeight > 0 && fixedIncomeWeight / totalPositivePortfolioWeight > 0.5;

    const sectorDenominator =
        sectorAllocatedSum > 0 && totalPositivePortfolioWeight > 0
            ? sectorAllocatedSum / totalPositivePortfolioWeight >= 0.98
                ? sectorAllocatedSum
                : totalPositivePortfolioWeight
            : sectorAllocatedSum;

    const sectorAllocations: AllocationWeightEntry[] =
        !isPredominantlyFixedIncome && sectorDenominator > 0
            ? Array.from(sectorTotals.entries())
                  .map(([sector, val]) => ({ sector, weight: roundWeight(val / sectorDenominator) }))
                  .filter((e) => e.weight >= 1e-6)
                  .sort((a, b) => b.weight - a.weight)
                  .map((e) => ({ [e.sector]: e.weight }))
            : [];

    const selectedRawHoldings = isPredominantlyFixedIncome ? rawBondHoldings : rawEquityHoldings;
    const capLimit = options.maxTopHoldings ?? MAX_UNDERLYING_HOLDINGS;
    const topHoldings =
        totalPositivePortfolioWeight > 0
            ? mergeAndCapHoldings(
                  selectedRawHoldings.map((h) => ({
                      ...h,
                      weight: h.weight / totalPositivePortfolioWeight,
                  })),
                  capLimit
              )
            : [];

    return {
        countryAllocations,
        sectorAllocations,
        topHoldings,
        asOfDate,
        holdingsCount: items.length,
    };
}

interface UsAdditionalHoldingItem {
    securityType?: unknown;
    securityMainType?: unknown;
    securityLongDescription?: unknown;
    issuerName?: unknown;
    gicsSectorDescription?: unknown;
    sector?: unknown;
    bloombergIsoCountry?: unknown;
    marketValuePercentage?: unknown;
    isin?: unknown;
    ticker?: unknown;
}

export function aggregateVanguardUsAdditionalFundData(payload: unknown): {
    countryAllocations: AllocationWeightEntry[];
    topHoldings: UnderlyingHoldingEntry[];
    holdingsCount: number;
    asOfDate?: string;
} {
    if (!payload || typeof payload !== 'object') {
        return { countryAllocations: [], topHoldings: [], holdingsCount: 0 };
    }

    const details = (payload as {
        holdingDetails?: {
            asOfDate?: unknown;
            equityHoldings?: unknown;
            fixedIncomeHoldings?: unknown;
            shortTermReservesHoldings?: unknown;
        };
    }).holdingDetails;

    if (!details || typeof details !== 'object') {
        return { countryAllocations: [], topHoldings: [], holdingsCount: 0 };
    }

    const asOfDate =
        typeof details.asOfDate === 'string' && details.asOfDate.trim()
            ? details.asOfDate.trim()
            : undefined;

    const equityList = Array.isArray(details.equityHoldings)
        ? (details.equityHoldings as UsAdditionalHoldingItem[])
        : [];
    const fiList = Array.isArray(details.fixedIncomeHoldings)
        ? (details.fixedIncomeHoldings as UsAdditionalHoldingItem[])
        : [];
    const cashList = Array.isArray(details.shortTermReservesHoldings)
        ? (details.shortTermReservesHoldings as UsAdditionalHoldingItem[])
        : [];

    const countryTotals = new Map<string, number>();
    const rawEquityHoldings: UnderlyingHoldingEntry[] = [];
    const rawBondHoldings: UnderlyingHoldingEntry[] = [];
    let totalPositivePortfolioWeight = 0;
    let countryAllocatedSum = 0;
    let fixedIncomeWeight = 0;
    let holdingsCount = 0;

    for (const item of [...equityList, ...fiList]) {
        if (!item || typeof item !== 'object') continue;
        const secType = typeof item.securityType === 'string' ? item.securityType.trim().toUpperCase() : '';
        if (secType.startsWith('CT.') || secType.startsWith('DE.')) continue;

        const pct = parseNumericPercent(item.marketValuePercentage);
        if (pct === undefined || pct <= 0) continue;

        holdingsCount++;
        totalPositivePortfolioWeight += pct;

        if (secType.startsWith('MM.') || secType === 'CRNY') continue;

        const isBond = secType.startsWith('FI.');
        if (isBond) {
            fixedIncomeWeight += pct;
        }

        const isinPrefix = typeof item.isin === 'string' ? item.isin.trim().slice(0, 2) : null;
        const country =
            resolveIso2CountryName(typeof item.bloombergIsoCountry === 'string' ? item.bloombergIsoCountry : null) ??
            resolveIso2CountryName(isinPrefix);
        if (country) {
            countryTotals.set(country, (countryTotals.get(country) ?? 0) + pct);
            countryAllocatedSum += pct;
        }

        const issuerName = typeof item.issuerName === 'string' ? item.issuerName.trim() : '';
        const desc =
            typeof item.securityLongDescription === 'string' ? item.securityLongDescription.trim() : '';
        const ticker = typeof item.ticker === 'string' ? item.ticker.trim() : '';
        const hasClassHint = /\b(?:cl|class|ser|series)\s+[a-z0-9]/i.test(desc);
        const displayName = isBond || hasClassHint ? desc || issuerName || ticker : issuerName || desc || ticker;

        if (displayName) {
            const rawSector =
                typeof item.gicsSectorDescription === 'string'
                    ? item.gicsSectorDescription.trim()
                    : typeof item.sector === 'string'
                      ? item.sector.trim()
                      : '';
            const normalizedSector =
                !isBond && rawSector && !IGNORED_BUCKET_LABELS.has(rawSector.toLowerCase())
                    ? normalizeSectorName(rawSector)
                    : undefined;
            const entry: UnderlyingHoldingEntry = {
                name: displayName,
                ticker: ticker || undefined,
                isin: typeof item.isin === 'string' ? item.isin.trim().toUpperCase() || undefined : undefined,
                country: country ?? undefined,
                sector: normalizedSector && normalizedSector !== 'Other / Unclassified' ? normalizedSector : undefined,
                assetClass: isBond ? 'BOND' : 'EQUITY',
                weight: pct,
                source: 'vanguard',
            };
            if (isBond) {
                rawBondHoldings.push(entry);
            } else {
                rawEquityHoldings.push(entry);
            }
        }
    }

    for (const reserve of cashList) {
        if (!reserve || typeof reserve !== 'object') continue;
        const secType = typeof reserve.securityType === 'string' ? reserve.securityType.trim().toUpperCase() : '';
        if (secType.startsWith('CT.') || secType.startsWith('DE.')) continue;
        const pct = parseNumericPercent(reserve.marketValuePercentage);
        if (pct === undefined || pct <= 0) continue;
        holdingsCount++;
        totalPositivePortfolioWeight += pct;
    }

    const denominator =
        countryAllocatedSum > 0 && totalPositivePortfolioWeight > 0
            ? countryAllocatedSum / totalPositivePortfolioWeight >= 0.98
                ? countryAllocatedSum
                : totalPositivePortfolioWeight
            : countryAllocatedSum;

    const countryAllocations: AllocationWeightEntry[] =
        denominator > 0
            ? Array.from(countryTotals.entries())
                  .map(([country, val]) => ({ country, weight: roundWeight(val / denominator) }))
                  .filter((e) => e.weight >= 1e-6)
                  .sort((a, b) => b.weight - a.weight)
                  .map((e) => ({ [e.country]: e.weight }))
            : [];

    const isPredominantlyFixedIncome =
        totalPositivePortfolioWeight > 0 && fixedIncomeWeight / totalPositivePortfolioWeight > 0.5;
    const holdingDenominator =
        totalPositivePortfolioWeight >= 98 ? totalPositivePortfolioWeight : 100;
    const selectedRawHoldings = isPredominantlyFixedIncome ? rawBondHoldings : rawEquityHoldings;
    const topHoldings = mergeAndCapHoldings(
        selectedRawHoldings.map((h) => ({ ...h, weight: h.weight / holdingDenominator })),
        MAX_UNDERLYING_HOLDINGS
    );

    return { countryAllocations, topHoldings, holdingsCount, asOfDate };
}

export function aggregateVanguardUsVmfHoldings(
    entities: Array<{
        isin?: unknown;
        ticker?: unknown;
        symbol?: unknown;
        issuerName?: unknown;
        longName?: unknown;
        shortName?: unknown;
        name?: unknown;
        securityLongDescription?: unknown;
        sectorName?: unknown;
        gicsSectorDescription?: unknown;
        countryName?: unknown;
        countryCode?: unknown;
        marketValue?: unknown;
        percentWeight?: unknown;
    }>
): {
    countryAllocations: AllocationWeightEntry[];
    topHoldings: UnderlyingHoldingEntry[];
    holdingsCount: number;
} {
    let totalMv = 0;
    let totalPct = 0;
    for (const item of entities) {
        if (!item || typeof item !== 'object') continue;
        const mv = parseNumericPercent(item.marketValue);
        const pct = parseNumericPercent(item.percentWeight);
        if (mv !== undefined && mv > 0) totalMv += mv;
        if (pct !== undefined && pct > 0) totalPct += pct;
    }

    const useMv = totalMv > 0;
    if (!useMv && totalPct <= 0) {
        return { countryAllocations: [], topHoldings: [], holdingsCount: 0 };
    }

    const countryTotals = new Map<string, number>();
    const rawHoldings: UnderlyingHoldingEntry[] = [];
    let totalPositivePortfolioWeight = 0;
    let countryAllocatedSum = 0;
    let holdingsCount = 0;

    for (const item of entities) {
        if (!item || typeof item !== 'object') continue;
        const rawWeight = useMv
            ? parseNumericPercent(item.marketValue)
            : parseNumericPercent(item.percentWeight);
        if (rawWeight === undefined || rawWeight <= 0) continue;

        holdingsCount++;
        totalPositivePortfolioWeight += rawWeight;

        const isinPrefix = typeof item.isin === 'string' ? item.isin.trim().slice(0, 2) : null;
        const country =
            resolveCountryFromMarketEntry(item.countryCode, item.countryName) ??
            resolveIso2CountryName(isinPrefix);
        if (country) {
            countryTotals.set(country, (countryTotals.get(country) ?? 0) + rawWeight);
            countryAllocatedSum += rawWeight;
        }

        const rawTicker =
            typeof item.ticker === 'string'
                ? item.ticker.trim()
                : typeof item.symbol === 'string'
                  ? item.symbol.trim()
                  : '';
        const rawName = [
            item.longName,
            item.shortName,
            item.issuerName,
            item.name,
            item.securityLongDescription,
        ]
            .find((v) => typeof v === 'string' && v.trim()) as string | undefined;
        const displayName = rawName?.trim() || rawTicker;
        if (displayName) {
            const rawSector =
                typeof item.sectorName === 'string'
                    ? item.sectorName.trim()
                    : typeof item.gicsSectorDescription === 'string'
                      ? item.gicsSectorDescription.trim()
                      : '';
            const normalizedSector =
                rawSector && !IGNORED_BUCKET_LABELS.has(rawSector.toLowerCase())
                    ? normalizeSectorName(rawSector)
                    : undefined;
            rawHoldings.push({
                name: displayName,
                ticker: rawTicker || undefined,
                isin: typeof item.isin === 'string' ? item.isin.trim().toUpperCase() || undefined : undefined,
                country: country ?? undefined,
                sector:
                    normalizedSector && normalizedSector !== 'Other / Unclassified'
                        ? normalizedSector
                        : undefined,
                assetClass: 'EQUITY',
                weight: rawWeight,
                source: 'vanguard',
            });
        }
    }

    const denominator =
        countryAllocatedSum > 0 && totalPositivePortfolioWeight > 0
            ? countryAllocatedSum / totalPositivePortfolioWeight >= 0.98
                ? countryAllocatedSum
                : totalPositivePortfolioWeight
            : countryAllocatedSum;

    const countryAllocations: AllocationWeightEntry[] =
        denominator > 0
            ? Array.from(countryTotals.entries())
                  .map(([country, val]) => ({ country, weight: roundWeight(val / denominator) }))
                  .filter((e) => e.weight >= 1e-6)
                  .sort((a, b) => b.weight - a.weight)
                  .map((e) => ({ [e.country]: e.weight }))
            : [];

    const topHoldings =
        totalPositivePortfolioWeight > 0
            ? mergeAndCapHoldings(
                  rawHoldings.map((h) => ({ ...h, weight: h.weight / totalPositivePortfolioWeight })),
                  MAX_UNDERLYING_HOLDINGS
              )
            : [];

    return { countryAllocations, topHoldings, holdingsCount };
}

async function fetchVanguardCaAllocations(
    ctx: IssuerLookupContext,
    requester: RequesterFn,
    searchTerms: string[]
): Promise<IssuerAllocationResult | null> {
    let portId: string | undefined;
    for (const term of searchTerms) {
        if (KNOWN_VANGUARD_CA_PORT_IDS[term]) {
            portId = KNOWN_VANGUARD_CA_PORT_IDS[term];
            break;
        }
    }

    let catalogue: Map<string, string> | undefined;
    if (!portId) {
        catalogue = await discoverVanguardCaCatalogue(ctx, requester);
        for (const term of searchTerms) {
            const found = catalogue.get(term);
            if (found) {
                portId = found;
                break;
            }
        }
    }

    if (!portId) {
        warnDiagnostic(
            ctx,
            `[IssuerAdapter:vanguard] Could not resolve Vanguard Canada portId for ${ctx.symbol}`
        );
        return null;
    }

    const fundData = await fetchCaFundGraphQl(requester, portId);
    const parsedSummary = fundData ? parseVanguardCaFundAggregations(fundData) : null;
    const hasSummaryCountries = Boolean(parsedSummary && parsedSummary.countryAllocations.length > 0);

    // Fetch BOR holdings both as country fallback AND to extract individual stock Top 250 holdings.
    // Fail soft when FundAllocations already succeeded so country/sector sync never breaks.
    const borItems = await fetchCaBorHoldings(requester, portId).catch(() => []);

    if (hasSummaryCountries && parsedSummary && borItems.length === 0) {
        return {
            providerId: 'vanguard',
            productId: portId,
            countryAllocations: parsedSummary.countryAllocations,
            sectorAllocations:
                parsedSummary.sectorAllocations.length > 0
                    ? parsedSummary.sectorAllocations
                    : undefined,
            holdingsCount: parsedSummary.countryAllocations.length,
            asOfDate: parsedSummary.asOfDate,
        };
    }

    if (borItems.length === 0) {
        warnDiagnostic(
            ctx,
            `[IssuerAdapter:vanguard] No marketAllocation or borHoldings returned for ${ctx.symbol} (portId=${portId})`
        );
        return null;
    }

    const subCache = new Map<string, Promise<IssuerAllocationResult | null>>();
    const borAggregated = await aggregateCaBorHoldings(borItems, {
        resolveUnderlying: async (subTicker: string) => {
            if (!catalogue) {
                catalogue = await discoverVanguardCaCatalogue(ctx, requester).catch(() => new Map());
            }
            const subPortId = resolveVanguardCaTickerToPortId(subTicker, catalogue);
            if (!subPortId || subPortId === portId) return null;

            const existing = subCache.get(subPortId);
            if (existing) return existing;

            const promise = (async (): Promise<IssuerAllocationResult | null> => {
                const subFund = await fetchCaFundGraphQl(requester, subPortId).catch(() => null);
                const parsedSub = subFund ? parseVanguardCaFundAggregations(subFund) : null;
                if (!parsedSub || parsedSub.countryAllocations.length === 0) return null;

                let subTopHoldings: UnderlyingHoldingEntry[] = [];
                // For equity sub-ETFs inside an equity/balanced FOF (e.g. VGRO -> VUN/VCN/VIU/VEE),
                // fetch their BOR holdings one hop deeper so FOFs expose stock-level look-through.
                if (!parsedSub.isFixedIncome || parsedSummary?.isFixedIncome) {
                    const subBor = await fetchCaBorHoldings(requester, subPortId).catch(() => []);
                    if (subBor.length > 0) {
                        const subAgg = await aggregateCaBorHoldings(subBor, { maxTopHoldings: 500 });
                        subTopHoldings = subAgg.topHoldings;
                    }
                }

                return {
                    providerId: 'vanguard',
                    productId: subPortId,
                    countryAllocations: parsedSub.countryAllocations,
                    sectorAllocations:
                        parsedSub.sectorAllocations.length > 0
                            ? parsedSub.sectorAllocations
                            : undefined,
                    topHoldings: subTopHoldings.length > 0 ? subTopHoldings : undefined,
                    holdingsCount: parsedSub.countryAllocations.length,
                };
            })();
            subCache.set(subPortId, promise);
            return promise;
        },
    });

    if (hasSummaryCountries && parsedSummary) {
        return {
            providerId: 'vanguard',
            productId: portId,
            countryAllocations: parsedSummary.countryAllocations,
            sectorAllocations:
                parsedSummary.sectorAllocations.length > 0
                    ? parsedSummary.sectorAllocations
                    : undefined,
            topHoldings:
                borAggregated.topHoldings.length > 0 ? borAggregated.topHoldings : undefined,
            holdingsCount:
                borAggregated.holdingsCount > 0
                    ? borAggregated.holdingsCount
                    : parsedSummary.countryAllocations.length,
            asOfDate: parsedSummary.asOfDate ?? borAggregated.asOfDate,
        };
    }

    if (borAggregated.countryAllocations.length === 0) {
        return null;
    }

    return {
        providerId: 'vanguard',
        productId: portId,
        countryAllocations: borAggregated.countryAllocations,
        sectorAllocations:
            borAggregated.sectorAllocations.length > 0
                ? borAggregated.sectorAllocations
                : undefined,
        topHoldings:
            borAggregated.topHoldings.length > 0 ? borAggregated.topHoldings : undefined,
        holdingsCount: borAggregated.holdingsCount,
        asOfDate: borAggregated.asOfDate,
    };
}

async function fetchVanguardUsAllocations(
    ctx: IssuerLookupContext,
    requester: RequesterFn,
    ticker: string
): Promise<IssuerAllocationResult | null> {
    const additionalUrl = `https://investor.vanguard.com/irr/funds/profile/${encodeURIComponent(ticker)}-AdditionalFundData`;
    const addRes = await requester(additionalUrl, { headers: VANGUARD_US_HEADERS });

    if (addRes.ok) {
        const text = await addRes.text();
        if (text && !text.trimStart().startsWith('<')) {
            const payload = JSON.parse(text) as unknown;
            const aggregated = aggregateVanguardUsAdditionalFundData(payload);
            if (aggregated.countryAllocations.length > 0) {
                return {
                    providerId: 'vanguard',
                    productId: ticker,
                    countryAllocations: aggregated.countryAllocations,
                    topHoldings:
                        aggregated.topHoldings.length > 0 ? aggregated.topHoldings : undefined,
                    holdingsCount: aggregated.holdingsCount,
                    asOfDate: aggregated.asOfDate,
                };
            }
        }
    } else {
        await addRes.body?.cancel().catch(() => {});
    }

    // Fallback to VMF stock holdings endpoint
    const allEntities: Array<{ isin?: unknown; marketValue?: unknown; percentWeight?: unknown }> = [];
    let asOfDate: string | undefined;
    let start = 1;
    const count = 5000;

    for (let page = 0; page < 4; page++) {
        const vmfUrl = `https://investor.vanguard.com/vmf/api/${encodeURIComponent(ticker)}/portfolio-holding/stock?start=${start}&count=${count}`;
        const vmfRes = await requester(vmfUrl, { headers: VANGUARD_US_HEADERS });
        if (!vmfRes.ok) {
            await vmfRes.body?.cancel().catch(() => {});
            break;
        }
        const json = (await vmfRes.json().catch(() => null)) as {
            asOfDate?: unknown;
            size?: unknown;
            fund?: {
                entity?: Array<{ isin?: unknown; marketValue?: unknown; percentWeight?: unknown }>;
            };
        } | null;

        if (!asOfDate && typeof json?.asOfDate === 'string' && json.asOfDate.trim()) {
            asOfDate = json.asOfDate.trim();
        }
        const entities = Array.isArray(json?.fund?.entity) ? json.fund.entity : [];
        if (entities.length === 0) break;

        allEntities.push(...entities);
        const totalSize = typeof json?.size === 'number' ? json.size : allEntities.length;
        if (allEntities.length >= totalSize || entities.length < count) {
            break;
        }
        start += entities.length;
    }

    if (allEntities.length === 0) {
        warnDiagnostic(
            ctx,
            `[IssuerAdapter:vanguard] No US holdings resolved for ${ctx.symbol} via AdditionalFundData or VMF API`
        );
        return null;
    }

    const vmfAggregated = aggregateVanguardUsVmfHoldings(allEntities);
    if (vmfAggregated.countryAllocations.length === 0) {
        return null;
    }

    return {
        providerId: 'vanguard',
        productId: ticker,
        countryAllocations: vmfAggregated.countryAllocations,
        topHoldings:
            vmfAggregated.topHoldings.length > 0 ? vmfAggregated.topHoldings : undefined,
        holdingsCount: vmfAggregated.holdingsCount,
        asOfDate,
    };
}

export const vanguardAdapter: EtfIssuerAdapter = {
    id: 'vanguard',

    canHandle(ctx: IssuerLookupContext): boolean {
        const regionInfo = resolveVanguardRegionAndTicker(ctx.symbol);
        if (!regionInfo) return false;

        if (ctx.quoteType) {
            const upperType = ctx.quoteType.toUpperCase();
            if (upperType !== 'ETF' && upperType !== 'MUTUALFUND') {
                return false;
            }
        }

        const name = ctx.fundName?.trim();
        if (name) {
            return (
                /\bvanguard\b/i.test(name) &&
                /\b(etf|fund|trust|index|portfolio|equity|bond|income|balanced|growth|conservative)\b/i.test(
                    name
                )
            );
        }

        return regionInfo.searchTerms.some(
            (term) => Boolean(KNOWN_VANGUARD_CA_PORT_IDS[term]) || /^V[A-Z0-9.-]*$/.test(term)
        );
    },

    async fetchAllocations(ctx: IssuerLookupContext): Promise<IssuerAllocationResult | null> {
        const regionInfo = resolveVanguardRegionAndTicker(ctx.symbol);
        if (!regionInfo) return null;

        const requester = createIssuerRequester(this.id, ctx, 10_000);
        if (!requester) return null;

        if (regionInfo.region === 'ca') {
            return fetchVanguardCaAllocations(ctx, requester, regionInfo.searchTerms);
        }

        return fetchVanguardUsAllocations(ctx, requester, regionInfo.searchTerms[0]);
    },
};
