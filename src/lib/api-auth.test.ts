import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = () => globalThis.mockAuth ? globalThis.mockAuth() : Promise.resolve(null);")
    };
  }
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class NextResponse extends Response { static json(data, init) { return new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } }); } }")
    };
  }
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.replace("@/", "./src/");
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const globalThis: any;

const { safeCompare, isValidApiKey, isValidCronSecret, requireAuth } = await import('./api-auth.ts');

test('api-auth security helper tests', async (t) => {
    const originalEnv = { ...process.env };

    t.beforeEach(() => {
        globalThis.mockAuth = () => Promise.resolve(null);
    });

    t.afterEach(() => {
        process.env = { ...originalEnv };
        delete globalThis.mockAuth;
    });

    await t.test('safeCompare: correctly compares strings in constant time', () => {
        assert.strictEqual(safeCompare('secret123', 'secret123'), true);
        assert.strictEqual(safeCompare('secret123', 'secret124'), false);
        assert.strictEqual(safeCompare('short', 'longer_string'), false);
        assert.strictEqual(safeCompare(null, 'test'), false);
        assert.strictEqual(safeCompare('test', undefined), false);
        assert.strictEqual(safeCompare(null, null), false);
    });

    await t.test('isValidApiKey: validates MCP_API_KEY safely', () => {
        process.env.MCP_API_KEY = 'super-secret-mcp-key';

        assert.strictEqual(isValidApiKey('super-secret-mcp-key'), true);
        assert.strictEqual(isValidApiKey('wrong-key'), false);
        assert.strictEqual(isValidApiKey(''), false);
        assert.strictEqual(isValidApiKey(null), false);
        assert.strictEqual(isValidApiKey(undefined), false);

        delete process.env.MCP_API_KEY;
        assert.strictEqual(isValidApiKey('super-secret-mcp-key'), false);
    });

    await t.test('isValidCronSecret: validates CRON_SECRET safely', () => {
        process.env.CRON_SECRET = 'cron-daemon-secret';

        assert.strictEqual(isValidCronSecret('cron-daemon-secret'), true);
        assert.strictEqual(isValidCronSecret('wrong-secret'), false);
        assert.strictEqual(isValidCronSecret(null), false);

        delete process.env.CRON_SECRET;
        assert.strictEqual(isValidCronSecret('cron-daemon-secret'), false);
    });

    await t.test('requireAuth: allows valid API key when allowApiKey is true', async () => {
        process.env.MCP_API_KEY = 'mcp-key-123';
        const req = new Request('http://localhost/api/test', {
            headers: { 'x-api-key': 'mcp-key-123' }
        });

        const result = await requireAuth(req, { allowApiKey: true });
        assert.strictEqual(result.authorized, true);
        if (result.authorized) {
            assert.strictEqual(result.auth.role, 'ADMIN');
            assert.strictEqual(result.auth.isApiKey, true);
        }
    });

    await t.test('requireAuth: rejects valid API key when allowApiKey is false and no session', async () => {
        process.env.MCP_API_KEY = 'mcp-key-123';
        const req = new Request('http://localhost/api/test', {
            headers: { 'x-api-key': 'mcp-key-123' }
        });

        const result = await requireAuth(req, { allowApiKey: false });
        assert.strictEqual(result.authorized, false);
        if (!result.authorized) {
            assert.strictEqual(result.response.status, 401);
        }
    });

    await t.test('requireAuth: rejects request with 401 when no session and no API key', async () => {
        const req = new Request('http://localhost/api/test');

        const result = await requireAuth(req);
        assert.strictEqual(result.authorized, false);
        if (!result.authorized) {
            assert.strictEqual(result.response.status, 401);
        }
    });

    await t.test('requireAuth: enforces RBAC when role is insufficient', async () => {
        globalThis.mockAuth = () => Promise.resolve({
            user: { id: 'u1', name: 'Viewer User', role: 'VIEWER' }
        });

        const req = new Request('http://localhost/api/test');
        const result = await requireAuth(req, { allowedRoles: ['ADMIN', 'EDITOR'] });
        assert.strictEqual(result.authorized, false);
        if (!result.authorized) {
            assert.strictEqual(result.response.status, 403);
        }
    });

    await t.test('requireAuth: grants access when role is allowed', async () => {
        globalThis.mockAuth = () => Promise.resolve({
            user: { id: 'u1', name: 'Editor User', role: 'EDITOR' }
        });

        const req = new Request('http://localhost/api/test');
        const result = await requireAuth(req, { allowedRoles: ['ADMIN', 'EDITOR'] });
        assert.strictEqual(result.authorized, true);
        if (result.authorized) {
            assert.strictEqual(result.auth.role, 'EDITOR');
            assert.strictEqual(result.auth.isApiKey, false);
        }
    });

    await t.test('requireAuth: supports positional arguments (roles array and allowApiKey boolean)', async () => {
        process.env.MCP_API_KEY = 'mcp-key-123';
        const req = new Request('http://localhost/api/test', {
            headers: { 'x-api-key': 'mcp-key-123' }
        });

        const result = await requireAuth(req, ['ADMIN', 'EDITOR'], true);
        assert.strictEqual(result.authorized, true);
        if (result.authorized) {
            assert.strictEqual(result.auth.isApiKey, true);
        }
    });
});

