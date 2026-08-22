import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBoundaries } from './boundaries.mjs';

test('pure package dependency boundaries remain inward-only', () => {
  assert.deepEqual(checkBoundaries(), []);
});
