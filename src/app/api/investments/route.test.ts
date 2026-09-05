import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

const nextServerCode = `
export class NextResponse extends Response {
  static json(body, init) {
    return new Response(JSON.stringify(body), {
      status: init?.status || 200,
      headers: { "content-type": "application/json", ...init?.headers }
    });
  }
}
`;

const loaderCode = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(nextServerCode)})
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
`;

register("data:text/javascript," + encodeURIComponent(loaderCode));

const prismaMock: { findManyArgs: any; findManyImpl: (args: any) => Promise<any> } = {
  findManyArgs: null,
  findManyImpl: async () => []
};

(globalThis as any).prisma = {
  investment: {
    findMany: async (args: any) => {
      prismaMock.findManyArgs = args;
      return prismaMock.findManyImpl(args);
    }
  }
};

const routeModule = await import('./route.ts');

test('GET /api/investments', async (t) => {
  t.beforeEach(() => {
    prismaMock.findManyArgs = null;
    prismaMock.findManyImpl = async () => [];
  });

  await t.test('exports dynamic configuration set to force-dynamic', () => {
    assert.strictEqual(routeModule.dynamic, 'force-dynamic');
  });

  await t.test('returns all investments with active activities when no symbol searchParam is provided', async () => {
    const mockInvestments = [
      { symbol: 'AAPL', name: 'Apple Inc.', type: 'STOCK' },
      { symbol: 'GOOGL', name: 'Alphabet Inc.', type: 'STOCK' },
      { symbol: 'MSFT', name: 'Microsoft Corporation', type: 'STOCK' }
    ];

    prismaMock.findManyImpl = async () => mockInvestments;

    const request = new Request('http://localhost/api/investments');
    const response = await routeModule.GET(request);

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body, mockInvestments);

    assert.deepStrictEqual(prismaMock.findManyArgs, {
      where: {
        activities: {
          some: {}
        }
      },
      select: {
        symbol: true,
        name: true,
        type: true
      },
      distinct: ['symbol'],
      orderBy: {
        symbol: 'asc'
      }
    });
  });

  await t.test('filters investments by symbol searchParam when provided', async () => {
    const mockInvestments = [
      { symbol: 'AAPL', name: 'Apple Inc.', type: 'STOCK' }
    ];

    prismaMock.findManyImpl = async () => mockInvestments;

    const request = new Request('http://localhost/api/investments?symbol=AAPL');
    const response = await routeModule.GET(request);

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body, mockInvestments);

    assert.deepStrictEqual(prismaMock.findManyArgs, {
      where: {
        symbol: 'AAPL',
        activities: {
          some: {}
        }
      },
      select: {
        symbol: true,
        name: true,
        type: true
      },
      distinct: ['symbol'],
      orderBy: {
        symbol: 'asc'
      }
    });
  });

  await t.test('returns an empty array when no investments match', async () => {
    prismaMock.findManyImpl = async () => [];

    const request = new Request('http://localhost/api/investments?symbol=NONEXISTENT');
    const response = await routeModule.GET(request);

    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body, []);
  });

  await t.test('returns status 500 when database throws an error', async () => {
    const originalConsoleError = console.error;
    let loggedError: any = null;
    console.error = (...args: any[]) => {
      loggedError = args;
    };

    try {
      prismaMock.findManyImpl = async () => {
        throw new Error('Database connection failed');
      };

      const request = new Request('http://localhost/api/investments');
      const response = await routeModule.GET(request);

      assert.strictEqual(response.status, 500);
      const body = await response.json();
      assert.deepStrictEqual(body, { error: 'Internal Server Error' });
      assert.ok(loggedError);
      assert.strictEqual(loggedError[0], 'Error fetching investments:');
    } finally {
      console.error = originalConsoleError;
    }
  });
});
