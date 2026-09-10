import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nearestExistingPath } from './alyte-service-baseline';

describe('private evaluation path handling', () => {
  it('retains a dangling symlink as the nearest existing ancestor', () => {
    const root = mkdtempSync(join(tmpdir(), 'alyte-path-test-'));
    const privateRoot = join(root, 'private');
    mkdirSync(privateRoot, { recursive: true });
    const dangling = join(privateRoot, 'dangling');
    symlinkSync(join(root, 'missing-target'), dangling);

    assert.equal(nearestExistingPath(join(dangling, 'nested', 'output.json')), dangling);
    assert.equal(lstatSync(dangling).isSymbolicLink(), true);
  });
});
