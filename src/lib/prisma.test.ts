import test from 'node:test';
import assert from 'node:assert';

test('src/lib/prisma.ts exports a PrismaClient instance and manages global singleton', async (t) => {
    // Clean up global state before starting tests
    const globalForPrisma = globalThis as unknown as { prisma: any };
    delete globalForPrisma.prisma;

    // First import
    const { prisma } = await import('./prisma.ts');

    await t.test('exports a valid PrismaClient instance', () => {
        assert.ok(prisma, 'prisma should be defined');
        assert.ok(prisma.constructor, 'prisma should have a constructor');
        assert.strictEqual(prisma.constructor.name, 'PrismaClient');
    });

    await t.test('attaches prisma instance to globalThis in non-production', () => {
        if (process.env.NODE_ENV !== 'production') {
            assert.strictEqual(globalForPrisma.prisma, prisma, 'globalThis.prisma should match the exported prisma instance');
        }
    });

    await t.test('reuses existing globalThis.prisma instance when module is re-imported', async () => {
        const mockExistingPrisma = { isCustomMock: true, constructor: { name: 'PrismaClient' } };
        globalForPrisma.prisma = mockExistingPrisma;

        // Re-import module using cache-busting query string so module evaluation runs again
        const reimportedModule = await import(`./prisma.ts?update=${Date.now()}`);

        assert.strictEqual(
            reimportedModule.prisma,
            mockExistingPrisma,
            'prisma export should reuse the pre-existing globalThis.prisma instance'
        );
    });
});
