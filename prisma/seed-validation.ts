export const WEAK_OR_DEFAULT_PASSWORDS = new Set([
    'admin',
    'admin123',
    'administrator',
    'password',
    'password123',
    'changeme',
    'change_me',
    '12345678',
    'root',
    'your_secure_admin_password_here',
    'your_secure_password_here',
]);

/**
 * Validates the ADMIN_PASSWORD environment variable during seeding.
 * Ensures the password is provided, meets minimum length criteria, and is not a default/weak placeholder.
 */
export function validateAdminPassword(password?: string): string {
    if (!password || password.trim() === '') {
        throw new Error('ADMIN_PASSWORD environment variable is required for initial seeding of the admin user.');
    }

    if (password.length < 8) {
        throw new Error('ADMIN_PASSWORD must be at least 8 characters long.');
    }

    if (WEAK_OR_DEFAULT_PASSWORDS.has(password.toLowerCase())) {
        throw new Error('ADMIN_PASSWORD cannot be set to a weak or default placeholder password.');
    }

    return password;
}
