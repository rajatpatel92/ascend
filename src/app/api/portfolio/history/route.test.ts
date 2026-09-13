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
    const relativePath = specifier.replace("@/", "./src/");
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
});
