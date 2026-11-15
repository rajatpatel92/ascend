export type DripConfidence = 'HIGH' | 'MEDIUM';

export type DripMatchKind =
    | 'BATCH_PAIR'
    | 'EXACT_COST'
    | 'ROUNDED_DRIP'
    | 'WHOLE_SHARE'
    | 'NET_OF_TAX';

export interface DripScanActivity {
    id: string;
    type: string;
    date: Date | string;
    quantity: number;
    price: number;
    fee?: number | null;
    currency: string;
    investmentId: string;
    accountId?: string | null;
    createdAt?: Date | string | null;
    investment?: {
        symbol?: string | null;
        name?: string | null;
    } | null;
    account?: {
        name?: string | null;
        type?: string | null;
    } | null;
    platform?: {
        name?: string | null;
    } | null;
}

export interface DripMatchCandidate {
    buyId: string;
    dividendId: string;
    investmentId: string;
    symbol: string;
    investmentName: string;
    accountId: string | null;
    accountName: string;
    accountType: string;
    platformName: string;
    currency: string;
    buyDate: string;
    buyQuantity: number;
    buyPrice: number;
    buyFee: number;
    buyCost: number;
    dividendDate: string;
    dividendQuantity: number;
    dividendRate: number;
    dividendAmount: number;
    dayDiff: number;
    amountDiff: number;
    amountDiffPct: number;
    confidence: DripConfidence;
    matchKind: DripMatchKind;
    reasons: string[];
}

export interface DripScanSummary {
    totalScannedBuys: number;
    highCount: number;
    mediumCount: number;
    existingDripCount: number;
    totalHighAmount: number;
    totalMediumAmount: number;
}

