import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('contracts build emits the package runtime and declarations before consumers load it', () => {
  assert.equal(fs.existsSync('packages/contracts/dist/index.js'), true);
  assert.equal(fs.existsSync('packages/contracts/dist/index.d.ts'), true);

  const manifest = JSON.parse(fs.readFileSync('packages/contracts/package.json', 'utf8'));
  assert.equal(manifest.exports['.'].import, './dist/index.js');
  assert.equal(manifest.exports['.'].types, './dist/index.d.ts');

  const version = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { CONTRACT_VERSION } from '@alyte/contracts'; process.stdout.write(CONTRACT_VERSION)",
    ],
    { encoding: 'utf8' },
  );
  assert.equal(version, '2026-08-28');
});
