import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ProtectionError, protectionFailureCategory, validateProtectionReport } from './protection';

describe('local database protection policy', () => {
  test('accepts absent SQLite sidecars while requiring the primary report', () => {
    const report = {
      protectedPaths: ['/tmp/alyte.sqlite'],
      missingSidecarPaths: ['/tmp/alyte.sqlite-wal', '/tmp/alyte.sqlite-shm'],
    };

    assert.doesNotThrow(() => validateProtectionReport('/tmp/alyte.sqlite', report));
  });

  test('accepts a report containing only the files that exist at verification time', () => {
    const report = {
      protectedPaths: ['/tmp/alyte.sqlite', '/tmp/alyte.sqlite-wal'],
      missingSidecarPaths: ['/tmp/alyte.sqlite-shm'],
    };

    assert.doesNotThrow(() => validateProtectionReport('/tmp/alyte.sqlite', report));
  });

  test('rejects a report that does not verify the primary database', () => {
    assert.throws(
      () =>
        validateProtectionReport('/tmp/alyte.sqlite', {
          protectedPaths: ['/tmp/alyte.sqlite-wal'],
          missingSidecarPaths: ['/tmp/alyte.sqlite-shm'],
        }),
      (error: unknown) =>
        error instanceof ProtectionError &&
        error.category === 'data_protection_verification' &&
        error.message === 'The primary local database file was not protected',
    );
  });

  test('maps native diagnostics to a stable category without exposing paths', () => {
    const category = protectionFailureCategory({
      userInfo: { failureCategory: 'backup_exclusion_verification' },
    });

    assert.equal(category, 'backup_exclusion_verification');
    assert.equal(
      new ProtectionError('The local database could not be protected', { category }).category,
      'backup_exclusion_verification',
    );
    assert.equal(
      protectionFailureCategory({ message: 'Alyte failure: data_protection_verification' }),
      'data_protection_verification',
    );
  });
});