export interface DripScanResult {
    candidates: DripMatchCandidate[];
    summary: DripScanSummary;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MIN_DAY_DIFF = -1;
const MAX_DAY_DIFF = 5;
const BATCH_CREATED_WINDOW_MS = 15_000;

function toUtcDayMs(value: Date | string): number {
    const d = value instanceof Date ? value : new Date(value);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function toIsoString(value: Date | string): string {
    const d = value instanceof Date ? value : new Date(value);
    return d.toISOString();
}

function toCreatedTimeMs(value?: Date | string | null): number | null {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function formatDayDiffReason(dayDiff: number): string {
    if (dayDiff === 0) return 'Same Day';
    return dayDiff > 0 ? `+${dayDiff}d` : `${dayDiff}d`;
}

interface EvaluatedPair {
    dividend: DripScanActivity;
    buy: DripScanActivity;
    confidence: DripConfidence;
    matchKind: DripMatchKind;
    reasons: string[];
    dayDiff: number;
    amountDiff: number;
    amountDiffPct: number;
    divAmount: number;
    buyCost: number;
    buyFee: number;
    score: number;
}

function evaluatePair(
    dividend: DripScanActivity,
    buy: DripScanActivity
): EvaluatedPair | null {
    const divAmount = Math.abs((dividend.quantity || 0) * (dividend.price || 0));
    const buyQty = Math.abs(buy.quantity || 0);
    const buyFee = Math.abs(buy.fee || 0);
    const buyPrincipal = buyQty * (buy.price || 0);
    const buyCost = buyPrincipal + buyFee;

    if (divAmount <= 0 || buyQty <= 0 || buyPrincipal <= 0) {
        return null;
    }

    const dayDiff = Math.round((toUtcDayMs(buy.date) - toUtcDayMs(dividend.date)) / MS_PER_DAY);
    if (dayDiff < MIN_DAY_DIFF || dayDiff > MAX_DAY_DIFF) {
        return null;
    }

    const absDayDiff = Math.abs(dayDiff);
    const amountDiff = Math.abs(buyCost - divAmount);
    const amountDiffPct = amountDiff / divAmount;

    // Exact cost match: total BUY outlay matches dividend payout within rounding precision.
    const isExactCostMatch = amountDiff <= 0.05 || amountDiffPct <= 0.001;
    // Close rounding match: covers historical 4-decimal share rounding with zero fee.
    const isCloseRoundingMatch =
        buyFee === 0 && amountDiff <= Math.max(0.5, divAmount * 0.01);

    const divCreatedMs = toCreatedTimeMs(dividend.createdAt);
    const buyCreatedMs = toCreatedTimeMs(buy.createdAt);
    const isBatchPair =
        divCreatedMs !== null &&
        buyCreatedMs !== null &&
        Math.abs(buyCreatedMs - divCreatedMs) <= BATCH_CREATED_WINDOW_MS &&
        (isExactCostMatch || isCloseRoundingMatch);

    const isWholeShareMatch =
        buyFee === 0 &&
        buyQty >= 1 &&
        Math.abs(buyQty - Math.round(buyQty)) < 1e-6 &&
        buy.price > 0 &&
        divAmount - buyCost >= -0.05 &&
        divAmount - buyCost < buy.price;

    const ratio = buyCost / divAmount;
    const isNetOfTaxMatch =
        buyFee === 0 &&
        dayDiff >= -1 &&
        dayDiff <= 3 &&
        ratio >= 0.68 &&
        ratio <= 0.92;

    if (
        !isExactCostMatch &&
        !isCloseRoundingMatch &&
        !isWholeShareMatch &&
        !isNetOfTaxMatch
    ) {
        return null;
    }

    // +/- 1 day window with exact total cost or close DRIP rounding belongs to High Confidence.
    const qualifiesHigh =
        absDayDiff <= 1 &&
        (isExactCostMatch || isCloseRoundingMatch) &&
        (buyFee === 0 || isExactCostMatch);

    const confidence: DripConfidence = qualifiesHigh ? 'HIGH' : 'MEDIUM';

    let matchKind: DripMatchKind;
    if (isBatchPair) {
        matchKind = 'BATCH_PAIR';
    } else if (isExactCostMatch) {
        matchKind = 'EXACT_COST';
    } else if (isCloseRoundingMatch) {
        matchKind = 'ROUNDED_DRIP';
    } else if (isWholeShareMatch) {
        matchKind = 'WHOLE_SHARE';
    } else {
        matchKind = 'NET_OF_TAX';
    }

    const reasons: string[] = [];
    if (isExactCostMatch) reasons.push('Exact Cost Match');
    else if (isCloseRoundingMatch) reasons.push('Close Amount (~4-dec)');
    else if (isWholeShareMatch) reasons.push('Whole-Share DRIP');
    else if (isNetOfTaxMatch) reasons.push(`Net-of-Tax (~${Math.round(ratio * 100)}%)`);

    reasons.push(formatDayDiffReason(dayDiff));
    if (buyFee === 0) reasons.push('Zero Fee');
    if (isBatchPair) reasons.push('Ascend Batch');

    let score = confidence === 'HIGH' ? 1000 : 500;
    if (isExactCostMatch) score += 300;
    else if (isCloseRoundingMatch) score += 160;
    else if (isWholeShareMatch) score += 80;
    if (isBatchPair) score += 200;
    if (absDayDiff === 0) score += 100;
    else if (absDayDiff === 1) score += 60;
    else score -= absDayDiff * 10;
    if (buyFee === 0) score += 25;
    score -= Math.min(200, amountDiffPct * 200);

    return {
        dividend,
        buy,
        confidence,
        matchKind,
        reasons,
        dayDiff,
        amountDiff,
        amountDiffPct,
        divAmount,
        buyCost,
        buyFee,
        score
    };
}

/**
 * Scans portfolio activities to identify historical BUY transactions that
 * were likely Dividend Reinvestments (DRIPs), using 1-to-1 greedy pairing per
 * (investmentId, accountId) bucket.
 */
export function scanDripCandidates(activities: DripScanActivity[]): DripScanResult {
    const groups = new Map<string, DripScanActivity[]>();

    let totalScannedBuys = 0;
    let existingDripCount = 0;

    for (const act of activities) {
        if (act.type === 'BUY') totalScannedBuys += 1;
        if (act.type === 'DRIP') existingDripCount += 1;

        if (act.type !== 'DIVIDEND' && act.type !== 'BUY' && act.type !== 'DRIP') {
            continue;
        }

        const key = `${act.investmentId}|${act.accountId || 'none'}`;
        const list = groups.get(key);
        if (list) {
            list.push(act);
        } else {
            groups.set(key, [act]);
        }
    }

    const candidates: DripMatchCandidate[] = [];

    for (const group of groups.values()) {
        const dividends = group.filter((a) => a.type === 'DIVIDEND');
        const existingDrips = group.filter((a) => a.type === 'DRIP');
        const buys = group.filter((a) => a.type === 'BUY');

        if (dividends.length === 0 || buys.length === 0) {
            continue;
        }

        const consumedDividendIds = new Set<string>();

        // 1. Reserve dividends already paired with existing DRIP activities
        if (existingDrips.length > 0) {
            const dripPairs: EvaluatedPair[] = [];
            for (const div of dividends) {
                for (const drip of existingDrips) {
                    const evaluated = evaluatePair(div, drip);
                    if (evaluated) dripPairs.push(evaluated);
                }
            }
            dripPairs.sort((a, b) => b.score - a.score);
            const consumedDripIds = new Set<string>();
            for (const pair of dripPairs) {
                if (consumedDividendIds.has(pair.dividend.id) || consumedDripIds.has(pair.buy.id)) {
                    continue;
                }
                consumedDividendIds.add(pair.dividend.id);
                consumedDripIds.add(pair.buy.id);
            }
        }

        // 2. Evaluate candidate (DIVIDEND, BUY) pairs on remaining dividends
        const buyPairs: EvaluatedPair[] = [];
        for (const div of dividends) {
            if (consumedDividendIds.has(div.id)) continue;
            for (const buy of buys) {
                const evaluated = evaluatePair(div, buy);
                if (evaluated) buyPairs.push(evaluated);
            }
        }

        // Rank strongest exact-cost & closest-date pairs first for clean 1-to-1 matching
        buyPairs.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (a.amountDiff !== b.amountDiff) return a.amountDiff - b.amountDiff;
            return a.buy.id.localeCompare(b.buy.id);
        });

        const matchedBuyIds = new Set<string>();

        for (const pair of buyPairs) {
            if (consumedDividendIds.has(pair.dividend.id) || matchedBuyIds.has(pair.buy.id)) {
                continue;
            }
            consumedDividendIds.add(pair.dividend.id);
            matchedBuyIds.add(pair.buy.id);

            const buy = pair.buy;
            const div = pair.dividend;

            candidates.push({
                buyId: buy.id,
                dividendId: div.id,
                investmentId: buy.investmentId,
                symbol: buy.investment?.symbol || 'UNKNOWN',
                investmentName: buy.investment?.name || '',
                accountId: buy.accountId ?? null,
                accountName: buy.account?.name || 'Unassigned',
                accountType: buy.account?.type || '',
                platformName: buy.platform?.name || '',
                currency: buy.currency || div.currency || 'USD',
                buyDate: toIsoString(buy.date),
                buyQuantity: Math.abs(buy.quantity),
                buyPrice: buy.price,
                buyFee: pair.buyFee,
                buyCost: pair.buyCost,
                dividendDate: toIsoString(div.date),
                dividendQuantity: Math.abs(div.quantity),
                dividendRate: div.price,
                dividendAmount: pair.divAmount,
                dayDiff: pair.dayDiff,
                amountDiff: pair.amountDiff,
                amountDiffPct: pair.amountDiffPct,
                confidence: pair.confidence,
                matchKind: pair.matchKind,
                reasons: pair.reasons
            });
        }
    }

    // Sort results: HIGH confidence first, then newest BUY date descending
    candidates.sort((a, b) => {
        if (a.confidence !== b.confidence) {
            return a.confidence === 'HIGH' ? -1 : 1;
        }
        const timeDiff = new Date(b.buyDate).getTime() - new Date(a.buyDate).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.symbol.localeCompare(b.symbol);
    });

    const highCandidates = candidates.filter((c) => c.confidence === 'HIGH');
    const mediumCandidates = candidates.filter((c) => c.confidence === 'MEDIUM');

    return {
        candidates,
        summary: {
            totalScannedBuys,
            highCount: highCandidates.length,
            mediumCount: mediumCandidates.length,
            existingDripCount,
            totalHighAmount: highCandidates.reduce((sum, c) => sum + c.buyCost, 0),
            totalMediumAmount: mediumCandidates.reduce((sum, c) => sum + c.buyCost, 0)
        }
    };
}
