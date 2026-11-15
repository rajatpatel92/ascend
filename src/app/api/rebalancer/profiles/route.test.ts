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
      url: "data:text/javascript," + encodeURIComponent("export const prisma = globalThis.__profilesPrismaMock;")
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = () => Promise.resolve({ user: { id: 'u1', role: 'ADMIN' } });")
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

let settingValue: string | null = null;
let txOps: unknown[] = [];

const prismaMock = {
    systemSetting: {
        findUnique: async () => (settingValue ? { key: 'rebalancer_profiles_v1', value: settingValue } : null),
        upsert: async (args: { create?: { value: string }; update?: { value: string } }) => {
            settingValue = args.update?.value ?? args.create?.value ?? null;
            return { key: 'rebalancer_profiles_v1', value: settingValue };
        }
    },
    targetAllocation: {
        findMany: async () => [
            { symbol: 'VFV.TO', targetPercentage: 80, yearlyDriftAdjustment: -1, lastAdjustmentDate: null, createdAt: new Date('2026-01-01') }
        ],
        deleteMany: (args: unknown) => ({ op: 'deleteMany', args }),
        upsert: (args: unknown) => ({ op: 'upsert', args })
    },
    $transaction: async (ops: unknown[]) => {
        txOps = ops;
        return ops;
    }
};

(globalThis as Record<string, unknown>).__profilesPrismaMock = prismaMock;

const { GET, POST, DELETE } = await import('./route.ts');

test('/api/rebalancer/profiles GET seeds default profile from TargetAllocation when unset', async () => {
    settingValue = null;
    const res = await GET(new Request('http://localhost/api/rebalancer/profiles'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeProfileId, 'default');
    assert.equal(body.profiles.length, 1);
    assert.equal(body.profiles[0].tickerTargets[0].symbol, 'VFV.TO');
});

test('/api/rebalancer/profiles POST creates profile, persists SystemSetting, and syncs TargetAllocation', async () => {
    settingValue = null;
    txOps = [];
    const req = new Request('http://localhost/api/rebalancer/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            profile: {
                id: 'retirement',
                name: 'Retirement 60/40',
                dimension: 'CATEGORY',
                tickerTargets: [{ symbol: 'XBAL.TO', targetPercentage: 100, yearlyDriftAdjustment: null }],
                categoryTargets: [
                    { investmentType: 'ETF', targetPercentage: 60 },
                    { investmentType: 'Bond', targetPercentage: 40 }
                ],
                updatedAt: new Date().toISOString()
            }
        })
    });

    const res = await POST(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeProfileId, 'retirement');
    assert.equal(body.profiles.length, 2);
    assert.ok(settingValue?.includes('Retirement 60/40'));
    assert.equal(txOps.length, 2); // deleteMany + 1 upsert
});

test('/api/rebalancer/profiles DELETE rejects last profile and removes secondary profiles cleanly', async () => {
    // Delete 'retirement' leaving 'default'
    const delOk = await DELETE(new Request('http://localhost/api/rebalancer/profiles?id=retirement', { method: 'DELETE' }));
    assert.equal(delOk.status, 200);
    const okBody = await delOk.json();
    assert.equal(okBody.profiles.length, 1);
    assert.equal(okBody.activeProfileId, 'default');

    // Attempt to delete last remaining profile
    const delLast = await DELETE(new Request('http://localhost/api/rebalancer/profiles?id=default', { method: 'DELETE' }));
    assert.equal(delLast.status, 400);
});
