import { normalizeCountryName, normalizeSectorName } from '../look-through.ts';
import {
    createIssuerRequester,
    emitIssuerDiagnostic,
    type IssuerRequestOptions,
} from './http.ts';
import type {
    AllocationWeightEntry,
    EtfIssuerAdapter,
    IssuerAllocationResult,
    IssuerLookupContext,
} from './types.ts';

type RequesterFn = (url: string, opts?: IssuerRequestOptions) => Promise<Response>;

const TD_FUND_CARD_BASE_URL =
    'https://www.td.com/ca/en/asset-management/funds/solutions/etfs/fundcard';
const TD_FUND_FILTER_URL =
    'https://www.td.com/bin/fund-filter-data?productType=etf&reqType=overview&lang=en';

const DEFAULT_HEADERS: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
    Referer: 'https://www.td.com/ca/en/asset-management/funds/solutions/etfs/',
    'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// Verified TD Asset Management Canada ETF ticker -> fundId mapping
export const TD_ETF_FUND_IDS: Record<string, string> = {
    TEC: '7113',
    'TEC.U': '7230',
    TECI: '7202',
    TECX: '7280',
    TPU: '6902',
    'TPU.U': '7231',
    TTP: '6901',
    TPE: '6904',
    THE: '6905',
    THU: '6903',
    TEQT: '7418',
    TGRO: '7151',
    TBAL: '7150',
    TCON: '7149',
    TDB: '6900',
    TCLB: '7127',
    TCSH: '7114',
    TCBN: '7115',
    TCLV: '6906',
    TULV: '6907',
    TILV: '6908',
    TGED: '7111',
    TGEU: '7112',
    TGGR: '7125',
    TGRE: '7126',
    TGFI: '7128',
    TPRF: '7129',
    TUHY: '7130',
    TULB: '7131',
    TUSB: '7132',
    'TUSB.U': '7232',
    TQCD: '7134',
    TQGD: '7135',
    TQSM: '7136',
    TBNK: '7203',
    THDS: '7204',
    TRVL: '7281',
};

const IGNORED_LABELS = new Set([
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
    'cash',
    'cash and cash equivalent',
    'cash and cash equivalents',
    'cash & cash equivalents',
    'cash and equivalents',
]);

const NON_SOVEREIGN_REGIONAL_LABELS = new Map<string, string>([
    ['european union', 'European Union'],
    ['asia/pacific rim', 'Asia/Pacific Rim'],
    ['asia pacific rim', 'Asia/Pacific Rim'],
    ['other european', 'Other European'],
    ['africa and middle east', 'Africa and Middle East'],
    ['latin america', 'Latin America'],
    ['other asian', 'Other Asian'],
    ['emerging markets', 'Emerging Markets'],
    ['developed europe', 'Developed Europe'],
    ['north america', 'North America'],
]);

const SECTION_STOP_HEADINGS = new Set([
    'fund geography',
    'sector mix',
    'asset mix',
    'top 10 holdings',
    'top ten holdings',
    'top holdings',
    'holdings',
    'portfolio characteristics',
    'credit quality',
    'term to maturity',
    'maturity breakdown',
    'distributions',
    'performance',
    'historical performance',
    'fund details',
    'fund facts',
    'risk rating',
]);

let cachedTdCatalogueMap: Map<string, string> | null = null;

function warnDiagnostic(ctx: IssuerLookupContext, msg: string): void {
    emitIssuerDiagnostic(ctx, msg);
}

function roundWeight(weight: number): number {
    return Math.round(weight * 1_000_000) / 1_000_000;
}

function decodeHtmlEntities(raw: string): string {
    if (!raw.includes('&')) return raw;
    return raw.replace(
        /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
        (full, entity: string) => {
            switch (entity.toLowerCase()) {
                case 'amp':
                    return '&';
                case 'lt':
                    return '<';
                case 'gt':
                    return '>';
                case 'quot':
                    return '"';
                case 'apos':
                case '#39':
                    return "'";
                case 'nbsp':
                    return ' ';
                default: {
                    const codePoint = entity.toLowerCase().startsWith('#x')
                        ? Number.parseInt(entity.slice(2), 16)
                        : Number.parseInt(entity.slice(1), 10);
                    if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
                        return String.fromCodePoint(codePoint);
                    }
                    return full;
                }
            }
        }
    );
}

