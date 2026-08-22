import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShowcaseSnapshot } from '../packages/fixtures/src/index.js';

test('showcase output is deterministic synthetic data', () => {
  const first = loadShowcaseSnapshot('preview', true);
  const second = loadShowcaseSnapshot('preview', true);
  assert.deepEqual(first, second);
  assert.deepEqual(first?.records, ['Synthetic lab report', 'Synthetic intake event']);
  assert.deepEqual(
    first?.intakeEvents.map((event) => event.name),
    ['Synthetic breakfast', 'Synthetic drink'],
  );
});

test('showcase mode cannot be requested by production', () => {
  assert.throws(() => loadShowcaseSnapshot('production', true), /disabled in production/);
});
