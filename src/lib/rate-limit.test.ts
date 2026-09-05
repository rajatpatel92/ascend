import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

// Register module hook to resolve `@/lib/prisma` to `globalThis.prisma`
register("data:text/javascript," + encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
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

// Create a prisma delegate proxy on globalThis before importing rate-limit module
const prismaDelegate: {
    $transaction: (cb: any) => any;
    currentMock: any;
} = {
    $transaction: (cb: any) => prismaDelegate.currentMock.$transaction(cb),
    currentMock: null
};

(globalThis as any).prisma = prismaDelegate;

// Import checkRateLimit directly from source file
const { checkRateLimit } = await import('./rate-limit.ts');

test('checkRateLimit - Direct Module Integration & Business Logic', async (t) => {
    t.beforeEach(() => {
        prismaDelegate.currentMock = null;
    });

    await t.test('allows request and creates record if key does not exist', async () => {
        let upsertCalledWith: any = null;
        const now = new Date();

        const txMock = {
            rateLimit: {
                findUnique: async () => null,
                upsert: async (args: any) => {
                    upsertCalledWith = args;
                    return { key: args.where.key, count: 1, expiresAt: args.create.expiresAt };
                },
                update: async () => {
                    assert.fail('update should not be called when creating new record');
                }
            }
        };

        prismaDelegate.currentMock = {
            $transaction: async (cb: any) => cb(txMock)
        };

        const allowed = await checkRateLimit('user-123', 5, 60);

        assert.strictEqual(allowed, true);
        assert.ok(upsertCalledWith);
        assert.strictEqual(upsertCalledWith.where.key, 'user-123');
        assert.strictEqual(upsertCalledWith.create.count, 1);
        assert.ok(upsertCalledWith.create.expiresAt.getTime() >= now.getTime() + 59 * 1000);
    });

    await t.test('allows request and resets record if existing record is expired', async () => {
        let upsertCalledWith: any = null;
        const expiredTime = new Date(Date.now() - 5000); // 5s in the past

        const txMock = {
            rateLimit: {
                findUnique: async () => ({
                    key: 'user-123',
                    count: 10,
                    expiresAt: expiredTime
                }),
                upsert: async (args: any) => {
                    upsertCalledWith = args;
                    return { key: args.where.key, count: 1, expiresAt: args.create.expiresAt };
                },
                update: async () => {
                    assert.fail('update should not be called when record is expired');
                }
            }
        };

        prismaDelegate.currentMock = {
            $transaction: async (cb: any) => cb(txMock)
        };

        const allowed = await checkRateLimit('user-123', 5, 60);

        assert.strictEqual(allowed, true);
        assert.ok(upsertCalledWith);
        assert.strictEqual(upsertCalledWith.update.count, 1);
        assert.ok(upsertCalledWith.update.expiresAt.getTime() > Date.now());
    });

    await t.test('allows request and increments count if under limit', async () => {
        let updateCalledWith: any = null;
        const validTime = new Date(Date.now() + 60000); // 60s in future

        const txMock = {
            rateLimit: {
                findUnique: async () => ({
                    key: 'user-123',
                    count: 3,
                    expiresAt: validTime
                }),
                upsert: async () => {
                    assert.fail('upsert should not be called for active unexpired key');
                },
                update: async (args: any) => {
                    updateCalledWith = args;
                    return { key: 'user-123', count: 4, expiresAt: validTime };
                }
            }
        };

        prismaDelegate.currentMock = {
            $transaction: async (cb: any) => cb(txMock)
        };

        const allowed = await checkRateLimit('user-123', 5, 60);

        assert.strictEqual(allowed, true);
        assert.ok(updateCalledWith);
        assert.strictEqual(updateCalledWith.where.key, 'user-123');
        assert.strictEqual(updateCalledWith.data.count, 4);
    });

    await t.test('allows request when count is exactly limit - 1 (boundary case)', async () => {
        let updateCalledWith: any = null;
        const validTime = new Date(Date.now() + 60000);

        const txMock = {
            rateLimit: {
                findUnique: async () => ({
                    key: 'user-123',
                    count: 4,
                    expiresAt: validTime
                }),
                update: async (args: any) => {
                    updateCalledWith = args;
                    return { key: 'user-123', count: 5, expiresAt: validTime };
                }
            }
        };

        prismaDelegate.currentMock = {
            $transaction: async (cb: any) => cb(txMock)
        };

        const allowed = await checkRateLimit('user-123', 5, 60);

        assert.strictEqual(allowed, true);
        assert.strictEqual(updateCalledWith.data.count, 5);
    });

    await t.test('blocks request when count has reached limit', async () => {
        let updateCalled = false;
        const validTime = new Date(Date.now() + 60000);

        const txMock = {
            rateLimit: {
                findUnique: async () => ({
                    key: 'user-123',
                    count: 5,
                    expiresAt: validTime
                }),
                update: async () => {
                    updateCalled = true;
                }
            }
        };

        prismaDelegate.currentMock = {
            $transaction: async (cb: any) => cb(txMock)
        };

        const allowed = await checkRateLimit('user-123', 5, 60);

        assert.strictEqual(allowed, false);
        assert.strictEqual(updateCalled, false);
    });

    await t.test('blocks request when count exceeds limit', async () => {
        let updateCalled = false;
        const validTime = new Date(Date.now() + 60000);

        const txMock = {
            rateLimit: {
                findUnique: async () => ({
                    key: 'user-123',
                    count: 12,
                    expiresAt: validTime
                }),
                update: async () => {
                    updateCalled = true;
                }
            }
        };

        prismaDelegate.currentMock = {
            $transaction: async (cb: any) => cb(txMock)
        };

        const allowed = await checkRateLimit('user-123', 5, 60);

        assert.strictEqual(allowed, false);
        assert.strictEqual(updateCalled, false);
    });

    await t.test('fails open (returns true) and logs error when transaction throws exception', async () => {
        const originalConsoleError = console.error;
        let loggedError: any = null;
        console.error = (...args: any[]) => {
            loggedError = args;
        };

        try {
            prismaDelegate.currentMock = {
                $transaction: async () => {
                    throw new Error('Database connection failure');
                }
            };

            const allowed = await checkRateLimit('user-123', 5, 60);

            assert.strictEqual(allowed, true);
            assert.ok(loggedError);
            assert.strictEqual(loggedError[0], 'Rate limit error:');
        } finally {
            console.error = originalConsoleError;
        }
    });
});