export function resolveTdTickerCandidates(symbol: string): string[] | null {
    const trimmed = symbol.trim().toUpperCase();
    if (!trimmed || trimmed.endsWith('=X') || trimmed.startsWith('^')) {
        return null;
    }

    if (!/\.(TO|NE|V|CN)$/.test(trimmed)) {
        return null;
    }

    const base = trimmed.replace(/\.(TO|NE|V|CN)$/, '');
    const candidates = [base];
    const usdMatch = base.match(/^(.+?)[.-]U$/);
    if (usdMatch) {
        candidates.push(`${usdMatch[1]}.U`, usdMatch[1]);
    }
    return Array.from(new Set(candidates));
}

function normalizeTdCountryOrRegion(rawLabel: string): string | null {
    const trimmed = rawLabel.trim();
    const lower = trimmed.toLowerCase();
    if (!trimmed || IGNORED_LABELS.has(lower)) {
        return null;
    }
    const regional = NON_SOVEREIGN_REGIONAL_LABELS.get(lower);
    if (regional) {
        return regional;
    }
    const canonical = normalizeCountryName(trimmed);
    return canonical === 'Unspecified' ? null : canonical;
}

function normalizePercentageBuckets(
    rawEntries: Array<{ label: string; pct: number }>,
    normalizer: (label: string) => string | null
): AllocationWeightEntry[] {
    const totals = new Map<string, number>();
    let sum = 0;

    for (const item of rawEntries) {
        if (!Number.isFinite(item.pct) || item.pct <= 0) continue;
        const label = normalizer(item.label);
        if (!label) continue;
        totals.set(label, (totals.get(label) ?? 0) + item.pct);
        sum += item.pct;
    }

    if (totals.size === 0 || sum <= 0) return [];
    const denominator = sum >= 98 ? sum : 100;

    return Array.from(totals.entries())
        .map(([key, val]) => ({ key, weight: roundWeight(val / denominator) }))
        .filter((e) => e.weight >= 1e-6)
        .sort((a, b) => b.weight - a.weight)
        .map((e) => ({ [e.key]: e.weight }));
}

