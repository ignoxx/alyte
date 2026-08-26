import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyLocalModelEvent, hasResumableModelDownload, notInstalledSnapshot } from './model';
import {
  formatModelDownloadSize,
  isExpectedDownloadCancellation,
  modelFailureMessageKey,
  modelDownloadAction,
  modelOperation,
  modelProgressPercent,
  modelStateLabelKey,
  modelStatusTone,
} from './model-ui';
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
  assert.equal(modelStateLabelKey('cancelling'), 'settings.modelStorageCancelling');
  assert.equal(modelStateLabelKey('deleting'), 'settings.modelStorageDeleting');
});

test('lifecycle presentation keeps transition actions exclusive', () => {
  const states = [
    ['not-installed', 'download'],
    ['downloading', 'cancel'],
    ['verifying', 'cancel'],
    ['ready', 'remove'],
    ['loaded', 'remove'],
    ['failed', 'retry'],
    ['cancelling', 'cancelling'],
    ['deleting', 'deleting'],
  ] as const;

  for (const [state, operation] of states) assert.equal(modelOperation(state), operation);
  assert.equal(modelOperation(null), 'checking');
  assert.equal(modelStatusTone(null), 'neutral');
  assert.equal(
    modelStatusTone({ ...notInstalledSnapshot(productionLocalModelManifest), state: 'ready' }),
    'measured',
  );
  assert.equal(
    modelStatusTone({
      ...notInstalledSnapshot(productionLocalModelManifest),
      state: 'failed',
      failure: 'checksum-mismatch',
    }),
    'reviewNeeded',
  );
  assert.equal(
    modelStatusTone({
      ...notInstalledSnapshot(productionLocalModelManifest),
      state: 'failed',
      bytesReceived: 100,
      progress: 100 / productionLocalModelManifest.pack.artifact.bytes,
      failure: 'interrupted',
    }),
    'neutral',
  );
});

test('retained partials present a continue action and keep honest progress', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  const interrupted = {
    ...initial,
    state: 'failed' as const,
    bytesReceived: 100,
    progress: 100 / initial.expectedBytes,
    failure: 'interrupted' as const,
  };
  const partial = applyLocalModelEvent(
    applyLocalModelEvent(initial, { kind: 'progress', bytesReceived: 100 }),
    { kind: 'cancel-requested' },
  );
  const resumed = applyLocalModelEvent(partial, { kind: 'cancelled' });

  assert.equal(hasResumableModelDownload(interrupted), true);
  assert.equal(modelDownloadAction(interrupted), 'continue');
  assert.equal(hasResumableModelDownload(resumed), true);
  assert.equal(modelDownloadAction(resumed), 'continue');
  assert.equal(resumed.bytesReceived, 100);
  assert.equal(resumed.progress, 100 / resumed.expectedBytes);
  assert.equal(
    modelDownloadAction({
      ...resumed,
      state: 'failed',
      bytesReceived: 0,
      progress: 0,
      failure: 'interrupted',
    }),
    'retry',
  );
});

test('failures preserve action-oriented copy categories', () => {
  assert.equal(modelFailureMessageKey('offline'), 'onboarding.modelFailureOffline');
  assert.equal(modelFailureMessageKey('insufficient-space'), 'onboarding.modelFailureSpace');
  assert.equal(modelFailureMessageKey('checksum-mismatch'), 'onboarding.modelFailureChecksum');
  assert.equal(modelFailureMessageKey('interrupted'), 'onboarding.modelFailureInterrupted');
  assert.equal(modelFailureMessageKey('cancelled'), 'onboarding.modelCancelDisclosure');
  assert.equal(modelFailureMessageKey('unavailable'), 'onboarding.modelFailureUnavailable');
  assert.equal(modelFailureMessageKey('unknown'), 'onboarding.modelFailureGeneric');
});

test('cancellation is only calm when a requested cancel has the typed cancelled category', () => {
  assert.equal(isExpectedDownloadCancellation({ failure: 'cancelled' }, true), true);
  assert.equal(isExpectedDownloadCancellation({ failureCategory: 'cancelled' }, true), true);
  assert.equal(isExpectedDownloadCancellation({ failure: 'cancelled' }, false), false);
  assert.equal(isExpectedDownloadCancellation({ failure: 'runtime-failed' }, true), false);
  assert.equal(isExpectedDownloadCancellation(new Error('cancelled'), true), false);
});

test('download size formatting follows the device locale and localized unit keys', () => {
  assert.equal(
    formatModelDownloadSize(productionLocalModelManifest.pack.artifact.bytes, 'en-US'),
    '2,841,481,184 bytes (2.8 GB)',
  );
  assert.equal(
    formatModelDownloadSize(productionLocalModelManifest.pack.artifact.bytes, 'de-DE'),
    '2.841.481.184 bytes (2,8 GB)',
  );
});
