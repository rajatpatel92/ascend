/* eslint-disable @typescript-eslint/no-explicit-any */
import type { NextAuthConfig } from 'next-auth';

/**
 * Validates and constructs a safe redirect URL.
 * Prevents Unvalidated Redirect (CWE-601) vulnerabilities by ensuring:
 * 1. Target URL is parsed safely relative to base URL.
 * 2. Protocol-relative ('//') and backslash-based ('/\') targets are rejected.
 * 3. Target URL matches base URL origin (same-origin restriction).
 * 4. Target URL uses http or https protocol only.
 * 5. Falls back to a safe default same-origin path ('/').
 */
export function getSafeRedirectUrl(target: string | null | undefined, baseUrl: URL | string): URL {
    const base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
    const defaultRedirect = new URL('/', base);

    if (!target || typeof target !== 'string') {
        return defaultRedirect;
    }

    const trimmed = target.trim();

    // Prevent protocol-relative URLs (//evil.com) and backslash tricks (/\evil.com or \evil.com)
    if (trimmed.startsWith('//') || trimmed.startsWith('/\\') || trimmed.includes('\\')) {
        return defaultRedirect;
    }

    try {
        const targetUrl = new URL(trimmed, base);

        // Enforce same-origin policy
        if (targetUrl.origin !== base.origin) {
            return defaultRedirect;
        }

        // Enforce http or https protocol
        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
            return defaultRedirect;
        }

        return targetUrl;
    } catch {
        return defaultRedirect;
    }
}

export const authConfig = {
    pages: {
        signIn: '/login',
    },
    callbacks: {
        authorized({ auth, request: nextUrl }) {
            const isLoggedIn = !!auth?.user;
            const isOnLoginPage = nextUrl.nextUrl.pathname.startsWith('/login');
            const isApiAuthRoute = nextUrl.nextUrl.pathname.startsWith('/api/auth');

            if (isApiAuthRoute) return true;

            if (isOnLoginPage) {
                if (isLoggedIn) {
                    const callbackUrl = nextUrl.nextUrl.searchParams.get('callbackUrl');
                    const safeRedirectUrl = getSafeRedirectUrl(callbackUrl, nextUrl.nextUrl);
                    return Response.redirect(safeRedirectUrl);
                }
                return true;
            }

            if (!isLoggedIn) {
                return false; // Redirects to login
            }

            return true;
        },
        async redirect({ url, baseUrl }) {
            return getSafeRedirectUrl(url, baseUrl).toString();
        },
        async jwt({ token, user }) {
            if (user) {
                token.role = (user as any).role;
                token.id = user.id;
                token.aiEnabled = (user as any).aiEnabled;
            }
            return token;
        },
        async session({ session, token }) {
            if (session.user) {
                (session.user as any).role = token.role;
                session.user.id = token.id as string || token.sub as string;
                (session.user as any).aiEnabled = token.aiEnabled;
            }
            return session;
        },
    },
    providers: [], // Configured in auth.ts
} satisfies NextAuthConfig;
