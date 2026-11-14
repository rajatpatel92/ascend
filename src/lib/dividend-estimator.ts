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
    const byDay = new Map<string, NormalizedDividendEvent>();
    for (const raw of rawEvents) {
        const dateObj = new Date(raw?.date);
        const amount = Number(raw?.perShareAmount);
        if (Number.isNaN(dateObj.getTime()) || !Number.isFinite(amount) || amount <= 0) continue;

        const key = toUtcDateKey(dateObj);
        const existing = byDay.get(key);
        if (existing) {
            existing.perShareAmount = (existing.perShareAmount + amount) / 2;
        } else {
            byDay.set(key, { date: dateObj, perShareAmount: amount });
        }
    }

    const validEvents = Array.from(byDay.values()).sort((a, b) => b.date.getTime() - a.date.getTime());
    if (validEvents.length === 0) return undefined;

    const eventsLastYear = options.filterLastYearFromNow && options.now
        ? (() => {
            const oneYearAgo = new Date(options.now);
            oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear() - 1);
            return validEvents.filter(e => e.date >= oneYearAgo);
        })()
        : validEvents;

    // # Reason: A 365-day window can catch an extra edge-date payment (e.g., 13 monthly or 5 quarterly
    // payouts) when ex-dates shift by a day or two YoY; trim the extra boundary payout for regular cadences.
    let annualEvents = eventsLastYear;
    if (eventsLastYear.length >= 2) {
        const intervals: number[] = [];
        for (let i = 0; i < eventsLastYear.length - 1; i++) {
            const gapDays = (eventsLastYear[i].date.getTime() - eventsLastYear[i + 1].date.getTime()) / MS_PER_DAY;
            intervals.push(gapDays);
        }
        const isMonthlySeries = eventsLastYear.length === 13 && intervals.every(d => d >= 20 && d <= 40);
        const isQuarterlySeries = eventsLastYear.length === 5 && intervals.every(d => d >= 75 && d <= 105);
        if (isMonthlySeries) {
            annualEvents = eventsLastYear.slice(0, 12);
        } else if (isQuarterlySeries) {
            annualEvents = eventsLastYear.slice(0, 4);
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
 * (`qty = shares, price = rate`) and lump-sum entries (`qty = 1, price = totalPayout`).
 */
export function buildPerShareDividendEventsFromActivities(
    activities: PortfolioActivityLike[],
    behaviorMap: Map<string, string>
): DividendEventPoint[] {
    let runningShares = 0;
    const perDay = new Map<string, {
        date: Date;
        totalNetCash: number;
        sharesAtDay: number;
        weightedRateCash: number;
        weightedRateQty: number;
        hasExplicitShareQty: boolean;
    }>();

    const eventsInOrder: { key: string; ratePerShare: number }[] = [];

    const flushDayIfPending = (key: string) => {
        const entry = perDay.get(key);
        if (!entry) return;
        let ratePerShare = 0;
        if (entry.hasExplicitShareQty && entry.weightedRateQty > QUANTITY_EPSILON) {
            ratePerShare = entry.weightedRateCash / entry.weightedRateQty;
        } else if (entry.sharesAtDay > QUANTITY_EPSILON) {
            ratePerShare = entry.totalNetCash / entry.sharesAtDay;
        }
        if (ratePerShare > 0) {
            eventsInOrder.push({ key, ratePerShare });
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

        if (behavior === 'ADD') {
            runningShares += absQty;
        } else if (behavior === 'REMOVE') {
            runningShares = Math.max(0, runningShares - absQty);
            if (runningShares < 1e-9) runningShares = 0;
        } else if (behavior === 'SPLIT') {
            if (currentDayKey) {
                flushDayIfPending(currentDayKey);
                currentDayKey = null;
            }
            if (absQty > 0) {
                runningShares *= absQty;
                // Adjust historical per-share payouts to current post-split share equivalents
                for (const prev of eventsInOrder) {
                    prev.ratePerShare /= absQty;
                }
            }
        } else if (activity.type === 'DIVIDEND') {
            const netCash = Math.max(0, absQty * activity.price - (activity.fee || 0));
            if (netCash <= 0) continue;

            const isExplicitShareQty = Math.abs(absQty - 1) > QUANTITY_EPSILON;
            currentDayKey = dayKey;
            const existing = perDay.get(dayKey);
            if (existing) {
                existing.totalNetCash += netCash;
                existing.sharesAtDay = Math.max(existing.sharesAtDay, runningShares);
                existing.weightedRateCash += netCash;
                existing.weightedRateQty += absQty;
                existing.hasExplicitShareQty = existing.hasExplicitShareQty || isExplicitShareQty;
            } else {
                perDay.set(dayKey, {
                    date: dateObj,
                    totalNetCash: netCash,
                    sharesAtDay: runningShares,
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
        date: perDay.get(ev.key)!.date,
        perShareAmount: ev.ratePerShare
    }));
}