function extractDataAttributeJson(html: string, attrNames: string[]): Array<{ label: string; pct: number }> {
    for (const attrName of attrNames) {
        const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = html.match(new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
        const rawValue = match ? decodeHtmlEntities(match[1] ?? match[2] ?? '') : '';
        if (!rawValue.trim()) continue;

        try {
            const parsed = JSON.parse(rawValue) as unknown;
            const entries: Array<{ label: string; pct: number }> = [];
            if (Array.isArray(parsed)) {
                for (const row of parsed) {
                    if (!row || typeof row !== 'object') continue;
                    const rec = row as Record<string, unknown>;
                    const rawLabel = rec.label ?? rec.name ?? rec.country ?? rec.sector ?? rec.category;
                    const rawPct = rec.value ?? rec.percentage ?? rec.weight ?? rec.percent ?? rec.pct;
                    const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
                    const pct =
                        typeof rawPct === 'number'
                            ? rawPct
                            : typeof rawPct === 'string'
                              ? Number(rawPct.replace(/[%,\s]/g, ''))
                              : Number.NaN;
                    if (label && Number.isFinite(pct) && pct > 0) {
                        entries.push({ label, pct });
                    }
                }
            }
            if (entries.length > 0) {
                return entries;
            }
        } catch {
            // Ignore malformed attribute and continue checking fallbacks
        }
    }
    return [];
}

function htmlToLines(html: string): string[] {
    const cleaned = html
        .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
        .replace(/<\/?(?:div|p|li|tr|td|th|h[1-6]|section|article|dt|dd|br|thead|tbody|ul|ol)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');

    return decodeHtmlEntities(cleaned)
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

function extractSectionPairs(
    lines: string[],
    headingName: string
): { entries: Array<{ label: string; pct: number }>; asOfDate?: string } {
    const targetLower = headingName.toLowerCase();
    const startIdx = lines.findIndex((line) => line.toLowerCase() === targetLower);
    if (startIdx < 0) {
        return { entries: [] };
    }

    const entries: Array<{ label: string; pct: number }> = [];
    let asOfDate: string | undefined;

    for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 60); i++) {
        const line = lines[i];
        const lower = line.toLowerCase();

        if (SECTION_STOP_HEADINGS.has(lower) && lower !== targetLower) {
            break;
        }

        const asOfMatch = line.match(/^as of\s+(.+)$/i);
        if (asOfMatch) {
            asOfDate = asOfMatch[1].trim();
            continue;
        }

        // Skip optional table column headers like "Category" or "%"
        if (lower === 'category' || lower === 'region' || lower === 'sector' || lower === '%' || lower === 'weight') {
            continue;
        }

        // Case 1: "United States 89.50%" or "United States 89.50"
        const inlineMatch = line.match(/^(.+?)\s+(-?\d+(?:\.\d+)?)\s*%$/);
        if (inlineMatch) {
            const label = inlineMatch[1].trim();
            const pct = Number(inlineMatch[2]);
            if (label && Number.isFinite(pct) && pct > 0 && pct <= 100) {
                entries.push({ label, pct });
                continue;
            }
        }

        // Case 2: Label on line i, percentage "89.50%" on line i + 1
        if (i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            const pctMatch = nextLine.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
            if (pctMatch && !/\d%$/.test(line)) {
                const pct = Number(pctMatch[1]);
                if (Number.isFinite(pct) && pct > 0 && pct <= 100) {
                    entries.push({ label: line, pct });
                    i++;
                    continue;
                }
            }
        }

        if (entries.length > 0 && line.length > 50) {
            // Reached narrative footnote / paragraph below table
            break;
        }
    }

    return { entries, asOfDate };
}

/**
 * Parses TD ETF FundCard HTML extracting Fund Geography and Sector Mix allocations
 * from either structured JSON `data-*` attributes or SSR text tables.
 */
export function parseTdFundCardHtml(html: string): {
    countryAllocations: AllocationWeightEntry[];
    sectorAllocations: AllocationWeightEntry[];
    asOfDate?: string;
} {
    const lines = htmlToLines(html);

    const attrGeo = extractDataAttributeJson(html, [
        'data-fund-geography',
        'data-geography',
        'data-geographic-mix',
    ]);
    const textGeo = attrGeo.length === 0 ? extractSectionPairs(lines, 'Fund Geography') : { entries: [] };
    const rawGeo = attrGeo.length > 0 ? attrGeo : textGeo.entries;

    const attrSector = extractDataAttributeJson(html, [
        'data-sector-mix',
        'data-sector-allocation',
    ]);
    const textSector = attrSector.length === 0 ? extractSectionPairs(lines, 'Sector Mix') : { entries: [] };
    const rawSector = attrSector.length > 0 ? attrSector : textSector.entries;

    const countryAllocations = normalizePercentageBuckets(rawGeo, normalizeTdCountryOrRegion);

    let fixedIncomePct = 0;
    let totalSectorPct = 0;
    for (const item of rawSector) {
        if (!Number.isFinite(item.pct) || item.pct <= 0) continue;
        const lower = item.label.trim().toLowerCase();
        if (IGNORED_LABELS.has(lower)) continue;
        totalSectorPct += item.pct;
        if (
            lower.includes('fixed income') ||
            lower.includes('government') ||
            lower.includes('corporate') ||
            lower.includes('treasury') ||
            lower === 'bonds'
        ) {
            fixedIncomePct += item.pct;
        }
    }

    const isPredominantlyFixedIncome =
        totalSectorPct > 0 && fixedIncomePct / totalSectorPct > 0.5;

    const sectorAllocations = !isPredominantlyFixedIncome
        ? normalizePercentageBuckets(rawSector, (raw) => {
              if (IGNORED_LABELS.has(raw.trim().toLowerCase())) return null;
              const canonical = normalizeSectorName(raw);
              return canonical === 'Other / Unclassified' ? null : canonical;
          })
        : [];

    const asOfDate = textGeo.asOfDate ?? textSector.asOfDate;

    return {
        countryAllocations,
        sectorAllocations,
        asOfDate,
    };
}

function collectTdCatalogueEntries(node: unknown, out: Map<string, string>): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) {
            collectTdCatalogueEntries(item, out);
        }
        return;
    }

    const rec = node as Record<string, unknown>;
    const rawCode = rec.fundCode ?? rec.ticker ?? rec.symbol ?? rec.etfCode;
    let rawId = rec.fundId ?? rec.id;
    if (!rawId && typeof rec.fundCardUrl === 'string') {
        const match = rec.fundCardUrl.match(/[?&]fundId=(\d+)/i);
        if (match) rawId = match[1];
    }

    if (typeof rawCode === 'string' && (typeof rawId === 'string' || typeof rawId === 'number')) {
        const tickerClean = rawCode
            .trim()
            .toUpperCase()
            .replace(/\.(TO|NE|V|CN)$/, '');
        const idStr = String(rawId).trim();
        if (tickerClean && /^\d+$/.test(idStr) && !out.has(tickerClean)) {
            out.set(tickerClean, idStr);
        }
    }

    for (const val of Object.values(rec)) {
        if (val && typeof val === 'object') {
            collectTdCatalogueEntries(val, out);
        }
    }
}

