import test from 'node:test';
import assert from 'node:assert';
import { computePerformanceChartMetrics } from './performance-chart.ts';

test('computePerformanceChartMetrics', async (t) => {
    await t.test('ALL range avoids double-counting reinvested dividends in Period P&L', () => {
        // Out-of-pocket principal = 140,301.71; ending portfolio value = 158,647.46
        // Cumulative dividends = 5,871.42 (all reinvested via DRIP/buys -> unreinvestedDividend = 0)
        const res = computePerformanceChartMetrics({
            range: 'ALL',
            data: [
                {
                    date: '2023-01-01',
                    value: 1000,
                    invested: 1000,
                    nav: 100,
                    dividend: 0,
                    unreinvestedDividend: 0
                },
                {
                    date: '2026-11-14',
                    value: 158647.46,
                    invested: 140301.71,
                    nav: 132.23,
                    dividend: 5871.42,
                    unreinvestedDividend: 0
                }
            ]
        });

        // Expected Period P&L = 158,647.46 - 140,301.71 = 18,345.75 (NOT 24,217.17)
        assert.ok(Math.abs(res.valueChange - 18345.75) < 0.01);
        assert.ok(Math.abs(res.returnChange - 32.23) < 0.01);
        assert.ok(Math.abs(res.totalContribution - 140301.71) < 0.01);
    });

    await t.test('credits un-reinvested cash dividends once without double-counting reinvested ones', () => {
        const res = computePerformanceChartMetrics({
            range: 'ALL',
            data: [
                {
                    date: '2025-01-01',
                    value: 10000,
                    invested: 10000,
                    nav: 100,
                    dividend: 0,
                    unreinvestedDividend: 0
                },
                {
                    date: '2025-06-01',
                    // $500 dividend total: $300 reinvested into marketValue (+$300), $200 unspent cash
                    value: 10300,
                    invested: 10000,
                    nav: 105,
                    dividend: 500,
                    unreinvestedDividend: 200
                }
            ]
        });

        // Total profit = (10,300 - 10,000) + 200 un-reinvested = 500
        assert.ok(Math.abs(res.valueChange - 500) < 0.01);
    });

    await t.test('sub-range delta accounts for dividend reinvestment without double-counting', () => {
        const res = computePerformanceChartMetrics({
            range: '1M',
            data: [
                {
                    // Start of 1M window: $500 pre-period dividend waiting in cash pool
                    date: '2026-10-15',
                    value: 10000,
                    invested: 10000,
                    nav: 110,
                    dividend: 500,
                    unreinvestedDividend: 500
                },
                {
                    // End of 1M window: $500 pre-period cash dividend deployed into shares ($0 external flow)
                    // plus $200 new appreciation
                    date: '2026-11-14',
                    value: 10700,
                    invested: 10000,
                    nav: 112.2,
                    dividend: 500,
                    unreinvestedDividend: 0
                }
            ]
        });

        // Period P&L = (10,700 - 10,000) - (10,000 - 10,000) + (0 - 500) = 200
        assert.ok(Math.abs(res.valueChange - 200) < 0.01);
        assert.ok(Math.abs(res.returnChange - 2.0) < 0.01);
    });

    await t.test('1D range prefers explicit day-change overrides when provided', () => {
        const res = computePerformanceChartMetrics({
            range: '1D',
            overrideChange: -412.5,
            overrideChangePercent: -0.26,
            data: [
                { date: '2026-11-14T14:30:00Z', value: 159000, invested: 159000, nav: 100 },
                { date: '2026-11-14T21:00:00Z', value: 158600, invested: 159000, nav: 99.75 }
            ]
        });

        assert.strictEqual(res.valueChange, -412.5);
        assert.strictEqual(res.returnChange, -0.26);
    });

    await t.test('uses prior* baseline on sub-ranges so first-day inflows and <1Y portfolio inception metrics are exact', () => {
        const res = computePerformanceChartMetrics({
            range: '1Y',
            data: [
                {
                    // Portfolio began mid-1Y window: prior* is 0 / nav 100
                    date: '2026-06-01',
                    value: 1000,
                    invested: 1000,
                    nav: 100,
                    dividend: 0,
                    unreinvestedDividend: 0,
                    priorValue: 0,
                    priorInvested: 0,
                    priorNav: 100,
                    priorUnreinvestedDividend: 0
                },
                {
                    date: '2026-11-14',
                    value: 1200,
                    invested: 1000,
                    nav: 120,
                    dividend: 0,
                    unreinvestedDividend: 0
                }
            ]
        });

        assert.ok(Math.abs(res.totalContribution - 1000) < 0.01);
        assert.ok(Math.abs(res.valueChange - 200) < 0.01);
        assert.ok(Math.abs(res.returnChange - 20) < 0.01);
    });
});

