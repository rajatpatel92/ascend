import { describe, test } from 'node:test';
import assert from 'node:assert';
import { calculateLookThrough } from '../look-through.ts';
import {
    aggregateIsharesHoldings,
    extractHoldingsTables,
    isharesAdapter,
    parseCsvRows,
    resolveIsharesRegionAndTicker,
    selectBestAutocompleteCandidate,
} from './ishares.ts';
import { resolveIssuerAllocations } from './index.ts';
import type { EtfIssuerAdapter } from './types.ts';

function mockResponse(body: string, status = 200): Response {
    return new Response(body, {
        status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
}

describe('iShares direct-issuer adapter', () => {
    describe('parseCsvRows & extractHoldingsTables', () => {
        test('parses multi-table BlackRock Canada fund-of-funds CSV and selects Aggregate Underlying Holdings', () => {
            const multiTableCsv = [
                '\uFEFFFund Holdings as of,"Nov 16, 2026"',
                'Inception Date,"Aug 07, 2019"',
                '\u00A0',
                'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency',
                'XTOT,ISHARES CORE S&P TOTAL US STK MKT,"-",Equity,"10,000,000.00",45.00,"10,000,000.00",100000,100.00,Canada,Toronto,CAD',
                'XIC,ISHARES CORE S&P TSX CAPPED COMP,"-",Equity,"5,000,000.00",25.00,"5,000,000.00",100000,50.00,Canada,Toronto,CAD',
                'XEF,ISHARES CORE MSCI EAFE IMI INDEX,"-",Equity,"5,000,000.00",25.00,"5,000,000.00",100000,50.00,Canada,Toronto,CAD',
                '\u00A0',
                'Fund Holdings as of,"Nov 16, 2026"',
                '\u00A0',
                'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Price,Location,Exchange,Currency',
                'NVDA,"NVIDIA CORP",Information Technology,Equity,"4,500,000.00",22.50,140.00,United States,NASDAQ,USD',
                'RY,"ROYAL BANK OF CANADA",Financials,Equity,"2,500,000.00",12.50,170.00,Canada,Toronto,CAD',
                '005930,"SAMSUNG ELECTRONICS LTD",Information Technology,Equity,"2,000,000.00",0.00,60.00,"Korea (South)",Korea Exchange,KRW',
                '7203,"TOYOTA MOTOR CORP",Consumer Discretionary,Equity,"1,000,000.00",0.00,25.00,Japan,Tokyo,JPY',
                'CAD,"CAD CASH",Cash and/or Derivatives,Cash,"-50,000.00",-0.25,1.00,Canada,-,CAD',
            ].join('\n');

            const parsedRows = parseCsvRows(multiTableCsv);
            assert.ok(parsedRows.length > 10);

            const { tables, asOfDate } = extractHoldingsTables(multiTableCsv);
            assert.strictEqual(tables.length, 2);
            assert.strictEqual(asOfDate, 'Nov 16, 2026');

            const underlyingTable = tables[tables.length - 1];
            assert.strictEqual(underlyingTable.length, 5);
            assert.strictEqual(underlyingTable[2].location, 'Korea (South)');

            const aggregated = aggregateIsharesHoldings(underlyingTable);
            assert.strictEqual(aggregated.holdingsCount, 5);

            const countryMap = Object.assign({}, ...aggregated.countryAllocations);
            // Total positive Market Value = 4.5M + 2.5M + 2.0M + 1.0M = 10.0M (even though Samsung & Toyota had Weight (%) = 0.00)
            assert.ok(Math.abs(countryMap['United States'] - 0.45) < 1e-6);
            assert.ok(Math.abs(countryMap['Canada'] - 0.25) < 1e-6);
            assert.ok(Math.abs(countryMap['South Korea'] - 0.20) < 1e-6);
            assert.ok(Math.abs(countryMap['Japan'] - 0.10) < 1e-6);

            const sectorMap = Object.assign({}, ...aggregated.sectorAllocations);
            assert.ok(Math.abs(sectorMap['Technology'] - 0.65) < 1e-6);
            assert.ok(Math.abs(sectorMap['Financial Services'] - 0.25) < 1e-6);
            assert.ok(Math.abs(sectorMap['Consumer Cyclical'] - 0.10) < 1e-6);
        });

        test('supports US Market Weight column header when Market Value is omitted', () => {
            const usCsv = [
                'iShares Core S&P 500 ETF',
                'Fund Holdings as of,"Nov 16, 2026"',
                'Ticker,Name,Sector,Asset Class,Market Weight,Price,Location',
                'AAPL,"APPLE INC",Information Technology,Equity,7.00,220.00,United States',
                'ACN,"ACCENTURE PLC",Information Technology,Equity,3.00,350.00,Ireland',
            ].join('\n');

            const { tables, asOfDate } = extractHoldingsTables(usCsv);
            assert.strictEqual(tables.length, 1);
            assert.strictEqual(asOfDate, 'Nov 16, 2026');

            const aggregated = aggregateIsharesHoldings(tables[0]);
            const countryMap = Object.assign({}, ...aggregated.countryAllocations);
            assert.ok(Math.abs(countryMap['United States'] - 0.7) < 1e-6);
            assert.ok(Math.abs(countryMap['Ireland'] - 0.3) < 1e-6);
        });

        test('excludes positive Cash and paired FX-forward derivative legs from country weights', () => {
            const hedgedCsv = [
                'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                'AAPL,APPLE INC,Information Technology,Equity,"6,000,000.00",60.00,United States',
                'ASML,ASML HOLDING NV,Information Technology,Equity,"3,000,000.00",30.00,Netherlands',
                'CAD,CAD CASH,Cash and/or Derivatives,Cash,"1,000,000.00",10.00,Canada',
                'CADFX,"CAD/USD FORWARD LEG",Cash and/or Derivatives,FX,"10,000,000.00",100.00,Canada',
                'USDFX,"USD/CAD FORWARD LEG",Cash and/or Derivatives,FX,"-10,000,000.00",-100.00,United States',
            ].join('\r\n');

            const { tables } = extractHoldingsTables(hedgedCsv);
            const aggregated = aggregateIsharesHoldings(tables[0]);
            const countryMap = Object.assign({}, ...aggregated.countryAllocations);

            // FX legs are excluded; genuine 10% cash keeps totalPortfolioWeight = 10M so US = 0.6, NL = 0.3, and Canada is NOT inflated by cash/FX
            assert.ok(Math.abs(countryMap['United States'] - 0.6) < 1e-6);
            assert.ok(Math.abs(countryMap['Netherlands'] - 0.3) < 1e-6);
            assert.strictEqual(countryMap['Canada'], undefined);
        });

        test('supports fallback Country header and omits bond credit sectors on fixed-income ETFs', () => {
            const bondCsv = [
                'Ticker,Name,Sector,Asset Class,Weight (%),Country',
                'GCAN,"CANADA GOVT BOND",Treasuries,Fixed Income,70.00,Canada',
                'UST,"US TREASURY NOTE",Treasuries,Fixed Income,30.00,United States',
            ].join('\n');

            const { tables } = extractHoldingsTables(bondCsv);
            assert.strictEqual(tables.length, 1);

            const aggregated = aggregateIsharesHoldings(tables[0]);
            assert.deepStrictEqual(aggregated.countryAllocations, [
                { Canada: 0.7 },
                { 'United States': 0.3 },
            ]);
            assert.deepStrictEqual(aggregated.sectorAllocations, []);
        });

        test('handles CRLF, escaped quotes, sparse rows, and keeps primary table when a smaller auxiliary table follows', async () => {
            const csvWithQuotesAndAux = [
                'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                'FOO,"FOO ""BAR"", INC.",Industrials,Equity,"800,000.00",80.00,United States',
                ',SPECIAL UNIT,,,"200,000.00",20.00,',
                '\r\n',
                'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                'COLLAT,COLLATERAL CASH,-,Cash,"10,000.00",100.00,Canada',
            ].join('\r\n');

            const { tables } = extractHoldingsTables(csvWithQuotesAndAux);
            assert.strictEqual(tables.length, 2);
            assert.strictEqual(tables[0].length, 2);
            assert.strictEqual(tables[0][0].name, 'FOO "BAR", INC.');

            const mockFetch: typeof fetch = async (input) => {
                const url = String(input);
                if (url.includes('autoComplete.search')) {
                    return mockResponse(JSON.stringify([
                        { category: 'productAutocomplete', id: '/us/products/111111/test', label: 'iShares Test Industrials ETF' },
                    ]));
                }
                return mockResponse(csvWithQuotesAndAux);
            };

            const res = await isharesAdapter.fetchAllocations({
                symbol: 'TEST',
                quoteType: 'ETF',
                fundName: 'iShares Test Industrials ETF',
                fetchFn: mockFetch,
            });
            assert.ok(res);
            assert.deepStrictEqual(res.countryAllocations, [{ 'United States': 0.8 }]);
        });
    });

    describe('resolveIsharesRegionAndTicker & canHandle', () => {
        test('maps Canadian suffixes including USD .U.TO variants and US tickers', () => {
            assert.deepStrictEqual(resolveIsharesRegionAndTicker('XEQT.TO'), {
                region: 'ca',
                searchTerms: ['XEQT'],
            });
            assert.deepStrictEqual(resolveIsharesRegionAndTicker('XEF.U.TO'), {
                region: 'ca',
                searchTerms: ['XEF.U', 'XEF'],
            });
            assert.deepStrictEqual(resolveIsharesRegionAndTicker('IVV'), {
                region: 'us',
                searchTerms: ['IVV'],
            });
            assert.strictEqual(resolveIsharesRegionAndTicker('USDCAD=X'), null);
            assert.strictEqual(resolveIsharesRegionAndTicker('^GSPC'), null);
            assert.strictEqual(resolveIsharesRegionAndTicker('VWCE.DE'), null);
        });

        test('canHandle filters out equities, FX, and third-party ETFs', () => {
            assert.strictEqual(
                isharesAdapter.canHandle({ symbol: 'AAPL', quoteType: 'EQUITY', fundName: 'Apple Inc.' }),
                false
            );
            assert.strictEqual(
                isharesAdapter.canHandle({ symbol: 'VEQT.TO', quoteType: 'ETF', fundName: 'Vanguard All-Equity ETF Portfolio' }),
                false
            );
            assert.strictEqual(
                isharesAdapter.canHandle({ symbol: 'ZSP.TO', quoteType: 'ETF', fundName: 'BMO S&P 500 Index ETF' }),
                false
            );
            assert.strictEqual(
                isharesAdapter.canHandle({ symbol: 'CASH.TO', quoteType: 'ETF', fundName: 'Monthly Cash ETF' }),
                false
            );
            assert.strictEqual(
                isharesAdapter.canHandle({ symbol: 'BLK', fundName: 'BlackRock, Inc.' }),
                false
            );
            assert.strictEqual(
                isharesAdapter.canHandle({ symbol: 'XEQT.TO', quoteType: 'ETF', fundName: 'iShares Core Equity ETF Portfolio' }),
                true
            );
            assert.strictEqual(
                isharesAdapter.canHandle({ symbol: 'IVV', quoteType: 'ETF', fundName: 'BlackRock iShares Core S&P 500 ETF' }),
                true
            );
            assert.strictEqual(
                isharesAdapter.canHandle({ symbol: 'XIC.TO', quoteType: 'ETF' }),
                true
            );
        });
    });

    describe('selectBestAutocompleteCandidate', () => {
        test('prefers unhedged fund over hedged variant using fundName similarity and rejects zero-overlap candidates', () => {
            const autocompletePayload = [
                { category: 'other', id: '/topics/etfs', label: 'ETFs' },
                {
                    category: 'productAutocomplete',
                    id: '/ca/investors/en/products/239850/ishares-msci-eafe-index-etf-cadhedged-fund',
                    label: 'iShares MSCI EAFE Index ETF (CAD-Hedged)',
                },
                {
                    category: 'productAutocomplete',
                    id: '/ca/investors/en/products/251422/ishares-core-msci-eafe-imi-index-etf',
                    label: 'iShares Core MSCI EAFE IMI Index ETF',
                },
            ];

            const selected = selectBestAutocompleteCandidate(
                autocompletePayload,
                'iShares Core MSCI EAFE IMI Index ETF'
            );
            assert.ok(selected);
            assert.strictEqual(selected.productId, '251422');

            // Unrelated candidate must be rejected even when candidates.length === 1
            const rejectedSingle = selectBestAutocompleteCandidate(
                [autocompletePayload[2]],
                'iShares Bitcoin Trust ETF'
            );
            assert.strictEqual(rejectedSingle, null);
        });
    });

    describe('fetchAllocations, resolveIssuerAllocations & calculateLookThrough integration', () => {
        test('resolves productId via .U.TO fallback term, feeds cleanly into calculateLookThrough, and fails soft on network errors', async () => {
            const requestedUrls: string[] = [];
            const mockFetch: typeof fetch = async (input) => {
                const url = String(input);
                requestedUrls.push(url);

                if (url.includes('term=XEF.U')) {
                    return mockResponse('[]');
                }
                if (url.includes('term=XEF')) {
                    return mockResponse(
                        JSON.stringify([
                            {
                                category: 'productAutocomplete',
                                id: '/ca/investors/en/products/251422/ishares-core-msci-eafe-imi-index-etf',
                                label: 'iShares Core MSCI EAFE IMI Index ETF',
                            },
                        ])
                    );
                }
                if (url.includes('/products/251422/fund/1464253357814.ajax')) {
                    return mockResponse(
                        [
                            'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                            'ASML,ASML HOLDING NV,Information Technology,Equity,540000,54.00,Netherlands',
                            'NESN,NESTLE SA,Consumer Staples,Equity,360000,36.00,Switzerland',
                            'EUR,EUR CASH,Cash and/or Derivatives,Cash,100000,10.00,Germany',
                        ].join('\n')
                    );
                }
                return mockResponse('Not Found', 404);
            };

            const result = await resolveIssuerAllocations({
                symbol: 'XEF.U.TO',
                quoteType: 'ETF',
                fundName: 'iShares Core MSCI EAFE IMI Index ETF (USD)',
                fetchFn: mockFetch,
            });

            assert.ok(result);
            assert.strictEqual(result.providerId, 'ishares');
            assert.strictEqual(result.productId, '251422');
            assert.deepStrictEqual(result.countryAllocations, [
                { Netherlands: 0.54 },
                { Switzerland: 0.36 },
            ]);
            assert.strictEqual(requestedUrls.length, 3);

            const lookThrough = calculateLookThrough([
                {
                    symbol: 'XEF.U.TO',
                    name: 'iShares Core MSCI EAFE IMI Index ETF (USD)',
                    type: 'ETF',
                    value: 10_000,
                    countryAllocations: result.countryAllocations,
                    sectorAllocations: result.sectorAllocations,
                },
            ]);
            const countryMap = Object.fromEntries(lookThrough.byCountry.map((c) => [c.name, c.value]));
            assert.strictEqual(countryMap['Netherlands'], 5400);
            assert.strictEqual(countryMap['Switzerland'], 3600);
            assert.strictEqual(countryMap['Global / Other'], 1000);
        });

        test('fails soft on HTML WAF challenge, CSV HTTP 500, or fetch throw and coalesces concurrent default lookups', async (subT) => {
            const wafFetch: typeof fetch = async () => mockResponse('<html><title>Access Denied</title></html>', 403);
            assert.strictEqual(
                await resolveIssuerAllocations({
                    symbol: 'IVV',
                    quoteType: 'ETF',
                    fundName: 'iShares Core S&P 500 ETF',
                    fetchFn: wafFetch,
                }),
                null
            );

            const csvFailFetch: typeof fetch = async (input) => {
                if (String(input).includes('autoComplete.search')) {
                    return mockResponse(JSON.stringify([
                        { category: 'productAutocomplete', id: '/us/products/239726/ishares-core-sp-500-etf', label: 'iShares Core S&P 500 ETF' },
                    ]));
                }
                return mockResponse('Server Error', 500);
            };
            assert.strictEqual(
                await resolveIssuerAllocations({
                    symbol: 'IVV',
                    quoteType: 'ETF',
                    fundName: 'iShares Core S&P 500 ETF',
                    fetchFn: csvFailFetch,
                }),
                null
            );

            // Coalesce concurrent default-fetch calls per symbol
            let fetchCalls = 0;
            subT.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
                fetchCalls++;
                await new Promise((r) => setTimeout(r, 10));
                if (String(input).includes('autoComplete.search')) {
                    return mockResponse(JSON.stringify([
                        { category: 'productAutocomplete', id: '/us/products/239726/ishares-core-sp-500-etf', label: 'iShares Core S&P 500 ETF' },
                    ]));
                }
                return mockResponse([
                    'Ticker,Name,Sector,Asset Class,Market Weight,Location',
                    'AAPL,APPLE INC,Information Technology,Equity,100.00,United States',
                ].join('\n'));
            });

            const [r1, r2, r3] = await Promise.all([
                resolveIssuerAllocations({ symbol: 'IVV', quoteType: 'ETF', fundName: 'iShares Core S&P 500 ETF' }),
                resolveIssuerAllocations({ symbol: 'IVV', quoteType: 'ETF', fundName: 'iShares Core S&P 500 ETF' }),
                resolveIssuerAllocations({ symbol: 'IVV', quoteType: 'ETF', fundName: 'iShares Core S&P 500 ETF' }),
            ]);
            assert.strictEqual(fetchCalls, 2);
            assert.deepStrictEqual(r1?.countryAllocations, [{ 'United States': 1 }]);
            assert.deepStrictEqual(r2, r1);
            assert.deepStrictEqual(r3, r1);

            const throwingAdapter: EtfIssuerAdapter = {
                id: 'broken',
                canHandle: () => true,
                fetchAllocations: async () => {
                    throw new Error('ECONNRESET');
                },
            };
            const fallbackAdapter: EtfIssuerAdapter = {
                id: 'fallback',
                canHandle: () => true,
                fetchAllocations: async () => ({
                    providerId: 'fallback',
                    countryAllocations: [{ Canada: 1 }],
                }),
            };

            const recovered = await resolveIssuerAllocations(
                { symbol: 'XIC.TO', quoteType: 'ETF' },
                [throwingAdapter, fallbackAdapter]
            );
            assert.ok(recovered);
            assert.strictEqual(recovered.providerId, 'fallback');
            assert.deepStrictEqual(recovered.countryAllocations, [{ Canada: 1 }]);
        });
    });
});
