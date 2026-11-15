export interface HistoryPointInput {
    date: string;
    value: number;
    invested: number;
    nav?: number;
    marketValue?: number;
    dividend?: number;
    unreinvestedDividend?: number;
    priorValue?: number;
    priorInvested?: number;
    priorNav?: number;
    priorUnreinvestedDividend?: number;
}

export interface ChartDataPoint {
    date: string;
    dateNumber: number;
    value: number;
    invested: number;
    marketValue: number;
    dividend: number;
    unreinvestedDividend: number;
}

export interface ComputedPerformanceMetrics {
    chartData: ChartDataPoint[];
    returnChange: number;
    valueChange: number;
    totalContribution: number;
    avgContribution: number;
    periodMonths: number;
    minMarketValue: number;
    maxMarketValue: number;
    maxAbsReturn: number;
}

export function parseHistoryTimestamp(dateStr: string): number {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d, 12, 0, 0).getTime();
    }
    return new Date(dateStr).getTime();
}

/**
 * Derives chart series points and period summary metrics for PerformanceChart.
 *
 * # Reason: `invested` tracks out-of-pocket principal (excluding reinvested dividends),
 * so reinvested dividends are already reflected in `marketValue`. Adding only
 * `unreinvestedDividend` avoids double-counting reinvested dividends in Period P&L
 * while still crediting unspent cash dividends.
 */
export function computePerformanceChartMetrics(params: {
    data: HistoryPointInput[];
    range: string;
    overrideChange?: number;
    overrideChangePercent?: number;
}): ComputedPerformanceMetrics {
    const { data, range, overrideChange, overrideChangePercent } = params;

    const totalInvested = data.reduce((sum, point) => sum + point.invested, 0);
    const avgInv = data.length > 0 ? totalInvested / data.length : 0;
    const hasPriorNav = data[0]?.priorNav !== undefined && Number.isFinite(data[0].priorNav) && (data[0].priorNav || 0) > 0;

    const points: ChartDataPoint[] = data.map(point => {
        const value = point.value;
        const invested = point.invested;
        let returnPercent = 0;

        if (point.nav !== undefined) {
            const startNav = hasPriorNav ? (data[0].priorNav as number) : (data[0]?.nav || 100);
            if (startNav > 0) {
                returnPercent = ((point.nav / startNav) - 1) * 100;
            }
        } else {
            const profit = value - invested;
            returnPercent = avgInv !== 0 ? (profit / avgInv) * 100 : 0;
        }

        return {
            date: point.date,
            dateNumber: parseHistoryTimestamp(point.date),
            value: returnPercent,
            invested,
            marketValue: value,
            dividend: point.dividend || 0,
            unreinvestedDividend: point.unreinvestedDividend ?? 0
        };
    });

    let retChange = 0;
    let valChange = 0;
    let contrib = 0;
    let avgContrib = 0;
    let months = 0;
    let minVal = 0;
    let maxVal = 0;
    let maxRet = 0;

    if (points.length > 0) {
        const firstPoint = points[0];
        const lastPoint = points[points.length - 1];
        const firstRaw = data[0];

        if (
            range === '1D' &&
            typeof overrideChange === 'number' &&
            Number.isFinite(overrideChange) &&
            typeof overrideChangePercent === 'number' &&
            Number.isFinite(overrideChangePercent)
        ) {
            valChange = overrideChange;
            retChange = overrideChangePercent;
        } else if (range === 'ALL' || range === 'MAX') {
            retChange = lastPoint.value;
            valChange = (lastPoint.marketValue || 0) - (lastPoint.invested || 0) + (lastPoint.unreinvestedDividend || 0);
        } else {
            retChange = hasPriorNav ? lastPoint.value : (lastPoint.value - firstPoint.value);
            const startVal = firstRaw.priorValue ?? (firstPoint.marketValue || 0);
            const endVal = lastPoint.marketValue || 0;
            const startInv = firstRaw.priorInvested ?? (firstPoint.invested || 0);
            const endInv = lastPoint.invested || 0;
            const startDiv = firstRaw.priorUnreinvestedDividend ?? (firstPoint.unreinvestedDividend || 0);
            const endDiv = lastPoint.unreinvestedDividend || 0;
            valChange = (endVal - startVal) - (endInv - startInv) + (endDiv - startDiv);
        }

        if (range === 'ALL' || range === 'MAX') {
            contrib = lastPoint.invested;
        } else {
            const baseInv = firstRaw.priorInvested ?? firstPoint.invested;
            contrib = lastPoint.invested - baseInv;
        }

        const diffDays = Math.ceil(Math.abs(lastPoint.dateNumber - firstPoint.dateNumber) / (1000 * 60 * 60 * 24));
        months = diffDays / 30.44;
        if (months >= 1) {
            avgContrib = contrib / months;
        }

        const mvArr = points.map(p => p.marketValue);
        minVal = Math.min(...mvArr);
        maxVal = Math.max(...mvArr);
        maxRet = Math.max(...points.map(p => Math.abs(p.value)));
    }

    return {
        chartData: points,
        returnChange: retChange,
        valueChange: valChange,
        totalContribution: contrib,
        avgContribution: avgContrib,
        periodMonths: months,
        minMarketValue: minVal,
        maxMarketValue: maxVal,
        maxAbsReturn: maxRet
    };
}
