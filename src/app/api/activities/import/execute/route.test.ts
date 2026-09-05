import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('Import Execute route structural verification', async (t) => {
    const filePath = path.resolve('src/app/api/activities/import/execute/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    await t.test('Imports auth correctly', () => {
        assert.ok(content.includes('import { auth } from "@/auth"') || content.includes("import { auth } from '@/auth'"), 'Should import auth');
    });

    await t.test('Uses prisma.currency.createMany for bulk currency insertion', () => {
        assert.ok(content.includes('prisma.currency.createMany'), 'Should use prisma.currency.createMany');
    });

    await t.test('Uses prisma.investment.createMany for bulk investment insertion', () => {
        assert.ok(content.includes('prisma.investment.createMany'), 'Should use prisma.investment.createMany');
    });

    await t.test('Passes skipDuplicates: true to prevent duplicate errors', () => {
        const createManyMatches = content.match(/createMany\(\{[\s\S]*?skipDuplicates:\s*true/g);
        assert.ok(createManyMatches && createManyMatches.length >= 2, 'Both createMany calls should specify skipDuplicates: true');
    });

    await t.test('Does not use individual investment.create in loop/Promise.all', () => {
        assert.ok(!content.includes('prisma.investment.create({'), 'Should not call individual prisma.investment.create');
    });
});
