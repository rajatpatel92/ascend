export interface RebalanceItem {
    symbol: string;
    currentPercent: number;
    targetPercent: number;
    glidePathPercent: number | null;
    driftPercent: number;
    currentValue: number;
    targetValue: number;
    driftValue: number;
    action: string;
    actionShares: number;
    assetPrice: number;
    assetCurrency: string;
}

export interface TargetConfig {
    symbol: string;
    targetPercentage: number;
    yearlyDriftAdjustment: number | null;
}

export type RebalanceMode = 'FULL' | 'BUY_ONLY';

export interface RebalancePlanOptions {
    mode: RebalanceMode;
    newCash: number;
    tolerancePercent: number;
    wholeShares: boolean;
}

export interface PlannedRebalanceRow extends RebalanceItem {
    effectiveAction: 'BUY' | 'SELL' | 'HOLD';
    tradeValue: number;
    tradeShares: number;
    postTradeValue: number;
    postTradePercent: number;
    postTradeDriftPercent: number;
    isOutOfBand: boolean;
    isUntargeted: boolean;
}

export interface RebalancePlanSummary {
    totalValue: number;
    postTradeTotalValue: number;
    totalBuyValue: number;
    totalSellValue: number;
    unallocatedCash: number;
    buyCount: number;
    sellCount: number;
    holdCount: number;
    outOfBandCount: number;
    maxAbsDrift: number;
    portfolioTurnoverPercent: number;
    targetSumPercent: number;
    targetedCount: number;
    untargetedCount: number;
    glideActiveCount: number;
}

export interface RebalancePlanResult {
    rows: PlannedRebalanceRow[];
    summary: RebalancePlanSummary;
}

const VALUE_EPSILON = 0.01;

/**
 * Computes share price expressed in the user's selected display/target currency.
 * Falls back cleanly when actionShares or driftValue are zero.
 */
function inferPriceInDisplayCurrency(item: RebalanceItem): number {
    if (item.actionShares > 0.000001 && Math.abs(item.driftValue) > VALUE_EPSILON) {
        return Math.abs(item.driftValue) / item.actionShares;
    }
    return item.assetPrice > 0 ? item.assetPrice : 0;
}

/**
 * Formats share counts cleanly without losing precision on high-priced assets/fractional shares.
 */
