export interface Transaction {
    amount: number; // Negative for outflow (Buy), Positive for inflow (Sell, Dividend, Current Value)
    date: Date;
}

export function calculateXIRR(transactions: Transaction[], guess: number = 0.1): number | null {
    if (!Array.isArray(transactions) || transactions.length < 2) return null;

    // # Reason: Avoid mutating the caller's array and filter out non-finite or zero-amount entries
    // before checking sign balance and date span.
    const valid = transactions
        .map(t => ({
            amount: Number(t?.amount),
            date: t?.date instanceof Date ? t.date : new Date(t?.date)
        }))
        .filter(t => Number.isFinite(t.amount) && Math.abs(t.amount) > 1e-12 && !Number.isNaN(t.date.getTime()));

    if (valid.length < 2) return null;

    let hasPositive = false;
    let hasNegative = false;
    let totalMagnitude = 0;
    for (const t of valid) {
        if (t.amount > 0) hasPositive = true;
        if (t.amount < 0) hasNegative = true;
        totalMagnitude += Math.abs(t.amount);
    }
    if (!hasPositive || !hasNegative) return null;

    const sorted = [...valid].sort((a, b) => a.date.getTime() - b.date.getTime());
    const t0 = sorted[0].date.getTime();
    const MS_PER_DAY = 1000 * 60 * 60 * 24;

    const periods = sorted.map(t => ({
        amount: t.amount,
        years: (t.date.getTime() - t0) / MS_PER_DAY / 365
    }));

    const maxYears = periods[periods.length - 1].years;
    if (maxYears <= 0) return null;

    const f = (x: number): number => {
        if (!Number.isFinite(x) || x <= -1) return Number.NaN;
        const base = 1 + x;
        let sum = 0;
        for (const p of periods) {
            sum += p.amount / Math.pow(base, p.years);
        }
        return sum;
    };

    const df = (x: number): number => {
        if (!Number.isFinite(x) || x <= -1) return Number.NaN;
        const base = 1 + x;
        let sum = 0;
        for (const p of periods) {
            if (p.years === 0) continue;
            sum += (-p.years * p.amount) / Math.pow(base, p.years + 1);
        }
        return sum;
    };

    const stepTol = 1e-7;
    const npvTol = Math.max(1e-4, totalMagnitude * 1e-7);

    // 1. Try damped Newton-Raphson from primary guess and fallback seeds
    const initialGuess = Number.isFinite(guess) && guess > -0.99 ? guess : 0.1;
    const seeds = Array.from(new Set([initialGuess, 0.1, 0, -0.3, 0.5, -0.7]));

    for (const seed of seeds) {
        let x0 = seed;
        for (let i = 0; i < 100; i++) {
            const y = f(x0);
            if (!Number.isFinite(y)) break;
            if (Math.abs(y) <= npvTol) return x0;

            const dy = df(x0);
            if (!Number.isFinite(dy) || Math.abs(dy) < 1e-12) break;

            let x1 = x0 - y / dy;
            // # Reason: Fractional exponents (1 + x)^years require 1 + x > 0; damp steps that overshoot <= -1.
            if (x1 <= -1) {
                x1 = (x0 - 0.999999) / 2;
            }
            if (x1 > 1e6) {
                x1 = 1e6;
            }

            if (Math.abs(x1 - x0) < stepTol && Math.abs(f(x1)) <= npvTol) {
                return x1;
            }
            x0 = x1;
        }
    }

    // 2. Bracketed bisection fallback guarantees convergence for monotonic or volatile cash-flow series
    const grid = [
        -0.999999, -0.9999, -0.999, -0.99, -0.95, -0.9, -0.8, -0.7, -0.6, -0.5,
        -0.4, -0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75,
        1, 1.5, 2, 3, 5, 10, 25, 50, 100, 500, 5000
    ];

    for (let i = 0; i < grid.length - 1; i++) {
        let lo = grid[i];
        let hi = grid[i + 1];
        let fLo = f(lo);
        let fHi = f(hi);

        if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) continue;
        if (Math.abs(fLo) <= npvTol) return lo;
        if (Math.abs(fHi) <= npvTol) return hi;

        if (fLo * fHi < 0) {
            for (let iter = 0; iter < 100; iter++) {
                const mid = (lo + hi) / 2;
                const fMid = f(mid);
                if (!Number.isFinite(fMid)) break;
                if (Math.abs(fMid) <= npvTol || Math.abs(hi - lo) < stepTol) {
                    return mid;
                }
                if (fLo * fMid <= 0) {
                    hi = mid;
                    fHi = fMid;
                } else {
                    lo = mid;
                    fLo = fMid;
                }
            }
            return (lo + hi) / 2;
        }
    }

    return null;
}
