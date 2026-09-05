import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register module hook to resolve `@/auth`, `@prisma/client`, `next/server`, and `bcryptjs`
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = async () => globalThis.mockAuth();")
    };
  }
  if (specifier === "@prisma/client") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class PrismaClient { constructor() { return globalThis.mockPrisma; } }")
    };
  }
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export class NextResponse extends Response { constructor(body, init) { super(body, init); } }")
    };
  }
  if (specifier === "bcryptjs") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export default { hash: async (p, salt) => 'hashed_' + p };")
    };
  }
  if (specifier.startsWith("@/")) {
    const relativePath = specifier.replace("@/", "./src/");
    return nextResolve(new URL(relativePath, "file://" + process.cwd() + "/").href, context);
  }
  return nextResolve(specifier, context);
}
`));

// Setup global delegate proxy before importing route handler
const prismaDelegate: {
    user: {
        update: (args: any) => Promise<any>;
        delete: (args: any) => Promise<any>;
    }
} = {
    user: {
        update: async (args: any) => globalThis.mockPrismaUserUpdate(args),
        delete: async (args: any) => globalThis.mockPrismaUserDelete(args)
    }
};

(globalThis as any).mockPrisma = prismaDelegate;
(globalThis as any).mockAuth = () => null;
(globalThis as any).mockPrismaUserUpdate = async () => {};
(globalThis as any).mockPrismaUserDelete = async () => {};

// Direct ESM import of route handler
const { PUT, DELETE } = await import('./[id]/route.ts');

test('PUT /api/users/[id] Handler Direct Function Execution Tests', async (t) => {
    t.beforeEach(() => {
        (globalThis as any).mockAuth = async () => null;
        (globalThis as any).mockPrismaUserUpdate = async () => {};
        (globalThis as any).mockPrismaUserDelete = async () => {};
    });

    await t.test('returns 401 Unauthorized if session is missing', async () => {
        (globalThis as any).mockAuth = async () => null;
        const req = new Request('http://localhost/api/users/user1', {
            method: 'PUT',
            body: JSON.stringify({ name: 'New Name' })
        });
        const res = await PUT(req, { params: Promise.resolve({ id: 'user1' }) });
        assert.strictEqual(res.status, 401);
        const text = await res.text();
        assert.strictEqual(text, 'Unauthorized');
    });

    await t.test('returns 401 Unauthorized if non-admin attempts to update another user', async () => {
        (globalThis as any).mockAuth = async () => ({
            user: { id: 'user2', role: 'USER' }
        });
        const req = new Request('http://localhost/api/users/user1', {
            method: 'PUT',
            body: JSON.stringify({ name: 'New Name' })
        });
        const res = await PUT(req, { params: Promise.resolve({ id: 'user1' }) });
        assert.strictEqual(res.status, 401);
        const text = await res.text();
        assert.strictEqual(text, 'Unauthorized');
    });

    await t.test('returns 403 Forbidden if non-admin attempts to change role on own account', async () => {
        (globalThis as any).mockAuth = async () => ({
            user: { id: 'user1', role: 'USER' }
        });
        const req = new Request('http://localhost/api/users/user1', {
            method: 'PUT',
            body: JSON.stringify({ role: 'ADMIN' })
        });
        const res = await PUT(req, { params: Promise.resolve({ id: 'user1' }) });
        assert.strictEqual(res.status, 403);
        const text = await res.text();
        assert.strictEqual(text, 'Unauthorized to change role');
    });

    await t.test('allows user to update their own name and aiEnabled', async () => {
        let updatedWhere: any = null;
        let updatedData: any = null;

        (globalThis as any).mockAuth = async () => ({
            user: { id: 'user1', role: 'USER' }
        });
        (globalThis as any).mockPrismaUserUpdate = async (args: any) => {
            updatedWhere = args.where;
            updatedData = args.data;
            return { id: 'user1' };
        };

        const req = new Request('http://localhost/api/users/user1', {
            method: 'PUT',
            body: JSON.stringify({ name: 'Updated User1', aiEnabled: true })
        });
        const res = await PUT(req, { params: Promise.resolve({ id: 'user1' }) });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(updatedWhere, { id: 'user1' });
        assert.deepStrictEqual(updatedData, { name: 'Updated User1', aiEnabled: true });
    });

    await t.test('hashes password when password field is provided', async () => {
        let updatedData: any = null;

        (globalThis as any).mockAuth = async () => ({
            user: { id: 'user1', role: 'USER' }
        });
        (globalThis as any).mockPrismaUserUpdate = async (args: any) => {
            updatedData = args.data;
            return { id: 'user1' };
        };

        const req = new Request('http://localhost/api/users/user1', {
            method: 'PUT',
            body: JSON.stringify({ password: 'secretpassword' })
        });
        const res = await PUT(req, { params: Promise.resolve({ id: 'user1' }) });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(updatedData.password, 'hashed_secretpassword');
    });

    await t.test('allows ADMIN user to update role of another user', async () => {
        let updatedWhere: any = null;
        let updatedData: any = null;

        (globalThis as any).mockAuth = async () => ({
            user: { id: 'admin1', role: 'ADMIN' }
        });
        (globalThis as any).mockPrismaUserUpdate = async (args: any) => {
            updatedWhere = args.where;
            updatedData = args.data;
            return { id: 'user2' };
        };

        const req = new Request('http://localhost/api/users/user2', {
            method: 'PUT',
            body: JSON.stringify({ role: 'EDITOR' })
        });
        const res = await PUT(req, { params: Promise.resolve({ id: 'user2' }) });

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(updatedWhere, { id: 'user2' });
        assert.strictEqual(updatedData.role, 'EDITOR');
    });

    await t.test('returns 500 on database error during update', async () => {
        const consoleErrorOrig = console.error;
        console.error = () => {};

        try {
            (globalThis as any).mockAuth = async () => ({
                user: { id: 'admin1', role: 'ADMIN' }
            });
            (globalThis as any).mockPrismaUserUpdate = async () => {
                throw new Error('Database down');
            };

            const req = new Request('http://localhost/api/users/user2', {
                method: 'PUT',
                body: JSON.stringify({ name: 'Error Test' })
            });
            const res = await PUT(req, { params: Promise.resolve({ id: 'user2' }) });

            assert.strictEqual(res.status, 500);
            const text = await res.text();
            assert.strictEqual(text, 'Internal Server Error');
        } finally {
            console.error = consoleErrorOrig;
        }
    });
});

test('DELETE /api/users/[id] Handler Direct Function Execution Tests', async (t) => {
    t.beforeEach(() => {
        (globalThis as any).mockAuth = async () => null;
        (globalThis as any).mockPrismaUserUpdate = async () => {};
        (globalThis as any).mockPrismaUserDelete = async () => {};
    });

    await t.test('returns 401 Unauthorized if session is missing or user is non-ADMIN', async () => {
        (globalThis as any).mockAuth = async () => ({
            user: { id: 'user1', role: 'USER' }
        });
        const req = new Request('http://localhost/api/users/user2', { method: 'DELETE' });
        const res = await DELETE(req, { params: Promise.resolve({ id: 'user2' }) });
        assert.strictEqual(res.status, 401);
    });

    await t.test('returns 400 Bad Request if ADMIN tries to delete themselves', async () => {
        (globalThis as any).mockAuth = async () => ({
            user: { id: 'admin1', role: 'ADMIN' }
        });
        const req = new Request('http://localhost/api/users/admin1', { method: 'DELETE' });
        const res = await DELETE(req, { params: Promise.resolve({ id: 'admin1' }) });
        assert.strictEqual(res.status, 400);
        const text = await res.text();
        assert.strictEqual(text, 'Cannot delete yourself');
    });

    await t.test('successfully deletes specified user if requester is ADMIN', async () => {
        let deletedWhere: any = null;

        (globalThis as any).mockAuth = async () => ({
            user: { id: 'admin1', role: 'ADMIN' }
        });
        (globalThis as any).mockPrismaUserDelete = async (args: any) => {
            deletedWhere = args.where;
            return { id: 'user2' };
        };

        const req = new Request('http://localhost/api/users/user2', { method: 'DELETE' });
        const res = await DELETE(req, { params: Promise.resolve({ id: 'user2' }) });

        assert.strictEqual(res.status, 204);
        assert.deepStrictEqual(deletedWhere, { id: 'user2' });
    });

    await t.test('returns 500 on database error during delete', async () => {
        const consoleErrorOrig = console.error;
        console.error = () => {};

        try {
            (globalThis as any).mockAuth = async () => ({
                user: { id: 'admin1', role: 'ADMIN' }
            });
            (globalThis as any).mockPrismaUserDelete = async () => {
                throw new Error('Database error');
            };

            const req = new Request('http://localhost/api/users/user2', { method: 'DELETE' });
            const res = await DELETE(req, { params: Promise.resolve({ id: 'user2' }) });

            assert.strictEqual(res.status, 500);
        } finally {
            console.error = consoleErrorOrig;
        }
    });
});
