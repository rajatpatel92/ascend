import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/prisma" || specifier === "./prisma" || specifier === "@prisma/client") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const prisma = globalThis.prisma; export class PrismaClient {}")
    };
  }
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class NextResponse extends Response { static json(data, init) { return new Response(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } }); } }")
    };
  }
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.replace("@/", "./src/");
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

const prismaDelegate: {
    currentMock: any;
} = {
    currentMock: null
};

(globalThis as any).prisma = {
    activity: {
        findMany: async (...args: any[]) => prismaDelegate.currentMock?.activity?.findMany?.(...args) ?? []
    },
    activityType: {
        findMany: async (...args: any[]) => prismaDelegate.currentMock?.activityType?.findMany?.(...args) ?? []
    }
};

const { GET } = await import('./route.ts');

test('GET /api/holdings', async (t) => {
    t.beforeEach(() => {
        prismaDelegate.currentMock = null;
    });

    await t.test('returns 400 error when symbol parameter is missing', async () => {
        const req = new Request('http://localhost/api/holdings');
        const res = await GET(req);
        assert.strictEqual(res.status, 400);

        const data = await res.json();
        assert.deepStrictEqual(data, { error: 'Symbol is required' });
    });

    await t.test('calculates correct quantity with default activity behaviors (BUY, SELL, TRANSFER_IN, TRANSFER_OUT)', async () => {
        let requestedWhere: any = null;

        prismaDelegate.currentMock = {
            activity: {
                findMany: async (args: any) => {
                    requestedWhere = args.where;
                    return [
                        { type: 'BUY', quantity: 10 },
                        { type: 'SELL', quantity: 3 },
                        { type: 'TRANSFER_IN', quantity: 5 },
                        { type: 'TRANSFER_OUT', quantity: 2 },
                        { type: 'DIVIDEND', quantity: 100 } // Should be treated as NEUTRAL
                    ];
                }
            },
            activityType: {
                findMany: async () => [] // Returns empty, triggers default behavior map setup
            }
        };

        const req = new Request('http://localhost/api/holdings?symbol=AAPL');
        const res = await GET(req);

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(requestedWhere, { investment: { symbol: 'AAPL' } });

        const data = await res.json();
        // 10 (BUY) - 3 (SELL) + 5 (TRANSFER_IN) - 2 (TRANSFER_OUT) = 10
        assert.strictEqual(data.quantity, 10);
    });

    await t.test('uses activity types and custom behaviors from database', async () => {
        prismaDelegate.currentMock = {
            activity: {
                findMany: async () => [
                    { type: 'CUSTOM_BUY', quantity: 50 },
                    { type: 'CUSTOM_SELL', quantity: 15 }
                ]
            },
            activityType: {
                findMany: async () => [
                    { name: 'CUSTOM_BUY', behavior: 'ADD' },
                    { name: 'CUSTOM_SELL', behavior: 'REMOVE' }
                ]
            }
        };

        const req = new Request('http://localhost/api/holdings?symbol=MSFT');
        const res = await GET(req);

        assert.strictEqual(res.status, 200);
        const data = await res.json();
        assert.strictEqual(data.quantity, 35);
    });

    await t.test('returns 500 status when database query fails', async () => {
        const originalConsoleError = console.error;
        let loggedError: any = null;
        console.error = (...args: any[]) => {
            loggedError = args;
        };

        try {
            prismaDelegate.currentMock = {
                activity: {
                    findMany: async () => {
                        throw new Error('Database connection failed');
                    }
                }
            };

            const req = new Request('http://localhost/api/holdings?symbol=GOOGL');
            const res = await GET(req);

            assert.strictEqual(res.status, 500);
            const data = await res.json();
            assert.deepStrictEqual(data, { error: 'Internal Server Error' });
            assert.ok(loggedError);
        } finally {
            console.error = originalConsoleError;
        }
    });
});
