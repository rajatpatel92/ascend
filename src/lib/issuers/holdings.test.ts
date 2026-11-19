import test from 'node:test';
import assert from 'node:assert';
import {
    extractYahooTopHoldings,
    mergeAndCapHoldings,
    parseSecurityIdentity,
    sanitizeStoredHoldings,
} from './holdings.ts';

test('issuer holdings normalization & deduplication', async (t) => {
    await t.test('keeps dual-class shares strictly separate while merging identical share classes across sources', () => {
        const googly = parseSecurityIdentity({
            name: 'ALPHABET INC CLASS A',
            ticker: 'GOOGL',
            country: 'United States',
        });
        const goog = parseSecurityIdentity({
            name: 'ALPHABET INC CLASS C',
            ticker: 'GOOG',
            country: 'United States',
        });

        assert.strictEqual(googly.shareClass, 'a');
        assert.strictEqual(goog.shareClass, 'c');
        assert.notStrictEqual(googly.nameKey, goog.nameKey);
        assert.notStrictEqual(googly.tickerKey, goog.tickerKey);

        const merged = mergeAndCapHoldings([
            { name: 'Apple Inc - Common', weight: 0.1, source: 'td' },
            { name: 'APPLE INC', ticker: 'AAPL', country: 'United States', weight: 0.05, source: 'ishares' },
            { name: 'Alphabet Inc - Common Cl A', weight: 0.04, source: 'td' },
            { name: 'ALPHABET INC-CL A', isin: 'US02079K3059', ticker: 'GOOGL', country: 'United States', weight: 0.02, source: 'vanguard' },
            { name: 'Alphabet Inc - Common Cl C', weight: 0.035, source: 'td' },
            { name: 'ALPHABET INC-CL C', isin: 'US02079K1079', ticker: 'GOOG', country: 'United States', weight: 0.015, source: 'vanguard' },
            { name: 'BERKSHIRE HATHAWAY INC-CL B', isin: 'US0846707026', weight: 0.02, source: 'bmo' },
            { name: 'Berkshire Hathaway Inc.', ticker: 'BRK-B', weight: 0.01, source: 'ishares' },
        ]);

        assert.strictEqual(merged.length, 4);

        const apple = merged.find((m) => m.ticker === 'AAPL');
        assert.ok(apple);
        assert.strictEqual(apple.weight, 0.15);

        const alphaA = merged.find((m) => m.ticker === 'GOOGL');
        const alphaC = merged.find((m) => m.ticker === 'GOOG');
        assert.ok(alphaA && alphaC);
        assert.strictEqual(alphaA.weight, 0.06);
        assert.strictEqual(alphaC.weight, 0.05);

        const brkB = merged.find((m) => m.ticker === 'BRK-B' || m.ticker === 'BRK.B');
        assert.ok(brkB);
        assert.strictEqual(brkB.weight, 0.03);
    });

    await t.test('caps merged holdings at Top 250 sorted descending by weight', () => {
        const rows = Array.from({ length: 320 }, (_, idx) => ({
            name: `Company ${idx + 1} Inc`,
            ticker: `CMP${idx + 1}`,
            weight: (320 - idx) / 100000,
        }));

        const capped = mergeAndCapHoldings(rows);
        assert.strictEqual(capped.length, 250);
        assert.strictEqual(capped[0].ticker, 'CMP1');
        assert.strictEqual(capped[249].ticker, 'CMP250');
    });

    await t.test('extractYahooTopHoldings normalizes fractions and handles missing tickers gracefully', () => {
        const extracted = extractYahooTopHoldings([
            { symbol: 'RY.TO', holdingName: 'Royal Bank of Canada', holdingPercent: 0.0715 },
            { symbol: 'TD.TO', holdingName: 'Toronto-Dominion Bank', holdingPercent: 5.5 }, // already 0-100 fallback test
            { symbol: '', holdingName: 'Invalid Zero', holdingPercent: 0 },
        ]);

        assert.strictEqual(extracted.length, 2);
        assert.strictEqual(extracted[0].ticker, 'RY.TO');
        assert.strictEqual(extracted[0].weight, 0.0715);
        assert.strictEqual(extracted[0].source, 'yahoo');
        assert.strictEqual(extracted[1].ticker, 'TD.TO');
        assert.strictEqual(extracted[1].weight, 0.055);
    });

    await t.test('sanitizeStoredHoldings filters malformed entries and enforces 250 cap', () => {
        const raw = [
            { name: 'Apple Inc - Common', ticker: 'aapl', weight: 0.12, source: 'td' },
            { name: '', weight: 0.1 },
            { name: 'Negative', weight: -0.05 },
            ...Array.from({ length: 260 }, (_, idx) => ({
                name: `Extra ${idx}`,
                weight: 0.0001 + idx * 0.00001,
            })),
        ];

        const sanitized = sanitizeStoredHoldings(raw);
        assert.strictEqual(sanitized.length, 250);
        assert.strictEqual(sanitized[0].name, 'Apple Inc');
        assert.strictEqual(sanitized[0].ticker, 'AAPL');
        assert.strictEqual(sanitized[0].weight, 0.12);
    });
});
