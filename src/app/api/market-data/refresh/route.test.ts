import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register module hook to resolve `@/auth`, `@/lib/market-data`, and `next/server` to global mocks
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class NextResponse extends Response {
          static json(body, init) {
            const status = init?.status ?? 200;
            return new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json', ...(init?.headers || {}) }
            });
          }
        }
      \`)
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockAuth(...args);")
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const MarketDataService = { refreshMarketData: (...args) => globalThis.__mockRefreshMarketData(...args) };")
    };
  }
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.replace("@/", "./src/");
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

// Setup global mock holders before importing route module
(globalThis as any).__mockAuth = async () => null;
(globalThis as any).__mockRefreshMarketData = async () => {};

// Import route POST function
const { POST } = await import('./route.ts');

test('POST /api/market-data/refresh', async (t) => {
    t.beforeEach(() => {
        (globalThis as any).__mockAuth = async () => ({ user: { name: 'Test User' } });
        (globalThis as any).__mockRefreshMarketData = async () => {};
    });

    await t.test('returns 401 Unauthorized when user is not authenticated', async () => {
        (globalThis as any).__mockAuth = async () => null;

        const request = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'AAPL' }),
            headers: { 'Content-Type': 'application/json' },
        });

        const response = await POST(request);
        assert.strictEqual(response.status, 401);

        const data = await response.json();
        assert.deepStrictEqual(data, { error: 'Unauthorized' });
    });

    await t.test('returns 400 Bad Request when symbol is missing from request body', async () => {
        const request = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({}),
            headers: { 'Content-Type': 'application/json' },
        });

        const response = await POST(request);
        assert.strictEqual(response.status, 400);

        const data = await response.json();
        assert.deepStrictEqual(data, { error: 'Symbol is required' });
    });

    await t.test('calls MarketDataService.refreshMarketData and returns 200 success when symbol is provided', async () => {
        let refreshedSymbol: string | null = null;
        (globalThis as any).__mockRefreshMarketData = async (symbol: string) => {
            refreshedSymbol = symbol;
        };

        const request = new Request('http://localhost/api/market-data/refresh', {
            method: 'POST',
            body: JSON.stringify({ symbol: 'AAPL' }),
            headers: { 'Content-Type': 'application/json' },
        });

        const response = await POST(request);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.deepStrictEqual(data, { success: true });
        assert.strictEqual(refreshedSymbol, 'AAPL');
    });

    await t.test('returns 500 Internal Server Error when MarketDataService throws an error', async () => {
        const consoleErrorOriginal = console.error;
        let loggedError: any = null;
        console.error = (...args: any[]) => {
            loggedError = args;
        };

        try {
            (globalThis as any).__mockRefreshMarketData = async () => {
                throw new Error('API Rate Limit Exceeded');
            };

            const request = new Request('http://localhost/api/market-data/refresh', {
                method: 'POST',
                body: JSON.stringify({ symbol: 'AAPL' }),
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            assert.strictEqual(response.status, 500);

            const data = await response.json();
            assert.deepStrictEqual(data, { error: 'Internal Server Error' });
            assert.ok(loggedError);
            assert.strictEqual(loggedError[0], 'Error in refresh endpoint:');
        } finally {
            console.error = consoleErrorOriginal;
        }
    });

    await t.test('returns 500 Internal Server Error when request body JSON is invalid', async () => {
        const consoleErrorOriginal = console.error;
        console.error = () => {};

        try {
            const request = new Request('http://localhost/api/market-data/refresh', {
                method: 'POST',
                body: 'invalid-json',
                headers: { 'Content-Type': 'application/json' },
            });

            const response = await POST(request);
            assert.strictEqual(response.status, 500);

            const data = await response.json();
            assert.deepStrictEqual(data, { error: 'Internal Server Error' });
        } finally {
            console.error = consoleErrorOriginal;
        }
    });
});
