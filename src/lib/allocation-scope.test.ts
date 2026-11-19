import test from 'node:test';
import assert from 'node:assert';
import { buildHoldingsScope, type ScopeInteractiveFilters } from './allocation-scope.ts';
import type { CountryBreakdown, SectorBreakdown } from './look-through.ts';
import type { PortfolioHoldingStock } from './holdings-look-through.ts';

const EMPTY_FILTERS: ScopeInteractiveFilters = {
    investmentType: null,
    accountType: null,
    accountName: null,
    sector: null,
    country: null,
    stockKey: null,
};

const SAMPLE_SECTOR_BREAKDOWN: SectorBreakdown = {
    name: 'Technology',
    value: 14400,
    percentage: 48,
    contributors: [
        {
            symbol: 'XEQT.TO',
            name: 'iShares Core Equity ETF',
            allocatedValue: 10000,
            holdingValue: 20000,
            weightInHolding: 0.5,
            weightInSector: 69.4444,
            isLookThrough: true,
        },
        {
            symbol: 'MSFT',
            name: 'Microsoft Corp',
            allocatedValue: 4400,
            holdingValue: 4400,
            weightInHolding: 1.0,
            weightInSector: 30.5556,
            isLookThrough: false,
        },
    ],
};

const SAMPLE_COUNTRY_BREAKDOWN: CountryBreakdown = {
    name: 'United States',
    value: 12400,
    percentage: 41.3333,
    contributors: [
        {
            symbol: 'XEQT.TO',
            name: 'iShares Core Equity ETF',
            allocatedValue: 8000,
            holdingValue: 20000,
            weightInHolding: 0.4,
            weightInSector: 64.5161,
            isLookThrough: true,
        },
        {
            symbol: 'MSFT',
            name: 'Microsoft Corp',
            allocatedValue: 4400,
            holdingValue: 4400,
            weightInHolding: 1.0,
            weightInSector: 35.4839,
            isLookThrough: false,
        },
    ],
};

const SAMPLE_STOCK: PortfolioHoldingStock = {
    key: 'ticker:AAPL',
    name: 'Apple Inc',
    ticker: 'AAPL',
    value: 3000,
    percentage: 10,
    directValue: 1000,
    lookThroughValue: 2000,
    contributorCount: 2,
    contributors: [
        {
            symbol: 'XEQT.TO',
            name: 'iShares Core Equity ETF',
            isDirect: false,
            weightInFund: 0.1,
            value: 2000,
            percentageOfStock: 66.6667,
        },
        {
            symbol: 'AAPL',
            name: 'Apple Inc',
            isDirect: true,
            weightInFund: 1.0,
            value: 1000,
            percentageOfStock: 33.3333,
        },
    ],
};

