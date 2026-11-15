import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class NextResponse extends Response {
          static json(body, init) {
            return Response.json(body, init);
          }
        }
      \`)
    };
  }
  if (specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const prisma = globalThis.__glidePrismaMock;")
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = () => globalThis.__glideAuthMock();")
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

let mockSession: { user: { id: string; role: string } } | null = null;
let mockTargets: Array<{
    id: string;
    symbol: string;
    targetPercentage: number;
    yearlyDriftAdjustment: number | null;
    lastAdjustmentDate: Date | null;
    createdAt: Date;
}> = [];
let txOps: unknown[] = [];

(globalThis as Record<string, unknown>).__glideAuthMock = async () => mockSession;
(globalThis as Record<string, unknown>).__glidePrismaMock = {
    targetAllocation: {
        findMany: async () => mockTargets,
        update: (args: unknown) => ({ op: 'update', args })
    },
    $transaction: async (ops: unknown[]) => {
        txOps = ops;
        return ops;
    }
};

const { POST } = await import('./route.ts');

test('POST /api/cron/glide-path-adjust returns 401 when unauthenticated', async () => {
    mockSession = null;
    const res = await POST(new Request('http://localhost/api/cron/glide-path-adjust', { method: 'POST' }));
    assert.equal(res.status, 401);
});

test('POST /api/cron/glide-path-adjust returns 403 for VIEWER role', async () => {
    mockSession = { user: { id: 'v1', role: 'VIEWER' } };
    const res = await POST(new Request('http://localhost/api/cron/glide-path-adjust', { method: 'POST' }));
    assert.equal(res.status, 403);
});

test('POST /api/cron/glide-path-adjust supports dryRun without mutating DB', async () => {
    mockSession = { user: { id: 'a1', role: 'ADMIN' } };
    txOps = [];
    const recentDate = new Date();
    mockTargets = [
        {
            id: 't1',
            symbol: 'VFV.TO',
            targetPercentage: 70,
            yearlyDriftAdjustment: -1,
            lastAdjustmentDate: recentDate,
            createdAt: recentDate
        },
        {
            id: 't2',
            symbol: 'ZAG.TO',
            targetPercentage: 30,
            yearlyDriftAdjustment: 1,
            lastAdjustmentDate: recentDate,
            createdAt: recentDate
        }
    ];

    const res = await POST(new Request('http://localhost/api/cron/glide-path-adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true, forceOneYearStep: true })
    }));

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dryRun, true);
    assert.equal(body.adjustedCount, 2);
    assert.equal(txOps.length, 0);
    assert.equal(body.updated[0].newTarget, 69);
    assert.equal(body.updated[1].newTarget, 31);
});

test('POST /api/cron/glide-path-adjust forceOneYearStep commits transaction for ADMIN/EDITOR', async () => {
    mockSession = { user: { id: 'e1', role: 'EDITOR' } };
    txOps = [];
    const recentDate = new Date();
    mockTargets = [
        {
            id: 't1',
            symbol: 'VFV.TO',
            targetPercentage: 70,
            yearlyDriftAdjustment: -1.5,
            lastAdjustmentDate: recentDate,
            createdAt: recentDate
        }
    ];

    const res = await POST(new Request('http://localhost/api/cron/glide-path-adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, forceOneYearStep: true })
    }));

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dryRun, false);
    assert.equal(body.adjustedCount, 1);
    assert.equal(txOps.length, 1);
    assert.equal(body.updated[0].newTarget, 68.5);
});
