import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeLocalModelNativeModule, createLocalModelService } from './native';

test('explicit simulator fake completes the same verified lifecycle without model bytes', async () => {
  const service = createLocalModelService({ native: createFakeLocalModelNativeModule() });
  const states: string[] = [];
  const unsubscribe = service.subscribe((snapshot) => states.push(snapshot.state));

  const ready = await service.startDownload();
  assert.equal(ready.state, 'ready');
  assert.equal(ready.progress, 1);
  assert.equal(ready.loaded, false);
  assert.equal(states.includes('downloading'), true);
  assert.equal(states.includes('verifying'), true);

  await assert.rejects(() => service.infer('synthetic prompt'), /not loaded/);
  assert.equal((await service.load()).state, 'loaded');
  assert.deepEqual(JSON.parse(await service.infer('synthetic prompt')), {
    schemaVersion: 'alyte.semantic-mapper.v1',
    proposals: [],
  });
  assert.equal((await service.unload()).state, 'ready');
  await assert.rejects(() => service.infer('synthetic prompt'), /not loaded/);
  assert.equal((await service.deletePack()).state, 'not-installed');
  unsubscribe();
});

test('explicit simulator fake cancellation remains active during transfer', async () => {
  const service = createLocalModelService({ native: createFakeLocalModelNativeModule() });
  const download = service.startDownload();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const cancelled = await service.cancelDownload();
  assert.equal(cancelled.state, 'not-installed');
  assert.equal((await download).state, 'not-installed');
});

test('native and JavaScript manifest identity mismatch fails closed before download', async () => {
  const native = createFakeLocalModelNativeModule();
  const manifest = native.getManifest() as Record<string, any>;
  const mismatchedNative = {
    ...native,
    getManifest: () => ({ ...manifest, runtime: { ...manifest.runtime, revision: 'tampered' } }),
  };
  const service = createLocalModelService({ native: mismatchedNative });
  await assert.rejects(() => service.startDownload(), /local model module is unavailable/);
});

test('late native registration can recover without relaxing the manifest gate', async () => {
  const native = createFakeLocalModelNativeModule();
  let available = false;
  const service = createLocalModelService({
    resolveNative: () => (available ? native : null),
  });

  await assert.rejects(() => service.getState(), /local model module is unavailable/);
  available = true;

  assert.equal((await service.getState()).state, 'not-installed');
  await assert.rejects(
    () =>
      createLocalModelService({
        resolveNative: () => ({
          ...native,
          getManifest: () => ({
            ...(native.getManifest() as Record<string, unknown>),
            runtime: { revision: 'tampered' },
          }),
        }),
      }).getState(),
    /local model module is unavailable/,
  );
});
