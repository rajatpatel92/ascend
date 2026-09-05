import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('Rebalancer Targets API route optimization', async (t) => {
    const filePath = path.join(process.cwd(), 'src/app/api/rebalancer/targets/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    await t.test('POST handler uses prisma.$transaction for batch execution', () => {
        assert.ok(content.includes('prisma.$transaction('), 'Should call prisma.$transaction');
        assert.ok(!content.includes('Promise.all(targets.map'), 'Should not use unbatched Promise.all for target upserts');
    });

    await t.test('POST handler includes deleteMany in $transaction array', () => {
        assert.ok(content.includes('deleteMany'), 'Should include deleteMany operation');
        // Ensure deleteMany is inside the transaction array before upsertOperations
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
