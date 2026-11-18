import http from 'node:http';
import https from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Formats an Error including nested `.cause` and `AggregateError.errors` chains
 * so Node `fetch` / `undici` network failures surface their underlying OS/TLS codes.
 */
export function formatErrorDetails(error: unknown, maxDepth = 4): string {
    const visited = new Set<unknown>();

    const formatNode = (err: unknown, depth: number): string => {
        if (err === null || err === undefined) return 'unknown error';
        if (typeof err !== 'object') return String(err);
        if (visited.has(err)) return '[Circular]';
        visited.add(err);

        const rec = err as {
            name?: unknown;
            message?: unknown;
            code?: unknown;
            errno?: unknown;
            syscall?: unknown;
            address?: unknown;
            port?: unknown;
            hostname?: unknown;
            cause?: unknown;
            errors?: unknown[];
        };

        const message = typeof rec.message === 'string' && rec.message.trim()
            ? rec.message.trim()
            : (typeof rec.name === 'string' ? rec.name : 'Error');

        const metaParts: string[] = [];
        if (typeof rec.code === 'string' && rec.code) metaParts.push(`code=${rec.code}`);
        else if (typeof rec.code === 'number') metaParts.push(`code=${rec.code}`);
        if (typeof rec.syscall === 'string' && rec.syscall) metaParts.push(`syscall=${rec.syscall}`);
        if (typeof rec.hostname === 'string' && rec.hostname) metaParts.push(`host=${rec.hostname}`);
        if (typeof rec.address === 'string' && rec.address) {
            const addr = typeof rec.port === 'number' ? `${rec.address}:${rec.port}` : rec.address;
            metaParts.push(`addr=${addr}`);
        }

        let summary = metaParts.length > 0 ? `${message} [${metaParts.join(' ')}]` : message;

        if (depth < maxDepth) {
            if (Array.isArray(rec.errors) && rec.errors.length > 0) {
                const sub = rec.errors
                    .slice(0, 4)
                    .map((e) => formatNode(e, depth + 1))
                    .join('; ');
                summary += ` (errors: ${sub})`;
            }
            if (rec.cause !== undefined && rec.cause !== null && rec.cause !== err) {
                summary += ` (cause: ${formatNode(rec.cause, depth + 1)})`;
            }
        }

        return summary;
    };

    return formatNode(error, 0);
}

function decodeBodyBuffer(raw: Buffer, contentEncodingHeader: string | string[] | undefined): Buffer {
    const encoding = (Array.isArray(contentEncodingHeader)
        ? contentEncodingHeader[0]
        : contentEncodingHeader || ''
    ).trim().toLowerCase();

    if (!encoding || encoding === 'identity' || raw.length === 0) {
        return raw;
    }
    if (encoding === 'gzip' || encoding === 'x-gzip') {
        return gunzipSync(raw);
    }
    if (encoding === 'deflate') {
        return inflateSync(raw);
    }
    if (encoding === 'br') {
        return brotliDecompressSync(raw);
    }
    return raw;
}

