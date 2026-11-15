export interface DividendEventPoint {
    date: Date | string | number;
    perShareAmount: number;
}

export interface NormalizedDividendEvent {
    date: Date;
    perShareAmount: number;
}

export interface DividendEstimationResult {
    nextDate?: Date;
    nextAmount?: number;
    trailingAnnualRate?: number;
    annualizedRate?: number;
    cadenceDays?: number;
}

export interface AnalyzeDividendOptions {
    /** Reference date (typically UTC midnight today) for rolling forward and/or 12M windowing. */
    now?: Date;
    /** Filter events to the 12 months preceding `now` (use for multi-year activity histories). */
    filterLastYearFromNow?: boolean;
    /** Roll nextDate forward by the detected cadence until >= now (bounded by staleness). */
    rollForward?: boolean;
    /** Override max days since last dividend before rolling forward stops. */
    maxStaleDays?: number;
    /** Annualize regular monthly/quarterly/semi-annual cadences when history spans < ~1 year. */
    annualizeShortHistory?: boolean;
}

export interface PortfolioActivityLike {
    type: string;
    date: Date | string;
    quantity: number;
    price: number;
    fee?: number | null;
    accountId?: string | null;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const QUANTITY_EPSILON = 0.00001;

function toUtcDateKey(date: Date): string {
    return date.toISOString().split('T')[0];
}

function advanceDateByCadence(date: Date, intervalDays: number): Date {
    const next = new Date(date);
    if (intervalDays >= 25 && intervalDays <= 35) {
        next.setUTCDate(next.getUTCDate() + 30);
    } else if (intervalDays >= 85 && intervalDays <= 95) {
        next.setUTCDate(next.getUTCDate() + 91);
    } else if (intervalDays >= 360) {
        next.setUTCFullYear(next.getUTCFullYear() + 1);
    } else {
        next.setUTCDate(next.getUTCDate() + intervalDays);
    }
    return next;
}

function getMedianIntervalDays(eventsDesc: NormalizedDividendEvent[]): number {
    const intervals: number[] = [];
    const maxPairs = Math.min(3, eventsDesc.length - 1);
    for (let i = 0; i < maxPairs; i++) {
        const diffMs = Math.abs(eventsDesc[i].date.getTime() - eventsDesc[i + 1].date.getTime());
        const days = Math.ceil(diffMs / MS_PER_DAY);
        if (days > 0) intervals.push(days);
    }
    if (intervals.length === 0) return 0;
    const sorted = [...intervals].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Deduplicates dividend events by UTC day, trims 12M boundary overlaps for regular cadences,
 * computes trailing/annualized dividend rates, and estimates the next payout date & amount.
 */
export function analyzeDividendHistory(
    rawEvents: DividendEventPoint[],
    options: AnalyzeDividendOptions = {}
): DividendEstimationResult | undefined {
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) return undefined;

    // Group same-day events (e.g., multi-account payouts on the same day) into distinct dates
    const byDay = new Map<string, { date: Date; sum: number; count: number }>();
    for (const raw of rawEvents) {
        const dateObj = new Date(raw?.date);
        const amount = Number(raw?.perShareAmount);
        if (Number.isNaN(dateObj.getTime()) || !Number.isFinite(amount) || amount <= 0) continue;

        const key = toUtcDateKey(dateObj);
        const existing = byDay.get(key);
        if (existing) {
            existing.sum += amount;
            existing.count += 1;
        } else {
            byDay.set(key, { date: dateObj, sum: amount, count: 1 });
        }
    }

    const validEvents: NormalizedDividendEvent[] = Array.from(byDay.values())
        .map(item => ({ date: item.date, perShareAmount: item.sum / item.count }))
        .sort((a, b) => b.date.getTime() - a.date.getTime());
    if (validEvents.length === 0) return undefined;

    const eventsLastYear = options.filterLastYearFromNow && options.now
        ? (() => {
            const oneYearAgo = new Date(options.now);
            oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
            return validEvents.filter(e => e.date >= oneYearAgo);
        })()
        : validEvents;

    // # Reason: A 365-day window can catch an extra edge-date payment (e.g., 13 monthly, 5 quarterly,
    // 3 semi-annual, or 2 annual payouts) when ex-dates shift slightly YoY; trim the extra boundary payout.
    let annualEvents = eventsLastYear;
    if (eventsLastYear.length >= 2) {
        const intervals: number[] = [];
        for (let i = 0; i < eventsLastYear.length - 1; i++) {
            const gapDays = (eventsLastYear[i].date.getTime() - eventsLastYear[i + 1].date.getTime()) / MS_PER_DAY;
            intervals.push(gapDays);
        }
        const isMonthlySeries = eventsLastYear.length === 13 && intervals.every(d => d >= 20 && d <= 40);
        const isQuarterlySeries = eventsLastYear.length === 5 && intervals.every(d => d >= 75 && d <= 105);
        const isSemiAnnualSeries = eventsLastYear.length === 3 && intervals.every(d => d >= 150 && d <= 210);
        const isAnnualSeries = eventsLastYear.length === 2 && intervals[0] >= 330;
        if (isMonthlySeries) {
            annualEvents = eventsLastYear.slice(0, 12);
        } else if (isQuarterlySeries) {
            annualEvents = eventsLastYear.slice(0, 4);
        } else if (isSemiAnnualSeries) {
            annualEvents = eventsLastYear.slice(0, 2);
        } else if (isAnnualSeries) {
            annualEvents = eventsLastYear.slice(0, 1);
        }
    }

    const trailingAnnualRate = annualEvents.reduce((sum, e) => sum + e.perShareAmount, 0);

    if (validEvents.length < 2) {
        return trailingAnnualRate > 0 ? { trailingAnnualRate, annualizedRate: trailingAnnualRate } : undefined;
    }

    const cadenceDays = getMedianIntervalDays(validEvents);
    if (cadenceDays <= 0) {
        return trailingAnnualRate > 0 ? { trailingAnnualRate, annualizedRate: trailingAnnualRate } : undefined;
    }

    let annualizedRate = trailingAnnualRate;
    if (options.annualizeShortHistory && validEvents.length >= 2) {
        const spanDays = (validEvents[0].date.getTime() - validEvents[validEvents.length - 1].date.getTime()) / MS_PER_DAY;
        if (spanDays < 320) {
            const recentCount = Math.min(3, validEvents.length);
            const recentAvg = validEvents.slice(0, recentCount).reduce((s, e) => s + e.perShareAmount, 0) / recentCount;
            if (cadenceDays >= 25 && cadenceDays <= 35 && eventsLastYear.length < 12) {
                annualizedRate = Math.max(trailingAnnualRate, recentAvg * 12);
            } else if (cadenceDays >= 85 && cadenceDays <= 95 && eventsLastYear.length < 4) {
                annualizedRate = Math.max(trailingAnnualRate, recentAvg * 4);
            } else if (cadenceDays >= 170 && cadenceDays <= 195 && eventsLastYear.length < 2) {
                annualizedRate = Math.max(trailingAnnualRate, recentAvg * 2);
            }
        }
    }

    let nextDate = advanceDateByCadence(validEvents[0].date, cadenceDays);

    if (options.rollForward && options.now) {
        const refDate = new Date(options.now);
        const daysSinceLast = (refDate.getTime() - validEvents[0].date.getTime()) / MS_PER_DAY;
        const maxStaleDays = options.maxStaleDays ?? Math.max(120, cadenceDays * 4);

        if (daysSinceLast > maxStaleDays) {
            // Dividend appears discontinued/too stale to project forward safely
            return {
                nextDate,
                nextAmount: validEvents[0].perShareAmount,
                trailingAnnualRate: trailingAnnualRate > 0 ? trailingAnnualRate : undefined,
                annualizedRate: annualizedRate > 0 ? annualizedRate : undefined,
                cadenceDays
            };
        }

        let steps = 0;
        while (nextDate < refDate && steps < 24) {
            nextDate = advanceDateByCadence(nextDate, cadenceDays);
            steps++;
        }
    }

    return {
        nextDate,
        nextAmount: validEvents[0].perShareAmount,
        trailingAnnualRate: trailingAnnualRate > 0 ? trailingAnnualRate : undefined,
        annualizedRate: annualizedRate > 0 ? annualizedRate : undefined,
        cadenceDays
    };
}

/**
 * Reconstructs split-adjusted per-share dividend events from recorded Ascend activities
 * for a single symbol (sorted ascending by date). Supports both per-share dividend entries
 * (`qty = shares, price = rate`), lump-sum entries (`qty = 1, price = totalPayout`),
 * and multi-account STOCK_SPLIT rows without ratio^N compounding.
 */
export function buildPerShareDividendEventsFromActivities(
    activities: PortfolioActivityLike[],
    behaviorMap: Map<string, string>
): DividendEventPoint[] {
    const sharesByAccount = new Map<string, number>();
    const appliedCorporateSplits = new Set<string>();
    const appliedAccountSplits = new Set<string>();

    const getTotalRunningShares = (): number => {
        let total = 0;
        for (const qty of sharesByAccount.values()) {
            total += qty;
        }
        return total;
    };

    const perDay = new Map<string, {
        date: Date;
        totalNetCash: number;
        sharesAtDay: number;
        weightedRateCash: number;
        weightedRateQty: number;
        hasExplicitShareQty: boolean;
    }>();

    const eventsInOrder: { date: Date; ratePerShare: number }[] = [];

    const flushDayIfPending = (key: string) => {
        const entry = perDay.get(key);
        if (!entry) return;
        perDay.delete(key);

        let ratePerShare = 0;
        if (entry.hasExplicitShareQty && entry.weightedRateQty > QUANTITY_EPSILON) {
            ratePerShare = entry.weightedRateCash / entry.weightedRateQty;
        } else if (entry.sharesAtDay > QUANTITY_EPSILON) {
            ratePerShare = entry.totalNetCash / entry.sharesAtDay;
        }
        if (ratePerShare > 0) {
            eventsInOrder.push({ date: entry.date, ratePerShare });
        }
    };

    let currentDayKey: string | null = null;

    for (const activity of activities) {
        const dateObj = new Date(activity.date);
        if (Number.isNaN(dateObj.getTime())) continue;

        const dayKey = toUtcDateKey(dateObj);
        if (currentDayKey && currentDayKey !== dayKey) {
            flushDayIfPending(currentDayKey);
            currentDayKey = null;
        }

        const behavior = behaviorMap.get(activity.type) || 'NEUTRAL';
        const absQty = Math.abs(activity.quantity);
        const accKey = activity.accountId || '__unassigned__';

        if (behavior === 'ADD') {
            const nextQty = (sharesByAccount.get(accKey) || 0) + absQty;
            sharesByAccount.set(accKey, nextQty);
        } else if (behavior === 'REMOVE') {
            const nextQty = Math.max(0, (sharesByAccount.get(accKey) || 0) - absQty);
            sharesByAccount.set(accKey, nextQty < 1e-9 ? 0 : nextQty);
        } else if (behavior === 'SPLIT') {
            if (currentDayKey) {
                flushDayIfPending(currentDayKey);
                currentDayKey = null;
            }
            if (absQty > 0) {
                if (activity.accountId) {
                    const splitAccKey = `${dayKey}:${activity.accountId}:${absQty}`;
                    if (!appliedAccountSplits.has(splitAccKey)) {
                        appliedAccountSplits.add(splitAccKey);
                        const prevAccQty = sharesByAccount.get(activity.accountId) || 0;
                        if (prevAccQty > 0) {
                            sharesByAccount.set(activity.accountId, prevAccQty * absQty);
                        }
                    }
                } else {
                    const hasUnassigned = (sharesByAccount.get('__unassigned__') || 0) > 0;
                    if (hasUnassigned) {
                        const splitUnassignedKey = `${dayKey}:__unassigned__:${absQty}`;
                        if (!appliedAccountSplits.has(splitUnassignedKey)) {
                            appliedAccountSplits.add(splitUnassignedKey);
                            sharesByAccount.set('__unassigned__', (sharesByAccount.get('__unassigned__') || 0) * absQty);
                        }
                    } else {
                        const splitGlobalKey = `${dayKey}:__global__:${absQty}`;
                        if (!appliedAccountSplits.has(splitGlobalKey)) {
                            appliedAccountSplits.add(splitGlobalKey);
                            for (const [k, qty] of sharesByAccount.entries()) {
                                sharesByAccount.set(k, qty * absQty);
                            }
                        }
                    }
                }

                // # Reason: SplitService writes one STOCK_SPLIT row per account; adjust historical
                // per-share dividend rates only once per corporate split day+ratio.
                const corporateSplitKey = `${dayKey}:${absQty}`;
                if (!appliedCorporateSplits.has(corporateSplitKey)) {
                    appliedCorporateSplits.add(corporateSplitKey);
                    for (const prev of eventsInOrder) {
                        prev.ratePerShare /= absQty;
                    }
                }
            }
        } else if (activity.type === 'DIVIDEND') {
            const netCash = Math.max(0, absQty * activity.price - (activity.fee || 0));
            if (netCash <= 0) continue;

            const totalRunningShares = getTotalRunningShares();
            const isExplicitShareQty = Math.abs(absQty - 1) > QUANTITY_EPSILON;
            currentDayKey = dayKey;
            const existing = perDay.get(dayKey);
            if (existing) {
                existing.totalNetCash += netCash;
                existing.sharesAtDay = Math.max(existing.sharesAtDay, totalRunningShares);
                existing.weightedRateCash += netCash;
                existing.weightedRateQty += absQty;
                existing.hasExplicitShareQty = existing.hasExplicitShareQty || isExplicitShareQty;
            } else {
                perDay.set(dayKey, {
                    date: dateObj,
                    totalNetCash: netCash,
                    sharesAtDay: totalRunningShares,
                    weightedRateCash: netCash,
                    weightedRateQty: absQty,
                    hasExplicitShareQty: isExplicitShareQty
                });
            }
        }
    }

    if (currentDayKey) {
        flushDayIfPending(currentDayKey);
    }

    return eventsInOrder.map(ev => ({
        date: ev.date,
        perShareAmount: ev.ratePerShare
    }));
}
