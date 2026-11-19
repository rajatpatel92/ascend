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
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    connectTimeoutMs?: number;
    family?: 0 | 4 | 6;
}

const UNREACHABLE_ERROR_CODES = new Set([
    'UND_ERR_CONNECT_TIMEOUT',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
]);

export const DEFAULT_HOST_CIRCUIT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

interface HostCircuitEntry {
    openUntilMs: number;
    reason: string;
}

function getHostCircuitMap(): Map<string, HostCircuitEntry> {
    const g = globalThis as unknown as { __ascendIssuerHostCircuit?: Map<string, HostCircuitEntry> };
    if (!(g.__ascendIssuerHostCircuit instanceof Map)) {
        g.__ascendIssuerHostCircuit = new Map();
    }
    return g.__ascendIssuerHostCircuit;
}

/**
 * Checks whether an error chain represents a TCP/DNS/network connectivity failure
 * (e.g. Akamai ASN packet drop causing UND_ERR_CONNECT_TIMEOUT) rather than an HTTP response.
 */
export function isNetworkUnreachableError(error: unknown, maxDepth = 4): boolean {
    const visited = new Set<unknown>();
    const inspect = (err: unknown, depth: number): boolean => {
        if (!err || typeof err !== 'object' || visited.has(err)) return false;
        visited.add(err);

        const rec = err as {
            code?: unknown;
            name?: unknown;
            message?: unknown;
            cause?: unknown;
            errors?: unknown[];
        };

        if (typeof rec.code === 'string' && UNREACHABLE_ERROR_CODES.has(rec.code)) {
            return true;
        }
        if (rec.name === 'TimeoutError') {
            return true;
        }
        if (
            typeof rec.message === 'string' &&
            /\b(connect timeout|connect timed out|request timed out|enetunreach|ehostunreach|econnrefused|etimedout)\b/i.test(
                rec.message
            )
        ) {
            return true;
        }

        if (depth < maxDepth) {
            if (Array.isArray(rec.errors) && rec.errors.some((sub) => inspect(sub, depth + 1))) {
                return true;
            }
            if (rec.cause && inspect(rec.cause, depth + 1)) {
                return true;
            }
        }

        return false;
    };

    return inspect(error, 0);
}

export function getHostCircuitStatus(
    hostname: string,
    nowMs = Date.now()
): { open: boolean; remainingMs: number; reason?: string } {
    const map = getHostCircuitMap();
    const key = hostname.trim().toLowerCase();
    const entry = map.get(key);
    if (!entry) return { open: false, remainingMs: 0 };
    if (nowMs >= entry.openUntilMs) {
        map.delete(key);
        return { open: false, remainingMs: 0 };
    }
    return {
        open: true,
        remainingMs: entry.openUntilMs - nowMs,
        reason: entry.reason,
    };
}

export function recordHostFailure(
    hostname: string,
    reason: string,
    cooldownMs = DEFAULT_HOST_CIRCUIT_COOLDOWN_MS,
    nowMs = Date.now()
): void {
    const key = hostname.trim().toLowerCase();
    if (!key) return;
    getHostCircuitMap().set(key, {
        openUntilMs: nowMs + Math.max(0, cooldownMs),
        reason,
    });
}

export function recordHostSuccess(hostname: string): void {
    const key = hostname.trim().toLowerCase();
    if (!key) return;
    getHostCircuitMap().delete(key);
}

export function resetHostCircuitBreakersForTests(): void {
    getHostCircuitMap().clear();
}

import type { IssuerLookupContext } from './types.ts';

/**
 * Fallback GET/POST helper built on `node:https` / `node:http` that bypasses `undici` and Next.js
 * `fetch` wrappers and defaults to IPv4 (`family: 4`) to avoid broken IPv6 Docker bridge routing.
 */
