import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

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
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const prisma = {
          investment: { findMany: (...args) => globalThis.__mockPrisma.investment.findMany(...args) },
          benchmark: { findMany: (...args) => globalThis.__mockPrisma.benchmark.findMany(...args) }
        };
      \`)
    };
  }
  if (specifier === "@/lib/market-data") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export const MarketDataService = {
          refreshPriceOnly: (...args) => globalThis.__mockMarketDataService.refreshPriceOnly(...args)
        };
      \`)
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockIncrAuth(...args);")
    };
  }
  if (specifier.startsWith("@/")) {
    let relativePath = specifier.replace("@/", "./src/");
    if (!relativePath.endsWith('.ts') && !relativePath.endsWith('.js')) {
      relativePath += '.ts';
    }
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

type IncrMocks = {
    __mockIncrAuth: () => Promise<{ user: { id: string; role: string } } | null>;
    __mockPrisma: {
        investment: { findMany: () => Promise<Array<{ symbol: string }>> };
        benchmark: { findMany: () => Promise<Array<{ symbol: string }>> };
    };
    __mockMarketDataService: {
        refreshPriceOnly: (symbols: string | string[]) => Promise<number>;
    };
};

const mockIncrG = globalThis as unknown as IncrMocks;
mockIncrG.__mockIncrAuth = async () => null;
mockIncrG.__mockPrisma = {
    investment: { findMany: async () => [] },
    benchmark: { findMany: async () => [] }
};
mockIncrG.__mockMarketDataService = {
    refreshPriceOnly: async () => 0
};

const { GET, dynamic } = await import('./route.ts');
const { resetSyncStateForTests } = await import('@/lib/sync-state');

test('GET /api/cron/market-data/incremental endpoint', async (t) => {
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalSecret = process.env.CRON_SECRET;

    t.beforeEach(() => {
        resetSyncStateForTests();
        mockIncrG.__mockIncrAuth = async () => null;
    });

    t.afterEach(() => {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        process.env.CRON_SECRET = originalSecret;
        resetSyncStateForTests();
    });

    await t.test('exports dynamic configuration set to force-dynamic', () => {
        assert.strictEqual(dynamic, 'force-dynamic');
    });

    await t.test('returns 401 Unauthorized if secret is required and invalid', async () => {
        process.env.CRON_SECRET = 'secret-key-123';
        const request = new Request('http://localhost/api/cron/market-data/incremental?key=wrong');
        const response = await GET(request);

        assert.strictEqual(response.status, 401);
        const body = await response.json();
        assert.deepStrictEqual(body, { error: 'Unauthorized' });
    });

    await t.test('allows ADMIN session and rejects VIEWER/EDITOR sessions when secret is absent', async () => {
        delete process.env.CRON_SECRET;

        mockIncrG.__mockIncrAuth = async () => ({ user: { id: 'u1', role: 'VIEWER' } });
        const viewerRes = await GET(new Request('http://localhost/api/cron/market-data/incremental'));
        assert.strictEqual(viewerRes.status, 401);

        mockIncrG.__mockIncrAuth = async () => ({ user: { id: 'u2', role: 'EDITOR' } });
        const editorRes = await GET(new Request('http://localhost/api/cron/market-data/incremental'));
        assert.strictEqual(editorRes.status, 401);

        console.log = () => {};
        mockIncrG.__mockPrisma = {
            investment: { findMany: async () => [{ symbol: 'AAPL' }] },
            benchmark: { findMany: async () => [] }
        };
        mockIncrG.__mockMarketDataService = {
            refreshPriceOnly: async (symbols: string | string[]) => Array.isArray(symbols) ? symbols.length : 1
        };

        mockIncrG.__mockIncrAuth = async () => ({ user: { id: 'admin-1', role: 'ADMIN' } });
        const adminRes = await GET(new Request('http://localhost/api/cron/market-data/incremental'));
        assert.strictEqual(adminRes.status, 200);
        const body = await adminRes.json();
        assert.strictEqual(body.message, 'Incremental Refresh Done');
    });

    await t.test('executes bulk refresh and returns stats on success', async () => {
        process.env.CRON_SECRET = 'secret-key-123';

        (globalThis as any).__mockPrisma = {
            investment: {
                findMany: async () => [
                    { symbol: 'AAPL' },
                    { symbol: 'MSFT' }
                ]
            },
            benchmark: {
                findMany: async () => [
                    { symbol: 'SPY' }
                ]
            }
        };

        let batchPassed: string[] = [];
        (globalThis as any).__mockMarketDataService = {
            refreshPriceOnly: async (symbols: string | string[]) => {
                const arr = Array.isArray(symbols) ? symbols : [symbols];
                batchPassed.push(...arr);
                return arr.length;
            }
        };

        console.log = () => {};

        const request = new Request('http://localhost/api/cron/market-data/incremental?key=secret-key-123');
        const response = await GET(request);

        assert.strictEqual(response.status, 200);
        const body = await response.json();

        assert.strictEqual(body.message, 'Incremental Refresh Done');
        assert.ok(body.stats.total > 0);
        assert.strictEqual(body.stats.success, body.stats.total);
        assert.strictEqual(body.stats.failed, 0);

        assert.ok(batchPassed.includes('AAPL'));
        assert.ok(batchPassed.includes('MSFT'));
        assert.ok(batchPassed.includes('SPY'));
        assert.ok(batchPassed.includes('CAD=X'));
    });

    await t.test('returns 500 when database query fails', async () => {
        process.env.CRON_SECRET = 'secret-key-123';

        (globalThis as any).__mockPrisma = {
            investment: {
                findMany: async () => {
                    throw new Error('Database connection lost');
                }
            },
            benchmark: {
                findMany: async () => []
            }
        };

        console.error = () => {};

        const request = new Request('http://localhost/api/cron/market-data/incremental?key=secret-key-123');
        const response = await GET(request);

        assert.strictEqual(response.status, 500);
        const body = await response.json();
        assert.strictEqual(body.error, 'Database connection lost');
    });
});