export function formatShareCount(shares: number, wholeShares: boolean): string {
    if (!Number.isFinite(shares) || shares <= 0) return '0';
    if (wholeShares) {
        return Math.round(shares).toLocaleString();
    }
    if (shares >= 100) {
        return Number(shares.toFixed(1)).toLocaleString(undefined, { maximumFractionDigits: 1 });
    }
    if (shares >= 1) {
        return Number(shares.toFixed(2)).toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return Number(shares.toFixed(4)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Computes an actionable rebalance plan supporting Full (Buy/Sell) and Buy-Only (Cash Inflow)
 * modes, drift tolerance bands, and whole vs. fractional share constraints.
 */
export function computeRebalancePlan(
    items: RebalanceItem[],
    options: RebalancePlanOptions
): RebalancePlanResult {
    const safeNewCash = options.mode === 'BUY_ONLY' && Number.isFinite(options.newCash)
        ? Math.max(0, options.newCash)
        : 0;
    const safeTolerance = Number.isFinite(options.tolerancePercent)
        ? Math.max(0, options.tolerancePercent)
        : 0;

    const totalValue = items.reduce((sum, item) => sum + item.currentValue, 0);
    const targetSumPercent = items.reduce((sum, item) => sum + item.targetPercent, 0);
    const targetedCount = items.filter((item) => item.targetPercent > 0).length;
    const untargetedCount = items.filter((item) => item.targetPercent <= 0 && item.currentValue > VALUE_EPSILON).length;
    const glideActiveCount = items.filter((item) => item.glidePathPercent !== null && item.glidePathPercent !== 0).length;

    const priceMap = new Map<string, number>();
    for (const item of items) {
        priceMap.set(item.symbol, inferPriceInDisplayCurrency(item));
    }

    // Raw currency trade delta (+ = BUY, - = SELL) before share rounding
    const rawDeltaBySymbol = new Map<string, number>();

    if (options.mode === 'FULL') {
        for (const item of items) {
            const isOutOfBand = Math.abs(item.driftPercent) > safeTolerance + 1e-9;
            // driftValue = currentValue - targetValue -> negative driftValue means BUY
            const delta = isOutOfBand && Math.abs(item.driftValue) > VALUE_EPSILON
                ? -item.driftValue
                : 0;
            rawDeltaBySymbol.set(item.symbol, delta);
        }
    } else {
        // BUY_ONLY mode: deploy safeNewCash to reduce underweight deficits without selling
        const postCashTotal = totalValue + safeNewCash;
        const shortfalls = items.map((item) => {
            const isOutOfBand = item.driftPercent < -(safeTolerance + 1e-9) || safeNewCash > VALUE_EPSILON;
            const idealValue = (item.targetPercent / 100) * postCashTotal;
            const deficit = item.targetPercent > 0 && isOutOfBand
                ? Math.max(0, idealValue - item.currentValue)
                : 0;
            return { symbol: item.symbol, targetPercent: item.targetPercent, deficit };
        });

        const totalShortfall = shortfalls.reduce((sum, entry) => sum + entry.deficit, 0);

        if (safeNewCash <= VALUE_EPSILON) {
            for (const item of items) {
                rawDeltaBySymbol.set(item.symbol, 0);
            }
        } else if (totalShortfall > VALUE_EPSILON) {
            if (safeNewCash <= totalShortfall) {
                const ratio = safeNewCash / totalShortfall;
                for (const entry of shortfalls) {
                    rawDeltaBySymbol.set(entry.symbol, entry.deficit * ratio);
                }
            } else {
                // Fill all deficits first, then allocate surplus cash proportionally to target weights
                const surplus = safeNewCash - totalShortfall;
                const positiveTargetSum = items.reduce(
                    (sum, item) => sum + (item.targetPercent > 0 ? item.targetPercent : 0),
                    0
                );
                for (const entry of shortfalls) {
                    const extra = positiveTargetSum > 0 && entry.targetPercent > 0
                        ? surplus * (entry.targetPercent / positiveTargetSum)
                        : 0;
                    rawDeltaBySymbol.set(entry.symbol, entry.deficit + extra);
                }
            }
        } else if (targetSumPercent > 0) {
            // Portfolio is already balanced or overweight on targeted items; distribute across targets
            for (const item of items) {
                const allocation = item.targetPercent > 0
                    ? safeNewCash * (item.targetPercent / targetSumPercent)
                    : 0;
                rawDeltaBySymbol.set(item.symbol, allocation);
            }
        }
    }

    // Apply share rounding & price constraints
    let totalBuyValue = 0;
    let totalSellValue = 0;

    const intermediate = items.map((item) => {
        const rawDelta = rawDeltaBySymbol.get(item.symbol) || 0;
        const unitPrice = priceMap.get(item.symbol) || 0;
        const isOutOfBand = Math.abs(item.driftPercent) > safeTolerance + 1e-9;

        let effectiveAction: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
        let tradeValue = 0;
        let tradeShares = 0;

        if (Math.abs(rawDelta) > VALUE_EPSILON && unitPrice > 0) {
            const rawShares = Math.abs(rawDelta) / unitPrice;
            if (options.wholeShares) {
                const wholeCount = options.mode === 'BUY_ONLY'
                    ? Math.floor(rawShares)
                    : Math.round(rawShares);
                if (wholeCount >= 1) {
                    tradeShares = wholeCount;
                    tradeValue = wholeCount * unitPrice;
                    effectiveAction = rawDelta > 0 ? 'BUY' : 'SELL';
                }
            } else if (rawShares >= 0.0001) {
                tradeShares = rawShares;
                tradeValue = Math.abs(rawDelta);
                effectiveAction = rawDelta > 0 ? 'BUY' : 'SELL';
            }
        }

        if (effectiveAction === 'BUY') totalBuyValue += tradeValue;
        if (effectiveAction === 'SELL') totalSellValue += tradeValue;

        const signedDelta = effectiveAction === 'BUY'
            ? tradeValue
            : effectiveAction === 'SELL'
                ? -tradeValue
                : 0;

        return {
            item,
            isOutOfBand,
            effectiveAction,
            tradeValue,
            tradeShares,
            postTradeValue: Math.max(0, item.currentValue + signedDelta)
        };
    });

    const rawUnallocated = options.mode === 'BUY_ONLY'
        ? Math.max(0, safeNewCash - totalBuyValue)
        : 0;
    const unallocatedCash = rawUnallocated < VALUE_EPSILON ? 0 : rawUnallocated;

    const postTradeAssetsTotal = intermediate.reduce((sum, entry) => sum + entry.postTradeValue, 0);
    const postTradeTotalValue = postTradeAssetsTotal + unallocatedCash;

    let buyCount = 0;
    let sellCount = 0;
    let holdCount = 0;
    let outOfBandCount = 0;
    let maxAbsDrift = 0;
    let absDriftSum = 0;

    const rows: PlannedRebalanceRow[] = intermediate.map((entry) => {
        const { item, isOutOfBand, effectiveAction, tradeValue, tradeShares, postTradeValue } = entry;
        if (effectiveAction === 'BUY') buyCount += 1;
        else if (effectiveAction === 'SELL') sellCount += 1;
        else holdCount += 1;

        if (isOutOfBand) outOfBandCount += 1;
        const absDrift = Math.abs(item.driftPercent);
        if (absDrift > maxAbsDrift) maxAbsDrift = absDrift;
        absDriftSum += absDrift;

        const postTradePercent = postTradeTotalValue > 0
            ? (postTradeValue / postTradeTotalValue) * 100
            : 0;
        const postTradeDriftPercent = postTradePercent - item.targetPercent;

        return {
            ...item,
            effectiveAction,
            tradeValue,
            tradeShares,
            postTradeValue,
            postTradePercent,
            postTradeDriftPercent,
            isOutOfBand,
            isUntargeted: item.targetPercent <= 0 && item.currentValue > VALUE_EPSILON
        };
    });

    const portfolioTurnoverPercent = absDriftSum / 2;

    return {
        rows,
        summary: {
            totalValue,
            postTradeTotalValue,
            totalBuyValue,
            totalSellValue,
            unallocatedCash,
            buyCount,
            sellCount,
            holdCount,
            outOfBandCount,
            maxAbsDrift,
            portfolioTurnoverPercent,
            targetSumPercent,
            targetedCount,
            untargetedCount,
            glideActiveCount
        }
    };
}

/**
 * Proportionally scales non-zero target allocations so their sum is exactly 100.0%.
 */
export function normalizeTargetsTo100(targets: TargetConfig[]): TargetConfig[] {
    const positive = targets.filter((t) => t.targetPercentage > 0 && t.symbol.trim() !== '');
    const total = positive.reduce((sum, t) => sum + t.targetPercentage, 0);
    if (total <= 0) return targets;

    const scaled = targets.map((t) => {
        if (t.targetPercentage <= 0 || t.symbol.trim() === '') {
            return { ...t, targetPercentage: 0 };
        }
        return {
            ...t,
            targetPercentage: Math.round(((t.targetPercentage / total) * 100) * 10) / 10
        };
    });

    // Adjust largest positive weight so total is exactly 100.0 after 1-decimal rounding
    const roundedTotal = scaled.reduce((sum, t) => sum + t.targetPercentage, 0);
    const diff = Math.round((100 - roundedTotal) * 10) / 10;
    if (Math.abs(diff) > 0) {
        let maxIdx = -1;
        let maxVal = -1;
        scaled.forEach((t, idx) => {
            if (t.targetPercentage > maxVal) {
                maxVal = t.targetPercentage;
                maxIdx = idx;
            }
        });
        if (maxIdx !== -1) {
            scaled[maxIdx] = {
                ...scaled[maxIdx],
                targetPercentage: Math.max(0, Math.round((scaled[maxIdx].targetPercentage + diff) * 10) / 10)
            };
        }
    }

    return scaled;
}

/**
 * Seeds target configurations from current portfolio weights while preserving any existing glide-path rules.
 */
export function seedTargetsFromHoldings(
    items: RebalanceItem[],
    existingTargets: TargetConfig[]
): TargetConfig[] {
    const existingMap = new Map(
        existingTargets.map((t) => [t.symbol.trim().toUpperCase(), t])
    );

    const active = items.filter((item) => item.currentValue > VALUE_EPSILON || item.currentPercent > 0.05);
    if (active.length === 0) return existingTargets;

    const rawTargets: TargetConfig[] = active.map((item) => {
        const existing = existingMap.get(item.symbol.toUpperCase());
        return {
            symbol: item.symbol,
            targetPercentage: Math.max(0, Math.round(item.currentPercent * 10) / 10),
            yearlyDriftAdjustment: existing?.yearlyDriftAdjustment ?? null
        };
    });

    return normalizeTargetsTo100(rawTargets).sort((a, b) => b.targetPercentage - a.targetPercentage);
}

export interface GlidePathPoint {
    yearLabel: string;
    year: number;
    totalPercent: number;
    [symbol: string]: string | number;
}

/**
 * Projects configured target allocations forward over the specified year horizons using each asset's glide path.
 */
export function buildGlidePathSeries(
    targets: TargetConfig[],
    years: number[] = [0, 1, 2, 3, 5]
): GlidePathPoint[] {
    const activeTargets = targets.filter((t) => t.symbol.trim() !== '' && (t.targetPercentage > 0 || (t.yearlyDriftAdjustment ?? 0) !== 0));
    return years.map((yr) => {
        const point: GlidePathPoint = {
            yearLabel: yr === 0 ? 'Today' : `+${yr}Y`,
            year: yr,
            totalPercent: 0
        };
        let sum = 0;
        for (const t of activeTargets) {
            const adj = t.yearlyDriftAdjustment ?? 0;
            const projected = Math.max(0, Math.round((t.targetPercentage + adj * yr) * 10) / 10);
            point[t.symbol] = projected;
            sum += projected;
        }
        point.totalPercent = Math.round(sum * 10) / 10;
        return point;
    });
}
