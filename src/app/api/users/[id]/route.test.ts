import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';

// Register ESM loader hook to mock dependencies before importing route handler
const resolverCode = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/auth") {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockAuth(...args);") };
  }
  if (specifier === "@prisma/client") {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class PrismaClient { constructor() { return globalThis.__mockPrisma; } }") };
  }
  if (specifier === "next/server") {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export class NextResponse extends Response { static json(body, init) { return new Response(JSON.stringify(body), init); } }") };
  }
  if (specifier === "bcryptjs") {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent("export default { hash: async (p, rounds) => p + \\"_hashed\\" };") };
  }
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.replace("@/", "./src/");
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(resolverCode));

// Global mock state
let deleteImpl = async (args: any): Promise<any> => {};
let updateImpl = async (args: any): Promise<any> => {};

(globalThis as any).__mockAuth = async () => null;
(globalThis as any).__mockPrisma = {
  user: {
    delete: (args: any) => deleteImpl(args),
    update: (args: any) => updateImpl(args)
  }
};

// Import route handlers
const { DELETE, PUT } = await import('./route.ts');

test('DELETE /api/users/[id]', async (t) => {
  t.beforeEach(() => {
    (globalThis as any).__mockAuth = async () => null;
    deleteImpl = async () => {};
    updateImpl = async () => {};
  });

  await t.test('returns 401 Unauthorized if user is not authenticated', async () => {
    (globalThis as any).__mockAuth = async () => null;
    const req = new Request('http://localhost/api/users/user-123', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'user-123' }) });

    assert.strictEqual(res.status, 401);
    const body = await res.text();
    assert.strictEqual(body, 'Unauthorized');
  });

  await t.test('returns 401 Unauthorized if authenticated user is not an ADMIN', async () => {
    (globalThis as any).__mockAuth = async () => ({
      user: { id: 'user-1', role: 'USER', name: 'Regular User' }
    });
    const req = new Request('http://localhost/api/users/user-123', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'user-123' }) });

    assert.strictEqual(res.status, 401);
    const body = await res.text();
    assert.strictEqual(body, 'Unauthorized');
  });

  await t.test('returns 400 Bad Request if ADMIN user attempts to delete themselves', async () => {
    (globalThis as any).__mockAuth = async () => ({
      user: { id: 'admin-1', role: 'ADMIN', name: 'Admin User' }
    });
    const req = new Request('http://localhost/api/users/admin-1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'admin-1' }) });

    assert.strictEqual(res.status, 400);
    const body = await res.text();
    assert.strictEqual(body, 'Cannot delete yourself');
  });

  await t.test('successfully deletes user when requested by ADMIN for another user ID', async () => {
    let deleteCalledWith: any = null;
    deleteImpl = async (args: any) => {
      deleteCalledWith = args;
      return { id: 'user-123' };
    };

    (globalThis as any).__mockAuth = async () => ({
      user: { id: 'admin-1', role: 'ADMIN', name: 'Admin User' }
    });

    const req = new Request('http://localhost/api/users/user-123', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'user-123' }) });

    assert.strictEqual(res.status, 204);
    assert.deepStrictEqual(deleteCalledWith, { where: { id: 'user-123' } });
  });

  await t.test('returns 500 Internal Server Error when database deletion fails', async () => {
    const originalConsoleError = console.error;
    console.error = () => {}; // suppress log during test

    try {
      deleteImpl = async () => {
        throw new Error('Database connection failed');
      };

      (globalThis as any).__mockAuth = async () => ({
        user: { id: 'admin-1', role: 'ADMIN', name: 'Admin User' }
      });

      const req = new Request('http://localhost/api/users/user-123', { method: 'DELETE' });
      const res = await DELETE(req, { params: Promise.resolve({ id: 'user-123' }) });

      assert.strictEqual(res.status, 500);
      const body = await res.text();
      assert.strictEqual(body, 'Internal Server Error');
    } finally {
      console.error = originalConsoleError;
    }
  });
});

test('PUT /api/users/[id]', async (t) => {
  t.beforeEach(() => {
    (globalThis as any).__mockAuth = async () => null;
    deleteImpl = async () => {};
    updateImpl = async () => {};
  });

  await t.test('returns 401 Unauthorized if user is not authenticated', async () => {
    (globalThis as any).__mockAuth = async () => null;
    const req = new Request('http://localhost/api/users/user-123', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' })
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'user-123' }) });

    assert.strictEqual(res.status, 401);
  });

  await t.test('returns 401 Unauthorized if non-ADMIN tries to update another user profile', async () => {
    (globalThis as any).__mockAuth = async () => ({
      user: { id: 'user-1', role: 'USER' }
    });
    const req = new Request('http://localhost/api/users/user-2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' })
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'user-2' }) });

    assert.strictEqual(res.status, 401);
  });

  await t.test('returns 403 Forbidden if non-ADMIN attempts to change role', async () => {
    (globalThis as any).__mockAuth = async () => ({
      user: { id: 'user-1', role: 'USER' }
    });
    const req = new Request('http://localhost/api/users/user-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'ADMIN' })
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'user-1' }) });

    assert.strictEqual(res.status, 403);
    const body = await res.text();
    assert.strictEqual(body, 'Unauthorized to change role');
  });

  await t.test('allows non-ADMIN to update own profile fields (name, aiEnabled)', async () => {
    let updateCalledWith: any = null;
    updateImpl = async (args: any) => {
      updateCalledWith = args;
      return {};
    };

    (globalThis as any).__mockAuth = async () => ({
      user: { id: 'user-1', role: 'USER' }
    });
    const req = new Request('http://localhost/api/users/user-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name', aiEnabled: true })
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'user-1' }) });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(updateCalledWith, {
      where: { id: 'user-1' },
      data: { name: 'Updated Name', aiEnabled: true }
    });
  });

  await t.test('allows ADMIN to update role and hash password', async () => {
    let updateCalledWith: any = null;
    updateImpl = async (args: any) => {
      updateCalledWith = args;
      return {};
    };

    (globalThis as any).__mockAuth = async () => ({
      user: { id: 'admin-1', role: 'ADMIN' }
    });
    const req = new Request('http://localhost/api/users/user-2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'EDITOR', password: 'secretpassword' })
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'user-2' }) });

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(updateCalledWith, {
      where: { id: 'user-2' },
      data: { role: 'EDITOR', password: 'secretpassword_hashed' }
    });
  });

  await t.test('returns 500 Internal Server Error when database update fails', async () => {
    const originalConsoleError = console.error;
    console.error = () => {};

    try {
      updateImpl = async () => {
        throw new Error('Database update failed');
      };

      (globalThis as any).__mockAuth = async () => ({
        user: { id: 'admin-1', role: 'ADMIN' }
      });
      const req = new Request('http://localhost/api/users/user-2', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' })
      });
      const res = await PUT(req, { params: Promise.resolve({ id: 'user-2' }) });

      assert.strictEqual(res.status, 500);
      const body = await res.text();
      assert.strictEqual(body, 'Internal Server Error');
    } finally {
      console.error = originalConsoleError;
    }
  });
});

test('Static Security Checks for src/app/api/users/[id]/route.ts', async (t) => {
  await t.test('Source file imports auth and checks ADMIN role in DELETE', () => {
    const filePath = path.join(process.cwd(), 'src/app/api/users/[id]/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    assert.ok(content.includes('import { auth } from "@/auth"') || content.includes("import { auth } from '@/auth'"));
    assert.ok(content.includes("role !== 'ADMIN'"));
    assert.ok(content.includes('Cannot delete yourself'));
  });
});
