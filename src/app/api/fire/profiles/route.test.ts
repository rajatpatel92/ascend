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
      url: "data:text/javascript," + encodeURIComponent("export const prisma = globalThis.__fireProfilesPrismaMock;")
    };
  }
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = () => Promise.resolve({ user: { id: 'u1', role: globalThis.__fireProfilesRole || 'ADMIN' } });")
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

const prismaMock = {
    systemSetting: {
        findUnique: async () => (settingValue ? { key: 'fire_profiles_v1', value: settingValue } : null),
        upsert: async (args: { create?: { value: string }; update?: { value: string } }) => {
            settingValue = args.update?.value ?? args.create?.value ?? null;
            return { key: 'fire_profiles_v1', value: settingValue };
        }
    }
};

(globalThis as Record<string, unknown>).__fireProfilesPrismaMock = prismaMock;
(globalThis as Record<string, unknown>).__fireProfilesRole = 'ADMIN';

const { GET, POST, DELETE } = await import('./route.ts');

test('/api/fire/profiles GET seeds default FIRE profile using requested currency when unset', async () => {
    settingValue = null;
    (globalThis as Record<string, unknown>).__fireProfilesRole = 'VIEWER';

    const res = await GET(new Request('http://localhost/api/fire/profiles?currency=USD'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.activeProfileId, 'default');
    assert.equal(body.profiles.length, 1);
    assert.equal(body.profiles[0].name, 'Default FIRE Plan');
    assert.equal(body.profiles[0].currency, 'USD');
    assert.equal(body.profiles[0].params.withdrawalRate, 4);
});

test('/api/fire/profiles POST rejects VIEWER writes with 403 and persists profiles for ADMIN/EDITOR', async () => {
    settingValue = null;
    (globalThis as Record<string, unknown>).__fireProfilesRole = 'VIEWER';

    const viewerRes = await POST(
        new Request('http://localhost/api/fire/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profile: { id: 'lean', name: 'Lean FIRE', currency: 'CAD' }
            })
        })
    );
    assert.equal(viewerRes.status, 403);

    (globalThis as Record<string, unknown>).__fireProfilesRole = 'ADMIN';
    const adminRes = await POST(
        new Request('http://localhost/api/fire/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                profile: {
                    id: 'coast-fire',
                    name: 'Coast FIRE 2038',
                    currency: 'USD',
                    params: {
                        fireDate: '2038-05',
                        monthlyContribution: 3500,
                        expectedReturn: 7.5,
                        inflationRate: 2.5,
                        currentMonthlyExpense: 4500,
                        calculationMode: 'FIXED_HORIZON',
                        withdrawalRate: 4.0,
                        withdrawalDuration: 35
                    }
                }
            })
        })
    );
    assert.equal(adminRes.status, 200);
    const body = await adminRes.json();
    assert.equal(body.activeProfileId, 'coast-fire');
    assert.equal(body.profiles.length, 2);
    assert.equal(body.profiles[1].params.calculationMode, 'FIXED_HORIZON');
    assert.equal(body.profiles[1].params.withdrawalDuration, 35);
    assert.ok(settingValue?.includes('Coast FIRE 2038'));
});

test('/api/fire/profiles POST activateOnly switches active profile and rejects unknown id', async () => {
    (globalThis as Record<string, unknown>).__fireProfilesRole = 'EDITOR';

    const missingRes = await POST(
        new Request('http://localhost/api/fire/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeProfileId: 'non-existent', activateOnly: true })
        })
    );
    assert.equal(missingRes.status, 404);

    const switchRes = await POST(
        new Request('http://localhost/api/fire/profiles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeProfileId: 'default', activateOnly: true })
        })
    );
    assert.equal(switchRes.status, 200);
    const switchBody = await switchRes.json();
    assert.equal(switchBody.activeProfileId, 'default');
});

test('/api/fire/profiles DELETE removes secondary profiles and refuses deleting the last profile', async () => {
    (globalThis as Record<string, unknown>).__fireProfilesRole = 'ADMIN';

    const delOk = await DELETE(
        new Request('http://localhost/api/fire/profiles?id=coast-fire', { method: 'DELETE' })
    );
    assert.equal(delOk.status, 200);
    const okBody = await delOk.json();
    assert.equal(okBody.profiles.length, 1);
    assert.equal(okBody.activeProfileId, 'default');

    const delLast = await DELETE(
        new Request('http://localhost/api/fire/profiles?id=default', { method: 'DELETE' })
    );
    assert.equal(delLast.status, 400);
});
