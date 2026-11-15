import test from 'node:test';
import assert from 'node:assert';
import { buildBehaviorMap } from './activity-helpers.ts';

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
