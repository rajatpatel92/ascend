import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register module hook to resolve `@/auth`, `@/lib/prisma`, `@/lib/market-data`, `@/lib/xirr`, and `next/server` to global mocks
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
        export class NextRequest extends Request {}
      \`)
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockAuth(...args);")
    };
  }
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const prisma = globalThis.__mockPrisma;")
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const MarketDataService = globalThis.__mockMarketDataService;")
    };
  }
  if (specifier === "@/lib/xirr") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const calculateXIRR = () => 0.1; export class Transaction {}")
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
(globalThis as any).__mockPrisma = {
    activity: {
        findMany: async () => []
    },
    activityType: {
        findMany: async () => []
    },
    user: {
        findMany: async () => []
    }
};
(globalThis as any).__mockMarketDataService = {
    getPrice: async () => null,
    getHistoricalPrices: async () => ({}),
    getExchangeRate: async () => 1
};

// Import route GET function
const { GET } = await import('./route.ts');

test('GET /api/portfolio', async (t) => {
    t.beforeEach(() => {
        (globalThis as any).__mockAuth = async () => ({ user: { name: 'Test User' } });
        (globalThis as any).__mockPrisma = {
            activity: {
                findMany: async () => []
            },
            activityType: {
                findMany: async () => []
            },
            user: {
                findMany: async () => []
            }
        };
    });

    await t.test('returns 401 Unauthorized when user is not authenticated', async () => {
        (globalThis as any).__mockAuth = async () => null;

        const request = new Request('http://localhost/api/portfolio');

        const response = await GET(request as any);
        assert.strictEqual(response.status, 401);

        const data = await response.json();
        assert.deepStrictEqual(data, { error: 'Unauthorized' });
    });

    await t.test('returns 200 OK and portfolio summary when authenticated', async () => {
        const request = new Request('http://localhost/api/portfolio');

        const response = await GET(request as any);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.ok('totalValue' in data);
        assert.ok('constituents' in data);
    });
});
