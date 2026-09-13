import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/prisma" || specifier === "./prisma" || specifier === "@prisma/client") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const prisma = globalThis.prisma; export class PrismaClient {}")
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = async () => globalThis.mockSession ?? null;")
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const MarketDataService = { refreshMarketData: async () => {}, getPrice: async () => null };")
    };
  }
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class NextResponse extends Response { static json(data, init) { return new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } }); } }")
    };
  }
  if (specifier.startsWith("@/")) {
    let relativePath = specifier.replace("@/", "./src/");
    if (!relativePath.endsWith(".ts") && !relativePath.endsWith(".js") && !relativePath.endsWith(".json")) {
      relativePath += ".ts";
    }
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

const prismaDelegate: {
    currentMock: any;
} = {
    currentMock: null
};

(globalThis as any).prisma = {
    activity: {
        findMany: async (...args: any[]) => prismaDelegate.currentMock?.activity?.findMany?.(...args) ?? []
    }
};

const { GET, POST } = await import('./route.ts');

test('API /api/activities authentication & timing-safe API key comparison', async (t) => {
    const originalEnv = process.env.MCP_API_KEY;

    t.beforeEach(() => {
        process.env.MCP_API_KEY = 'mcp-secret-key-123';
        (globalThis as any).mockSession = null;
        prismaDelegate.currentMock = null;
    });

    t.after(() => {
        process.env.MCP_API_KEY = originalEnv;
    });

    await t.test('GET returns 401 when x-api-key is missing and no session', async () => {
        const req = new Request('http://localhost/api/activities');
        const res = await GET(req);
        assert.strictEqual(res.status, 401);
        const data = await res.json();
        assert.deepStrictEqual(data, { error: 'Unauthorized' });
    });

    await t.test('GET returns 401 when x-api-key is incorrect', async () => {
        const req = new Request('http://localhost/api/activities', {
            headers: { 'x-api-key': 'wrong-key-456' }
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 401);
    });

    await t.test('GET returns 200 when x-api-key matches MCP_API_KEY', async () => {
        prismaDelegate.currentMock = {
            activity: {
                findMany: async () => [{ id: 'act-1', type: 'BUY' }]
            }
        };

        const req = new Request('http://localhost/api/activities', {
            headers: { 'x-api-key': 'mcp-secret-key-123' }
        });
        const res = await GET(req);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.deepStrictEqual(data, [{ id: 'act-1', type: 'BUY' }]);
    });

    await t.test('GET returns 200 when valid session is present without API key', async () => {
        (globalThis as any).mockSession = { user: { id: 'user-1' } };
        prismaDelegate.currentMock = {
            activity: {
                findMany: async () => [{ id: 'act-2', type: 'SELL' }]
            }
        };

        const req = new Request('http://localhost/api/activities');
        const res = await GET(req);
        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.deepStrictEqual(data, [{ id: 'act-2', type: 'SELL' }]);
    });

    await t.test('POST returns 401 when x-api-key is missing or invalid and no session', async () => {
        const req = new Request('http://localhost/api/activities', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'AAPL' }),
            headers: { 'x-api-key': 'invalid-key' }
        });
        const res = await POST(req);
        assert.strictEqual(res.status, 401);
    });
});
