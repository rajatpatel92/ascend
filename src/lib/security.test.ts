import test from 'node:test';
import assert from 'node:assert';
import { timingSafeCompare } from './security.ts';

test('timingSafeCompare', async (t) => {
    await t.test('returns true for matching strings', () => {
        assert.strictEqual(timingSafeCompare('mcp-secret-123', 'mcp-secret-123'), true);
        assert.strictEqual(timingSafeCompare('a', 'a'), true);
        assert.strictEqual(timingSafeCompare('complex_key_!@#$%^&*()', 'complex_key_!@#$%^&*()'), true);
    });

    await t.test('returns false for non-matching strings of same length', () => {
        assert.strictEqual(timingSafeCompare('mcp-secret-123', 'mcp-secret-124'), false);
        assert.strictEqual(timingSafeCompare('A', 'a'), false);
    });

    await t.test('returns false for non-matching strings of different lengths', () => {
        assert.strictEqual(timingSafeCompare('mcp-secret-123', 'mcp-secret-12'), false);
        assert.strictEqual(timingSafeCompare('mcp-secret-123', 'mcp-secret-1234'), false);
        assert.strictEqual(timingSafeCompare('a', 'ab'), false);
    });

    await t.test('returns false when provided or expected is null, undefined, or empty string', () => {
        assert.strictEqual(timingSafeCompare(undefined, 'secret'), false);
        assert.strictEqual(timingSafeCompare('secret', undefined), false);
        assert.strictEqual(timingSafeCompare(undefined, undefined), false);

        assert.strictEqual(timingSafeCompare(null, 'secret'), false);
        assert.strictEqual(timingSafeCompare('secret', null), false);
        assert.strictEqual(timingSafeCompare(null, null), false);

        assert.strictEqual(timingSafeCompare('', 'secret'), false);
        assert.strictEqual(timingSafeCompare('secret', ''), false);
        assert.strictEqual(timingSafeCompare('', ''), false);
    });

    await t.test('handles unicode and long strings correctly', () => {
        const longKey = 'x'.repeat(1000);
        assert.strictEqual(timingSafeCompare(longKey, longKey), true);
        assert.strictEqual(timingSafeCompare(longKey, longKey + 'y'), false);

        const unicodeKey = '🔑secret-key-🔑';
        assert.strictEqual(timingSafeCompare(unicodeKey, unicodeKey), true);
        assert.strictEqual(timingSafeCompare(unicodeKey, '🔑secret-key-🔓'), false);
    });
});
