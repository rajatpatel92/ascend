import crypto from 'node:crypto';

/**
 * Performs a constant-time comparison of two strings to protect against timing attacks.
 * Hashes both inputs using SHA-256 before comparing with crypto.timingSafeEqual,
 * ensuring fixed-length buffer comparisons regardless of input string length differences.
 *
 * @param provided The user-provided secret (e.g. API key from request header)
 * @param expected The expected secret (e.g. environment variable)
 * @returns true if both values are non-empty and equal; false otherwise.
 */
export function timingSafeCompare(
    provided: string | null | undefined,
    expected: string | null | undefined
): boolean {
    if (!provided || !expected) {
        return false;
    }

    const hashProvided = crypto.createHash('sha256').update(provided).digest();
    const hashExpected = crypto.createHash('sha256').update(expected).digest();

    return crypto.timingSafeEqual(hashProvided, hashExpected);
}
