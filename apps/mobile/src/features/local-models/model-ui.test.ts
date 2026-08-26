import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLocalModelEvent, notInstalledSnapshot } from './model';
import { modelFailureMessageKey, modelProgressPercent, modelStateLabelKey } from './model-ui';
import { productionLocalModelManifest } from './manifest';

test('model progress is a bounded, whole-number presentation value', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  const partial = applyLocalModelEvent(initial, {
    kind: 'progress',
    bytesReceived: Math.floor(initial.expectedBytes * 0.456),
  });

  assert.equal(modelProgressPercent(initial), 0);
  assert.equal(modelProgressPercent(partial), 46);
  assert.equal(modelProgressPercent({ ...partial, progress: 2 } as typeof partial), 100);
});

test('every native lifecycle state has a user-facing status key', () => {
  assert.equal(modelStateLabelKey('not-installed'), 'settings.modelStorageNotInstalled');
  assert.equal(modelStateLabelKey('downloading'), 'settings.modelStorageDownloading');
  assert.equal(modelStateLabelKey('verifying'), 'settings.modelStorageVerifying');
  assert.equal(modelStateLabelKey('ready'), 'settings.modelStorageReady');
  assert.equal(modelStateLabelKey('loaded'), 'settings.modelStorageLoaded');
  assert.equal(modelStateLabelKey('failed'), 'settings.modelStorageFailed');
  assert.equal(modelStateLabelKey('cancelling'), 'settings.modelStorageWorking');
  assert.equal(modelStateLabelKey('deleting'), 'settings.modelStorageWorking');
});

test('failures preserve action-oriented copy categories', () => {
  assert.equal(modelFailureMessageKey('offline'), 'onboarding.modelFailureOffline');
  assert.equal(modelFailureMessageKey('insufficient-space'), 'onboarding.modelFailureSpace');
  assert.equal(modelFailureMessageKey('checksum-mismatch'), 'onboarding.modelFailureChecksum');
  assert.equal(modelFailureMessageKey('interrupted'), 'onboarding.modelFailureInterrupted');
  assert.equal(modelFailureMessageKey('unavailable'), 'onboarding.modelFailureUnavailable');
  assert.equal(modelFailureMessageKey('unknown'), 'onboarding.modelFailureGeneric');
});
