import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

// Register module hook to resolve `@/auth`, `@/lib/prisma`, `@/lib/portfolio-analytics`, and `next/server` to global mocks
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
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const prisma = { activity: { findMany: (...args) => globalThis.__mockPrismaActivityFindMany(...args) } };")
    };
  }
  if (specifier === "@/lib/portfolio-analytics") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const PortfolioAnalytics = { calculateComparisonHistory: (...args) => globalThis.__mockCalculateComparisonHistory(...args), calculateIntradayHistory: (...args) => globalThis.__mockCalculateIntradayHistory(...args) };")
    };
  }
  if (specifier.startsWith("@/")) {
    let relativePath = specifier.replace("@/", "./src/");
    if (!relativePath.endsWith('.ts') && !relativePath.endsWith('.js') && !relativePath.endsWith('.json')) {
      relativePath += '.ts';
    }
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

// Setup global mock holders before importing route module
(globalThis as any).__mockAuth = async () => null;
(globalThis as any).__mockPrismaActivityFindMany = async () => [];
(globalThis as any).__mockCalculateComparisonHistory = async () => ({ portfolio: [] });
(globalThis as any).__mockCalculateIntradayHistory = async () => [];

// Import route GET function
const { GET, dynamic } = await import('./route.ts');

test('GET /api/portfolio/history', async (t) => {
  await t.test('exports dynamic configuration set to force-dynamic', () => {
    assert.strictEqual(dynamic, 'force-dynamic');
  });

  await t.test('returns 401 Unauthorized when user is not authenticated', async () => {
    (globalThis as any).__mockAuth = async () => null;

    const request = new Request('http://localhost/api/portfolio/history');
    const response = await GET(request);

    assert.strictEqual(response.status, 401);
    const body = await response.json();
    assert.deepStrictEqual(body, { error: 'Unauthorized' });
  });

  await t.test('returns 200 OK when user is authenticated', async () => {
    (globalThis as any).__mockAuth = async () => ({ user: { id: 'user-1' } });
    (globalThis as any).__mockPrismaActivityFindMany = async () => [];

    const request = new Request('http://localhost/api/portfolio/history');
    const response = await GET(request);

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body, []);
  });

  await t.test('Security Check: route file contains auth check before request processing', () => {
    const filePath = path.resolve('src/app/api/portfolio/history/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    assert.ok(
      content.includes("import { auth } from '@/auth'") || content.includes('import { auth } from "@auth"'),
      'Should import auth from @/auth'
    );

    const getMatch = content.match(/export async function GET[\s\S]*?\{([\s\S]*?)\n[ ]*try/);
    assert.ok(getMatch, 'GET function body before try block not found');
    assert.ok(getMatch[1].includes('await auth()'), 'GET should call auth()');
    assert.ok(getMatch[1].includes('401'), 'GET should return 401 if unauthorized');
  });

  await t.test('1D fast-path avoids calculateComparisonHistory and handles openValue = 0 safely', async () => {
    (globalThis as any).__mockAuth = async () => ({ user: { id: 'user-1' } });
    (globalThis as any).__mockPrismaActivityFindMany = async () => ([
      {
        id: 'act-1',
        type: 'BUY',
        quantity: 10,
        price: 100,
        date: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        investment: { symbol: 'AAPL', type: 'EQUITY', currencyCode: 'USD' },
        account: { type: 'TFSA' }
      }
    ]);

    let compCalled = 0;
    (globalThis as any).__mockCalculateComparisonHistory = async () => {
      compCalled++;
      return { portfolio: [] };
    };
    (globalThis as any).__mockCalculateIntradayHistory = async () => ([
      { date: '2026-01-02T14:30:00.000Z', marketValue: 0 },
      { date: '2026-01-02T15:00:00.000Z', marketValue: 1050 }
    ]);
    (globalThis as any)._portfolio1DCache = null;

    const response = await GET(new Request('http://localhost/api/portfolio/history?range=1D&currency=USD'));
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(compCalled, 0);
    assert.strictEqual(body.length, 2);
    assert.strictEqual(body[0].nav, 100);
    assert.strictEqual(body[1].nav, 100);
  });

  await t.test('sub-range attaches prior* pre-window baseline from day before window start', async () => {
    (globalThis as any).__mockAuth = async () => ({ user: { id: 'user-1' } });
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2);
    const todayIso = today.toISOString().split('T')[0];
    const yesterdayIso = yesterday.toISOString().split('T')[0];
    const twoDaysAgoIso = twoDaysAgo.toISOString().split('T')[0];

    (globalThis as any).__mockPrismaActivityFindMany = async () => ([
      {
        id: 'act-1',
        type: 'BUY',
        quantity: 10,
        price: 100,
        date: twoDaysAgo,
        investment: { symbol: 'AAPL', type: 'EQUITY', currencyCode: 'USD' },
        account: { type: 'TFSA' }
      }
    ]);
    (globalThis as any).__mockCalculateComparisonHistory = async () => ({
      portfolio: [
        { date: twoDaysAgoIso, marketValue: 1000, nav: 100, netFlow: 1000, dividend: 0, unreinvestedDividends: 0 },
        { date: yesterdayIso, marketValue: 1500, nav: 105, netFlow: 450, dividend: 0, unreinvestedDividends: 0 },
        { date: todayIso, marketValue: 1600, nav: 112, netFlow: 0, dividend: 0, unreinvestedDividends: 0 }
      ]
    });

    const response = await GET(new Request(`http://localhost/api/portfolio/history?range=CUSTOM&startDate=${yesterdayIso}&endDate=${todayIso}&currency=USD`));
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.length, 2);
    assert.strictEqual(body[0].date, yesterdayIso);
    assert.strictEqual(body[0].priorValue, 1000);
    assert.strictEqual(body[0].priorInvested, 1000);
    assert.strictEqual(body[0].priorNav, 100);
    assert.strictEqual(body[0].priorUnreinvestedDividend, 0);
  });
});