test('buildHoldingsScope', async (t) => {
    await t.test('returns null when no interactive filters are active', () => {
        const scope = buildHoldingsScope({
            activeDimension: 'sector',
            filters: EMPTY_FILTERS,
            filteredConstituents: [
                { symbol: 'XEQT.TO', quantity: 100, value: 20000, valueTarget: 20000 },
            ],
            totalPortfolioValue: 30000,
            activeSectorBreakdown: null,
            activeCountryBreakdown: null,
            selectedStock: null,
        });
        assert.strictEqual(scope, null);
    });

    await t.test('builds X-Ray scope for Underlying Stock combining Direct Holding and ETF Look-Through', () => {
        const scope = buildHoldingsScope({
            activeDimension: 'holdings',
            filters: { ...EMPTY_FILTERS, stockKey: 'ticker:AAPL' },
            filteredConstituents: [
                { symbol: 'XEQT.TO', quantity: 500, value: 20000, valueTarget: 20000 },
                { symbol: 'AAPL', quantity: 5, value: 1000, valueTarget: 1000 },
            ],
            totalPortfolioValue: 30000,
            activeSectorBreakdown: null,
            activeCountryBreakdown: null,
            selectedStock: SAMPLE_STOCK,
        });

        assert.ok(scope);
        assert.strictEqual(scope.mode, 'xray');
        assert.strictEqual(scope.kind, 'Underlying Stock');
        assert.strictEqual(scope.title, 'Apple Inc (AAPL)');
        assert.strictEqual(scope.totalValue, 3000);
        assert.strictEqual(scope.directValue, 1000);
        assert.strictEqual(scope.etfValue, 2000);
        assert.ok(Math.abs(scope.portfolioPct - 10) < 0.01);

        assert.strictEqual(scope.bySymbol['XEQT.TO'].sourceLabel, 'ETF Look-Through');
        assert.strictEqual(scope.bySymbol['XEQT.TO'].weightPct, 10);
        assert.strictEqual(scope.bySymbol['XEQT.TO'].exposureValue, 2000);
        assert.ok(Math.abs(scope.bySymbol['XEQT.TO'].sharePct - 66.6667) < 0.01);

        assert.strictEqual(scope.bySymbol['AAPL'].sourceLabel, 'Direct Holding');
        assert.strictEqual(scope.bySymbol['AAPL'].weightPct, 100);
        assert.strictEqual(scope.bySymbol['AAPL'].exposureValue, 1000);
        assert.ok(Math.abs(scope.bySymbol['AAPL'].sharePct - 33.3333) < 0.01);
    });

    await t.test('builds X-Ray scope for Sector and Geography breakdowns', () => {
        const sectorScope = buildHoldingsScope({
            activeDimension: 'sector',
            filters: { ...EMPTY_FILTERS, sector: 'Technology' },
            filteredConstituents: [
                { symbol: 'XEQT.TO', quantity: 500, value: 20000, valueTarget: 20000 },
                { symbol: 'MSFT', quantity: 10, value: 4400, valueTarget: 4400 },
            ],
            totalPortfolioValue: 30000,
            activeSectorBreakdown: SAMPLE_SECTOR_BREAKDOWN,
            activeCountryBreakdown: null,
            selectedStock: null,
        });

        assert.ok(sectorScope);
        assert.strictEqual(sectorScope.mode, 'xray');
        assert.strictEqual(sectorScope.kind, 'Sector');
        assert.strictEqual(sectorScope.totalValue, 14400);
        assert.strictEqual(sectorScope.directValue, 4400);
        assert.strictEqual(sectorScope.etfValue, 10000);
        assert.strictEqual(sectorScope.bySymbol['XEQT.TO'].weightPct, 50);

        const countryScope = buildHoldingsScope({
            activeDimension: 'country',
            filters: { ...EMPTY_FILTERS, country: 'United States' },
            filteredConstituents: [
                { symbol: 'XEQT.TO', quantity: 500, value: 20000, valueTarget: 20000 },
                { symbol: 'MSFT', quantity: 10, value: 4400, valueTarget: 4400 },
            ],
            totalPortfolioValue: 30000,
            activeSectorBreakdown: null,
            activeCountryBreakdown: SAMPLE_COUNTRY_BREAKDOWN,
            selectedStock: null,
        });

        assert.ok(countryScope);
        assert.strictEqual(countryScope.kind, 'Geography');
        assert.strictEqual(countryScope.title, 'United States');
        assert.strictEqual(countryScope.totalValue, 12400);
    });

    await t.test('builds slice scope for Asset Type, Account Type, and Account tabs', () => {
        const accountTypeScope = buildHoldingsScope({
            activeDimension: 'accountType',
            filters: { ...EMPTY_FILTERS, accountType: 'TFSA' },
            filteredConstituents: [
                { symbol: 'XEQT.TO', quantity: 300, value: 15000, valueTarget: 15000 },
                { symbol: 'ZEA.TO', quantity: 200, value: 5000, valueTarget: 5000 },
                { symbol: 'OLD', quantity: 0, value: 0, valueTarget: 0 },
            ],
            totalPortfolioValue: 40000,
            activeSectorBreakdown: null,
            activeCountryBreakdown: null,
            selectedStock: null,
        });

        assert.ok(accountTypeScope);
        assert.strictEqual(accountTypeScope.mode, 'slice');
        assert.strictEqual(accountTypeScope.kind, 'Account Type');
        assert.strictEqual(accountTypeScope.title, 'TFSA');
        assert.strictEqual(accountTypeScope.totalValue, 20000);
        assert.strictEqual(accountTypeScope.portfolioPct, 50);
        assert.strictEqual(accountTypeScope.bySymbol['XEQT.TO'].sharePct, 75);
        assert.strictEqual(accountTypeScope.bySymbol['XEQT.TO'].weightPct, null);
        assert.strictEqual(accountTypeScope.bySymbol['ZEA.TO'].sharePct, 25);
        assert.strictEqual(accountTypeScope.bySymbol['OLD'], undefined);

        const assetTypeScope = buildHoldingsScope({
            activeDimension: 'type',
            filters: { ...EMPTY_FILTERS, investmentType: 'ETF' },
            filteredConstituents: [
                { symbol: 'XEQT.TO', quantity: 500, value: 20000, valueTarget: 20000 },
            ],
            totalPortfolioValue: 25000,
            activeSectorBreakdown: null,
            activeCountryBreakdown: null,
            selectedStock: null,
        });

        assert.ok(assetTypeScope);
        assert.strictEqual(assetTypeScope.kind, 'Asset Type');
        assert.strictEqual(assetTypeScope.portfolioPct, 80);
    });

    await t.test('scales X-Ray exposure proportionally when multi-filtered by an account slice', () => {
        // XEQT global value is 20,000, but narrowed to TFSA account it is 10,000 (40% US weight -> 4,000)
        const multiScope = buildHoldingsScope({
            activeDimension: 'country',
            filters: { ...EMPTY_FILTERS, country: 'United States', accountType: 'TFSA' },
            filteredConstituents: [
                { symbol: 'XEQT.TO', quantity: 250, value: 10000, valueTarget: 10000 },
            ],
            totalPortfolioValue: 30000,
            activeSectorBreakdown: null,
            activeCountryBreakdown: SAMPLE_COUNTRY_BREAKDOWN,
            selectedStock: null,
        });

        assert.ok(multiScope);
        assert.strictEqual(multiScope.mode, 'xray');
        assert.strictEqual(multiScope.totalValue, 4000);
        assert.strictEqual(multiScope.etfValue, 4000);
        assert.strictEqual(multiScope.directValue, 0);
        assert.strictEqual(multiScope.bySymbol['XEQT.TO'].exposureValue, 4000);
        assert.strictEqual(multiScope.bySymbol['XEQT.TO'].sharePct, 100);
        assert.ok(multiScope.subtitle.includes('Account Type: TFSA'));
    });

    await t.test('handles empty filtered constituents cleanly without NaN', () => {
        const emptyScope = buildHoldingsScope({
            activeDimension: 'account',
            filters: { ...EMPTY_FILTERS, accountName: 'Empty Account' },
            filteredConstituents: [],
            totalPortfolioValue: 0,
            activeSectorBreakdown: null,
            activeCountryBreakdown: null,
            selectedStock: null,
        });

        assert.ok(emptyScope);
        assert.strictEqual(emptyScope.mode, 'slice');
        assert.strictEqual(emptyScope.totalValue, 0);
        assert.strictEqual(emptyScope.portfolioPct, 0);
        assert.deepStrictEqual(emptyScope.bySymbol, {});
    });
});
