import { auth } from '@/auth';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

export type UserRole = 'ADMIN' | 'EDITOR' | 'VIEWER';

export interface AuthContext {
    userId?: string;
    username?: string;
    role: UserRole;
    isApiKey: boolean;
}

export type AuthResult = 
    | { authorized: true; auth: AuthContext }
    | { authorized: false; response: NextResponse };

/**
 * Constant-time string comparison to prevent timing attacks (CWE-208).
 * Ensures both buffers are evaluated in constant time even on length mismatch.
 */
export function safeCompare(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    if (bufA.length !== bufB.length) {
        // Run dummy timingSafeEqual to avoid timing leak through branch timing
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies if an incoming API key matches the configured MCP_API_KEY using constant-time comparison.
 */
export function isValidApiKey(apiKey: string | null | undefined): boolean {
    const configuredKey = process.env.MCP_API_KEY;
    if (!configuredKey || !apiKey) return false;
    return safeCompare(apiKey.trim(), configuredKey.trim());
}

/**
 * Verifies if an incoming secret matches CRON_SECRET using constant-time comparison.
 */
export function isValidCronSecret(secret: string | null | undefined): boolean {
    const configuredSecret = process.env.CRON_SECRET;
    if (!configuredSecret || !secret) return false;
    return safeCompare(secret.trim(), configuredSecret.trim());
}

export type RequireAuthOptions = {
    allowedRoles?: UserRole[];
    allowApiKey?: boolean;
};

/**
 * Validates request authentication and RBAC permissions.
 * Supports NextAuth sessions and optional MCP API key for programmatic access.
 * Accepts either:
 * - requireAuth(req, ['ADMIN', 'EDITOR'], true)
 * - requireAuth(req, { allowedRoles: ['ADMIN', 'EDITOR'], allowApiKey: true })
 */
export async function requireAuth(
    request: Request,
    rolesOrOptions?: UserRole[] | RequireAuthOptions,
    allowApiKeyArg: boolean = false
): Promise<AuthResult> {
    let allowedRoles: UserRole[] = ['ADMIN', 'EDITOR', 'VIEWER'];
    let allowApiKey = false;

    if (Array.isArray(rolesOrOptions)) {
        allowedRoles = rolesOrOptions;
        allowApiKey = Boolean(allowApiKeyArg);
    } else if (rolesOrOptions && typeof rolesOrOptions === 'object') {
        if (rolesOrOptions.allowedRoles) allowedRoles = rolesOrOptions.allowedRoles;
        if (typeof rolesOrOptions.allowApiKey === 'boolean') allowApiKey = rolesOrOptions.allowApiKey;
    }

    const apiKey = request?.headers?.get ? request.headers.get('x-api-key') : null;

    // 1. Check MCP API Key if permitted
    if (allowApiKey && isValidApiKey(apiKey)) {
        return {
            authorized: true,
            auth: {
                role: 'ADMIN', // Programmatic API key has admin privileges
                isApiKey: true
            }
        };
    }

    // 2. Check NextAuth Session
    const session = await auth();
    if (!session?.user) {
        return {
            authorized: false,
            response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        };
    }

    // 3. Extract and normalize User Role (defaults non-admin/editor roles like USER to VIEWER)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawRole = (session.user as any)?.role;
    let userRole: UserRole = 'VIEWER';
    if (rawRole === 'ADMIN' || rawRole === 'EDITOR') {
        userRole = rawRole;
    }

    // 4. Enforce Role-Based Access Control
    if (!allowedRoles.includes(userRole)) {
        return {
            authorized: false,
            response: NextResponse.json(
                { error: `Forbidden: Insufficient permissions for role '${userRole}'` },
                { status: 403 }
            )
        };
    }

    return {
        authorized: true,
        auth: {
            userId: session.user.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            username: (session.user as any).username || session.user.name || undefined,
            role: userRole,
            isApiKey: false
        }
    };
}
