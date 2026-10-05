import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server';
test('local boundary, source roundtrip, and cancellation delete the private session', async () => {
  const app = await startServer(14317);
  const base = 'http://127.0.0.1:14317';
  const sessions = join(homedir(), 'Library', 'Caches', 'AlyteImportLab', 'sessions');
  try {
    assert.equal((await fetch(base + '/api/status')).status, 403);
    assert.equal(
      (
        await fetch(base + '/api/status', {
          headers: { 'x-local-token': app.token, origin: 'https://example.com' },
        })
      ).status,
      403,
    );
    const headers = { 'x-local-token': app.token };
    assert.equal(
      (await fetch(base + '/api/import', { method: 'POST', headers, body: 'not a PDF' })).status,
      400,
    );
    const before = new Set(await readdir(sessions).catch(() => []));
    const synthetic = '%PDF-1.4\n% Synthetic cancellation fixture, deliberately incomplete.\n';
    assert.equal(
      (await fetch(base + '/api/import', { method: 'POST', headers, body: synthetic })).status,
      202,
    );
    const created = (await readdir(sessions)).filter((name) => !before.has(name));
    assert.equal(created.length, 1);
    const session = join(sessions, created[0]!);
    assert.equal((await stat(session)).mode & 0o777, 0o700);
    assert.equal((await stat(join(session, 'source.pdf'))).mode & 0o777, 0o600);
    assert.equal(await (await fetch(base + '/api/source', { headers })).text(), synthetic);
    assert.equal((await fetch(base + '/api/import', { method: 'DELETE', headers })).status, 200);
    await assert.rejects(stat(session), { code: 'ENOENT' });
    assert.equal((await fetch(base + '/api/source', { headers })).status, 404);
    assert.equal((await (await fetch(base + '/api/status', { headers })).json()).state, 'empty');
  } finally {
    await app.close();
  }
});
