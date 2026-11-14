import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
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
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockEvolutionAuth(...args);")
    };
  }
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const prisma = { activity: { findMany: (...args) => globalThis.__mockEvolutionPrisma.activity.findMany(...args) } };")
    };
  }
  if (specifier === "@/lib/portfolio-analytics") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const PortfolioAnalytics = { calculateFlows: (...args) => globalThis.__mockEvolutionAnalytics.calculateFlows(...args), calculateComparisonHistory: (...args) => globalThis.__mockEvolutionAnalytics.calculateComparisonHistory(...args) };")
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

interface EvolutionMockGlobals {
    __mockEvolutionAuth: () => Promise<unknown>;
    __mockEvolutionPrisma: {
        activity: {
            findMany: (args: unknown) => Promise<unknown[]>;
        };
    };
    __mockEvolutionAnalytics: {
        calculateFlows: (activities: unknown[], currency: string) => Promise<unknown>;
        calculateComparisonHistory: (activities: unknown[], bench: string, startDate: Date, currency: string) => Promise<unknown>;
    };
}

const g = globalThis as unknown as EvolutionMockGlobals;
const { POST } = await import('./route.ts');

test('POST /api/analytics/evolution account filtering alignment', async (t) => {
    const sampleActivities = [
        {
            id: 'act-assigned',
            type: 'BUY',
            quantity: 10,
            price: 100,
            fee: 0,
            date: new Date('2025-01-02T00:00:00.000Z'),
            accountId: 'acc-1',
            account: { id: 'acc-1', name: 'Main TFSA', type: 'TFSA' },
            investment: { symbol: 'VFV.TO', type: 'ETF', currencyCode: 'CAD' }
        },
        {
            id: 'act-unassigned',
            type: 'BUY',
            quantity: 5,
            price: 50,
            fee: 0,
            date: new Date('2025-01-03T00:00:00.000Z'),
            accountId: null,
            account: null,
            investment: { symbol: 'AAPL', type: 'EQUITY', currencyCode: 'USD' }
        }
    ];

    let capturedActivities: Array<{ id: string }> = [];

    t.beforeEach(() => {
        capturedActivities = [];
        g.__mockEvolutionAuth = async () => ({ user: { id: 'user-1', role: 'ADMIN' } });
        g.__mockEvolutionPrisma = {
            activity: {
                findMany: async () => sampleActivities
            }
        };
        g.__mockEvolutionAnalytics = {
            calculateFlows: async () => ({
                contributions: { day: [], week: [], month: [], year: [] },
                dividends: { month: [], year: [] }
            }),
            calculateComparisonHistory: async (activities) => {
                capturedActivities = activities as Array<{ id: string }>;
                return {
                    portfolio: [{ date: '2025-01-03', marketValue: 1250, nav: 100, netFlow: 1250, units: 12.5, dividend: 0 }],
                    benchmark: [],
                    summary: { portfolioReturn: 0, benchmarkReturn: 0 },
                    performers: { top: [], bottom: [] },
                    debug: []
                };
            }
        };
    });

    await t.test('retains unassigned-account activities when no account filter is applied', async () => {
        const req = new Request('http://localhost/api/analytics/evolution', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filters: { accountTypes: [], assetClasses: [] }, currency: 'CAD', mode: 'evolution' })
        });

        const res = await POST(req);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(
            capturedActivities.map(a => a.id),
            ['act-assigned', 'act-unassigned']
        );
    });

    await t.test('excludes unassigned-account activities when an accountTypes filter is applied', async () => {
        const req = new Request('http://localhost/api/analytics/evolution', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filters: { accountTypes: ['TFSA'], assetClasses: [] }, currency: 'CAD', mode: 'evolution' })
        });

        const res = await POST(req);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(
            capturedActivities.map(a => a.id),
            ['act-assigned']
        );
    });
});
