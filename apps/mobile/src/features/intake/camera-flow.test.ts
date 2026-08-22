import { test } from 'node:test';
import assert from 'node:assert/strict';
import type * as ImagePicker from 'expo-image-picker';
import { captureFromCamera } from './camera-flow';

test('camera flow reports permission denial without opening the picker', async () => {
  let launched = false;
  const result = await captureFromCamera(
    async () => ({ granted: false }),
    async () => {
      launched = true;
      return { canceled: true, assets: null } as const;
    },
  );
  assert.deepEqual(result, { kind: 'permission-denied' });
  assert.equal(launched, false);
});

test('camera flow keeps cancellation distinct from a captured asset', async () => {
  const cancelled = await captureFromCamera(
    async () => ({ granted: true }),
    async () => ({ canceled: true, assets: null }) as const,
  );
  assert.deepEqual(cancelled, { kind: 'cancelled' });

  const captured = await captureFromCamera(
    async () => ({ granted: true }),
    async () =>
      ({
        canceled: false,
        assets: [{ uri: 'file:///synthetic/intake.jpg' }],
      }) as ImagePicker.ImagePickerResult,
  );
  assert.equal(captured.kind, 'captured');
  if (captured.kind === 'captured') {
    assert.equal(captured.asset.uri, 'file:///synthetic/intake.jpg');
  }
});
