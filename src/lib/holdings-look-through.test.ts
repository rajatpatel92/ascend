import test from 'node:test';
import assert from 'node:assert';
import {
    calculatePortfolioHoldingsLookThrough,
    constituentHoldsUnderlyingStock,
} from './holdings-look-through.ts';

test('Portfolio-wide stock holdings look-through engine', async (t) => {
    await t.test('aggregates direct equity positions and multiple ETF look-through holdings with exact dollar & % sums', () => {
        const result = calculatePortfolioHoldingsLookThrough([
            {
                symbol: 'NVDA',
                name: 'NVIDIA Corporation',
                type: 'EQUITY',
                value: 10000,
                sector: 'Technology',
                country: 'United States',
            },
            {
                symbol: 'RY.TO',
                name: 'Royal Bank of Canada',
                type: 'EQUITY',
                value: 5000,
                sector: 'Financial Services',
                country: 'Canada',
            },
            {
                symbol: 'XEQT.TO',
                name: 'iShares Core Equity ETF Portfolio',
                type: 'ETF',
                value: 50000,
                topHoldings: [
                    { name: 'NVIDIA CORP', ticker: 'NVDA', weight: 0.04, sector: 'Technology', country: 'United States', assetClass: 'EQUITY', source: 'ishares' },
                    { name: 'ROYAL BANK OF CANADA', ticker: 'RY', weight: 0.02, sector: 'Financials', country: 'Canada', assetClass: 'EQUITY', source: 'ishares' },
                    { name: 'APPLE INC', ticker: 'AAPL', weight: 0.05, sector: 'Technology', country: 'United States', assetClass: 'EQUITY', source: 'ishares' },
                ],
            },
            {
                symbol: 'VGRO.TO',
                name: 'Vanguard Growth ETF Portfolio',
                type: 'ETF',
                value: 20000,
                topHoldings: [
                    { name: 'NVIDIA Corp.', ticker: 'NVDA', isin: 'US67066G1040', weight: 0.05, assetClass: 'EQUITY', source: 'vanguard' },
                    { name: 'Apple Inc.', ticker: 'AAPL', isin: 'US0378331005', weight: 0.05, assetClass: 'EQUITY', source: 'vanguard' },
                ],
            },
            {
                symbol: 'CASH.TO',
                name: 'Horizons High Interest Savings ETF',
                type: 'CASH',
                value: 10000,
            },
            {
                symbol: 'UNTRACKED.TO',
                name: 'Untracked Mutual Fund',
                type: 'MUTUALFUND',
                value: 5000,
                topHoldings: [],
            },
        ]);

        // Total portfolio value = 10k + 5k + 50k + 20k + 10k + 5k = 100,000
        assert.strictEqual(result.summary.totalPortfolioValue, 100000);
        assert.strictEqual(result.summary.directStocksValue, 15000);
        // ETF tracked equity = (50k * 0.11 = 5500) + (20k * 0.10 = 2000) = 7500
        assert.ok(Math.abs(result.summary.etfLookThroughStocksValue - 7500) < 1e-6);
        assert.strictEqual(result.summary.fixedIncomeAndCashValue, 10000);
        // Unattributed = 50k*(1-0.11) + 20k*(1-0.10) + 5k = 44500 + 18000 + 5000 = 67500
        assert.ok(Math.abs(result.summary.unattributedFundValue - 67500) < 1e-6);
        assert.strictEqual(result.summary.uniqueStockCount, 3);
        assert.strictEqual(result.summary.fundsWithHoldingsCount, 2);
        assert.strictEqual(result.summary.fundsTotalCount, 3);

        // NVDA: 10,000 direct + 50,000*0.04 (2,000) + 20,000*0.05 (1,000) = 13,000 (13.0%)
        const nvda = result.holdings[0];
        assert.strictEqual(nvda.ticker, 'NVDA');
        assert.ok(Math.abs(nvda.value - 13000) < 1e-6);
        assert.ok(Math.abs(nvda.percentage - 13) < 1e-6);
        assert.strictEqual(nvda.directValue, 10000);
        assert.ok(Math.abs(nvda.lookThroughValue - 3000) < 1e-6);
        assert.strictEqual(nvda.contributorCount, 3);
        assert.strictEqual(nvda.contributors[0].symbol, 'NVDA');
        assert.strictEqual(nvda.contributors[0].isDirect, true);

        // RY.TO merged across Direct RY.TO (5,000) + XEQT.TO RY in Canada (1,000) = 6,000 (6.0%)
        const ry = result.holdings.find((h) => h.ticker === 'RY.TO' || h.ticker === 'RY');
        assert.ok(ry);
        assert.strictEqual(ry.ticker, 'RY.TO');
        assert.ok(Math.abs(ry.value - 6000) < 1e-6);
        assert.ok(Math.abs(ry.percentage - 6) < 1e-6);

        // AAPL across XEQT (2,500) + VGRO (1,000) = 3,500 (3.5%), zero direct
        const aapl = result.holdings.find((h) => h.ticker === 'AAPL');
        assert.ok(aapl);
        assert.strictEqual(aapl.directValue, 0);
        assert.ok(Math.abs(aapl.value - 3500) < 1e-6);
        assert.ok(Math.abs(aapl.percentage - 3.5) < 1e-6);

        // Constituent match helper check
        assert.strictEqual(constituentHoldsUnderlyingStock({ symbol: 'NVDA' }, nvda), true);
        assert.strictEqual(constituentHoldsUnderlyingStock({ symbol: 'XEQT.TO' }, nvda), true);
        assert.strictEqual(constituentHoldsUnderlyingStock({ symbol: 'CASH.TO' }, nvda), false);
    });

    await t.test('keeps dual-class shares strictly separate across direct holdings and multiple ETFs', () => {
        const result = calculatePortfolioHoldingsLookThrough([
            {
                symbol: 'GOOGL',
                name: 'Alphabet Inc. Class A',
                type: 'EQUITY',
                value: 4000,
                country: 'United States',
            },
            {
                symbol: 'TEC.TO',
                name: 'TD Global Technology Leaders Index ETF',
                type: 'ETF',
                value: 10000,
                topHoldings: [
                    { name: 'Alphabet Inc - Common Cl A', ticker: 'GOOGL', weight: 0.05, assetClass: 'EQUITY', source: 'td' },
                    { name: 'Alphabet Inc - Common Cl C', ticker: 'GOOG', weight: 0.04, assetClass: 'EQUITY', source: 'td' },
                ],
            },
            {
                symbol: 'VTI',
                name: 'Vanguard Total Stock Market ETF',
                type: 'ETF',
                value: 10000,
                topHoldings: [
                    { name: 'Alphabet Inc.', ticker: 'GOOGL', isin: 'US02079K3059', weight: 0.02, assetClass: 'EQUITY', source: 'vanguard' },
                    { name: 'Alphabet Inc.', ticker: 'GOOG', isin: 'US02079K1079', weight: 0.02, assetClass: 'EQUITY', source: 'vanguard' },
                ],
            },
        ]);

        assert.strictEqual(result.summary.uniqueStockCount, 2);
        const googl = result.holdings.find((h) => h.ticker === 'GOOGL');
        const goog = result.holdings.find((h) => h.ticker === 'GOOG');
        assert.ok(googl);
        assert.ok(goog);
        // GOOGL: 4000 direct + 500 TD + 200 Vanguard = 4700
        assert.ok(Math.abs(googl.value - 4700) < 1e-6);
        assert.strictEqual(googl.directValue, 4000);
        // GOOG: 400 TD + 200 Vanguard = 600
        assert.ok(Math.abs(goog.value - 600) < 1e-6);
        assert.strictEqual(goog.directValue, 0);
    });

    await t.test('excludes BOND holdings from stock X-Ray while crediting bond ETFs to fixedIncomeAndCashValue', () => {
        const result = calculatePortfolioHoldingsLookThrough([
            {
                symbol: 'ZAG.TO',
                name: 'BMO Aggregate Bond Index ETF',
                type: 'ETF',
                value: 20000,
                topHoldings: [
                    { name: 'Canada Govt 3.5%', weight: 0.6, assetClass: 'BOND', source: 'bmo' },
                    { name: 'Ontario Bond 2.9%', weight: 0.4, assetClass: 'BOND', source: 'bmo' },
                ],
            },
            {
                symbol: 'BTC-CAD',
                name: 'Bitcoin',
                type: 'CRYPTO',
                value: 5000,
            },
        ]);

        assert.strictEqual(result.summary.uniqueStockCount, 0);
        assert.strictEqual(result.holdings.length, 0);
        assert.strictEqual(result.summary.fixedIncomeAndCashValue, 25000);
        assert.strictEqual(result.summary.unattributedFundValue, 0);
    });
});
