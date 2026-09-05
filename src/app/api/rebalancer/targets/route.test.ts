import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

// Register module hook to resolve `next/server` and `@/lib/prisma`
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class NextResponse extends Response {
          static json(body, init) {
            const response = Response.json(body, init);
            return response;
          }
        }
      \`)
    };
  }
  if (specifier === "@/lib/prisma" || specifier === "./prisma" || specifier === "@prisma/client") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const prisma = globalThis.prisma; export class PrismaClient {}")
    };
  }
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.replace("@/", "./src/");
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

const prismaMock = {
    targetAllocation: {
        findMany: async (_args?: any) => [],
        deleteMany: (args?: any) => ({ op: 'deleteMany', args }),
        upsert: (args?: any) => ({ op: 'upsert', args })
    },
    $transaction: async (ops: any[]) => ops
};

(globalThis as any).prisma = prismaMock;

// Dynamically import route handlers inside async function or top-level import
let GET: any;
let POST: any;

test.before(async () => {
    const routeModule = await import('./route.ts');
    GET = routeModule.GET;
    POST = routeModule.POST;
});

test('Rebalancer Targets API Route - Static Code Verification', async (t) => {
    const filePath = path.join(process.cwd(), 'src/app/api/rebalancer/targets/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    await t.test('POST handler uses prisma.$transaction for batch execution', () => {
        assert.ok(content.includes('prisma.$transaction('), 'Should call prisma.$transaction');
        assert.ok(!content.includes('Promise.all(targets.map'), 'Should not use unbatched Promise.all for target upserts');
    });

    await t.test('POST handler includes deleteMany in $transaction array', () => {
        assert.ok(content.includes('deleteMany'), 'Should include deleteMany operation');
        const txIndex = content.indexOf('prisma.$transaction([');
        const deleteIndex = content.indexOf('prisma.targetAllocation.deleteMany');
        assert.ok(txIndex !== -1, 'prisma.$transaction array must be present');
        assert.ok(deleteIndex > txIndex, 'deleteMany should be executed inside $transaction batch');
    });

    await t.test('POST handler validates targets array input', () => {
        assert.ok(content.includes("Array.isArray(targets)"), 'Should validate that targets is an array');
        assert.ok(content.includes("targets must be an array"), 'Should return correct error message for invalid input');
    });
});

test('Rebalancer Targets API Route - GET Handler', async (t) => {
    await t.test('returns target allocations sorted by symbol', async () => {
        const mockTargets = [
            { id: '1', symbol: 'AAPL', targetPercentage: 60, yearlyDriftAdjustment: null },
            { id: '2', symbol: 'MSFT', targetPercentage: 40, yearlyDriftAdjustment: 2.5 }
        ];

        let findManyArgs: any = null;
        prismaMock.targetAllocation.findMany = async (args: any) => {
            findManyArgs = args;
            return mockTargets;
        };

        const response = await GET();
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.deepStrictEqual(data, { targets: mockTargets });
        assert.deepStrictEqual(findManyArgs, { orderBy: { symbol: 'asc' } });
    });

    await t.test('returns 500 status code when database findMany fails', async () => {
        prismaMock.targetAllocation.findMany = async () => {
            throw new Error('Database connection failed');
        };

        const response = await GET();
        assert.strictEqual(response.status, 500);

        const data = await response.json();
        assert.strictEqual(data.error, 'Database connection failed');
    });
});

test('Rebalancer Targets API Route - POST Handler', async (t) => {
    await t.test('returns 400 when body does not contain targets array', async () => {
        const invalidBodies = [
            {},
            { targets: 'not-an-array' },
            { targets: 123 },
            { targets: null }
        ];

        for (const body of invalidBodies) {
            const req = new Request('http://localhost/api/rebalancer/targets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const response = await POST(req);
            assert.strictEqual(response.status, 400);

            const data = await response.json();
            assert.strictEqual(data.error, 'targets must be an array');
        }
    });

    await t.test('successfully replaces targets and returns updated targets', async () => {
        let transactionOps: any[] = [];
        prismaMock.$transaction = async (ops: any[]) => {
            transactionOps = ops;
            // First item in $transaction is deleteMany result, remaining items are upserted targets
            return [{ count: 1 }, { id: '1', symbol: 'AAPL', targetPercentage: 70 }, { id: '2', symbol: 'NVDA', targetPercentage: 30 }];
        };

        const targetsPayload = [
            { symbol: 'AAPL', targetPercentage: 70, yearlyDriftAdjustment: '5' },
            { symbol: 'NVDA', targetPercentage: 30 }
        ];

        const req = new Request('http://localhost/api/rebalancer/targets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targets: targetsPayload })
        });

        const response = await POST(req);
        assert.strictEqual(response.status, 200);

        const data = await response.json();
        assert.strictEqual(data.success, true);
        assert.deepStrictEqual(data.targets, [
            { id: '1', symbol: 'AAPL', targetPercentage: 70 },
            { id: '2', symbol: 'NVDA', targetPercentage: 30 }
        ]);

        // Verify operations passed to $transaction
        assert.strictEqual(transactionOps.length, 3);
        const [deleteOp, upsert1, upsert2] = transactionOps;

        // Verify deleteMany targets symbols not in input
        assert.deepStrictEqual(deleteOp.args, {
            where: {
                symbol: {
                    notIn: ['AAPL', 'NVDA']
                }
            }
        });

        // Verify upsert for AAPL with yearlyDriftAdjustment
        assert.strictEqual(upsert1.args.where.symbol, 'AAPL');
        assert.strictEqual(upsert1.args.create.symbol, 'AAPL');
        assert.strictEqual(upsert1.args.create.targetPercentage, 70);
        assert.strictEqual(upsert1.args.create.yearlyDriftAdjustment, 5);
        assert.ok(upsert1.args.create.lastAdjustmentDate instanceof Date);
        assert.strictEqual(upsert1.args.update.targetPercentage, 70);
        assert.strictEqual(upsert1.args.update.yearlyDriftAdjustment, 5);

        // Verify upsert for NVDA without yearlyDriftAdjustment
        assert.strictEqual(upsert2.args.where.symbol, 'NVDA');
        assert.strictEqual(upsert2.args.create.symbol, 'NVDA');
        assert.strictEqual(upsert2.args.create.targetPercentage, 30);
        assert.strictEqual(upsert2.args.create.yearlyDriftAdjustment, null);
        assert.strictEqual(upsert2.args.update.targetPercentage, 30);
        assert.strictEqual(upsert2.args.update.yearlyDriftAdjustment, undefined);
    });

    await t.test('correctly handles explicit falsy yearlyDriftAdjustment', async () => {
        let transactionOps: any[] = [];
        prismaMock.$transaction = async (ops: any[]) => {
            transactionOps = ops;
            return [{ count: 0 }, { id: '1', symbol: 'TSLA', targetPercentage: 100 }];
        };

        const targetsPayload = [
            { symbol: 'TSLA', targetPercentage: 100, yearlyDriftAdjustment: '' }
        ];

        const req = new Request('http://localhost/api/rebalancer/targets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targets: targetsPayload })
        });

        const response = await POST(req);
        assert.strictEqual(response.status, 200);

        const [_, upsertOp] = transactionOps;
        assert.strictEqual(upsertOp.args.create.yearlyDriftAdjustment, null);
        assert.strictEqual(upsertOp.args.update.yearlyDriftAdjustment, null);
    });

    await t.test('returns 500 when transaction fails', async () => {
        prismaMock.$transaction = async () => {
            throw new Error('Transaction execution failed');
        };

        const req = new Request('http://localhost/api/rebalancer/targets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targets: [] })
        });

        const response = await POST(req);
        assert.strictEqual(response.status, 500);

        const data = await response.json();
        assert.strictEqual(data.error, 'Transaction execution failed');
    });
});
