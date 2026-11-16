import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getActiveSettingsSection,
    getVisibleSettingsSections,
    isSettingsPath,
} from './settings-nav.ts';

test('isSettingsPath identifies root and nested settings routes accurately', () => {
    assert.equal(isSettingsPath('/settings'), true);
    assert.equal(isSettingsPath('/settings/currency'), true);
    assert.equal(isSettingsPath('/settings/data'), true);
    assert.equal(isSettingsPath('/'), false);
    assert.equal(isSettingsPath('/activities'), false);
    assert.equal(isSettingsPath('/settings-legacy'), false);
    assert.equal(isSettingsPath(null), false);
});

test('getVisibleSettingsSections enforces role visibility rules', () => {
    const adminSections = getVisibleSettingsSections('ADMIN').map((s) => s.id);
    assert.deepEqual(adminSections, ['general', 'currency', 'accounts', 'users', 'data']);

    const editorSections = getVisibleSettingsSections('editor').map((s) => s.id);
    assert.deepEqual(editorSections, ['general', 'currency', 'accounts', 'users']);

    const viewerSections = getVisibleSettingsSections('VIEWER').map((s) => s.id);
    assert.deepEqual(viewerSections, ['general', 'currency', 'users']);

    assert.deepEqual(
        getVisibleSettingsSections(undefined).map((s) => s.id),
        ['general', 'currency', 'users']
    );
});

test('getActiveSettingsSection resolves active route with safe fallback', () => {
    assert.equal(getActiveSettingsSection('/settings').id, 'general');
    assert.equal(getActiveSettingsSection('/settings/currency').id, 'currency');
    assert.equal(getActiveSettingsSection('/settings/accounts').id, 'accounts');
    assert.equal(getActiveSettingsSection('/settings/users').id, 'users');
    assert.equal(getActiveSettingsSection('/settings/data').id, 'data');
    assert.equal(getActiveSettingsSection('/unknown').id, 'general');
});
