import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFireProfileSlugId,
    createDefaultFireProfile,
    hasFireProfileChanges,
    normalizeFireCurrency,
    sanitizeFireDate,
    sanitizeFireParams,
    sanitizeFireProfile
} from './fire-profiles.ts';

test('normalizeFireCurrency accepts supported currencies and falls back safely', () => {
    assert.equal(normalizeFireCurrency('usd'), 'USD');
    assert.equal(normalizeFireCurrency(' cad '), 'CAD');
    assert.equal(normalizeFireCurrency('INVALID', 'EUR'), 'EUR');
    assert.equal(normalizeFireCurrency(undefined, 'ZZZ'), 'CAD');
});

test('sanitizeFireDate validates YYYY-MM format and rejects out-of-range dates', () => {
    const ref = new Date(2026, 4, 15);
    assert.equal(sanitizeFireDate('2035-08', ref), '2035-08');
    assert.equal(sanitizeFireDate('2035-13', ref), '2036-05');
    assert.equal(sanitizeFireDate('not-a-date', ref), '2036-05');
});

test('sanitizeFireParams clamps bounds and preserves valid withdrawal settings', () => {
    const ref = new Date(2026, 0, 1);
    const sanitized = sanitizeFireParams(
        {
            fireDate: '2040-06',
            monthlyContribution: -500,
            expectedReturn: 8.25,
            inflationRate: 100,
            currentMonthlyExpense: 4200,
            calculationMode: 'FIXED_HORIZON',
            withdrawalRate: 0,
            withdrawalDuration: 120
        },
        ref
    );

    assert.equal(sanitized.fireDate, '2040-06');
    assert.equal(sanitized.monthlyContribution, 0);
    assert.equal(sanitized.expectedReturn, 8.25);
    assert.equal(sanitized.inflationRate, 30);
    assert.equal(sanitized.currentMonthlyExpense, 4200);
    assert.equal(sanitized.calculationMode, 'FIXED_HORIZON');
    assert.equal(sanitized.withdrawalRate, 0.1);
    assert.equal(sanitized.withdrawalDuration, 80);
});

test('createDefaultFireProfile and sanitizeFireProfile produce consistent profile records', () => {
    const ref = new Date('2026-06-01T12:00:00.000Z');
    const def = createDefaultFireProfile('USD', ref);
    assert.equal(def.id, 'default');
    assert.equal(def.name, 'Default FIRE Plan');
    assert.equal(def.currency, 'USD');
    assert.equal(def.params.withdrawalRate, 4);

    const sanitized = sanitizeFireProfile({ id: ' lean ', name: '  Lean FIRE  ', currency: 'eur' }, 'CAD', ref);
    assert.equal(sanitized.id, 'lean');
    assert.equal(sanitized.name, 'Lean FIRE');
    assert.equal(sanitized.currency, 'EUR');
});

test('buildFireProfileSlugId generates URL-safe unique slug ids', () => {
    const id = buildFireProfileSlugId('Fat FIRE (2038)', 1700000000000);
    assert.ok(id.startsWith('fat-fire-2038-'));
});

test('hasFireProfileChanges compares values accurately across matching and converted currencies', () => {
    const profile = createDefaultFireProfile('USD', new Date(2026, 0, 1));
    const sameParams = { ...profile.params };
    assert.equal(
        hasFireProfileChanges(profile, sameParams, 'USD', (amount) => amount),
        false
    );

    assert.equal(
        hasFireProfileChanges(
            profile,
            { ...sameParams, expectedReturn: 7.5 },
            'USD',
            (amount) => amount
        ),
        true
    );

    // 2000 USD -> 2800 CAD should be detected as clean (unchanged) when activeCurrency is CAD
    assert.equal(
        hasFireProfileChanges(
            profile,
            { ...sameParams, monthlyContribution: 2800, currentMonthlyExpense: 2800 },
            'CAD',
            (amount, from) => (from === 'USD' ? amount * 1.4 : amount)
        ),
        false
    );

    assert.equal(
        hasFireProfileChanges(
            profile,
            { ...sameParams, monthlyContribution: 3200, currentMonthlyExpense: 2800 },
            'CAD',
            (amount, from) => (from === 'USD' ? amount * 1.4 : amount)
        ),
        true
    );
});
