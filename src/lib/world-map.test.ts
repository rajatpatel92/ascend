import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    canonicalizeMapCountryName,
    computeChoroplethShade,
    prepareCountryMapData,
} from './world-map.ts';
import { WORLD_COUNTRY_MARKERS, WORLD_COUNTRY_SHAPES } from './world-map-data.ts';

function parseRgbLuminance(color: string): number {
    if (color.startsWith('#')) {
        const hex = Number.parseInt(color.slice(1), 16);
        const r = (hex >> 16) & 255;
        const g = (hex >> 8) & 255;
        const b = hex & 255;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    const match = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    assert.ok(match, `Expected rgb(...) or hex color, received "${color}"`);
    return 0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3]);
}

describe('world-map utility', () => {
    describe('canonicalizeMapCountryName', () => {
        test('maps Natural Earth and iShares aliases to shared canonical names', () => {
            assert.strictEqual(canonicalizeMapCountryName('United States of America'), 'United States');
            assert.strictEqual(canonicalizeMapCountryName('USA'), 'United States');
            assert.strictEqual(canonicalizeMapCountryName('Korea (South)'), 'South Korea');
            assert.strictEqual(canonicalizeMapCountryName('Republic of Korea'), 'South Korea');
            assert.strictEqual(canonicalizeMapCountryName('Czechia'), 'Czech Republic');
            assert.strictEqual(canonicalizeMapCountryName('Turkiye'), 'Turkey');
            assert.strictEqual(canonicalizeMapCountryName('Russian Federation'), 'Russia');
            assert.strictEqual(canonicalizeMapCountryName('Hong Kong SAR'), 'Hong Kong');
            assert.strictEqual(canonicalizeMapCountryName('Taiwan, Province of China'), 'Taiwan');
            assert.strictEqual(canonicalizeMapCountryName("Côte d'Ivoire"), 'Ivory Coast');
            assert.strictEqual(canonicalizeMapCountryName('Bahamas'), 'The Bahamas');
        });

        test('handles empty or null names safely', () => {
            assert.strictEqual(canonicalizeMapCountryName(''), 'Unspecified');
            assert.strictEqual(canonicalizeMapCountryName('   '), 'Unspecified');
            assert.strictEqual(canonicalizeMapCountryName(null), 'Unspecified');
            assert.strictEqual(canonicalizeMapCountryName(undefined), 'Unspecified');
        });

        test('covers major global equity markets in generated Natural Earth shapes and markers', () => {
            const knownMapCountries = new Set<string>([
                ...WORLD_COUNTRY_SHAPES.map((s) => canonicalizeMapCountryName(s.name)),
                ...WORLD_COUNTRY_MARKERS.map((m) => canonicalizeMapCountryName(m.name)),
            ]);

            const majorMarkets = [
                'United States',
                'Canada',
                'Japan',
                'United Kingdom',
                'France',
                'Germany',
                'Switzerland',
                'Australia',
                'China',
                'India',
                'Taiwan',
                'South Korea',
                'Netherlands',
                'Sweden',
                'Denmark',
                'Spain',
                'Italy',
                'Brazil',
                'Hong Kong',
                'Singapore',
                'Ireland',
                'Mexico',
                'South Africa',
                'Norway',
                'Finland',
                'Belgium',
                'Israel',
                'Indonesia',
                'Thailand',
                'Malaysia',
                'Poland',
                'Turkey',
            ];

            for (const country of majorMarkets) {
                assert.ok(
                    knownMapCountries.has(country),
                    `Expected world-map-data to contain shape or marker for "${country}"`
                );
            }
        });
    });

    describe('computeChoroplethShade', () => {
        test('returns neutral base slate for zero or invalid amounts', () => {
            assert.strictEqual(computeChoroplethShade(0, 1000, true), '#161f2e');
            assert.strictEqual(computeChoroplethShade(-10, 1000, true), '#161f2e');
            assert.strictEqual(computeChoroplethShade(0, 0, true), '#161f2e');
            assert.strictEqual(computeChoroplethShade(0, 1000, false), '#e2e8f0');
        });

        test('produces monotonically brighter shades from Dark to Bright in dark mode', () => {
            const lumZero = parseRgbLuminance(computeChoroplethShade(0, 1000, true));
            const lumTiny = parseRgbLuminance(computeChoroplethShade(5, 1000, true));
            const lumMid = parseRgbLuminance(computeChoroplethShade(250, 1000, true));
            const lumMax = parseRgbLuminance(computeChoroplethShade(1000, 1000, true));

            assert.ok(lumZero < lumTiny, `Expected 0 (${lumZero}) < tiny (${lumTiny})`);
            assert.ok(lumTiny < lumMid, `Expected tiny (${lumTiny}) < mid (${lumMid})`);
            assert.ok(lumMid < lumMax, `Expected mid (${lumMid}) < max (${lumMax})`);
        });
    });

    describe('prepareCountryMapData', () => {
        test('filters dust, sorts descending, computes percentages, and merges canonical aliases', () => {
            const result = prepareCountryMapData([
                { name: 'Japan', value: 200 },
                { name: 'United States', value: 500 },
                { name: 'United States of America', value: 100 },
                { name: 'Tiny Dust', value: 0.005 },
                { name: 'Canada', value: 200 },
            ]);

            assert.strictEqual(result.totalValue, 1000);
            assert.strictEqual(result.maxValue, 500);
            assert.strictEqual(result.items.length, 4);
            assert.strictEqual(result.items[0].name, 'United States');
            assert.strictEqual(result.items[0].value, 500);

            const usCombined = result.byCanonicalName.get('United States');
            assert.ok(usCombined);
            assert.strictEqual(usCombined.name, 'United States');
            assert.strictEqual(usCombined.value, 600);
            assert.strictEqual(usCombined.percent, 60);
        });

        test('applies currency conversion when isPreConverted is false', () => {
            const result = prepareCountryMapData(
                [
                    { name: 'United States', value: 100 },
                    { name: 'Canada', value: 50 },
                ],
                {
                    isPreConverted: false,
                    convert: (amount) => amount * 1.4,
                }
            );

            assert.strictEqual(result.totalValue, 210);
            assert.strictEqual(result.items[0].value, 140);
            assert.strictEqual(result.items[1].value, 70);
        });

        test('handles empty datasets safely', () => {
            const result = prepareCountryMapData([]);
            assert.deepStrictEqual(result.items, []);
            assert.strictEqual(result.totalValue, 0);
            assert.strictEqual(result.maxValue, 0);
            assert.strictEqual(result.byCanonicalName.size, 0);
        });
    });
});
