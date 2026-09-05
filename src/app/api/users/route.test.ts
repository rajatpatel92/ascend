import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

// Register module hook to resolve imports for test execution
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@/auth") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent("export const auth = (...args) => globalThis.__mockAuth(...args);")
    };
  }
  if (specifier === "@prisma/client" || specifier === "./prisma" || specifier === "@/lib/prisma") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class PrismaClient {
          constructor() {
            return {
              user: {
                findMany: (...args) => globalThis.__mockPrisma.user.findMany(...args),
                findUnique: (...args) => globalThis.__mockPrisma.user.findUnique(...args),
                create: (...args) => globalThis.__mockPrisma.user.create(...args)
              }
            };
          }
        }
      \`)
    };
  }
  if (specifier === "next/server") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export class NextResponse {
          constructor(body, init) {
            this.body = body;
            this.status = init?.status ?? 200;
          }
          static json(data, init) {
            return new NextResponse(JSON.stringify(data), {
              status: init?.status ?? 200,
              headers: { 'content-type': 'application/json' }
            });
          }
          async json() {
            if (typeof this.body === 'string') return JSON.parse(this.body);
            return this.body;
          }
        }
      \`)
    };
  }
  if (specifier === "bcryptjs") {
    return {
      shortCircuit: true,
      url: "data:text/javascript," + encodeURIComponent(\`
        export default {
          hash: (...args) => globalThis.__mockBcryptHash(...args),
          compare: (...args) => globalThis.__mockBcryptCompare(...args)
        };
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

// Setup global mock holders
(globalThis as any).__mockAuth = async () => null;
(globalThis as any).__mockPrisma = {
    user: {
        findMany: async () => [],
        findUnique: async () => null,
        create: async () => ({})
    }
};
(globalThis as any).__mockBcryptHash = async (pwd: string) => `hashed_${pwd}`;

// Import the route module under test
const { GET, POST } = await import('./route.ts');

test('GET /api/users endpoint unit tests', async (t) => {
    t.beforeEach(() => {
        (globalThis as any).__mockAuth = async () => null;
        (globalThis as any).__mockPrisma = {
            user: {
                findMany: async () => [],
                findUnique: async () => null,
                create: async () => ({})
            }
        };
    });

    await t.test('returns 401 Unauthorized when session is null', async () => {
        (globalThis as any).__mockAuth = async () => null;

        const req = new Request('http://localhost:3000/api/users');
        const res = await GET(req);

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body, 'Unauthorized');
    });

    await t.test('queries all users when user role is ADMIN', async () => {
        (globalThis as any).__mockAuth = async () => ({
            user: { id: 'admin-1', role: 'ADMIN' }
        });

        let findManyArgs: any = null;
        const mockUsers = [
            { id: 'admin-1', username: 'admin', name: 'Admin User', role: 'ADMIN', createdAt: new Date(), aiEnabled: true },
            { id: 'user-2', username: 'viewer', name: 'Viewer User', role: 'VIEWER', createdAt: new Date(), aiEnabled: true }
        ];

        (globalThis as any).__mockPrisma = {
            user: {
                findMany: async (args: any) => {
                    findManyArgs = args;
                    return mockUsers;
                }
            }
        };

        const req = new Request('http://localhost:3000/api/users');
        const res = await GET(req);

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(findManyArgs.where, {});
        assert.deepStrictEqual(findManyArgs.select, {
            id: true,
            username: true,
            name: true,
            role: true,
            createdAt: true,
            aiEnabled: true
        });
        assert.deepStrictEqual(findManyArgs.orderBy, { createdAt: 'desc' });

        const body = await res.json();
        assert.strictEqual(body.length, 2);
    });

    await t.test('queries all users when user role is EDITOR', async () => {
        (globalThis as any).__mockAuth = async () => ({
            user: { id: 'editor-1', role: 'EDITOR' }
        });

        let findManyArgs: any = null;

        (globalThis as any).__mockPrisma = {
            user: {
                findMany: async (args: any) => {
                    findManyArgs = args;
                    return [];
                }
            }
        };

        const req = new Request('http://localhost:3000/api/users');
        const res = await GET(req);

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(findManyArgs.where, {});
    });

    await t.test('restricts query to own userId when role is not ADMIN or EDITOR (e.g. VIEWER)', async () => {
        (globalThis as any).__mockAuth = async () => ({
            user: { id: 'viewer-100', role: 'VIEWER' }
        });

        let findManyArgs: any = null;

        (globalThis as any).__mockPrisma = {
            user: {
                findMany: async (args: any) => {
                    findManyArgs = args;
                    return [{ id: 'viewer-100', username: 'viewer', name: 'Viewer', role: 'VIEWER', createdAt: new Date(), aiEnabled: true }];
                }
            }
        };

        const req = new Request('http://localhost:3000/api/users');
        const res = await GET(req);

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(findManyArgs.where, { id: 'viewer-100' });
    });

    await t.test('returns 500 Internal Server Error when database query fails', async () => {
        const originalConsoleError = console.error;
        console.error = () => {}; // Suppress expected console.error output

        try {
            (globalThis as any).__mockAuth = async () => ({
                user: { id: 'admin-1', role: 'ADMIN' }
            });

            (globalThis as any).__mockPrisma = {
                user: {
                    findMany: async () => {
                        throw new Error('Database error');
                    }
                }
            };

            const req = new Request('http://localhost:3000/api/users');
            const res = await GET(req);

            assert.strictEqual(res.status, 500);
            assert.strictEqual(res.body, 'Internal Server Error');
        } finally {
            console.error = originalConsoleError;
        }
    });
});

test('POST /api/users endpoint unit tests', async (t) => {
    t.beforeEach(() => {
        (globalThis as any).__mockAuth = async () => null;
        (globalThis as any).__mockPrisma = {
            user: {
                findMany: async () => [],
                findUnique: async () => null,
                create: async () => ({})
            }
        };
        (globalThis as any).__mockBcryptHash = async (pwd: string) => `hashed_${pwd}`;
    });

    await t.test('returns 401 Unauthorized when session is null', async () => {
        (globalThis as any).__mockAuth = async () => null;

        const req = new Request('http://localhost:3000/api/users', {
            method: 'POST',
            body: JSON.stringify({ username: 'newuser', password: 'password123', role: 'VIEWER' })
        });
        const res = await POST(req);

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body, 'Unauthorized');
    });

    await t.test('returns 401 Unauthorized when session user role is not ADMIN', async () => {
        (globalThis as any).__mockAuth = async () => ({
            user: { id: 'editor-1', role: 'EDITOR' }
        });

        const req = new Request('http://localhost:3000/api/users', {
            method: 'POST',
            body: JSON.stringify({ username: 'newuser', password: 'password123', role: 'VIEWER' })
        });
        const res = await POST(req);

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body, 'Unauthorized');
    });

    await t.test('returns 400 Bad Request when required fields are missing', async () => {
        (globalThis as any).__mockAuth = async () => ({
            user: { id: 'admin-1', role: 'ADMIN' }
        });

        // Missing password
        const req = new Request('http://localhost:3000/api/users', {
            method: 'POST',
            body: JSON.stringify({ username: 'newuser', role: 'VIEWER' })
        });
        const res = await POST(req);

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body, 'Missing required fields');
    });

    await t.test('returns 400 Bad Request when username already exists', async () => {
        (globalThis as any).__mockAuth = async () => ({
            user: { id: 'admin-1', role: 'ADMIN' }
        });

        (globalThis as any).__mockPrisma = {
            user: {
                findUnique: async (args: any) => {
                    if (args.where.username === 'existinguser') {
                        return { id: 'user-99', username: 'existinguser' };
                    }
                    return null;
                }
            }
        };

        const req = new Request('http://localhost:3000/api/users', {
            method: 'POST',
            body: JSON.stringify({ username: 'existinguser', password: 'password123', role: 'VIEWER' })
        });
        const res = await POST(req);

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body, 'Username already exists');
    });

    await t.test('hashes password and creates user successfully for ADMIN', async () => {
        (globalThis as any).__mockAuth = async () => ({
            user: { id: 'admin-1', role: 'ADMIN' }
        });

        let createArgs: any = null;
        let bcryptHashInput: string | null = null;

        (globalThis as any).__mockBcryptHash = async (pwd: string) => {
            bcryptHashInput = pwd;
            return 'hashed_secure_pass';
        };

        (globalThis as any).__mockPrisma = {
            user: {
                findUnique: async () => null,
                create: async (args: any) => {
                    createArgs = args;
                    return {
                        id: 'new-user-id',
                        username: args.data.username,
                        role: args.data.role
                    };
                }
            }
        };

        const req = new Request('http://localhost:3000/api/users', {
            method: 'POST',
            body: JSON.stringify({
                username: 'john_doe',
                password: 'mysecretpassword',
                role: 'EDITOR',
                name: 'John Doe',
                aiEnabled: true
            })
        });
        const res = await POST(req);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(bcryptHashInput, 'mysecretpassword');
        assert.strictEqual(createArgs.data.username, 'john_doe');
        assert.strictEqual(createArgs.data.password, 'hashed_secure_pass');
        assert.strictEqual(createArgs.data.role, 'EDITOR');
        assert.strictEqual(createArgs.data.name, 'John Doe');

        const body = await res.json();
        assert.deepStrictEqual(body, {
            id: 'new-user-id',
            username: 'john_doe',
            role: 'EDITOR'
        });
    });

    await t.test('returns 500 Internal Server Error when creation fails', async () => {
        const originalConsoleError = console.error;
        console.error = () => {}; // Suppress log

        try {
            (globalThis as any).__mockAuth = async () => ({
                user: { id: 'admin-1', role: 'ADMIN' }
            });

            (globalThis as any).__mockPrisma = {
                user: {
                    findUnique: async () => null,
                    create: async () => {
                        throw new Error('Database insertion failed');
                    }
                }
            };

            const req = new Request('http://localhost:3000/api/users', {
                method: 'POST',
                body: JSON.stringify({ username: 'newuser', password: 'password123', role: 'VIEWER' })
            });
            const res = await POST(req);

            assert.strictEqual(res.status, 500);
            assert.strictEqual(res.body, 'Internal Server Error');
        } finally {
            console.error = originalConsoleError;
        }
    });
});

test('Structural verification of src/app/api/users/route.ts', async (t) => {
    const filePath = path.resolve('src/app/api/users/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    await t.test('GET handler imports auth and PrismaClient', () => {
        assert.ok(content.includes('import { auth } from "@/auth"') || content.includes("import { auth } from '@/auth'"), 'Should import auth');
        assert.ok(content.includes('import { PrismaClient } from "@prisma/client"'), 'Should import PrismaClient');
    });

    await t.test('GET handler includes role-based condition for ADMIN and EDITOR', () => {
        assert.ok(content.includes("userRole === 'ADMIN' || userRole === 'EDITOR'"), 'Should check for ADMIN or EDITOR role');
    });

    await t.test('POST handler restricts access to ADMIN role only', () => {
        assert.ok(content.includes("(session.user as any).role !== 'ADMIN'"), 'POST should restrict non-ADMIN roles');
    });
});
