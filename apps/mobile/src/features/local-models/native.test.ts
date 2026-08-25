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
  assert.equal(states.includes('downloading'), true);
  assert.equal(states.includes('verifying'), true);

  assert.equal((await service.load()).state, 'loaded');
  assert.equal((await service.unload()).state, 'ready');
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
