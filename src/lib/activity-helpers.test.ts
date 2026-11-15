import test from 'node:test';
import assert from 'node:assert';
import { buildBehaviorMap, isDripAlias, normalizeActivityType } from './activity-helpers.ts';

test('buildBehaviorMap maps DRIP to ADD by default', () => {
    const map = buildBehaviorMap([
        { name: 'BUY', behavior: 'ADD' },
        { name: 'SELL', behavior: 'REMOVE' }
    ]);

    assert.strictEqual(map.get('BUY'), 'ADD');
    assert.strictEqual(map.get('DRIP'), 'ADD');
    assert.strictEqual(map.get('SELL'), 'REMOVE');
    assert.strictEqual(map.get('DIVIDEND'), 'NEUTRAL');
    assert.strictEqual(map.get('TRANSFER_IN'), 'ADD');
    assert.strictEqual(map.get('TRANSFER_OUT'), 'REMOVE');
});

test('normalizeActivityType maps common brokerage DRIP aliases to DRIP', () => {
    assert.strictEqual(normalizeActivityType('DRIP'), 'DRIP');
    assert.strictEqual(normalizeActivityType('drip'), 'DRIP');
    assert.strictEqual(normalizeActivityType('reinvest'), 'DRIP');
    assert.strictEqual(normalizeActivityType('Reinvestment'), 'DRIP');
    assert.strictEqual(normalizeActivityType('DIVIDEND REINVEST'), 'DRIP');
    assert.strictEqual(normalizeActivityType('dividend_reinvestment'), 'DRIP');
    assert.strictEqual(normalizeActivityType('DIV-REINVEST'), 'DRIP');
    assert.strictEqual(normalizeActivityType('  reinvested  dividend '), 'DRIP');

    assert.strictEqual(isDripAlias('REINVEST'), true);
    assert.strictEqual(isDripAlias('Dividend_Reinvestment'), true);
    assert.strictEqual(isDripAlias('DRIP'), false);
    assert.strictEqual(isDripAlias('BUY'), false);
});

test('normalizeActivityType handles standard aliases and preserves unknown/empty edge cases', () => {
    assert.strictEqual(normalizeActivityType('div'), 'DIVIDEND');
    assert.strictEqual(normalizeActivityType('stock split'), 'STOCK_SPLIT');
    assert.strictEqual(normalizeActivityType('transfer-in'), 'TRANSFER_IN');
    assert.strictEqual(normalizeActivityType('transfer_out'), 'TRANSFER_OUT');
    assert.strictEqual(normalizeActivityType(' buy '), 'BUY');
    assert.strictEqual(normalizeActivityType('CUSTOM_TYPE'), 'CUSTOM_TYPE');
    assert.strictEqual(normalizeActivityType(''), '');
    assert.strictEqual(normalizeActivityType(null), '');
});
