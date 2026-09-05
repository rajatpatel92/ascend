import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('src/app/api/market-data/intraday/route.ts security check', async (t) => {
  await t.test('GET handler includes authentication check', () => {
    const filePath = path.join(process.cwd(), 'src/app/api/market-data/intraday/route.ts');
    const content = fs.readFileSync(filePath, 'utf8');

    // Check for auth import
    assert.ok(content.includes("import { auth } from '@/auth'"), 'Should import auth');

    // Check for auth call and 401 response
    assert.ok(content.includes('const session = await auth()'), 'Should call auth()');
    assert.ok(content.includes('status: 401'), 'Should return 401 status code if unauthorized');
    assert.ok(content.includes("error: 'Unauthorized'"), 'Should return Unauthorized error message');
  });
});
