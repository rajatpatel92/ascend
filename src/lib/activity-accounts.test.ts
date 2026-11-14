import test from 'node:test';
import assert from 'node:assert';
import { filterSelectableAccounts, type SelectableAccount } from './activity-accounts.ts';

const sampleAccounts: SelectableAccount[] = [
    { id: 'acc-active-cad', name: 'Rajat', type: 'TFSA', platformId: 'p1', currency: 'CAD', isActive: true },
    { id: 'acc-inactive-cad', name: 'Rajat', type: 'RRSP', platformId: 'p1', currency: 'CAD', isActive: false },
    { id: 'acc-active-usd', name: 'Rajat', type: 'USD', platformId: 'p2', currency: 'USD', isActive: true },
    { id: 'acc-inactive-usd', name: 'Rajat', type: 'Margin', platformId: 'p2', currency: 'USD', isActive: false },
    { id: 'acc-legacy-undefined', name: 'Rajat', type: 'Cash', platformId: 'p1', currency: 'CAD' },
];

test('filterSelectableAccounts', async (t) => {
    await t.test('excludes inactive accounts when adding a new activity', () => {
        const result = filterSelectableAccounts(sampleAccounts, 'CAD');
        assert.deepStrictEqual(
            result.map((a) => a.id),
            ['acc-active-cad', 'acc-legacy-undefined']
        );
    });

    await t.test('excludes inactive accounts when editingAccountId is null or empty', () => {
        const resultNull = filterSelectableAccounts(sampleAccounts, 'USD', null);
        const resultEmpty = filterSelectableAccounts(sampleAccounts, 'USD', '');
        assert.deepStrictEqual(resultNull.map((a) => a.id), ['acc-active-usd']);
        assert.deepStrictEqual(resultEmpty.map((a) => a.id), ['acc-active-usd']);
    });

    await t.test('includes the activity own inactive (transferred out) account when editing', () => {
        const result = filterSelectableAccounts(sampleAccounts, 'CAD', 'acc-inactive-cad');
        assert.deepStrictEqual(
            result.map((a) => a.id),
            ['acc-active-cad', 'acc-inactive-cad', 'acc-legacy-undefined']
        );
    });

    await t.test('does not include other inactive accounts when editing an activity', () => {
        const result = filterSelectableAccounts(sampleAccounts, 'CAD', 'acc-active-cad');
        assert.deepStrictEqual(
            result.map((a) => a.id),
            ['acc-active-cad', 'acc-legacy-undefined']
        );
    });

    await t.test('includes the edited activity own account even if currency differs', () => {
        const result = filterSelectableAccounts(sampleAccounts, 'CAD', 'acc-inactive-usd');
        assert.deepStrictEqual(
            result.map((a) => a.id),
            ['acc-active-cad', 'acc-inactive-usd', 'acc-legacy-undefined']
        );
    });
});
