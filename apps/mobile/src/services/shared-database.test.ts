import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSerializedFactory } from './shared-database';

test('serializes shared database opens and continues after a failed open', async () => {
  const open = createSerializedFactory();
  let active = 0;
  let peak = 0;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = open(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await firstGate;
    active -= 1;
    throw new Error('first open failed');
  });
  const second = open(async () => {
    active += 1;
    peak = Math.max(peak, active);
    active -= 1;
    return 'second open';
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  assert.equal(peak, 1);
  releaseFirst!();
  await assert.rejects(first, /first open failed/);
  assert.equal(await second, 'second open');
  assert.equal(peak, 1);
});