export async function fetchViaNodeHttp(
    initialUrl: string,
    options: NodeHttpsFetchOptions = {}
): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? 8_000;
    const connectTimeoutMs = Math.min(timeoutMs, options.connectTimeoutMs ?? 5_000);
    const family = options.family ?? 4;
    const accumulatedSetCookies: string[] = [];
    let currentUrl = initialUrl;
    let method: 'GET' | 'POST' = options.method ?? 'GET';
    let requestBody: string | undefined = method === 'POST' ? options.body : undefined;
    const requestHeaders: Record<string, string> = {
        ...options.headers,
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'close',
    };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const parsed = new URL(currentUrl);
        const transport = parsed.protocol === 'http:' ? http : https;
        const hopHeaders: Record<string, string> = { ...requestHeaders };
        if (requestBody !== undefined) {
            const hasContentLength = Object.keys(hopHeaders).some(
                (k) => k.toLowerCase() === 'content-length'
            );
            if (!hasContentLength) {
                hopHeaders['Content-Length'] = String(Buffer.byteLength(requestBody, 'utf8'));
            }
        }

        const hopResult = await new Promise<{
            statusCode: number;
            headers: http.IncomingHttpHeaders;
            body: Buffer;
        }>((resolve, reject) => {
            let settled = false;
            let deadlineTimer: NodeJS.Timeout | undefined;
            let connectTimer: NodeJS.Timeout | undefined;
            const cleanup = () => {
                if (deadlineTimer !== undefined) {
                    clearTimeout(deadlineTimer);
                    deadlineTimer = undefined;
                }
                if (connectTimer !== undefined) {
                    clearTimeout(connectTimer);
                    connectTimer = undefined;
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
                    method,
                    headers: hopHeaders,
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

            // # Reason: Fail fast during TCP SYN drop (e.g. Akamai OCI ASN blackhole) rather than
            // waiting for the full request timeout.
            req.on('socket', (socket) => {
                if (!socket.connecting) return;
                connectTimer = setTimeout(() => {
                    const err = Object.assign(
                        new Error(`node:https connect timed out after ${connectTimeoutMs}ms (${parsed.hostname})`),
                        {
                            code: 'ETIMEDOUT',
                            syscall: 'connect',
                            hostname: parsed.hostname,
                        }
                    );
                    req.destroy(err);
                }, connectTimeoutMs);
                const clearConnectTimer = () => {
                    if (connectTimer !== undefined) {
                        clearTimeout(connectTimer);
                        connectTimer = undefined;
                    }
                };
                socket.once('connect', clearConnectTimer);
                socket.once('error', clearConnectTimer);
                socket.once('close', clearConnectTimer);
            });

            deadlineTimer = setTimeout(() => {
                req.destroy(
                    Object.assign(new Error(`node:https request timed out after ${timeoutMs}ms`), {
                        code: 'ETIMEDOUT',
                    })
                );
            }, timeoutMs);
            req.on('timeout', () => {
                req.destroy(
                    Object.assign(new Error(`node:https request timed out after ${timeoutMs}ms`), {
                        code: 'ETIMEDOUT',
                    })
                );
            });
            req.on('error', finishError);
            if (requestBody !== undefined) {
                req.end(requestBody);
            } else {
                req.end();
            }
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
            if (hopResult.statusCode !== 307 && hopResult.statusCode !== 308) {
                method = 'GET';
                requestBody = undefined;
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

export interface IssuerRequestOptions {
    method?: 'GET' | 'POST';
    body?: string;
    headers?: Record<string, string>;
}

/**
 * Creates a per-lookup requester with per-host circuit breakers and automatic
 * IPv4 `node:https` fallback when Next/undici fetch fails due to transport/IPv6 issues.
 */
export function createIssuerRequester(
    adapterId: string,
    ctx: IssuerLookupContext,
    defaultTimeoutMs = 8_000
): ((url: string, opts?: IssuerRequestOptions) => Promise<Response>) | null {
    const fetchImpl = ctx.fetchFn ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') return null;

    const timeoutMs = ctx.timeoutMs ?? defaultTimeoutMs;
    const nodeFallbackImpl = ctx.nodeHttpFn ?? fetchViaNodeHttp;
    const isMockedGlobalFetch = Boolean((globalThis.fetch as unknown as { mock?: unknown })?.mock);
    const canUseNodeFallback = Boolean(ctx.nodeHttpFn) || (!ctx.fetchFn && !isMockedGlobalFetch);
    let preferNodeHttp = false;

    return async (url: string, opts: IssuerRequestOptions = {}): Promise<Response> => {
        const method = opts.method ?? 'GET';
        const body = opts.body;
        const headers = opts.headers ?? {};
        const host = new URL(url).hostname;
        const circuit = getHostCircuitStatus(host);
        if (circuit.open) {
            const remainingSec = Math.max(1, Math.ceil(circuit.remainingMs / 1000));
            throw new Error(
                `Host ${host} skipped (${remainingSec}s cooldown active after earlier failure: ${circuit.reason ?? 'unreachable'})`
            );
        }

        const connectTimeoutMs = Math.min(timeoutMs, 5_000);

        if (preferNodeHttp && canUseNodeFallback) {
            try {
                const res = await nodeFallbackImpl(url, {
                    method,
                    body,
                    headers,
                    timeoutMs,
                    connectTimeoutMs,
                    family: 4,
                });
                recordHostSuccess(host);
                return res;
            } catch (nodeErr) {
                const nodeDetails = formatErrorDetails(nodeErr);
                if (isNetworkUnreachableError(nodeErr)) {
                    recordHostFailure(host, nodeDetails);
                }
                throw nodeErr;
            }
        }

        try {
            const res = await fetchImpl(url, {
                method,
                body,
                cache: 'no-store',
                headers,
                signal: AbortSignal.timeout(timeoutMs),
            });
            recordHostSuccess(host);
            return res;
        } catch (fetchErr) {
            const fetchDetails = formatErrorDetails(fetchErr);
            if (!canUseNodeFallback) {
                if (isNetworkUnreachableError(fetchErr)) {
                    recordHostFailure(host, fetchDetails);
                }
                throw fetchErr;
            }
            const msg = `[IssuerAdapter:${adapterId}] fetch error for ${ctx.symbol} (${fetchDetails}); retrying via IPv4 node:https`;
            console.warn(msg);
            ctx.onDiagnostic?.(msg);
            try {
                const fallbackRes = await nodeFallbackImpl(url, {
                    method,
                    body,
                    headers,
                    timeoutMs,
                    connectTimeoutMs,
                    family: 4,
                });
                preferNodeHttp = true;
                recordHostSuccess(host);
                return fallbackRes;
            } catch (nodeErr) {
                const nodeDetails = formatErrorDetails(nodeErr);
                const combinedSummary = `fetch failed (${fetchDetails}); node:https fallback failed (${nodeDetails})`;
                if (isNetworkUnreachableError(fetchErr) || isNetworkUnreachableError(nodeErr)) {
                    recordHostFailure(host, combinedSummary);
                }
                throw new Error(combinedSummary, { cause: nodeErr });
            }
        }
    };
}

