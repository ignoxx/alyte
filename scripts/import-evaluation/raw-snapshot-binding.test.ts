import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createRawSnapshotBinding,
  verifyRawSnapshotBinding,
  type RawSnapshotIdentity,
} from './raw-snapshot-binding';

const identity: RawSnapshotIdentity = {
  reportSha256: '1'.repeat(64),
  readerVersion: 'alyte.mac.synthetic-reader.v1',
  runtimeVersion: 'node-test;swift-test',
  readerBinarySha256: '2'.repeat(64),
  readerSourceSha256: '3'.repeat(64),
};

test('raw snapshot binding covers report, reader/runtime identity, and content', () => {
  const raw = JSON.stringify({
    readerVersion: identity.readerVersion,
    reportSha256: identity.reportSha256,
    runtimeVersion: identity.runtimeVersion,
    pageCount: 1,
    pages: [],
  });
  const binding = createRawSnapshotBinding(raw, identity);
  assert.equal(binding.snapshotSha256, createHash('sha256').update(raw).digest('hex'));
  const envelope = verifyRawSnapshotBinding(raw, binding, identity);
  assert.equal(envelope.reportSha256, identity.reportSha256);
});

test('raw snapshot binding rejects a stale report or changed reader runtime', () => {
  const raw = JSON.stringify({
    readerVersion: identity.readerVersion,
    reportSha256: identity.reportSha256,
    runtimeVersion: identity.runtimeVersion,
    pageCount: 1,
    pages: [],
  });
  const binding = createRawSnapshotBinding(raw, identity);
  assert.throws(
    () => verifyRawSnapshotBinding(raw, binding, { ...identity, reportSha256: '4'.repeat(64) }),
    /raw-snapshot-reportSha256-mismatch/u,
  );
  assert.throws(
    () => verifyRawSnapshotBinding(raw, binding, { ...identity, runtimeVersion: 'changed' }),
    /raw-snapshot-runtimeVersion-mismatch/u,
  );
  assert.throws(
    () => verifyRawSnapshotBinding(`${raw} `, binding, identity),
    /raw-snapshot-content-mismatch/u,
  );
});
