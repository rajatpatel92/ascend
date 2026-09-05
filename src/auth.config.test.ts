import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSafeRedirectUrl, authConfig } from './auth.config.ts';

describe('getSafeRedirectUrl', () => {
    const baseUrl = 'http://localhost:3000';

    it('returns default same-origin root URL when target is empty or undefined', () => {
        const result1 = getSafeRedirectUrl(undefined, baseUrl);
        assert.equal(result1.toString(), 'http://localhost:3000/');

        const result2 = getSafeRedirectUrl(null, baseUrl);
        assert.equal(result2.toString(), 'http://localhost:3000/');

        const result3 = getSafeRedirectUrl('', baseUrl);
        assert.equal(result3.toString(), 'http://localhost:3000/');
    });

    it('allows safe relative paths', () => {
        const result1 = getSafeRedirectUrl('/', baseUrl);
        assert.equal(result1.toString(), 'http://localhost:3000/');

        const result2 = getSafeRedirectUrl('/dashboard', baseUrl);
        assert.equal(result2.toString(), 'http://localhost:3000/dashboard');

        const result3 = getSafeRedirectUrl('/ai-analysis?tab=overview', baseUrl);
        assert.equal(result3.toString(), 'http://localhost:3000/ai-analysis?tab=overview');
    });

    it('allows same-origin full URLs', () => {
        const result = getSafeRedirectUrl('http://localhost:3000/settings', baseUrl);
        assert.equal(result.toString(), 'http://localhost:3000/settings');
    });

    it('blocks cross-origin URLs', () => {
        const result1 = getSafeRedirectUrl('https://evil.com', baseUrl);
        assert.equal(result1.toString(), 'http://localhost:3000/');

        const result2 = getSafeRedirectUrl('http://evil.com:3000/phishing', baseUrl);
        assert.equal(result2.toString(), 'http://localhost:3000/');
    });

    it('blocks protocol-relative URLs', () => {
        const result1 = getSafeRedirectUrl('//evil.com', baseUrl);
        assert.equal(result1.toString(), 'http://localhost:3000/');

        const result2 = getSafeRedirectUrl('//localhost:3000@evil.com', baseUrl);
        assert.equal(result2.toString(), 'http://localhost:3000/');
    });

    it('blocks backslash-based redirection tricks', () => {
        const result1 = getSafeRedirectUrl('/\\evil.com', baseUrl);
        assert.equal(result1.toString(), 'http://localhost:3000/');

        const result2 = getSafeRedirectUrl('\\evil.com', baseUrl);
        assert.equal(result2.toString(), 'http://localhost:3000/');
    });

    it('blocks javascript: and non-http/https protocols', () => {
        const result1 = getSafeRedirectUrl('javascript:alert(1)', baseUrl);
        assert.equal(result1.toString(), 'http://localhost:3000/');

        const result2 = getSafeRedirectUrl('data:text/html,<script>alert(1)</script>', baseUrl);
        assert.equal(result2.toString(), 'http://localhost:3000/');
    });
});

describe('authConfig callbacks', () => {
    describe('authorized callback', () => {
        const authorized = authConfig.callbacks.authorized as any;

        it('allows API auth routes unconditionally', () => {
            const nextUrl = { nextUrl: new URL('http://localhost:3000/api/auth/callback/credentials') };
            const result = authorized({ auth: null, request: nextUrl });
            assert.equal(result, true);
        });

        it('redirects logged-in user on /login page to default / when no callbackUrl', () => {
            const nextUrl = { nextUrl: new URL('http://localhost:3000/login') };
            const auth = { user: { name: 'Admin' } };
            const response = authorized({ auth, request: nextUrl });
            assert.ok(response instanceof Response);
            assert.equal(response.status, 302);
            assert.equal(response.headers.get('location'), 'http://localhost:3000/');
        });

        it('redirects logged-in user on /login page to valid relative callbackUrl', () => {
            const nextUrl = { nextUrl: new URL('http://localhost:3000/login?callbackUrl=/dashboard') };
            const auth = { user: { name: 'Admin' } };
            const response = authorized({ auth, request: nextUrl });
            assert.ok(response instanceof Response);
            assert.equal(response.status, 302);
            assert.equal(response.headers.get('location'), 'http://localhost:3000/dashboard');
        });

        it('blocks malicious callbackUrl and redirects logged-in user on /login to default /', () => {
            const nextUrl = { nextUrl: new URL('http://localhost:3000/login?callbackUrl=https://evil.com') };
            const auth = { user: { name: 'Admin' } };
            const response = authorized({ auth, request: nextUrl });
            assert.ok(response instanceof Response);
            assert.equal(response.status, 302);
            assert.equal(response.headers.get('location'), 'http://localhost:3000/');
        });

        it('returns true for logged-in user accessing protected page', () => {
            const nextUrl = { nextUrl: new URL('http://localhost:3000/dashboard') };
            const auth = { user: { name: 'Admin' } };
            const result = authorized({ auth, request: nextUrl });
            assert.equal(result, true);
        });

        it('returns false for logged-out user accessing protected page', () => {
            const nextUrl = { nextUrl: new URL('http://localhost:3000/dashboard') };
            const result = authorized({ auth: null, request: nextUrl });
            assert.equal(result, false);
        });
    });

    describe('redirect callback', () => {
        const redirect = authConfig.callbacks.redirect;

        it('returns safe destination string for valid path', async () => {
            const result = await redirect!({ url: '/dashboard', baseUrl: 'http://localhost:3000' });
            assert.equal(result, 'http://localhost:3000/dashboard');
        });

        it('returns fallback base URL string for malicious path', async () => {
            const result = await redirect!({ url: 'https://evil.com', baseUrl: 'http://localhost:3000' });
            assert.equal(result, 'http://localhost:3000/');
        });
    });
});
