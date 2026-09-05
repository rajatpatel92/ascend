import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register module hook to resolve `@/auth`, `@prisma/client`, `bcryptjs`, and `next/server`
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = () => globalThis.mockAuth();")
    };
  }
  if (specifier === "@prisma/client") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class PrismaClient {
          get user() {
            return globalThis.mockPrismaUser;
          }
        }
      \`)
    };
  }
  if (specifier === "bcryptjs") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export default { hash: (p, s) => globalThis.mockBcryptHash(p, s) };")
    };
  }
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class NextResponse extends Response {
          static json(data, init) {
            return new Response(JSON.stringify(data), {
              status: init?.status || 200,
              headers: { "content-type": "application/json", ...init?.headers }
            });
          }
        }
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

// Declare delegates on globalThis
(globalThis as any).mockAuth = () => null;
(globalThis as any).mockBcryptHash = async (password: string) => `hashed_${password}`;
(globalThis as any).mockPrismaUser = {
  findMany: async () => [],
  findUnique: async () => null,
  create: async () => ({})
};

const { GET, POST } = await import('./route.ts');

test('POST /api/users', async (t) => {
  t.beforeEach(() => {
    (globalThis as any).mockAuth = () => null;
    (globalThis as any).mockBcryptHash = async (p: string) => `hashed_${p}`;
    (globalThis as any).mockPrismaUser = {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => ({})
    };
  });

  await t.test('returns 401 Unauthorized if user is not authenticated', async () => {
    (globalThis as any).mockAuth = () => null;

    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'newuser', password: 'password123', role: 'USER' })
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 401);
    const body = await res.text();
    assert.strictEqual(body, 'Unauthorized');
  });

  await t.test('returns 401 Unauthorized if authenticated user is not ADMIN', async () => {
    const roles = ['USER', 'EDITOR', 'VIEWER'];

    for (const role of roles) {
      (globalThis as any).mockAuth = () => ({
        user: { id: 'u1', username: 'nonadmin', role }
      });

      const req = new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'newuser', password: 'password123', role: 'USER' })
      });

      const res = await POST(req);
      assert.strictEqual(res.status, 401, `Role ${role} should be rejected with 401`);
      const body = await res.text();
      assert.strictEqual(body, 'Unauthorized');
    }
  });

  await t.test('returns 400 Bad Request if missing required fields', async () => {
    (globalThis as any).mockAuth = () => ({
      user: { id: 'admin1', username: 'admin', role: 'ADMIN' }
    });

    const testCases = [
      { password: 'pass', role: 'USER' }, // missing username
      { username: 'user1', role: 'USER' }, // missing password
      { username: 'user1', password: 'pass' } // missing role
    ];

    for (const payload of testCases) {
      const req = new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const res = await POST(req);
      assert.strictEqual(res.status, 400);
      const body = await res.text();
      assert.strictEqual(body, 'Missing required fields');
    }
  });

  await t.test('returns 400 Bad Request if username already exists', async () => {
    (globalThis as any).mockAuth = () => ({
      user: { id: 'admin1', username: 'admin', role: 'ADMIN' }
    });

    let findUniqueCalledWith: any = null;
    (globalThis as any).mockPrismaUser.findUnique = async (args: any) => {
      findUniqueCalledWith = args;
      return { id: 'existing1', username: args.where.username };
    };

    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'existinguser', password: 'pass', role: 'USER' })
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(findUniqueCalledWith, { where: { username: 'existinguser' } });
    const body = await res.text();
    assert.strictEqual(body, 'Username already exists');
  });

  await t.test('successfully creates a user with default aiEnabled=true when omitted', async () => {
    (globalThis as any).mockAuth = () => ({
      user: { id: 'admin1', username: 'admin', role: 'ADMIN' }
    });

    let createArgs: any = null;
    (globalThis as any).mockPrismaUser.findUnique = async () => null;
    (globalThis as any).mockPrismaUser.create = async (args: any) => {
      createArgs = args;
      return {
        id: 'new-user-id',
        username: args.data.username,
        role: args.data.role
      };
    };

    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'john_doe',
        password: 'secret_password',
        role: 'EDITOR',
        name: 'John Doe'
      })
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.deepStrictEqual(json, {
      id: 'new-user-id',
      username: 'john_doe',
      role: 'EDITOR'
    });

    assert.ok(createArgs);
    assert.strictEqual(createArgs.data.username, 'john_doe');
    assert.strictEqual(createArgs.data.password, 'hashed_secret_password');
    assert.strictEqual(createArgs.data.role, 'EDITOR');
    assert.strictEqual(createArgs.data.name, 'John Doe');
    assert.strictEqual(createArgs.data.aiEnabled, true);
  });

  await t.test('successfully creates a user with explicitly false aiEnabled', async () => {
    (globalThis as any).mockAuth = () => ({
      user: { id: 'admin1', username: 'admin', role: 'ADMIN' }
    });

    let createArgs: any = null;
    (globalThis as any).mockPrismaUser.findUnique = async () => null;
    (globalThis as any).mockPrismaUser.create = async (args: any) => {
      createArgs = args;
      return {
        id: 'new-user-id-2',
        username: args.data.username,
        role: args.data.role
      };
    };

    const req = new Request('http://localhost/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'jane_doe',
        password: 'another_password',
        role: 'USER',
        name: 'Jane Doe',
        aiEnabled: false
      })
    });

    const res = await POST(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.deepStrictEqual(json, {
      id: 'new-user-id-2',
      username: 'jane_doe',
      role: 'USER'
    });

    assert.ok(createArgs);
    assert.strictEqual(createArgs.data.aiEnabled, false);
  });

  await t.test('returns 500 Internal Server Error when creation fails', async () => {
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      (globalThis as any).mockAuth = () => ({
        user: { id: 'admin1', username: 'admin', role: 'ADMIN' }
      });

      (globalThis as any).mockPrismaUser.findUnique = async () => null;
      (globalThis as any).mockPrismaUser.create = async () => {
        throw new Error('Database error');
      };

      const req = new Request('http://localhost/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'erruser', password: 'pass', role: 'USER' })
      });

      const res = await POST(req);
      assert.strictEqual(res.status, 500);
      const body = await res.text();
      assert.strictEqual(body, 'Internal Server Error');
    } finally {
      console.error = originalConsoleError;
    }
  });
});

test('GET /api/users', async (t) => {
  t.beforeEach(() => {
    (globalThis as any).mockAuth = () => null;
    (globalThis as any).mockPrismaUser = {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => ({})
    };
  });

  await t.test('returns 401 Unauthorized if user is not authenticated', async () => {
    (globalThis as any).mockAuth = () => null;

    const req = new Request('http://localhost/api/users', { method: 'GET' });
    const res = await GET(req);
    assert.strictEqual(res.status, 401);
    const body = await res.text();
    assert.strictEqual(body, 'Unauthorized');
  });

  await t.test('restricts result to own user id for regular users', async () => {
    (globalThis as any).mockAuth = () => ({
      user: { id: 'user-123', username: 'regular_user', role: 'VIEWER' }
    });

    let findManyArgs: any = null;
    (globalThis as any).mockPrismaUser.findMany = async (args: any) => {
      findManyArgs = args;
      return [
        { id: 'user-123', username: 'regular_user', name: 'Regular User', role: 'VIEWER', createdAt: new Date(), aiEnabled: true }
      ];
    };

    const req = new Request('http://localhost/api/users', { method: 'GET' });
    const res = await GET(req);
    assert.strictEqual(res.status, 200);

    const json = await res.json();
    assert.strictEqual(json.length, 1);
    assert.strictEqual(json[0].id, 'user-123');
    assert.deepStrictEqual(findManyArgs.where, { id: 'user-123' });
  });

  await t.test('returns all users for ADMIN or EDITOR roles', async () => {
    const roles = ['ADMIN', 'EDITOR'];

    for (const role of roles) {
      (globalThis as any).mockAuth = () => ({
        user: { id: 'user-456', username: 'privileged_user', role }
      });

      let findManyArgs: any = null;
      (globalThis as any).mockPrismaUser.findMany = async (args: any) => {
        findManyArgs = args;
        return [
          { id: 'user-1', username: 'u1', name: 'User 1', role: 'ADMIN', createdAt: new Date(), aiEnabled: true },
          { id: 'user-2', username: 'u2', name: 'User 2', role: 'USER', createdAt: new Date(), aiEnabled: true }
        ];
      };

      const req = new Request('http://localhost/api/users', { method: 'GET' });
      const res = await GET(req);
      assert.strictEqual(res.status, 200);

      const json = await res.json();
      assert.strictEqual(json.length, 2);
      assert.deepStrictEqual(findManyArgs.where, {});
    }
  });

  await t.test('returns 500 Internal Server Error when database fails on GET', async () => {
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      (globalThis as any).mockAuth = () => ({
        user: { id: 'user-123', username: 'user', role: 'ADMIN' }
      });

      (globalThis as any).mockPrismaUser.findMany = async () => {
        throw new Error('Database fetch failed');
      };

      const req = new Request('http://localhost/api/users', { method: 'GET' });
      const res = await GET(req);
      assert.strictEqual(res.status, 500);
      const body = await res.text();
      assert.strictEqual(body, 'Internal Server Error');
    } finally {
      console.error = originalConsoleError;
    }
  });
});
