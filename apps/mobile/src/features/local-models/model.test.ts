import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyLocalModelEvent,
  canCompleteModelOnboarding,
  canStartAutomatedExtraction,
  notInstalledSnapshot,
} from './model';
import { productionLocalModelManifest } from './manifest';

test('model cannot complete onboarding or extraction before verified promotion', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  const downloading = applyLocalModelEvent(initial, { kind: 'download-requested' });
  const partial = applyLocalModelEvent(downloading, { kind: 'progress', bytesReceived: 100 });
  const verifying = applyLocalModelEvent(partial, { kind: 'verification-started' });
  assert.equal(canCompleteModelOnboarding(initial), false);
  assert.equal(canCompleteModelOnboarding(partial), false);
  assert.equal(canCompleteModelOnboarding(verifying), false);
  assert.equal(canStartAutomatedExtraction(verifying), false);
  const ready = applyLocalModelEvent(verifying, { kind: 'verified' });
  assert.equal(canCompleteModelOnboarding(ready), true);
  assert.equal(canStartAutomatedExtraction(ready), true);
  assert.equal(ready.progress, 1);
});

test('cancel and delete return to a safe not-installed state', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  const ready = applyLocalModelEvent(
    applyLocalModelEvent(initial, { kind: 'verification-started' }),
    { kind: 'verified' },
  );
  const loaded = applyLocalModelEvent(ready, { kind: 'loaded' });
  assert.equal(loaded.state, 'loaded');
  const deleting = applyLocalModelEvent(loaded, { kind: 'delete-requested' });
  assert.equal(deleting.state, 'deleting');
  const deleted = applyLocalModelEvent(deleting, { kind: 'deleted' });
  assert.equal(deleted.state, 'not-installed');
  assert.equal(deleted.storageBytes, 0);
  const cancelled = applyLocalModelEvent(
    applyLocalModelEvent(initial, { kind: 'download-requested' }),
    { kind: 'cancel-requested' },
  );
  assert.equal(applyLocalModelEvent(cancelled, { kind: 'cancelled' }).state, 'not-installed');
});

test('cancelling a partial keeps its bytes available for a later continuation', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  const partial = applyLocalModelEvent(initial, { kind: 'progress', bytesReceived: 123 });
  const cancelled = applyLocalModelEvent(partial, { kind: 'cancelled' });
  assert.equal(cancelled.state, 'not-installed');
  assert.equal(cancelled.bytesReceived, 123);
  assert.equal(cancelled.progress, 123 / cancelled.expectedBytes);
});

test('normalizing incomplete ready state never grants readiness', async () => {
  const { normalizeLocalModelSnapshot } = await import('./model');
  const snapshot = normalizeLocalModelSnapshot(
    { state: 'ready', bytesReceived: productionLocalModelManifest.pack.artifact.bytes - 1 },
    productionLocalModelManifest,
  );
  assert.equal(snapshot.progress < 1, true);
  assert.equal(snapshot.failure, 'size-mismatch');
  assert.equal(canCompleteModelOnboarding(snapshot), false);

  const failedReady = normalizeLocalModelSnapshot(
    {
      state: 'ready',
      bytesReceived: productionLocalModelManifest.pack.artifact.bytes,
      failure: 'checksum-mismatch',
    },
    productionLocalModelManifest,
  );
  assert.equal(failedReady.state, 'failed');
  assert.equal(canCompleteModelOnboarding(failedReady), false);
});
