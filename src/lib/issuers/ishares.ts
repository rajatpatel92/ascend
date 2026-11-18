import { normalizeCountryName, normalizeSectorName } from '../look-through.ts';
import type {
    AllocationWeightEntry,
    EtfIssuerAdapter,
    IssuerAllocationResult,
    IssuerLookupContext,
} from './types.ts';

type IsharesRegion = 'ca' | 'us';

interface RegionConfig {
    region: IsharesRegion;
    baseUrl: string;
    buildHoldingsUrl: (productId: string, cleanTicker: string) => string;
}

interface AutocompleteItem {
    label?: unknown;
    id?: unknown;
    category?: unknown;
}

export interface ParsedIsharesHoldingRow {
    ticker?: string;
    name?: string;
    sector?: string;
    assetClass?: string;
    location?: string;
    marketValue?: number;
    weightPercent?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

const REGION_CONFIGS: Record<IsharesRegion, RegionConfig> = {
    ca: {
        region: 'ca',
        baseUrl: 'https://www.blackrock.com/ca/investors/en',
        buildHoldingsUrl: (productId: string, cleanTicker: string) => {
            const params = new URLSearchParams({
                fileType: 'csv',
                fileName: `${cleanTicker}_holdings`,
                dataType: 'fund',
            });
            return `https://www.blackrock.com/ca/investors/en/products/${productId}/fund/1464253357814.ajax?${params.toString()}`;
        },
    },
    us: {
        region: 'us',
        baseUrl: 'https://www.ishares.com/us',
        buildHoldingsUrl: (productId: string) =>
            `https://www.ishares.com/us/products/${productId}/fund/latest-holdings.csv`,
    },
};

const ISHARES_BRAND_PATTERN = /\b(ishares|blackrock)\b/i;

const LOCATION_HEADER_NAMES = ['location', 'country', 'country of risk', 'domicile'];

const PLACEHOLDER_LOCATIONS = new Set([
    '-',
    '--',
    'n/a',
    'na',
    'none',
    'null',
    'unassigned',
    'unspecified',
    'not available',
]);

const PLACEHOLDER_SECTORS = new Set([
    '-',
    '--',
    'n/a',
    'na',
    'none',
    'null',
    'other',
    'unassigned',
    'unspecified',
    'not available',
    'cash and/or derivatives',
]);

function cleanCell(value: string): string {
    return value.replace(/^\uFEFF/, '').replace(/\u00A0/g, ' ').trim();
}

/**
 * Parses an RFC-4180 CSV string into trimmed cell arrays per line, handling quoted commas
 * and escaped double quotes.
 */
export function parseCsvRows(csvText: string): string[][] {
    const text = csvText.replace(/^\uFEFF/, '');
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentCell = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];

        if (ch === '"') {
            if (inQuotes && next === '"') {
                currentCell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (ch === ',' && !inQuotes) {
            currentRow.push(cleanCell(currentCell));
            currentCell = '';
            continue;
        }

        if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && next === '\n') {
                i++;
            }
            currentRow.push(cleanCell(currentCell));
            rows.push(currentRow);
            currentRow = [];
            currentCell = '';
            continue;
        }

        currentCell += ch;
    }

    if (currentCell.length > 0 || currentRow.length > 0) {
        currentRow.push(cleanCell(currentCell));
        rows.push(currentRow);
    }

    return rows;
}

