import test from 'node:test';
import assert from 'node:assert';
import { validateAdminPassword } from '../../prisma/seed-validation.js';

test('validateAdminPassword', async (t) => {
    await t.test('throws error when password is missing or empty', () => {
        assert.throws(
            () => validateAdminPassword(undefined),
            /ADMIN_PASSWORD environment variable is required/
        );
        assert.throws(
            () => validateAdminPassword(''),
            /ADMIN_PASSWORD environment variable is required/
        );
        assert.throws(
            () => validateAdminPassword('   '),
            /ADMIN_PASSWORD environment variable is required/
        );
    });

    await t.test('throws error when password is shorter than 8 characters', () => {
        assert.throws(
            () => validateAdminPassword('short'),
            /ADMIN_PASSWORD must be at least 8 characters long/
        );
        assert.throws(
            () => validateAdminPassword('1234567'),
            /ADMIN_PASSWORD must be at least 8 characters long/
        );
    });

    await t.test('throws error when password is a weak or default placeholder', () => {
        assert.throws(
            () => validateAdminPassword('your_secure_admin_password_here'),
            /ADMIN_PASSWORD cannot be set to a weak or default placeholder password/
        );
        assert.throws(
            () => validateAdminPassword('YOUR_SECURE_PASSWORD_HERE'),
            /ADMIN_PASSWORD cannot be set to a weak or default placeholder password/
        );
        assert.throws(
            () => validateAdminPassword('password123'),
            /ADMIN_PASSWORD cannot be set to a weak or default placeholder password/
        );
        assert.throws(
            () => validateAdminPassword('admin123'),
            /ADMIN_PASSWORD cannot be set to a weak or default placeholder password/
        );
        assert.throws(
            () => validateAdminPassword('12345678'),
            /ADMIN_PASSWORD cannot be set to a weak or default placeholder password/
        );
    });

    await t.test('returns password when valid and secure', () => {
        const securePass = 'SuperSecureP@ssw0rd!2025';
        assert.strictEqual(validateAdminPassword(securePass), securePass);
    });
});
