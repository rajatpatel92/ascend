import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { calculateLookThrough } from '../look-through.ts';
import { fetchViaNodeHttp, formatErrorDetails } from './http.ts';
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

            // Coalesce concurrent default-fetch calls per symbol and verify browser-like request options
            let fetchCalls = 0;
            const observedOptions: RequestInit[] = [];
            subT.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
                fetchCalls++;
                if (init) observedOptions.push(init);
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
            assert.strictEqual(observedOptions.length, 2);
            for (const opt of observedOptions) {
                assert.strictEqual(opt.cache, 'no-store');
                const hdrs = opt.headers as Record<string, string>;
                assert.ok(hdrs['User-Agent']?.includes('Mozilla/5.0'));
                assert.ok(hdrs.Accept?.includes('text/csv'));
            }
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

        test('forwards Set-Cookie & Referer, warms up product page on CSV 403/HTML challenge, and emits onDiagnostic messages', async () => {
            const requests: Array<{ url: string; cookie: string | undefined; referer: string | undefined }> = [];
            let csvAttempts = 0;

            const warmupFetch: typeof fetch = async (input, init) => {
                const url = String(input);
                const hdrs = (init?.headers ?? {}) as Record<string, string>;
                requests.push({ url, cookie: hdrs.Cookie, referer: hdrs.Referer });

                if (url.includes('autoComplete.search')) {
                    const res = mockResponse(
                        JSON.stringify([
                            {
                                category: 'productAutocomplete',
                                id: '/ca/investors/en/products/309480/ishares-core-equity-etf-portfolio',
                                label: 'iShares Core Equity ETF Portfolio',
                            },
                        ])
                    );
                    res.headers.append('set-cookie', 'ak_bmsc=cookie1; Path=/; HttpOnly');
                    res.headers.append('set-cookie', 'ts-ca-one-locale=en_CA; Path=/');
                    return res;
                }

                if (url.includes('/products/309480/fund/')) {
                    csvAttempts++;
                    if (csvAttempts === 1) {
                        return mockResponse('<html>Access Denied</html>', 403);
                    }
                    assert.ok(hdrs.Cookie?.includes('ak_bmsc=cookie1'));
                    assert.ok(hdrs.Cookie?.includes('bm_sv=warmed_token'));
                    assert.strictEqual(
                        hdrs.Referer,
                        'https://www.blackrock.com/ca/investors/en/products/309480/'
                    );
                    return mockResponse(
                        [
                            'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                            'AAPL,APPLE INC,Information Technology,Equity,600000,60.00,United States',
                            'RY,ROYAL BANK OF CANADA,Financials,Equity,400000,40.00,Canada',
                        ].join('\n')
                    );
                }

                if (url === 'https://www.blackrock.com/ca/investors/en/products/309480/') {
                    const res = mockResponse('<html>Product Landing</html>', 200);
                    res.headers.append('set-cookie', 'bm_sv=warmed_token; Path=/');
                    return res;
                }

                return mockResponse('Not Found', 404);
            };

            const res = await isharesAdapter.fetchAllocations({
                symbol: 'XEQT.TO',
                quoteType: 'ETF',
                fundName: 'iShares Core Equity ETF Portfolio',
                fetchFn: warmupFetch,
            });

            assert.ok(res);
            assert.strictEqual(csvAttempts, 2);
            assert.strictEqual(requests.length, 4);
            assert.deepStrictEqual(res.countryAllocations, [
                { 'United States': 0.6 },
                { Canada: 0.4 },
            ]);

            const diagnostics: string[] = [];
            const blockedRes = await resolveIssuerAllocations({
                symbol: 'IVV',
                quoteType: 'ETF',
                fundName: 'iShares Core S&P 500 ETF',
                onDiagnostic: (msg) => diagnostics.push(msg),
                fetchFn: async () => mockResponse('<html>Access Denied</html>', 403),
            });
            assert.strictEqual(blockedRes, null);
            assert.ok(diagnostics.some((m) => m.includes('Autocomplete HTTP 403')));
        });

        test('falls back to IPv4 node:https on fetch network failure and logs full error cause', async () => {
            const diagnostics: string[] = [];
            let fetchCalls = 0;
            let nodeCalls = 0;

            const failingFetch: typeof fetch = async () => {
                fetchCalls++;
                const osErr = Object.assign(new Error('connect ETIMEDOUT 23.45.67.89:443'), {
                    code: 'ETIMEDOUT',
                    syscall: 'connect',
                    address: '23.45.67.89',
                    port: 443,
                });
                throw new TypeError('fetch failed', { cause: osErr });
            };

            const fallbackNodeHttp = async (url: string) => {
                nodeCalls++;
                if (url.includes('/autoComplete.search')) {
                    const res = mockResponse(
                        JSON.stringify([
                            {
                                category: 'productAutocomplete',
                                id: '/ca/investors/en/products/309480/ishares-core-equity-etf-portfolio',
                                label: 'iShares Core Equity ETF Portfolio',
                            },
                        ])
                    );
                    res.headers.append('set-cookie', 'ak_bmsc=node_cookie; Path=/');
                    return res;
                }
                if (url.includes('/products/309480/fund/')) {
                    return mockResponse(
                        [
                            'Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Location',
                            'AAPL,APPLE INC,Information Technology,Equity,750000,75.00,United States',
                            'RY,ROYAL BANK OF CANADA,Financials,Equity,250000,25.00,Canada',
                        ].join('\n')
                    );
                }
                return mockResponse('Not Found', 404);
            };

            const res = await isharesAdapter.fetchAllocations({
                symbol: 'XEQT.TO',
                quoteType: 'ETF',
                fundName: 'iShares Core Equity ETF Portfolio',
                fetchFn: failingFetch,
                nodeHttpFn: fallbackNodeHttp,
                onDiagnostic: (msg) => diagnostics.push(msg),
            });

            assert.ok(res);
            // # Reason: Once autocomplete falls back to node:https, preferNodeHttp reuses it for CSV.
            assert.strictEqual(fetchCalls, 1);
            assert.strictEqual(nodeCalls, 2);
            assert.ok(
                diagnostics.some(
                    (m) => m.includes('ETIMEDOUT') && m.includes('retrying via IPv4 node:https')
                )
            );
            assert.deepStrictEqual(res.countryAllocations, [
                { 'United States': 0.75 },
                { Canada: 0.25 },
            ]);

            // Verify combined error diagnostics when both fetchFn and nodeHttpFn fail
            const bothFailDiagnostics: string[] = [];
            const bothFailResult = await resolveIssuerAllocations({
                symbol: 'XEQT.TO',
                quoteType: 'ETF',
                fundName: 'iShares Core Equity ETF Portfolio',
                fetchFn: failingFetch,
                nodeHttpFn: async () => {
                    throw Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {
                        code: 'ECONNRESET',
                        syscall: 'read',
                    });
                },
                onDiagnostic: (msg) => bothFailDiagnostics.push(msg),
            });

            assert.strictEqual(bothFailResult, null);
            const failureDiag = bothFailDiagnostics.find((m) =>
                m.includes('[IssuerAdapter:ishares] Failed to resolve XEQT.TO:')
            );
            assert.ok(failureDiag);
            assert.ok(failureDiag.includes('ETIMEDOUT'));
            assert.ok(failureDiag.includes('ECONNRESET'));
        });
    });

    describe('formatErrorDetails & fetchViaNodeHttp', () => {
        test('formatErrorDetails unwraps nested causes and AggregateError entries', () => {
            const innerV6 = Object.assign(new Error('connect ENETUNREACH 2600:1400::1:443'), {
                code: 'ENETUNREACH',
                syscall: 'connect',
                address: '2600:1400::1',
                port: 443,
            });
            const innerV4 = Object.assign(new Error('connect ETIMEDOUT 23.1.2.3:443'), {
                code: 'ETIMEDOUT',
                syscall: 'connect',
                address: '23.1.2.3',
                port: 443,
            });
            const agg = new AggregateError([innerV6, innerV4], 'AggregateError');
            Object.assign(agg, { code: 'ETIMEDOUT', hostname: 'www.blackrock.com' });
            const top = new TypeError('fetch failed', { cause: agg });

            const formatted = formatErrorDetails(top);
            assert.ok(formatted.includes('fetch failed'));
            assert.ok(formatted.includes('host=www.blackrock.com'));
            assert.ok(formatted.includes('code=ENETUNREACH'));
            assert.ok(formatted.includes('addr=2600:1400::1:443'));
            assert.ok(formatted.includes('code=ETIMEDOUT'));
            assert.ok(formatted.includes('addr=23.1.2.3:443'));
        });

        test('fetchViaNodeHttp handles redirects, multi-value set-cookie headers, gzip decoding, and timeouts', async () => {
            const receivedCookiesOnFinalHop: string[] = [];

            const server = http.createServer((req, res) => {
                if (req.url === '/start') {
                    res.statusCode = 302;
                    res.setHeader('Location', '/final');
                    res.setHeader('Set-Cookie', [
                        'ak_bmsc=redirect_cookie; Path=/; HttpOnly',
                        'locale=en_CA; Path=/',
                    ]);
                    res.end();
                    return;
                }

                if (req.url === '/final') {
                    receivedCookiesOnFinalHop.push(req.headers.cookie || '');
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.setHeader('Content-Encoding', 'gzip');
                    res.setHeader('Set-Cookie', 'bm_sv=final_cookie; Path=/');
                    res.end(gzipSync(Buffer.from('Ticker,Weight\nAAPL,100', 'utf8')));
                    return;
                }

                if (req.url === '/slow') {
                    setTimeout(() => {
                        if (!res.writableEnded) {
                            res.statusCode = 200;
                            res.end('too late');
                        }
                    }, 300).unref();
                    return;
                }

                res.statusCode = 404;
                res.end('Not found');
            });

            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
            const address = server.address();
            assert.ok(address && typeof address === 'object');
            const baseUrl = `http://127.0.0.1:${address.port}`;

            try {
                const response = await fetchViaNodeHttp(`${baseUrl}/start`, {
                    headers: { Cookie: 'initial=1' },
                    timeoutMs: 2000,
                });

                assert.strictEqual(response.status, 200);
                assert.strictEqual(await response.text(), 'Ticker,Weight\nAAPL,100');
                assert.strictEqual(receivedCookiesOnFinalHop.length, 1);
                assert.ok(receivedCookiesOnFinalHop[0].includes('initial=1'));
                assert.ok(receivedCookiesOnFinalHop[0].includes('ak_bmsc=redirect_cookie'));
                assert.ok(receivedCookiesOnFinalHop[0].includes('locale=en_CA'));

                const responseCookies = response.headers.getSetCookie();
                assert.ok(responseCookies.some((c) => c.startsWith('ak_bmsc=redirect_cookie')));
                assert.ok(responseCookies.some((c) => c.startsWith('bm_sv=final_cookie')));

                await assert.rejects(
                    () => fetchViaNodeHttp(`${baseUrl}/slow`, { timeoutMs: 80 }),
                    /timed out/i
                );
            } finally {
                await new Promise<void>((resolve, reject) =>
                    server.close((err) => (err ? reject(err) : resolve()))
                );
            }
        });
    });
});
