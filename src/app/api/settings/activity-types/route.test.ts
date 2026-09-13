import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('Security Check: PUT /api/settings/activity-types/[id] has auth() check', async () => {
  const filePath = path.resolve('src/app/api/settings/activity-types/[id]/route.ts');
  const content = fs.readFileSync(filePath, 'utf8');

  // Check for auth import
  assert.ok(content.includes("import { auth } from '@/auth'") || content.includes('import { auth } from "@/auth"'), 'Should import auth from @/auth');

  // Check for auth() call in PUT
  const putMatch = content.match(/export async function PUT[\s\S]*?\{([\s\S]*?)\n[ ]*try/);
  assert.ok(putMatch, 'PUT function body before try block not found');
  assert.ok(putMatch[1].includes('await auth()'), 'PUT should call auth()');
  assert.ok(putMatch[1].includes('401'), 'PUT should return 401 if unauthorized');
});

test('Security Check: DELETE /api/settings/activity-types/[id] has auth() check', async () => {
  const filePath = path.resolve('src/app/api/settings/activity-types/[id]/route.ts');
  const content = fs.readFileSync(filePath, 'utf8');

  // Check for auth() call in DELETE
  const deleteMatch = content.match(/export async function DELETE[\s\S]*?\{([\s\S]*?)\n[ ]*try/);
  assert.ok(deleteMatch, 'DELETE function body before try block not found');
  assert.ok(deleteMatch[1].includes('await auth()'), 'DELETE should call auth()');
  assert.ok(deleteMatch[1].includes('401'), 'DELETE should return 401 if unauthorized');
});
