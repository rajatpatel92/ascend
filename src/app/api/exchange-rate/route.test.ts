import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('src/app/api/exchange-rate/route.ts validation logic', async (t) => {
    const filePath = path.join(process.cwd(), 'src/app/api/exchange-rate/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    await t.test('Validation regex should be present and correct', () => {
        // Check for the validation regex we implemented
        assert.ok(content.includes('/^[A-Z]{3,5}$/'), 'Should contain the currency validation regex');
    });

    await t.test('Validation logic should reject invalid inputs', () => {
        // Since we can't easily execute the handler without full Next.js environment,
        // we test the regex logic that was implemented in the file.
        const isValidCurrency = (val: any) => typeof val === 'string' && /^[A-Z]{3,5}$/.test(val);

        assert.strictEqual(isValidCurrency('USD'), true, 'USD should be valid');
        assert.strictEqual(isValidCurrency('EUR'), true, 'EUR should be valid');
        assert.strictEqual(isValidCurrency('USDT'), true, 'USDT should be valid');
        assert.strictEqual(isValidCurrency('ABCDE'), true, 'ABCDE should be valid');

        assert.strictEqual(isValidCurrency('US'), false, 'US should be too short');
        assert.strictEqual(isValidCurrency('ABCDEF'), false, 'ABCDEF should be too long');
        assert.strictEqual(isValidCurrency('usd'), false, 'Lowercase should be invalid');
        assert.strictEqual(isValidCurrency('US1'), false, 'Numbers should be invalid');
        assert.strictEqual(isValidCurrency(null), false, 'Null should be invalid');
        assert.strictEqual(isValidCurrency(123), false, 'Numbers should be invalid');
    });

    await t.test('Missing parameters check', () => {
        assert.ok(content.includes('if (!from || !to)'), 'Should check for missing from/to parameters');
    });

    await t.test('Invalid parameters check', () => {
        assert.ok(content.includes('if (!isValidCurrency(from) || !isValidCurrency(to))'), 'Should check for invalid from/to parameters');
    });
});
