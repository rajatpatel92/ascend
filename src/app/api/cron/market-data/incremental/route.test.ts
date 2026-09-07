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
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.replace("@/", "./src/");
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

(globalThis as any).__mockPrisma = {
    investment: { findMany: async () => [] },
    benchmark: { findMany: async () => [] }
};
(globalThis as any).__mockMarketDataService = {
    refreshPriceOnly: async () => 0
};

const { GET, dynamic } = await import('./route.ts');

test('GET /api/cron/market-data/incremental endpoint', async (t) => {
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalSecret = process.env.CRON_SECRET;

    t.afterEach(() => {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        process.env.CRON_SECRET = originalSecret;
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
