import {
    normalizeSectorName,
    resolveIso2CountryName,
} from '../look-through.ts';
import {
    createIssuerRequester,
    emitIssuerDiagnostic,
    type IssuerRequestOptions,
} from './http.ts';
import { mergeAndCapHoldings } from './holdings.ts';
import { parseXlsxFirstSheet } from './xlsx.ts';
import {
    MAX_UNDERLYING_HOLDINGS,
    type AllocationWeightEntry,
    type EtfIssuerAdapter,
    type IssuerAllocationResult,
    type IssuerLookupContext,
    type UnderlyingHoldingEntry,
} from './types.ts';

type RequesterFn = (url: string, opts?: IssuerRequestOptions) => Promise<Response>;

const BMO_HOLDINGS_BASE_URL =
    'https://df.bmogam.com/assets/static/reports/etf-funds-holdings';
const MAX_LOOKBACK_DAYS = 14;
const MAX_FOF_DEPTH = 2;

const DEFAULT_HEADERS: Record<string, string> = {
    Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/octet-stream, */*',
    'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
    Referer: 'https://www.bmogam.com/',
    'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Known BMO Canada ETF ISIN -> base ticker for recursive fund-of-funds look-through (e.g. ZBAL, ZGRO, ZEQT)
export const BMO_ETF_ISIN_TO_TICKER: Record<string, string> = {
    CA05574G1090: 'ZCN',
    CA05575T1003: 'ZSP',
    CA05576Y1088: 'ZEM',
    CA05579E1097: 'ZEA',
    CA05579H1029: 'ZUE',
    CA05579W1005: 'ZQQ',
    CA05580A1030: 'ZFL',
    CA05581J1093: 'ZUS',
    CA05581T1084: 'ZMU',
    CA05581X1097: 'ZNQ',
    CA05581Y1079: 'ZHY',
    CA05582Y1025: 'ZCB',
    CA05583M1086: 'ZAG',
    CA05589W2067: 'ZSML',
    CA05589X1050: 'ZMID',
    CA05590X1024: 'ZDB',
    CA05591A1012: 'ZMP',
    CA05591B1094: 'ZGB',
    CA05592K1030: 'ZCS',
    CA05592L1013: 'ZFS',
    CA05592M1095: 'ZCM',
    CA05592N1078: 'ZPS',
    CA05592P1027: 'ZFM',
    CA05592U1140: 'ZUAG',
    CA05593P1071: 'ZST',
};

const BMO_FUND_NAME_TO_TICKER: Array<[string, string]> = [
    ['bmo s&p/tsx capped composite', 'ZCN'],
    ['bmo s&p 500 hedged to cad', 'ZUE'],
    ['bmo s&p 500 index etf', 'ZSP'],
    ['bmo s&p us mid cap index etf', 'ZMID'],
    ['bmo s&p us small cap index etf', 'ZSML'],
    ['bmo msci eafe index etf', 'ZEA'],
    ['bmo msci emerging markets index etf', 'ZEM'],
    ['bmo nasdaq 100 equity hedged', 'ZQQ'],
    ['bmo nasdaq 100 equity index etf', 'ZNQ'],
    ['bmo aggregate bond index etf', 'ZAG'],
    ['bmo discount bond index etf', 'ZDB'],
    ['bmo us aggregate bond index etf', 'ZUAG'],
    ['bmo government bond index etf', 'ZGB'],
    ['bmo long federal bond index etf', 'ZFL'],
    ['bmo mid federal bond index etf', 'ZFM'],
    ['bmo short federal bond index etf', 'ZFS'],
    ['bmo corporate bond index etf', 'ZCB'],
    ['bmo mid corporate bond index etf', 'ZCM'],
    ['bmo short corporate bond index etf', 'ZCS'],
    ['bmo mid provincial bond index etf', 'ZMP'],
    ['bmo short provincial bond index etf', 'ZPS'],
    ['bmo high yield us corporate bond', 'ZHY'],
    ['bmo mid-term us ig corporate bond', 'ZMU'],
    ['bmo ultra short-term bond etf', 'ZST'],
    ['bmo ultra short-term us bond etf', 'ZUS'],
    ['bmo low volatility canadian equity', 'ZLB'],
    ['bmo low volatility us equity', 'ZLU'],
    ['bmo low volatility international equity', 'ZLI'],
];

const IGNORED_SECTORS = new Set([
    '-',
    '--',
    'n/a',
    'na',
    'none',
    'null',
    'other',
    'unknown',
    'unassigned',
    'unspecified',
    'not available',
    'cash',
    'cash and/or derivatives',
]);

export interface ParsedBmoHoldingRow {
    name: string;
    isin?: string;
    assetClass?: string;
    sector?: string;
    currency?: string;
    weightPercent?: number;
    marketValue?: number;
}

interface InternalResolvedBmo {
    countryAllocations: AllocationWeightEntry[];
    sectorAllocations: AllocationWeightEntry[];
    topHoldings: UnderlyingHoldingEntry[];
    isPredominantlyFixedIncome: boolean;
    holdingsCount: number;
    asOfDate?: string;
    ticker: string;
}

function warnDiagnostic(ctx: IssuerLookupContext, msg: string): void {
    emitIssuerDiagnostic(ctx, msg);
}

function roundWeight(weight: number): number {
    return Math.round(weight * 1_000_000) / 1_000_000;
}

function parseNumericCell(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const cleaned = raw.replace(/[$,%\s]/g, '').replace(/,/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '--') return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveBmoTickerCandidates(symbol: string): string[] | null {
    const trimmed = symbol.trim().toUpperCase();
    if (!trimmed || trimmed.endsWith('=X') || trimmed.startsWith('^')) {
        return null;
    }

    if (!/\.(TO|NE|V|CN)$/.test(trimmed)) {
        return null;
    }

    const base = trimmed.replace(/\.(TO|NE|V|CN)$/, '');
    const candidates = [base];
    // Handle share class / USD suffixes like ZUAG-F.TO -> ZUAG-F, ZUAG.F, ZUAG
    const suffixMatch = base.match(/^(.+?)([.-](F|U|H))$/);
    if (suffixMatch) {
        const prefix = suffixMatch[1];
        const letter = suffixMatch[3];
        candidates.push(`${prefix}.${letter}`, `${prefix}-${letter}`, prefix);
    }

    return Array.from(new Set(candidates));
}

function findHeaderIndex(headersLower: string[], candidates: string[]): number {
    for (const candidate of candidates) {
        const idx = headersLower.indexOf(candidate);
        if (idx !== -1) return idx;
    }
    return -1;
}

export function parseBmoHoldingsSheet(rows: string[][]): {
    holdings: ParsedBmoHoldingRow[];
    asOfDate?: string;
} {
    let headerIdx = -1;
    let asOfDate: string | undefined;

    const searchLimit = Math.min(rows.length, 25);
    for (let i = 0; i < searchLimit; i++) {
        const lower = rows[i].map((c) => c.trim().toLowerCase());
        const hasName =
            lower.includes('name') ||
            lower.includes('security name') ||
            lower.includes('holding name');
        const hasWeight =
            lower.includes('weight (%)') ||
            lower.includes('weight') ||
            lower.includes('base market value') ||
            lower.includes('market value');

        if (hasName && hasWeight) {
            headerIdx = i;
            break;
        }

        const joined = rows[i].filter(Boolean).join(' ');
        const dateMatch = joined.match(/(\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i);
        if (dateMatch && !asOfDate) {
            asOfDate = dateMatch[1];
        }
    }

    if (headerIdx < 0) {
        return { holdings: [], asOfDate };
    }

    const headersLower = rows[headerIdx].map((h) => h.trim().toLowerCase());
    const colIdx = {
        name: findHeaderIndex(headersLower, ['name', 'security name', 'holding name']),
        isin: findHeaderIndex(headersLower, ['isin']),
        assetClass: findHeaderIndex(headersLower, ['asset class', 'security type']),
        sector: findHeaderIndex(headersLower, ['sector', 'gics sector']),
        currency: findHeaderIndex(headersLower, ['currency']),
        weightPercent: findHeaderIndex(headersLower, ['weight (%)', 'weight']),
        marketValue: findHeaderIndex(headersLower, [
            'base market value',
            'market value',
            'market value (cad)',
            'market value (usd)',
        ]),
    };

    const holdings: ParsedBmoHoldingRow[] = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
        const cells = rows[r];
        if (!cells || cells.every((c) => !c)) {
            if (holdings.length > 0) break;
            continue;
        }

        const name = (colIdx.name >= 0 ? cells[colIdx.name] : cells[0])?.trim() || '';
        if (!name) continue;
        if (/^(total|holdings total|grand total)\b/i.test(name)) {
            break;
        }

        holdings.push({
            name,
            isin: colIdx.isin >= 0 ? cells[colIdx.isin]?.trim() || undefined : undefined,
            assetClass:
                colIdx.assetClass >= 0 ? cells[colIdx.assetClass]?.trim() || undefined : undefined,
            sector: colIdx.sector >= 0 ? cells[colIdx.sector]?.trim() || undefined : undefined,
            currency: colIdx.currency >= 0 ? cells[colIdx.currency]?.trim() || undefined : undefined,
            weightPercent:
                colIdx.weightPercent >= 0
                    ? parseNumericCell(cells[colIdx.weightPercent])
                    : undefined,
            marketValue:
                colIdx.marketValue >= 0 ? parseNumericCell(cells[colIdx.marketValue]) : undefined,
        });
    }

    return { holdings, asOfDate };
}

function detectUnderlyingBmoTicker(row: ParsedBmoHoldingRow): string | null {
    const cleanIsin = row.isin?.trim().toUpperCase();
    if (cleanIsin && BMO_ETF_ISIN_TO_TICKER[cleanIsin]) {
        return BMO_ETF_ISIN_TO_TICKER[cleanIsin];
    }

    const nameLower = row.name.trim().toLowerCase();
    // # Reason: Guard name matching to CA or missing ISINs and ETF phrasing so common stock
    // of Bank of Montreal ("BANK OF MONTREAL", CA0636711016) is never mistaken for an ETF.
    if (cleanIsin && !cleanIsin.startsWith('CA')) {
        return null;
    }

    for (const [pattern, ticker] of BMO_FUND_NAME_TO_TICKER) {
        if (nameLower.includes(pattern)) {
            return ticker;
        }
    }

    return null;
}

function isDerivativeRow(assetClassLower: string, nameLower: string): boolean {
    return (
        assetClassLower === 'fx' ||
        assetClassLower.includes('derivative') ||
        assetClassLower.includes('future') ||
        assetClassLower.includes('forward') ||
        /\b(fx forward|currency forward|forward contract)\b/i.test(nameLower)
    );
}

function isCashRow(assetClassLower: string, nameLower: string): boolean {
    return (
        assetClassLower === 'cash' ||
        assetClassLower.includes('cash') ||
        /^cash\b/i.test(nameLower) ||
        /\bcash\s*(collateral|reserve|equivalent)/i.test(nameLower)
    );
}

export async function aggregateBmoHoldings(
    rows: ParsedBmoHoldingRow[],
    options: {
        resolveUnderlying?: (ticker: string) => Promise<InternalResolvedBmo | null>;
        maxTopHoldings?: number;
    } = {}
): Promise<{
    countryAllocations: AllocationWeightEntry[];
    sectorAllocations: AllocationWeightEntry[];
    topHoldings: UnderlyingHoldingEntry[];
    isPredominantlyFixedIncome: boolean;
    holdingsCount: number;
}> {
    let totalMv = 0;
    let totalPct = 0;

    for (const row of rows) {
        const assetClassLower = (row.assetClass || '').trim().toLowerCase();
        const nameLower = row.name.trim().toLowerCase();
        if (isDerivativeRow(assetClassLower, nameLower)) continue;

        if (typeof row.marketValue === 'number' && row.marketValue > 0) {
            totalMv += row.marketValue;
        }
        if (typeof row.weightPercent === 'number' && row.weightPercent > 0) {
            totalPct += row.weightPercent;
        }
    }

    const useMarketValue = totalMv > 0;
    if (!useMarketValue && totalPct <= 0) {
        return {
            countryAllocations: [],
            sectorAllocations: [],
            topHoldings: [],
            isPredominantlyFixedIncome: false,
            holdingsCount: 0,
        };
    }

    const countryTotals = new Map<string, number>();
    const sectorTotals = new Map<string, number>();
    const rawEquityHoldings: UnderlyingHoldingEntry[] = [];
    const rawBondHoldings: UnderlyingHoldingEntry[] = [];
    let totalPositivePortfolioWeight = 0;
    let countryAllocatedSum = 0;
    let sectorAllocatedSum = 0;
    let fixedIncomeWeight = 0;

    for (const row of rows) {
        const assetClassLower = (row.assetClass || '').trim().toLowerCase();
        const nameLower = row.name.trim().toLowerCase();
        if (isDerivativeRow(assetClassLower, nameLower)) continue;

        const rawWeight = useMarketValue ? row.marketValue : row.weightPercent;
        if (typeof rawWeight !== 'number' || !Number.isFinite(rawWeight) || rawWeight <= 0) {
            continue;
        }

        totalPositivePortfolioWeight += rawWeight;

        if (isCashRow(assetClassLower, nameLower)) {
            continue;
        }

        const underlyingTicker = detectUnderlyingBmoTicker(row);
        if (underlyingTicker && options.resolveUnderlying) {
            const sub = await options.resolveUnderlying(underlyingTicker);
            if (sub && sub.countryAllocations.length > 0) {
                if (sub.isPredominantlyFixedIncome) {
                    fixedIncomeWeight += rawWeight;
                }
                for (const entry of sub.countryAllocations) {
                    for (const [country, w] of Object.entries(entry)) {
                        const weighted = rawWeight * w;
                        countryTotals.set(country, (countryTotals.get(country) ?? 0) + weighted);
                        countryAllocatedSum += weighted;
                    }
                }
                for (const entry of sub.sectorAllocations) {
                    for (const [sector, w] of Object.entries(entry)) {
                        const weighted = rawWeight * w;
                        sectorTotals.set(sector, (sectorTotals.get(sector) ?? 0) + weighted);
                        sectorAllocatedSum += weighted;
                    }
                }
                for (const h of sub.topHoldings) {
                    const weightedHolding: UnderlyingHoldingEntry = {
                        ...h,
                        weight: rawWeight * h.weight,
                        source: h.source ?? 'bmo',
                    };
                    if (sub.isPredominantlyFixedIncome || h.assetClass === 'BOND') {
                        rawBondHoldings.push(weightedHolding);
                    } else {
                        rawEquityHoldings.push(weightedHolding);
                    }
                }
                continue;
            }
        }

        const isBond = assetClassLower.includes('fixed income') || assetClassLower === 'bond';
        if (isBond) {
            fixedIncomeWeight += rawWeight;
        }

        const isinPrefix = row.isin?.trim().slice(0, 2);
        const country = resolveIso2CountryName(isinPrefix);
        if (country) {
            countryTotals.set(country, (countryTotals.get(country) ?? 0) + rawWeight);
            countryAllocatedSum += rawWeight;
        }

        const rawSector = (row.sector || '').trim();
        const sectorLower = rawSector.toLowerCase();
        let normalizedSector: string | undefined;
        if (rawSector && !IGNORED_SECTORS.has(sectorLower)) {
            const sector = normalizeSectorName(rawSector);
            if (sector !== 'Other / Unclassified') {
                sectorTotals.set(sector, (sectorTotals.get(sector) ?? 0) + rawWeight);
                sectorAllocatedSum += rawWeight;
                normalizedSector = sector;
            }
        }

        const isCommodity = assetClassLower.includes('commodit');
        if (!isCommodity && row.name.trim()) {
            const holdingEntry: UnderlyingHoldingEntry = {
                name: row.name.trim(),
                isin: row.isin?.trim().toUpperCase() || undefined,
                country: country ?? undefined,
                sector: !isBond ? normalizedSector : undefined,
                assetClass: isBond ? 'BOND' : 'EQUITY',
                weight: rawWeight,
                source: 'bmo',
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
        isPredominantlyFixedIncome,
        holdingsCount: rows.length,
    };
}

function formatYyyymmddUtc(baseDate: Date, offsetDays: number): { compact: string; iso: string } {
    const d = new Date(
        Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() - offsetDays)
    );
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return { compact: `${yyyy}${mm}${dd}`, iso: `${yyyy}-${mm}-${dd}` };
}

async function fetchBmoWorkbookWithLookback(
    ctx: IssuerLookupContext,
    requester: RequesterFn,
    tickerVariants: string[],
    referenceDate: Date
): Promise<{ buffer: Buffer; ticker: string; isoDate: string } | null> {
    const tryVariantOnDate = async (
        variant: string,
        offset: number
    ): Promise<{ buffer: Buffer; ticker: string; isoDate: string } | null> => {
        const { compact, iso } = formatYyyymmddUtc(referenceDate, offset);
        const url = `${BMO_HOLDINGS_BASE_URL}/Holdings_Extract_en_US_${encodeURIComponent(variant)}_${compact}.xlsx`;
        const res = await requester(url, { headers: DEFAULT_HEADERS });
        if (res.status === 403 || res.status === 404) {
            await res.body?.cancel().catch(() => {});
            return null;
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            return null;
        }
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
            return null;
        }
        return { buffer: buf, ticker: variant, isoDate: iso };
    };

    // Check recent 4 days across all variants first so class-suffix variants (e.g. ZUAG.F) resolve
    // promptly without burning 14 requests on non-matching filenames.
    const recentWindow = Math.min(4, MAX_LOOKBACK_DAYS);
    for (let offset = 0; offset < recentWindow; offset++) {
        for (const variant of tickerVariants) {
            const hit = await tryVariantOnDate(variant, offset);
            if (hit) return hit;
        }
    }

    for (const variant of tickerVariants) {
        for (let offset = recentWindow; offset < MAX_LOOKBACK_DAYS; offset++) {
            const hit = await tryVariantOnDate(variant, offset);
            if (hit) return hit;
        }
    }

    return null;
}

async function resolveBmoRecursive(
    ctx: IssuerLookupContext,
    requester: RequesterFn,
    tickerVariants: string[],
    referenceDate: Date,
    depth: number,
    visited: Set<string>,
    inRunCache: Map<string, Promise<InternalResolvedBmo | null>>
): Promise<InternalResolvedBmo | null> {
    const cacheKey = tickerVariants[0];
    if (visited.has(cacheKey)) return null;

    const existing = inRunCache.get(cacheKey);
    if (existing) return existing;

    const task = (async (): Promise<InternalResolvedBmo | null> => {
        const nextVisited = new Set(visited);
        nextVisited.add(cacheKey);

        const download = await fetchBmoWorkbookWithLookback(
            ctx,
            requester,
            tickerVariants,
            referenceDate
        );
        if (!download) {
            return null;
        }

        const sheetRows = parseXlsxFirstSheet(download.buffer);
        const parsed = parseBmoHoldingsSheet(sheetRows);
        if (parsed.holdings.length === 0) {
            return null;
        }

        const aggregated = await aggregateBmoHoldings(parsed.holdings, {
            maxTopHoldings: MAX_UNDERLYING_HOLDINGS,
            resolveUnderlying:
                depth < MAX_FOF_DEPTH
                    ? (subTicker) =>
                          resolveBmoRecursive(
                              ctx,
                              requester,
                              [subTicker],
                              referenceDate,
                              depth + 1,
                              nextVisited,
                              inRunCache
                          )
                    : undefined,
        });

        if (aggregated.countryAllocations.length === 0) {
            return null;
        }

        return {
            countryAllocations: aggregated.countryAllocations,
            sectorAllocations: aggregated.sectorAllocations,
            topHoldings: aggregated.topHoldings,
            isPredominantlyFixedIncome: aggregated.isPredominantlyFixedIncome,
            holdingsCount: aggregated.holdingsCount,
            asOfDate: parsed.asOfDate ?? download.isoDate,
            ticker: download.ticker,
        };
    })();

    inRunCache.set(cacheKey, task);
    return task;
}

export async function fetchBmoAllocationsWithDate(
    ctx: IssuerLookupContext,
    referenceDate: Date = new Date()
): Promise<IssuerAllocationResult | null> {
    const tickerVariants = resolveBmoTickerCandidates(ctx.symbol);
    if (!tickerVariants) return null;

    const requester = createIssuerRequester('bmo', ctx, 10_000);
    if (!requester) return null;

    const inRunCache = new Map<string, Promise<InternalResolvedBmo | null>>();
    const resolved = await resolveBmoRecursive(
        ctx,
        requester,
        tickerVariants,
        referenceDate,
        0,
        new Set<string>(),
        inRunCache
    );

    if (!resolved) {
        warnDiagnostic(
            ctx,
            `[IssuerAdapter:bmo] No country allocations resolved from BMO XLSX reports for ${ctx.symbol}`
        );
        return null;
    }

    return {
        providerId: 'bmo',
        productId: resolved.ticker,
        countryAllocations: resolved.countryAllocations,
        sectorAllocations:
            resolved.sectorAllocations.length > 0 ? resolved.sectorAllocations : undefined,
        topHoldings: resolved.topHoldings.length > 0 ? resolved.topHoldings : undefined,
        holdingsCount: resolved.holdingsCount,
        asOfDate: resolved.asOfDate,
    };
}

const NON_GEOGRAPHIC_BMO_TICKERS = new Set(['ZGLD', 'ZMMK']);
const NON_GEOGRAPHIC_BMO_NAME_PATTERN = /\b(bullion|physical\s+(?:gold|silver)|money\s+market)\b/i;

export const bmoAdapter: EtfIssuerAdapter = {
    id: 'bmo',

    canHandle(ctx: IssuerLookupContext): boolean {
        const tickerVariants = resolveBmoTickerCandidates(ctx.symbol);
        if (!tickerVariants) return false;

        if (ctx.quoteType) {
            const upperType = ctx.quoteType.toUpperCase();
            if (upperType !== 'ETF' && upperType !== 'MUTUALFUND') {
                return false;
            }
        }

        if (tickerVariants.some((t) => NON_GEOGRAPHIC_BMO_TICKERS.has(t))) {
            return false;
        }

        const name = ctx.fundName?.trim();
        if (name) {
            if (NON_GEOGRAPHIC_BMO_NAME_PATTERN.test(name)) {
                return false;
            }
            return (
                /\bbmo\b/i.test(name) &&
                /\b(etf|fund|trust|index|portfolio|bond|equity|yield|income|balanced|growth|conservative)\b/i.test(
                    name
                )
            );
        }

        return /^Z[A-Z0-9.-]*$/.test(tickerVariants[0]);
    },

    async fetchAllocations(ctx: IssuerLookupContext): Promise<IssuerAllocationResult | null> {
        return fetchBmoAllocationsWithDate(ctx, new Date());
    },
};