function mergeSetCookiesIntoHeaderMap(
    requestHeaders: Record<string, string>,
    setCookieValues: string[]
): void {
    if (setCookieValues.length === 0) return;

    const jar = new Map<string, string>();
    const existing = requestHeaders.Cookie || requestHeaders.cookie || '';
    for (const part of existing.split(';')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            jar.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
        }
    }

    for (const raw of setCookieValues) {
        const pair = raw.split(';', 1)[0]?.trim();
        if (!pair) continue;
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
            jar.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim());
        }
    }

    if (jar.size > 0) {
        delete requestHeaders.cookie;
        requestHeaders.Cookie = Array.from(jar.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
}

export interface NodeHttpsFetchOptions {
    headers?: Record<string, string>;
    timeoutMs?: number;
    family?: 0 | 4 | 6;
}

/**
 * Fallback GET helper built on `node:https` / `node:http` that bypasses `undici` and Next.js
 * `fetch` wrappers and defaults to IPv4 (`family: 4`) to avoid broken IPv6 Docker bridge routing.
 */
export async function fetchViaNodeHttp(
    initialUrl: string,
    options: NodeHttpsFetchOptions = {}
): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? 25_000;
    const family = options.family ?? 4;
    const accumulatedSetCookies: string[] = [];
    let currentUrl = initialUrl;
    const requestHeaders: Record<string, string> = {
        ...options.headers,
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'close',
    };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const parsed = new URL(currentUrl);
        const transport = parsed.protocol === 'http:' ? http : https;

        const hopResult = await new Promise<{
            statusCode: number;
            headers: http.IncomingHttpHeaders;
            body: Buffer;
        }>((resolve, reject) => {
            let settled = false;
            let deadlineTimer: NodeJS.Timeout | undefined;
            const cleanup = () => {
                if (deadlineTimer !== undefined) {
                    clearTimeout(deadlineTimer);
                    deadlineTimer = undefined;
                }
            };
            const finishError = (err: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };

            const req = transport.request(
                parsed,
                {
                    method: 'GET',
                    headers: requestHeaders,
                    agent: false,
                    family: family === 0 ? undefined : family,
                    timeout: timeoutMs,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer | string) => {
                        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                    });
                    res.on('end', () => {
                        if (settled) return;
                        settled = true;
                        cleanup();
                        resolve({
                            statusCode: res.statusCode ?? 200,
                            headers: res.headers,
                            body: Buffer.concat(chunks),
                        });
                    });
                    res.on('error', finishError);
                }
            );

            deadlineTimer = setTimeout(() => {
                req.destroy(new Error(`node:https request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            req.on('timeout', () => {
                req.destroy(new Error(`node:https request timed out after ${timeoutMs}ms`));
            });
            req.on('error', finishError);
            req.end();
        });

        const rawSetCookie = hopResult.headers['set-cookie'];
        const hopCookies = Array.isArray(rawSetCookie)
            ? rawSetCookie
            : (typeof rawSetCookie === 'string' ? [rawSetCookie] : []);
        accumulatedSetCookies.push(...hopCookies);

        const location = typeof hopResult.headers.location === 'string'
            ? hopResult.headers.location.trim()
            : '';

        if (REDIRECT_STATUSES.has(hopResult.statusCode) && location) {
            if (hop >= MAX_REDIRECTS) {
                throw new Error(`Exceeded maximum redirects (${MAX_REDIRECTS}) for ${initialUrl}`);
            }
            const nextUrl = new URL(location, currentUrl);
            if (nextUrl.hostname === parsed.hostname) {
                mergeSetCookiesIntoHeaderMap(requestHeaders, hopCookies);
            } else {
                delete requestHeaders.Cookie;
                delete requestHeaders.cookie;
            }
            currentUrl = nextUrl.toString();
            continue;
        }

        const decodedBody = decodeBodyBuffer(hopResult.body, hopResult.headers['content-encoding']);
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(hopResult.headers)) {
            if (value === undefined) continue;
            const lower = key.toLowerCase();
            if (lower === 'set-cookie' || lower === 'content-encoding' || lower === 'content-length') {
                continue;
            }
            if (Array.isArray(value)) {
                for (const item of value) {
                    responseHeaders.append(key, item);
                }
            } else {
                responseHeaders.set(key, value);
            }
        }
        for (const cookie of accumulatedSetCookies) {
            responseHeaders.append('set-cookie', cookie);
        }

        // # Reason: HTTP 204/304 responses forbid bodies in the Fetch Response constructor.
        const bodyAllowed = hopResult.statusCode !== 204 && hopResult.statusCode !== 304;
        return new Response(bodyAllowed ? new Uint8Array(decodedBody) : null, {
            status: hopResult.statusCode,
            headers: responseHeaders,
        });
    }

    throw new Error(`Exceeded maximum redirects (${MAX_REDIRECTS}) for ${initialUrl}`);
}