async function discoverTdCatalogue(
    ctx: IssuerLookupContext,
    requester: RequesterFn
): Promise<Map<string, string>> {
    if (!ctx.fetchFn && cachedTdCatalogueMap && cachedTdCatalogueMap.size > 0) {
        return cachedTdCatalogueMap;
    }

    const res = await requester(TD_FUND_FILTER_URL, {
        headers: {
            Accept: 'application/json',
            Referer: DEFAULT_HEADERS.Referer,
            'User-Agent': DEFAULT_HEADERS['User-Agent'],
        },
    });
    if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return new Map();
    }

    const json = (await res.json().catch(() => null)) as unknown;
    const discovered = new Map<string, string>();
    collectTdCatalogueEntries(json, discovered);

    if (!ctx.fetchFn && discovered.size > 0) {
        cachedTdCatalogueMap = discovered;
    }

    return discovered;
}

export const tdAdapter: EtfIssuerAdapter = {
    id: 'td',

    canHandle(ctx: IssuerLookupContext): boolean {
        const candidates = resolveTdTickerCandidates(ctx.symbol);
        if (!candidates) return false;

        if (ctx.quoteType) {
            const upperType = ctx.quoteType.toUpperCase();
            if (upperType !== 'ETF' && upperType !== 'MUTUALFUND') {
                return false;
            }
        }

        const name = ctx.fundName?.trim();
        if (name) {
            return (
                /\btd\b/i.test(name) &&
                /\b(etf|fund|trust|index|portfolio|equity|bond|income|balanced|growth|conservative|dividend|technology|leaders)\b/i.test(
                    name
                )
            );
        }

        return candidates.some((c) => Boolean(TD_ETF_FUND_IDS[c]));
    },

    async fetchAllocations(ctx: IssuerLookupContext): Promise<IssuerAllocationResult | null> {
        const candidates = resolveTdTickerCandidates(ctx.symbol);
        if (!candidates) return null;

        const requester = createIssuerRequester(this.id, ctx, 10_000);
        if (!requester) return null;

        let fundId: string | undefined;
        for (const candidate of candidates) {
            if (TD_ETF_FUND_IDS[candidate]) {
                fundId = TD_ETF_FUND_IDS[candidate];
                break;
            }
        }

        if (!fundId) {
            const catalogue = await discoverTdCatalogue(ctx, requester);
            for (const candidate of candidates) {
                const found = catalogue.get(candidate);
                if (found) {
                    fundId = found;
                    break;
                }
            }
        }

        if (!fundId) {
            warnDiagnostic(ctx, `[IssuerAdapter:td] Could not resolve TD fundId for ${ctx.symbol}`);
            return null;
        }

        const fundCardUrl = `${TD_FUND_CARD_BASE_URL}?fundId=${encodeURIComponent(fundId)}`;
        const res = await requester(fundCardUrl, { headers: DEFAULT_HEADERS });
        if (!res.ok) {
            warnDiagnostic(
                ctx,
                `[IssuerAdapter:td] FundCard HTTP ${res.status} for ${ctx.symbol} (fundId=${fundId})`
            );
            await res.body?.cancel().catch(() => {});
            return null;
        }

        const html = await res.text();
        if (!html) {
            return null;
        }

        const parsed = parseTdFundCardHtml(html);
        if (parsed.countryAllocations.length === 0) {
            warnDiagnostic(
                ctx,
                `[IssuerAdapter:td] No Fund Geography table parsed for ${ctx.symbol} (fundId=${fundId})`
            );
            return null;
        }

        return {
            providerId: this.id,
            productId: fundId,
            countryAllocations: parsed.countryAllocations,
            sectorAllocations:
                parsed.sectorAllocations.length > 0 ? parsed.sectorAllocations : undefined,
            holdingsCount: parsed.countryAllocations.length,
            asOfDate: parsed.asOfDate,
        };
    },
};
