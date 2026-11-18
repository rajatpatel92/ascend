import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    calculateLookThrough,
    normalizeSectorName,
    normalizeCountryName,
    constituentHasSectorExposure,
    constituentHasCountryExposure
} from './look-through.ts';
import type { LookThroughConstituent } from './look-through.ts';

describe('look-through utility', () => {
    describe('normalizeSectorName', () => {
        test('normalizes standard snake_case Yahoo sector names', () => {
            assert.strictEqual(normalizeSectorName('technology'), 'Technology');
            assert.strictEqual(normalizeSectorName('information_technology'), 'Technology');
            assert.strictEqual(normalizeSectorName('financial_services'), 'Financial Services');
            assert.strictEqual(normalizeSectorName('consumer_cyclical'), 'Consumer Cyclical');
            assert.strictEqual(normalizeSectorName('communication_services'), 'Communication Services');
            assert.strictEqual(normalizeSectorName('consumer_defensive'), 'Consumer Defensive');
            assert.strictEqual(normalizeSectorName('basic_materials'), 'Basic Materials');
            assert.strictEqual(normalizeSectorName('realestate'), 'Real Estate');
            assert.strictEqual(normalizeSectorName('utilities'), 'Utilities');
        });

        test('handles empty or whitespace strings', () => {
            assert.strictEqual(normalizeSectorName(''), 'Other / Unclassified');
            assert.strictEqual(normalizeSectorName('   '), 'Other / Unclassified');
            assert.strictEqual(normalizeSectorName(null), 'Other / Unclassified');
            assert.strictEqual(normalizeSectorName(undefined), 'Other / Unclassified');
        });

        test('title cases unrecognized sector names', () => {
            assert.strictEqual(normalizeSectorName('biotechnology_research'), 'Biotechnology Research');
            assert.strictEqual(normalizeSectorName('SPACE EXPLORATION'), 'Space Exploration');
        });
    });

    describe('normalizeCountryName', () => {
        test('normalizes country abbreviations and variations', () => {
            assert.strictEqual(normalizeCountryName('us'), 'United States');
            assert.strictEqual(normalizeCountryName('USA'), 'United States');
            assert.strictEqual(normalizeCountryName('united_states'), 'United States');
            assert.strictEqual(normalizeCountryName('ca'), 'Canada');
            assert.strictEqual(normalizeCountryName('UK'), 'United Kingdom');
            assert.strictEqual(normalizeCountryName('in'), 'India');
        });

        test('normalizes direct issuer CSV country aliases and ISO codes', () => {
            assert.strictEqual(normalizeCountryName('Korea (South)'), 'South Korea');
            assert.strictEqual(normalizeCountryName('Republic of Korea'), 'South Korea');
            assert.strictEqual(normalizeCountryName('kr'), 'South Korea');
            assert.strictEqual(normalizeCountryName('Russian Federation'), 'Russia');
            assert.strictEqual(normalizeCountryName('Taiwan, Province of China'), 'Taiwan');
            assert.strictEqual(normalizeCountryName('Hong Kong SAR'), 'Hong Kong');
            assert.strictEqual(normalizeCountryName('Turkiye'), 'Turkey');
            assert.strictEqual(normalizeCountryName('se'), 'Sweden');
            assert.strictEqual(normalizeCountryName('ie'), 'Ireland');
            assert.strictEqual(normalizeCountryName('sg'), 'Singapore');
            assert.strictEqual(normalizeCountryName('uae'), 'United Arab Emirates');
        });

        test('handles empty or null country', () => {
            assert.strictEqual(normalizeCountryName(''), 'Unspecified');
            assert.strictEqual(normalizeCountryName(null), 'Unspecified');
        });
    });

    describe('calculateLookThrough', () => {
        test('decomposes ETF sector allocations and combines with individual stocks', () => {
            const constituents: LookThroughConstituent[] = [
                {
                    symbol: 'AAPL',
                    name: 'Apple Inc.',
                    type: 'EQUITY',
                    value: 10000,
                    sector: 'Technology',
                    country: 'United States'
                },
                {
                    symbol: 'MSFT',
                    name: 'Microsoft Corp.',
                    type: 'EQUITY',
                    value: 10000,
                    sector: 'Technology',
                    country: 'United States'
                },
                {
                    symbol: 'JNJ',
                    name: 'Johnson & Johnson',
                    type: 'EQUITY',
                    value: 5000,
                    sector: 'Healthcare',
                    country: 'United States'
                },
                {
                    symbol: 'VOO',
                    name: 'Vanguard S&P 500 ETF',
                    type: 'ETF',
                    value: 50000,
                    country: 'United States',
                    sectorAllocations: [
                        { technology: 0.30 }, // 30% of $50,000 = $15,000
                        { financial_services: 0.15 }, // 15% of $50,000 = $7,500
                        { healthcare: 0.10 }, // 10% of $50,000 = $5,000
                        { consumer_cyclical: 0.10 }, // 10% of $50,000 = $5,000
                        { industrials: 0.10 }, // 10% of $50,000 = $5,000
                        { communication_services: 0.10 }, // 10% of $50,000 = $5,000
                        { consumer_defensive: 0.05 }, // 5% of $50,000 = $2,500
                        { energy: 0.05 }, // 5% of $50,000 = $2,500
                        { realestate: 0.05 } // 5% of $50,000 = $2,500
                    ]
                }
            ];

            const result = calculateLookThrough(constituents);

            assert.strictEqual(result.totalValue, 75000);

            // Check Technology: AAPL (10,000) + MSFT (10,000) + VOO (15,000) = 35,000
            const techSector = result.sectorDetails.find(s => s.name === 'Technology');
            assert.ok(techSector, 'Technology sector should exist');
            assert.strictEqual(techSector.value, 35000);
            assert.strictEqual(Number((techSector.percentage).toFixed(2)), Number(((35000 / 75000) * 100).toFixed(2)));

            // Check Contributors to Technology
            assert.strictEqual(techSector.contributors.length, 3);
            const vooContrib = techSector.contributors.find(c => c.symbol === 'VOO');
            assert.ok(vooContrib);
            assert.strictEqual(vooContrib.allocatedValue, 15000);
            assert.strictEqual(vooContrib.isLookThrough, true);
            assert.strictEqual(vooContrib.weightInHolding, 0.30);

            // Check Healthcare: JNJ (5,000) + VOO (5,000) = 10,000
            const healthSector = result.sectorDetails.find(s => s.name === 'Healthcare');
            assert.ok(healthSector);
            assert.strictEqual(healthSector.value, 10000);
            assert.strictEqual(healthSector.contributors.length, 2);

            // Check Financial Services: only from VOO (7,500)
            const finSector = result.sectorDetails.find(s => s.name === 'Financial Services');
            assert.ok(finSector);
            assert.strictEqual(finSector.value, 75000 * 0.10); // 7,500
            assert.strictEqual(finSector.contributors[0].symbol, 'VOO');
            assert.strictEqual(finSector.contributors[0].isLookThrough, true);
        });

        test('handles ETF with partial sector weighting sum by recording residual as Cash & Reserves', () => {
            const constituents: LookThroughConstituent[] = [
                {
                    symbol: 'TECH_ETF',
                    name: 'Tech Only ETF',
                    type: 'ETF',
                    value: 10000,
                    country: 'United States',
                    sectorAllocations: [
                        { technology: 0.90 } // 90% tech, 10% cash residual
                    ]
                }
            ];

            const result = calculateLookThrough(constituents);
            assert.strictEqual(result.totalValue, 10000);

            const tech = result.sectorDetails.find(s => s.name === 'Technology');
            assert.strictEqual(tech?.value, 9000);

            const cash = result.sectorDetails.find(s => s.name === 'Cash & Reserves');
            assert.ok(cash, 'Residual should be recorded as Cash & Reserves');
            assert.strictEqual(cash.value, 1000);
        });

        test('categorizes Crypto and Cash when sector is not specified', () => {
            const constituents: LookThroughConstituent[] = [
                {
                    symbol: 'BTC',
                    name: 'Bitcoin',
                    type: 'CRYPTO',
                    value: 5000
                },
                {
                    symbol: 'USD_CASH',
                    name: 'USD Balance',
                    type: 'CASH',
                    value: 2000,
                    currency: 'USD'
                }
            ];

            const result = calculateLookThrough(constituents);
            const cryptoSector = result.sectorDetails.find(s => s.name === 'Crypto / Digital Assets');
            assert.strictEqual(cryptoSector?.value, 5000);

            const cashSector = result.sectorDetails.find(s => s.name === 'Cash & Equivalents');
            assert.strictEqual(cashSector?.value, 2000);

            const btcCountry = result.countryDetails.find(c => c.name === 'Global / Decentralized');
            assert.strictEqual(btcCountry?.value, 5000);
        });

        test('returns empty structures when constituents list is empty', () => {
            const result = calculateLookThrough([]);
            assert.strictEqual(result.totalValue, 0);
            assert.strictEqual(result.bySector.length, 0);
            assert.strictEqual(result.byCountry.length, 0);
            assert.strictEqual(result.sectorDetails.length, 0);
            assert.strictEqual(result.countryDetails.length, 0);
        });

        test('ignores zero and negative value holdings', () => {
            const constituents: LookThroughConstituent[] = [
                {
                    symbol: 'ZERO',
                    value: 0,
                    sector: 'Technology'
                },
                {
                    symbol: 'NEG',
                    value: -500,
                    sector: 'Technology'
                },
                {
                    symbol: 'POS',
                    value: 1000,
                    sector: 'Technology'
                }
            ];

            const result = calculateLookThrough(constituents);
            assert.strictEqual(result.totalValue, 1000);
            assert.strictEqual(result.bySector[0].value, 1000);
            assert.strictEqual(result.sectorDetails[0].contributors.length, 1);
            assert.strictEqual(result.sectorDetails[0].contributors[0].symbol, 'POS');
        });

        test('filters out sub-cent floating-point dust holdings and exposes weightInHolding on country contributors', () => {
            const constituents: LookThroughConstituent[] = [
                {
                    symbol: 'DUST',
                    name: 'Sold Dust Position',
                    value: 0.000001,
                    sector: 'Technology',
                    country: 'Canada'
                },
                {
                    symbol: 'REAL_ETF',
                    name: 'Real ETF',
                    type: 'ETF',
                    value: 1000,
                    sectorAllocations: [
                        { technology: 0.5 },
                        { energy: 0.000001 }
                    ],
                    countryAllocations: [
                        { canada: 0.75 },
                        { united_states: 0.25 }
                    ]
                }
            ];

            const result = calculateLookThrough(constituents);
            assert.strictEqual(result.totalValue, 1000);

            const tech = result.sectorDetails.find(s => s.name === 'Technology');
            assert.ok(tech);
            assert.strictEqual(tech.contributors.length, 1);
            assert.strictEqual(tech.contributors[0].symbol, 'REAL_ETF');

            // Sub-cent sector allocation (1000 * 0.000001 = 0.001 < 0.01) should not create an Energy entry
            const energy = result.sectorDetails.find(s => s.name === 'Energy');
            assert.strictEqual(energy, undefined);

            // Country contributors should include weightInHolding and exclude DUST
            const canada = result.countryDetails.find(c => c.name === 'Canada');
            assert.ok(canada);
            assert.strictEqual(canada.contributors.length, 1);
            assert.strictEqual(canada.contributors[0].symbol, 'REAL_ETF');
            assert.strictEqual(canada.contributors[0].weightInHolding, 0.75);
        });
    });

    describe('constituentHasSectorExposure', () => {
        test('matches direct stock with matching sector', () => {
            const stock: LookThroughConstituent = {
                symbol: 'AAPL',
                value: 1000,
                sector: 'technology'
            };
            assert.strictEqual(constituentHasSectorExposure(stock, 'Technology'), true);
            assert.strictEqual(constituentHasSectorExposure(stock, 'Financial Services'), false);
        });

        test('matches ETF with sector allocations', () => {
            const etf: LookThroughConstituent = {
                symbol: 'VOO',
                value: 5000,
                sectorAllocations: [
                    { technology: 0.30 },
                    { financial_services: 0.15 }
                ]
            };
            assert.strictEqual(constituentHasSectorExposure(etf, 'Technology'), true);
            assert.strictEqual(constituentHasSectorExposure(etf, 'Financial Services'), true);
            assert.strictEqual(constituentHasSectorExposure(etf, 'Energy'), false);
        });

        test('matches crypto and cash fallbacks', () => {
            const crypto: LookThroughConstituent = {
                symbol: 'BTC',
                value: 1000,
                type: 'CRYPTO'
            };
            assert.strictEqual(constituentHasSectorExposure(crypto, 'Crypto / Digital Assets'), true);
            assert.strictEqual(constituentHasSectorExposure(crypto, 'Technology'), false);
        });

        test('matches residual Cash & Reserves and Other / Unclassified fallbacks', () => {
            const partialEtf: LookThroughConstituent = {
                symbol: 'PARTIAL',
                value: 1000,
                sectorAllocations: [{ technology: 0.85 }]
            };
            assert.strictEqual(constituentHasSectorExposure(partialEtf, 'Cash & Reserves'), true);

            const unclassified: LookThroughConstituent = {
                symbol: 'ZMMK.TO',
                value: 1000,
                type: 'CASH_EQUIV'
            };
            assert.strictEqual(constituentHasSectorExposure(unclassified, 'Other / Unclassified'), true);
        });
    });

    describe('constituentHasCountryExposure', () => {
        test('matches direct country and currency fallback', () => {
            const usStock: LookThroughConstituent = {
                symbol: 'AAPL',
                value: 1000,
                country: 'United States'
            };
            assert.strictEqual(constituentHasCountryExposure(usStock, 'United States'), true);
            assert.strictEqual(constituentHasCountryExposure(usStock, 'Canada'), false);

            const cadStock: LookThroughConstituent = {
                symbol: 'SHOP',
                value: 1000,
                currency: 'CAD'
            };
            assert.strictEqual(constituentHasCountryExposure(cadStock, 'Canada'), true);
        });

        test('does not fall back to currency when country or countryAllocations are defined', () => {
            const tsm: LookThroughConstituent = {
                symbol: 'TSM',
                value: 2000,
                country: 'Taiwan',
                currency: 'USD'
            };
            assert.strictEqual(constituentHasCountryExposure(tsm, 'Taiwan'), true);
            assert.strictEqual(constituentHasCountryExposure(tsm, 'United States'), false);

            const vxus: LookThroughConstituent = {
                symbol: 'VXUS',
                value: 3000,
                currency: 'USD',
                countryAllocations: [{ japan: 0.15 }, { uk: 0.10 }]
            };
            assert.strictEqual(constituentHasCountryExposure(vxus, 'Japan'), true);
            assert.strictEqual(constituentHasCountryExposure(vxus, 'Global / Other'), true);
            assert.strictEqual(constituentHasCountryExposure(vxus, 'United States'), false);
        });

        test('matches ETF country allocations and Unspecified fallback', () => {
            const globalEtf: LookThroughConstituent = {
                symbol: 'VXUS',
                value: 3000,
                countryAllocations: [
                    { japan: 0.15 },
                    { uk: 0.10 }
                ]
            };
            assert.strictEqual(constituentHasCountryExposure(globalEtf, 'Japan'), true);
            assert.strictEqual(constituentHasCountryExposure(globalEtf, 'United Kingdom'), true);
            assert.strictEqual(constituentHasCountryExposure(globalEtf, 'Canada'), false);

            const unknown: LookThroughConstituent = {
                symbol: 'MISC',
                value: 500
            };
            assert.strictEqual(constituentHasCountryExposure(unknown, 'Unspecified'), true);
        });
    });

    describe('portfolio overlap and decomposition integration', () => {
        test('accurately calculates combined exposure from multiple ETFs and direct stocks', () => {
            const portfolio: LookThroughConstituent[] = [
                {
                    symbol: 'AAPL',
                    name: 'Apple Inc.',
                    type: 'EQUITY',
                    value: 10000,
                    sector: 'Technology',
                    country: 'United States'
                },
                {
                    symbol: 'VOO',
                    name: 'Vanguard S&P 500 ETF',
                    type: 'ETF',
                    value: 20000,
                    country: 'United States',
                    sectorAllocations: [
                        { technology: 0.30 }, // $6,000
                        { financial_services: 0.15 }, // $3,000
                        { healthcare: 0.12 } // $2,400
                    ]
                },
                {
                    symbol: 'QQQ',
                    name: 'Invesco QQQ Trust',
                    type: 'ETF',
                    value: 10000,
                    country: 'United States',
                    sectorAllocations: [
                        { technology: 0.50 }, // $5,000
                        { communication_services: 0.15 } // $1,500
                    ]
                }
            ];

            const result = calculateLookThrough(portfolio);
            assert.strictEqual(result.totalValue, 40000);

            // Tech total: AAPL ($10,000) + VOO ($6,000) + QQQ ($5,000) = $21,000 (52.5%)
            const tech = result.sectorDetails.find(s => s.name === 'Technology');
            assert.ok(tech);
            assert.strictEqual(tech.value, 21000);
            assert.strictEqual(tech.percentage, 52.5);
            assert.strictEqual(tech.contributors.length, 3);

            // Verify contributors are sorted descending by allocatedValue
            assert.strictEqual(tech.contributors[0].symbol, 'AAPL');
            assert.strictEqual(tech.contributors[0].allocatedValue, 10000);
            assert.strictEqual(tech.contributors[0].isLookThrough, false);

            assert.strictEqual(tech.contributors[1].symbol, 'VOO');
            assert.strictEqual(tech.contributors[1].allocatedValue, 6000);
            assert.strictEqual(tech.contributors[1].isLookThrough, true);

            assert.strictEqual(tech.contributors[2].symbol, 'QQQ');
            assert.strictEqual(tech.contributors[2].allocatedValue, 5000);
            assert.strictEqual(tech.contributors[2].isLookThrough, true);
        });

        test('normalizes 0-100 percentage inputs and >1.0 or 0.995 rounding sums without losing value', () => {
            const constituents: LookThroughConstituent[] = [
                {
                    symbol: 'PCT_ETF',
                    type: 'ETF',
                    value: 10000,
                    sectorAllocations: [
                        { technology: 60 },
                        { healthcare: 40 }
                    ]
                },
                {
                    symbol: 'ROUND_ETF',
                    type: 'ETF',
                    value: 10000,
                    sectorAllocations: [
                        { financials: 0.50 },
                        { energy: 0.495 }
                    ]
                }
            ];

            const result = calculateLookThrough(constituents);
            assert.strictEqual(result.totalValue, 20000);
            const sectorSum = result.sectorDetails.reduce((s, d) => s + d.value, 0);
            assert.ok(Math.abs(sectorSum - 20000) < 0.05, `Expected sector sum 20000, got ${sectorSum}`);
            const tech = result.sectorDetails.find(s => s.name === 'Technology');
            assert.strictEqual(tech?.value, 6000);
        });
    });
});