function parseNumericCell(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const cleaned = raw.replace(/[$,%\s]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '--') return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function findHeaderIndex(headersLower: string[], candidates: string[]): number {
    for (const candidate of candidates) {
        const idx = headersLower.indexOf(candidate);
        if (idx !== -1) return idx;
    }
    return -1;
}

function isHoldingsHeaderRow(cells: string[]): boolean {
    if (cells.length < 4) return false;
    const lowerSet = new Set(cells.map((c) => c.toLowerCase()));
    const hasIdentity = lowerSet.has('ticker') || lowerSet.has('name');
    const hasLocation = LOCATION_HEADER_NAMES.some((name) => lowerSet.has(name));
    const hasWeightOrValue =
        lowerSet.has('weight (%)') ||
        lowerSet.has('market weight') ||
        lowerSet.has('market value');
    return hasIdentity && hasLocation && hasWeightOrValue;
}

function extractAsOfDate(rows: string[][], headerIndex: number): string | undefined {
    for (let i = Math.max(0, headerIndex - 10); i < headerIndex; i++) {
        const row = rows[i];
        if (row.length >= 2 && row[0].toLowerCase().startsWith('fund holdings as of')) {
            return row[1] || undefined;
        }
    }
    return undefined;
}

function hasAggregateHeadingNearHeader(rows: string[][], headerIndex: number): boolean {
    for (let i = Math.max(0, headerIndex - 6); i < headerIndex; i++) {
        const joined = rows[i].join(' ').toLowerCase();
        if (joined.includes('aggregate underlying')) {
            return true;
        }
    }
    return false;
}

/**
 * Extracts holdings tables from an iShares CSV and orders/marks them.
 * BlackRock Canada fund-of-funds CSVs (e.g. XEQT.TO) include a top-level ETF table followed
 * by a larger "Aggregate Underlying Holdings" table.
 */
export function extractHoldingsTables(csvText: string): {
    tables: ParsedIsharesHoldingRow[][];
    asOfDate?: string;
    aggregateTableIndex?: number;
} {
    const rows = parseCsvRows(csvText);
    const headerIndices: number[] = [];

    for (let i = 0; i < rows.length; i++) {
        if (isHoldingsHeaderRow(rows[i])) {
            headerIndices.push(i);
        }
    }

    const tables: ParsedIsharesHoldingRow[][] = [];
    let asOfDate: string | undefined;
    let aggregateTableIndex: number | undefined;

    for (let hIdx = 0; hIdx < headerIndices.length; hIdx++) {
        const startIdx = headerIndices[hIdx];
        const nextHeaderIdx = hIdx + 1 < headerIndices.length ? headerIndices[hIdx + 1] : rows.length;
        const headers = rows[startIdx].map((h) => h.toLowerCase());

        const colIdx = {
            ticker: headers.indexOf('ticker'),
            name: headers.indexOf('name'),
            sector: headers.indexOf('sector'),
            assetClass: headers.indexOf('asset class'),
            location: findHeaderIndex(headers, LOCATION_HEADER_NAMES),
            marketValue: headers.indexOf('market value'),
            weightPercent: findHeaderIndex(headers, ['weight (%)', 'market weight']),
        };

        const tableRows: ParsedIsharesHoldingRow[] = [];
        for (let r = startIdx + 1; r < nextHeaderIdx; r++) {
            const cells = rows[r];
            const nonEmptyCount = cells.filter((c) => c.length > 0).length;
            if (nonEmptyCount === 0) {
                if (tableRows.length > 0) break;
                continue;
            }

            const firstCellLower = (cells[0] || '').toLowerCase();
            if (firstCellLower.startsWith('fund holdings as of')) {
                if (tableRows.length > 0) break;
                continue;
            }

            const ticker = colIdx.ticker >= 0 ? cells[colIdx.ticker] : undefined;
            const name = colIdx.name >= 0 ? cells[colIdx.name] : undefined;
            if (!ticker && !name) continue;

            tableRows.push({
                ticker: ticker || undefined,
                name: name || undefined,
                sector: colIdx.sector >= 0 ? cells[colIdx.sector] : undefined,
                assetClass: colIdx.assetClass >= 0 ? cells[colIdx.assetClass] : undefined,
                location: colIdx.location >= 0 ? cells[colIdx.location] : undefined,
                marketValue: colIdx.marketValue >= 0 ? parseNumericCell(cells[colIdx.marketValue]) : undefined,
                weightPercent: colIdx.weightPercent >= 0 ? parseNumericCell(cells[colIdx.weightPercent]) : undefined,
            });
        }

        if (tableRows.length > 0) {
            const tableIdx = tables.length;
            tables.push(tableRows);
            asOfDate = extractAsOfDate(rows, startIdx) ?? asOfDate;
            if (hasAggregateHeadingNearHeader(rows, startIdx)) {
                aggregateTableIndex = tableIdx;
            }
        }
    }

    return { tables, asOfDate, aggregateTableIndex };
}

function selectPrimaryHoldingsTable(
    tables: ParsedIsharesHoldingRow[][],
    aggregateTableIndex?: number
): ParsedIsharesHoldingRow[] {
    if (aggregateTableIndex !== undefined && tables[aggregateTableIndex]) {
        return tables[aggregateTableIndex];
    }
    if (tables.length <= 1) {
        return tables[0] ?? [];
    }
    // # Reason: Fund-of-funds CSVs (e.g. XEQT.TO) list the small wrapper ETF table first and the
    // full look-through table second; picking the largest table (tie-breaking later) avoids both
    // under-decomposing wrappers and falling for small trailing footnote tables.
    let best = tables[0];
    for (let i = 1; i < tables.length; i++) {
        if (tables[i].length >= best.length) {
            best = tables[i];
        }
    }
    return best;
}

function roundWeight(weight: number): number {
    return Math.round(weight * 1_000_000) / 1_000_000;
}

function isDerivativeRow(assetClassLower: string): boolean {
    return (
        assetClassLower === 'fx' ||
        assetClassLower.includes('derivative') ||
        assetClassLower.includes('future') ||
        assetClassLower.includes('forward')
    );
}

function isCashRow(assetClassLower: string, sectorLower: string): boolean {
    return assetClassLower === 'cash' || sectorLower === 'cash and/or derivatives';
}

/**
 * Aggregates holdings rows into normalized country and sector weight distributions.
 * Prefers exact Market Value when positive values exist because 2-decimal Weight (%) rounds
 * thousands of small-cap constituents to 0.00% in global ETFs such as XEQT.TO.
 */
export function aggregateIsharesHoldings(rows: ParsedIsharesHoldingRow[]): {
    countryAllocations: AllocationWeightEntry[];
    sectorAllocations: AllocationWeightEntry[];
    holdingsCount: number;
} {
    let totalMarketValue = 0;
    let totalWeightPercent = 0;

    for (const row of rows) {
        const assetClassLower = (row.assetClass || '').trim().toLowerCase();
        if (isDerivativeRow(assetClassLower)) continue;

        if (typeof row.marketValue === 'number' && row.marketValue > 0) {
            totalMarketValue += row.marketValue;
        }
        if (typeof row.weightPercent === 'number' && row.weightPercent > 0) {
            totalWeightPercent += row.weightPercent;
        }
    }

    const useMarketValue = totalMarketValue > 0;
    if (!useMarketValue && totalWeightPercent <= 0) {
        return { countryAllocations: [], sectorAllocations: [], holdingsCount: 0 };
    }

    const countryTotals = new Map<string, number>();
    const sectorTotals = new Map<string, number>();
    let countryAllocatedSum = 0;
    let sectorAllocatedSum = 0;
    let fixedIncomeWeight = 0;
    let totalPositivePortfolioWeight = 0;

    for (const row of rows) {
        const assetClassLower = (row.assetClass || '').trim().toLowerCase();
        if (isDerivativeRow(assetClassLower)) {
            // # Reason: Currency-hedged ETFs (e.g. XSP.TO, XEH.TO) carry paired +100%/-100% FX forward
            // legs that would otherwise double totalPositivePortfolioWeight and skew countries.
            continue;
        }

        const rawWeight = useMarketValue ? row.marketValue : row.weightPercent;
        if (typeof rawWeight !== 'number' || !Number.isFinite(rawWeight) || rawWeight <= 0) {
            continue;
        }

        totalPositivePortfolioWeight += rawWeight;

        const sectorLower = (row.sector || '').trim().toLowerCase();
        const isCash = isCashRow(assetClassLower, sectorLower);

        if (assetClassLower.includes('fixed income') || assetClassLower === 'bond') {
            fixedIncomeWeight += rawWeight;
        }

        const rawLocation = (row.location || '').trim();
        if (!isCash && rawLocation && !PLACEHOLDER_LOCATIONS.has(rawLocation.toLowerCase())) {
            const country = normalizeCountryName(rawLocation);
            if (country !== 'Unspecified') {
                countryTotals.set(country, (countryTotals.get(country) || 0) + rawWeight);
                countryAllocatedSum += rawWeight;
            }
        }

        const rawSector = (row.sector || '').trim();
        if (!isCash && rawSector && !PLACEHOLDER_SECTORS.has(sectorLower)) {
            const sector = normalizeSectorName(rawSector);
            if (sector !== 'Other / Unclassified') {
                sectorTotals.set(sector, (sectorTotals.get(sector) || 0) + rawWeight);
                sectorAllocatedSum += rawWeight;
            }
        }
    }

    const countryDenominator =
        countryAllocatedSum > 0 && totalPositivePortfolioWeight > 0
            ? (countryAllocatedSum / totalPositivePortfolioWeight >= 0.98
                ? countryAllocatedSum
                : totalPositivePortfolioWeight)
            : countryAllocatedSum;

    const countryAllocations: AllocationWeightEntry[] = Array.from(countryTotals.entries())
        .map(([country, val]) => ({ country, weight: roundWeight(val / countryDenominator) }))
        .filter((entry) => entry.weight >= 1e-6)
        .sort((a, b) => b.weight - a.weight)
        .map((entry) => ({ [entry.country]: entry.weight }));

    // # Reason: Omit credit sector buckets (Treasuries, Corporates, Securitized) on predominantly
    // fixed-income ETFs so bond sectors do not mix into GICS equity sector charts.
    const isPredominantlyFixedIncome =
        totalPositivePortfolioWeight > 0 && fixedIncomeWeight / totalPositivePortfolioWeight > 0.5;

    const sectorDenominator =
        sectorAllocatedSum > 0 && totalPositivePortfolioWeight > 0
            ? (sectorAllocatedSum / totalPositivePortfolioWeight >= 0.98
                ? sectorAllocatedSum
                : totalPositivePortfolioWeight)
            : sectorAllocatedSum;

    const sectorAllocations: AllocationWeightEntry[] =
        !isPredominantlyFixedIncome && sectorDenominator > 0
            ? Array.from(sectorTotals.entries())
                  .map(([sector, val]) => ({ sector, weight: roundWeight(val / sectorDenominator) }))
                  .filter((entry) => entry.weight >= 1e-6)
                  .sort((a, b) => b.weight - a.weight)
                  .map((entry) => ({ [entry.sector]: entry.weight }))
            : [];

    return {
        countryAllocations,
        sectorAllocations,
        holdingsCount: rows.length,
    };
}

/**
 * Maps a Yahoo Finance symbol (e.g. XEQT.TO, XUU.U.TO, IVV) into the BlackRock/iShares
 * regional site and candidate search tickers.
 */
export function resolveIsharesRegionAndTicker(symbol: string): {
    region: IsharesRegion;
    searchTerms: string[];
} | null {
    const trimmed = symbol.trim().toUpperCase();
    if (!trimmed || trimmed.endsWith('=X') || trimmed.startsWith('^')) {
        return null;
    }

    if (/\.(TO|NE|V|CN)$/.test(trimmed)) {
        const base = trimmed.replace(/\.(TO|NE|V|CN)$/, '');
        const terms = [base];
        // USD-denominated TSX tickers like XEF.U.TO or XUU-U.TO map to the same underlying fund
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

function tokenizeName(value: string): Set<string> {
    return new Set(
        value
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((tok) => tok.length >= 2 && tok !== 'etf' && tok !== 'fund' && tok !== 'ishares')
    );
}

/**
 * Selects the best BlackRock productAutocomplete entry, comparing against Yahoo's fundName
 * when available to avoid picking CAD-hedged or similarly named variants accidentally.
 */
export function selectBestAutocompleteCandidate(
    items: unknown,
    fundName?: string | null
): { productId: string; label?: string } | null {
    if (!Array.isArray(items)) return null;

    const candidates: Array<{ productId: string; label: string; originalIndex: number }> = [];
    items.forEach((raw, idx) => {
        if (!raw || typeof raw !== 'object') return;
        const item = raw as AutocompleteItem;
        if (item.category !== 'productAutocomplete' || typeof item.id !== 'string') return;
        const match = item.id.match(/\/products\/(\d+)(?:\/|$)/);
        if (!match) return;
        candidates.push({
            productId: match[1],
            label: typeof item.label === 'string' ? item.label : '',
            originalIndex: idx,
        });
    });

    if (candidates.length === 0) return null;
    if (!fundName || !fundName.trim()) {
        return { productId: candidates[0].productId, label: candidates[0].label };
    }

    const normalizedTarget = fundName.trim().toLowerCase();
    const targetTokens = tokenizeName(normalizedTarget);
    const targetHedged = normalizedTarget.includes('hedged');

    let best = candidates[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestOverlap = 0;

    for (const candidate of candidates) {
        const normalizedLabel = candidate.label.toLowerCase();
        if (normalizedLabel === normalizedTarget) {
            return { productId: candidate.productId, label: candidate.label };
        }

        const labelTokens = tokenizeName(normalizedLabel);
        let overlap = 0;
        for (const tok of targetTokens) {
            if (labelTokens.has(tok)) overlap++;
        }

        const candidateHedged = normalizedLabel.includes('hedged');
        const hedgedPenalty = candidateHedged !== targetHedged ? 5 : 0;
        const unionSize = Math.max(1, targetTokens.size + labelTokens.size - overlap);
        const jaccard = overlap / unionSize;
        // Slight tie-breaker toward earlier autocomplete ranking
        const score = overlap * 2 + jaccard - hedgedPenalty - candidate.originalIndex * 0.05;

        if (score > bestScore) {
            bestScore = score;
            best = candidate;
            bestOverlap = overlap;
        }
    }

    if (targetTokens.size > 0 && bestOverlap === 0) {
        return null;
    }

    return { productId: best.productId, label: best.label };
}

export const isharesAdapter: EtfIssuerAdapter = {
    id: 'ishares',

    canHandle(ctx: IssuerLookupContext): boolean {
        const regionInfo = resolveIsharesRegionAndTicker(ctx.symbol);
        if (!regionInfo) return false;

        if (ctx.quoteType) {
            const upperType = ctx.quoteType.toUpperCase();
            if (upperType !== 'ETF' && upperType !== 'MUTUALFUND') {
                return false;
            }
        }

        const name = ctx.fundName?.trim();
        if (name) {
            // # Reason: If Yahoo returned a full name that doesn't mention iShares (or BlackRock
            // paired with a fund keyword), avoid probing BlackRock endpoints for equities or third-party ETFs.
            return (
                /\bishares\b/i.test(name) ||
                (ISHARES_BRAND_PATTERN.test(name) && /\b(etf|fund|trust|index|portfolio)\b/i.test(name))
            );
        }

        return true;
    },

    async fetchAllocations(ctx: IssuerLookupContext): Promise<IssuerAllocationResult | null> {
        const regionInfo = resolveIsharesRegionAndTicker(ctx.symbol);
        if (!regionInfo) return null;

        const fetchImpl = ctx.fetchFn ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') return null;

        const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const config = REGION_CONFIGS[regionInfo.region];

        let candidate: { productId: string; label?: string } | null = null;
        let matchedTerm = regionInfo.searchTerms[0];

        for (const term of regionInfo.searchTerms) {
            const acUrl =
                `${config.baseUrl}/autoComplete.search?type=autocomplete` +
                `&term=${encodeURIComponent(term)}&siteEntryPassthrough=true`;

            const acResponse = await fetchImpl(acUrl, {
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!acResponse.ok) {
                await acResponse.body?.cancel().catch(() => {});
                continue;
            }

            const acText = await acResponse.text();
            if (acText.trimStart().startsWith('<')) continue;

            let acJson: unknown;
            try {
                acJson = JSON.parse(acText);
            } catch {
                continue;
            }

            candidate = selectBestAutocompleteCandidate(acJson, ctx.fundName);
            if (candidate) {
                matchedTerm = term;
                break;
            }
        }

        if (!candidate) return null;

        const holdingsUrl = config.buildHoldingsUrl(candidate.productId, matchedTerm);
        const csvResponse = await fetchImpl(holdingsUrl, {
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!csvResponse.ok) {
            await csvResponse.body?.cancel().catch(() => {});
            return null;
        }

        const csvText = await csvResponse.text();
        if (!csvText || csvText.trimStart().startsWith('<')) {
            return null;
        }

        const { tables, asOfDate, aggregateTableIndex } = extractHoldingsTables(csvText);
        if (tables.length === 0) {
            return null;
        }

        const targetTable = selectPrimaryHoldingsTable(tables, aggregateTableIndex);
        const aggregated = aggregateIsharesHoldings(targetTable);
        if (aggregated.countryAllocations.length === 0) {
            return null;
        }

        return {
            providerId: this.id,
            productId: candidate.productId,
            countryAllocations: aggregated.countryAllocations,
            sectorAllocations:
                aggregated.sectorAllocations.length > 0 ? aggregated.sectorAllocations : undefined,
            holdingsCount: aggregated.holdingsCount,
            asOfDate,
        };
    },
};
