import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('Activity Import Validate API Route - Structural and Logic Verification', async (t) => {
    const filePath = path.join(process.cwd(), 'src/app/api/activities/import/validate/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    await t.test('Imports auth correctly and checks session', () => {
        assert.ok(content.includes("import { auth } from '@/auth'"), 'Should import auth');
        assert.ok(content.includes('const session = await auth()'), 'Should check session using auth()');
        assert.ok(content.includes('status: 401'), 'Should return 401 when unauthenticated');
    });

    await t.test('Parallelizes account and platform DB fetches using Promise.all', () => {
        assert.ok(content.includes('Promise.all(['), 'Should call Promise.all to fetch reference data concurrently');
        assert.ok(content.includes('prisma.account.findMany()'), 'Should query accounts inside Promise.all');
        assert.ok(content.includes('prisma.platform.findMany()'), 'Should query platforms inside Promise.all');
    });

    await t.test('Performs CSV parsing using papaparse', () => {
        assert.ok(content.includes('Papa.parse'), 'Should use Papa.parse for CSV parsing');
    });
});
