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
