import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { getHostCircuitStatus, resetHostCircuitBreakersForTests } from './http.ts';
import {
    aggregateVanguardUsAdditionalFundData,
    parseVanguardCaFundAggregations,
    resolveVanguardRegionAndTicker,
    vanguardAdapter,
} from './vanguard.ts';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

describe('Vanguard direct-issuer adapter', () => {
    beforeEach(() => {
        resetHostCircuitBreakersForTests();
    });

    describe('canHandle & region resolution', () => {
        test('maps CA/US tickers and filters out non-Vanguard or equity symbols', () => {
            assert.deepStrictEqual(resolveVanguardRegionAndTicker('VFV.TO'), {
                region: 'ca',
                searchTerms: ['VFV'],
            });
            assert.deepStrictEqual(resolveVanguardRegionAndTicker('VT'), {
                region: 'us',
                searchTerms: ['VT'],
            });
            assert.strictEqual(resolveVanguardRegionAndTicker('CAD=X'), null);
            assert.strictEqual(resolveVanguardRegionAndTicker('^GSPC'), null);

            assert.strictEqual(
                vanguardAdapter.canHandle({
                    symbol: 'VFV.TO',
                    quoteType: 'ETF',
                    fundName: 'Vanguard S&P 500 Index ETF',
                }),
                true
            );
            assert.strictEqual(
                vanguardAdapter.canHandle({
                    symbol: 'VT',
                    quoteType: 'ETF',
                    fundName: 'Vanguard Total World Stock Index Fund ETF Shares',
                }),
                true
            );
            assert.strictEqual(
                vanguardAdapter.canHandle({
                    symbol: 'QUU.TO',
                    quoteType: 'ETF',
                    fundName: 'Mackenzie US Large Cap Equity Index ETF',
                }),
                false
            );
            assert.strictEqual(
                vanguardAdapter.canHandle({
                    symbol: 'AAPL',
                    quoteType: 'EQUITY',
                    fundName: 'Apple Inc.',
                }),
                false
            );
            assert.strictEqual(
                vanguardAdapter.canHandle({ symbol: 'QUU.TO', quoteType: 'ETF' }),
                false
            );
        });
    });

    describe('Vanguard Canada GraphQL', () => {
        test('fetches CA fund-of-funds (VGRO.TO) with MSCTYATPCS group selection & sectors', async () => {
            const seenBodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
            let seenConsumerHeader = '';

            const mockFetch: typeof fetch = async (input, init) => {
                assert.strictEqual(String(input), 'https://www.vanguard.ca/gpx/graphql');
                assert.strictEqual(init?.method, 'POST');
                const hdrs = (init?.headers ?? {}) as Record<string, string>;
                seenConsumerHeader = hdrs['x-consumer-id'];
                const parsed = JSON.parse(String(init?.body)) as {
                    query: string;
                    variables: Record<string, unknown>;
                };
                seenBodies.push(parsed);

                return jsonResponse({
                    data: {
                        funds: [
                            {
                                profile: {
                                    portId: '9579',
                                    fundFullName: 'Vanguard Growth ETF Portfolio',
                                    assetClassificationLevel1: 'Balanced',
                                    primaryMarketEquityClassification: 'MSCI',
                                },
                                marketAllocation: [
                                    // Duplicate FTSE stat code that must NOT be double-counted with MSCTYATPCS
                                    { date: '2026-10-31', countryCode: 'US', countryName: 'United States', fundMktPercent: 45, holdingStatCode: 'FTCTYATPCS' },
                                    { date: '2026-10-31', countryCode: 'US', countryName: 'United States', fundMktPercent: 45, holdingStatCode: 'MSCTYATPCS' },
                                    { date: '2026-10-31', countryCode: 'CA', countryName: 'Canada', fundMktPercent: 30, holdingStatCode: 'MSCTYATPCS' },
                                    { date: '2026-10-31', countryCode: 'JP', countryName: 'Japan', fundMktPercent: 10, holdingStatCode: 'MSCTYATPCS' },
                                    { date: '2026-10-31', countryCode: 'GB', countryName: 'United Kingdom', fundMktPercent: 5, holdingStatCode: 'MSCTYATPCS' },
                                    { date: '2026-10-31', countryCode: 'KY', countryName: 'Other', fundMktPercent: 10, holdingStatCode: 'MSCTYATPCS' },
                                ],
                                sectorDiversification: [
                                    { date: '2026-10-31', sectorName: 'Technology', fundPercent: 25 },
                                    { date: '2026-10-31', sectorName: 'Financials', fundPercent: 20 },
                                    { date: '2026-10-31', sectorName: 'Industrials', fundPercent: 15 },
                                ],
                            },
                        ],
                    },
                });
            };

            const res = await vanguardAdapter.fetchAllocations({
                symbol: 'VGRO.TO',
                quoteType: 'ETF',
                fundName: 'Vanguard Growth ETF Portfolio',
                fetchFn: mockFetch,
            });

            assert.ok(res);
            assert.strictEqual(seenConsumerHeader, 'ca0');
            assert.deepStrictEqual(seenBodies[0].variables, { portIds: ['9579'] });
            assert.strictEqual(res.providerId, 'vanguard');
            assert.strictEqual(res.productId, '9579');
            assert.strictEqual(res.asOfDate, '2026-10-31');

            // KY resolved to null, leaving US 0.45, CA 0.30, JP 0.10, UK 0.05 (10% stays unallocated residual)
            assert.deepStrictEqual(res.countryAllocations, [
                { 'United States': 0.45 },
                { Canada: 0.3 },
                { Japan: 0.1 },
                { 'United Kingdom': 0.05 },
            ]);
            assert.deepStrictEqual(res.sectorAllocations, [
                { Technology: 0.25 },
                { 'Financial Services': 0.2 },
                { Industrials: 0.15 },
            ]);
        });

        test('omits sectors for fixed-income funds and supports dynamic product.model.json catalogue discovery', async () => {
            const mockFetch: typeof fetch = async (input, init) => {
                const url = String(input);
                if (url.includes('product.model.json')) {
                    return jsonResponse({
                        nested: { etfList: { portIds: '9999, 8888' } },
                    });
                }
                const parsed = JSON.parse(String(init?.body)) as { query: string };
                if (parsed.query.includes('FundCatalogue')) {
                    return jsonResponse({
                        data: {
                            funds: [
                                {
                                    portId: '9999',
                                    profile: {
                                        listings: [
                                            {
                                                stockExchangeMarketIdentifierCode: 'XTSE',
                                                identifiers: [{ altId: 'Ticker - Canada', altIdValue: 'VNEW' }],
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    });
                }
                return jsonResponse({
                    data: {
                        funds: [
                            {
                                profile: {
                                    portId: '9999',
                                    assetClassificationLevel1: 'Fixed Income',
                                },
                                marketAllocation: [
                                    { date: '2026-10-31', countryCode: 'CA', countryName: 'Canada', fundMktPercent: 100, holdingStatCode: 'CNTRYEMUG' },
                                ],
                                sectorDiversification: [
                                    { date: '2026-10-31', sectorName: 'Government', fundPercent: 70 },
                                ],
                            },
                        ],
                    },
                });
            };

            const res = await vanguardAdapter.fetchAllocations({
                symbol: 'VNEW.TO',
                quoteType: 'ETF',
                fundName: 'Vanguard New Canadian Bond ETF',
                fetchFn: mockFetch,
            });

            assert.ok(res);
            assert.strictEqual(res.productId, '9999');
            assert.deepStrictEqual(res.countryAllocations, [{ Canada: 1 }]);
            assert.strictEqual(res.sectorAllocations, undefined);

            // Direct unit check on fixed-income parse helper
            const parsedFi = parseVanguardCaFundAggregations({
                profile: { assetClassificationLevel1: 'Bond' },
                marketAllocation: [{ countryCode: 'US', fundMktPercent: 100 }],
                sectorDiversification: [{ sectorName: 'Treasury', fundPercent: 100 }],
            });
            assert.deepStrictEqual(parsedFi.sectorAllocations, []);
        });

        test('falls back to borHoldings with FX-hedge exclusion & underlying ETF look-through, plus IPv4 POST fallback', async () => {
            let nodePosts = 0;

            const mockFailingFetch: typeof fetch = async () => {
                throw new TypeError('fetch failed', {
                    cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
                });
            };

            const mockNodeHttp = async (url: string, opts: { method?: string; body?: string }) => {
                nodePosts++;
                assert.strictEqual(url, 'https://www.vanguard.ca/gpx/graphql');
                assert.strictEqual(opts.method, 'POST');
                const parsed = JSON.parse(opts.body || '{}') as { query: string; variables: { portIds: string[] } };

                if (parsed.query.includes('FundAllocations')) {
                    if (parsed.variables.portIds[0] === '9557') {
                        return jsonResponse({
                            data: {
                                funds: [
                                    {
                                        profile: { portId: '9557', assetClassificationLevel1: 'Equity' },
                                        marketAllocation: [{ countryCode: 'US', countryName: 'United States', fundMktPercent: 100 }],
                                    },
                                ],
                            },
                        });
                    }
                    // Primary portId returns empty marketAllocation -> triggers borHoldings fallback
                    return jsonResponse({
                        data: {
                            funds: [{ profile: { portId: '9563', assetClassificationLevel1: 'Equity' }, marketAllocation: [] }],
                        },
                    });
                }

                return jsonResponse({
                    data: {
                        borHoldings: [
                            {
                                holdings: {
                                    items: [
                                        {
                                            ticker: 'VUN',
                                            isin: 'CA92205A1021',
                                            securityType: 'EQ.ETF',
                                            marketValueBaseCurrency: 800,
                                            effectiveDate: '2026-10-31',
                                        },
                                        {
                                            ticker: 'ASML',
                                            isin: 'NL0010273215',
                                            bloombergIsoCountry: 'NL',
                                            gicsSectorDescription: 'Information Technology',
                                            securityType: 'EQ.ORD',
                                            marketValueBaseCurrency: 200,
                                        },
                                        {
                                            ticker: 'CADFX',
                                            securityType: 'CT.FXFWD',
                                            marketValueBaseCurrency: 1000,
                                        },
                                    ],
                                    lastItemKey: null,
                                },
                            },
                        ],
                    },
                });
            };

            const res = await vanguardAdapter.fetchAllocations({
                symbol: 'VFV.TO',
                quoteType: 'ETF',
                fundName: 'Vanguard S&P 500 Index ETF',
                fetchFn: mockFailingFetch,
                nodeHttpFn: mockNodeHttp,
            });

            assert.ok(res);
            assert.ok(nodePosts >= 3);
            assert.deepStrictEqual(res.countryAllocations, [
                { 'United States': 0.8 },
                { Netherlands: 0.2 },
            ]);
        });
    });

    describe('Vanguard US endpoints', () => {
        test('parses AdditionalFundData (VT) excluding shortTermReserves & CT. FX hedges', async () => {
            const mockFetch: typeof fetch = async (input) => {
                assert.ok(String(input).endsWith('/VT-AdditionalFundData'));
                return jsonResponse({
                    holdingDetails: {
                        asOfDate: '2026-10-31',
                        equityHoldings: [
                            { isin: 'US67066G1040', securityType: 'EQ.CS', marketValuePercentage: '62.0%' },
                            { isin: 'JP3633400001', securityType: 'EQ.CS', marketValuePercentage: 18 },
                            // KY offshore incorporation (e.g. Alibaba/Tencent Cayman ADR) goes to residual, not Cayman Islands
                            { isin: 'KYG017191142', securityType: 'EQ.CS', marketValuePercentage: 10 },
                            { isin: 'US0000000001', securityType: 'CT.FWD', marketValuePercentage: 50 },
                        ],
                        fixedIncomeHoldings: [
                            { isin: 'CA135087P123', securityType: 'FI.GOV', marketValuePercentage: 5 },
                        ],
                        shortTermReservesHoldings: [
                            { isin: 'US9999999999', securityType: 'MM.TBILL', marketValuePercentage: 5 },
                        ],
                    },
                });
            };

            const res = await vanguardAdapter.fetchAllocations({
                symbol: 'VT',
                quoteType: 'ETF',
                fundName: 'Vanguard Total World Stock Index Fund ETF Shares',
                fetchFn: mockFetch,
            });

            assert.ok(res);
            assert.strictEqual(res.providerId, 'vanguard');
            assert.strictEqual(res.asOfDate, '2026-10-31');
            assert.strictEqual(res.sectorAllocations, undefined);
            assert.deepStrictEqual(res.countryAllocations, [
                { 'United States': 0.62 },
                { Japan: 0.18 },
                { Canada: 0.05 },
            ]);

            // Direct parse test on missing details
            assert.deepStrictEqual(aggregateVanguardUsAdditionalFundData({}).countryAllocations, []);
        });

        test('falls back to vmf/api when AdditionalFundData returns 404, and opens circuit on network timeout', async () => {
            const mockFetch: typeof fetch = async (input) => {
                const url = String(input);
                if (url.includes('-AdditionalFundData')) {
                    return new Response('Not Found', { status: 404 });
                }
                if (url.includes('/vmf/api/VT/portfolio-holding/stock')) {
                    return jsonResponse({
                        asOfDate: '2026-10-31',
                        size: 2,
                        fund: {
                            entity: [
                                { isin: 'US0378331005', marketValue: 750 },
                                { isin: 'DE0007164600', marketValue: 250 },
                            ],
                        },
                    });
                }
                return new Response('Not Found', { status: 404 });
            };

            const res = await vanguardAdapter.fetchAllocations({
                symbol: 'VT',
                quoteType: 'ETF',
                fundName: 'Vanguard Total World Stock Index Fund ETF Shares',
                fetchFn: mockFetch,
            });

            assert.ok(res);
            assert.deepStrictEqual(res.countryAllocations, [
                { 'United States': 0.75 },
                { Germany: 0.25 },
            ]);

            // Verify circuit opens on connect timeout
            await assert.rejects(
                () =>
                    vanguardAdapter.fetchAllocations({
                        symbol: 'VT',
                        quoteType: 'ETF',
                        fundName: 'Vanguard Total World Stock Index Fund ETF Shares',
                        fetchFn: async () => {
                            throw new TypeError('fetch failed', {
                                cause: Object.assign(new Error('Connect Timeout Error'), {
                                    code: 'UND_ERR_CONNECT_TIMEOUT',
                                }),
                            });
                        },
                    }),
                /fetch failed/i
            );
            assert.strictEqual(getHostCircuitStatus('investor.vanguard.com').open, true);
        });

        test('extracts Top 250 stock holdings from Vanguard US AdditionalFundData and CA FOF borHoldings', async () => {
            const usAgg = aggregateVanguardUsAdditionalFundData({
                holdingDetails: {
                    asOfDate: '2026-10-31',
                    equityHoldings: [
                        {
                            ticker: 'GOOGL',
                            issuerName: 'Alphabet Inc.',
                            securityLongDescription: 'Alphabet Inc. Class A',
                            isin: 'US02079K3059',
                            securityType: 'EQ.CS',
                            marketValuePercentage: '4.5',
                        },
                        {
                            ticker: 'GOOG',
                            issuerName: 'Alphabet Inc.',
                            securityLongDescription: 'Alphabet Inc. Class C',
                            isin: 'US02079K1079',
                            securityType: 'EQ.CS',
                            marketValuePercentage: '3.8',
                        },
                    ],
                },
            });
            assert.strictEqual(usAgg.topHoldings.length, 2);
            assert.strictEqual(usAgg.topHoldings[0].ticker, 'GOOGL');
            assert.strictEqual(usAgg.topHoldings[1].ticker, 'GOOG');

            const mockCaFetch: typeof fetch = async (_input, init) => {
                const parsed = JSON.parse(String(init?.body)) as {
                    query: string;
                    variables: { portIds: string[] };
                };
                const pid = parsed.variables.portIds[0];

                if (parsed.query.includes('FundAllocations')) {
                    if (pid === '9579') {
                        return jsonResponse({
                            data: {
                                funds: [
                                    {
                                        profile: { portId: '9579', assetClassificationLevel1: 'Balanced' },
                                        marketAllocation: [
                                            { countryCode: 'US', fundMktPercent: 60 },
                                            { countryCode: 'CA', fundMktPercent: 40 },
                                        ],
                                    },
                                ],
                            },
                        });
                    }
                    if (pid === '9557') {
                        return jsonResponse({
                            data: {
                                funds: [
                                    {
                                        profile: { portId: '9557', assetClassificationLevel1: 'Equity' },
                                        marketAllocation: [{ countryCode: 'US', fundMktPercent: 100 }],
                                    },
                                ],
                            },
                        });
                    }
                    return jsonResponse({
                        data: {
                            funds: [
                                {
                                    profile: { portId: '9552', assetClassificationLevel1: 'Fixed Income' },
                                    marketAllocation: [{ countryCode: 'CA', fundMktPercent: 100 }],
                                },
                            ],
                        },
                    });
                }

                if (pid === '9579') {
                    return jsonResponse({
                        data: {
                            borHoldings: [
                                {
                                    holdings: {
                                        items: [
                                            { ticker: 'VUN', securityType: 'EQ.ETF', marketValuePercentage: 60 },
                                            { ticker: 'VAB', securityType: 'EQ.ETF', marketValuePercentage: 40 },
                                        ],
                                    },
                                },
                            ],
                        },
                    });
                }

                if (pid === '9557') {
                    return jsonResponse({
                        data: {
                            borHoldings: [
                                {
                                    holdings: {
                                        items: [
                                            {
                                                ticker: 'AAPL',
                                                issuerName: 'Apple Inc.',
                                                isin: 'US0378331005',
                                                securityType: 'EQ.ORD',
                                                bloombergIsoCountry: 'US',
                                                gicsSectorDescription: 'Information Technology',
                                                marketValuePercentage: 90,
                                            },
                                            {
                                                ticker: 'MSFT',
                                                issuerName: 'Microsoft Corp.',
                                                isin: 'US5949181045',
                                                securityType: 'EQ.ORD',
                                                bloombergIsoCountry: 'US',
                                                gicsSectorDescription: 'Information Technology',
                                                marketValuePercentage: 10,
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    });
                }

                return jsonResponse({ data: { borHoldings: [{ holdings: { items: [] } }] } });
            };

            const vgroRes = await vanguardAdapter.fetchAllocations({
                symbol: 'VGRO.TO',
                quoteType: 'ETF',
                fundName: 'Vanguard Growth ETF Portfolio',
                fetchFn: mockCaFetch,
            });
            assert.ok(vgroRes?.topHoldings);
            assert.strictEqual(vgroRes.topHoldings.length, 2);
            assert.strictEqual(vgroRes.topHoldings[0].ticker, 'AAPL');
            assert.ok(Math.abs(vgroRes.topHoldings[0].weight - 0.54) < 1e-6);
            assert.strictEqual(vgroRes.topHoldings[1].ticker, 'MSFT');
            assert.ok(Math.abs(vgroRes.topHoldings[1].weight - 0.06) < 1e-6);
        });
    });
});
