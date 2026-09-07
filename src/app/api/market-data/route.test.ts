import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register module hook to resolve `@/lib/market-data` and `next/server` to global mocks
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
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const MarketDataService = { getPrice: (...args) => globalThis.__mockGetPrice(...args) };")
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
(globalThis as any).__mockGetPrice = async () => null;

// Import route GET function
const { GET } = await import('./route.ts');

test('GET /api/market-data', async (t) => {
    t.beforeEach(() => {
        (globalThis as any).__mockGetPrice = async () => null;
    });

    await t.test('returns 400 Bad Request when symbol parameter is missing', async () => {
        const request = new Request('http://localhost/api/market-data');
        const response = await GET(request);

        assert.strictEqual(response.status, 400);
        const data = await response.json();
        assert.deepStrictEqual(data, { error: 'Symbol parameter is required' });
    });

    await t.test('returns 404 Not Found when symbol is not found by MarketDataService', async () => {
        let requestedSymbol = '';
        (globalThis as any).__mockGetPrice = async (symbol: string) => {
            requestedSymbol = symbol;
            return null;
        };

        const request = new Request('http://localhost/api/market-data?symbol=INVALID');
        const response = await GET(request);

        assert.strictEqual(response.status, 404);
        assert.strictEqual(requestedSymbol, 'INVALID');
        const data = await response.json();
        assert.deepStrictEqual(data, { error: 'Symbol not found' });
    });

    await t.test('returns 200 OK with market data when symbol is found', async () => {
        let requestedSymbol = '';
        const mockPriceData = {
            symbol: 'AAPL',
            price: 180.5,
            currency: 'USD',
            change: 1.2,
            changePercent: 0.67,
        };

        (globalThis as any).__mockGetPrice = async (symbol: string) => {
            requestedSymbol = symbol;
            return mockPriceData;
        };

        const request = new Request('http://localhost/api/market-data?symbol=AAPL');
        const response = await GET(request);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(requestedSymbol, 'AAPL');
        const data = await response.json();
        assert.deepStrictEqual(data, mockPriceData);
    });
});
