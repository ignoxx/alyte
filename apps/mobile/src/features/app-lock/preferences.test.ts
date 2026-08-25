import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_LOCK_POLICY_PREFERENCE,
  createAppLockPreferenceStore,
  decodeAppLockPreferences,
} from './preferences';

test('missing typed preferences default to a disabled immediate lock', async () => {
  const values = new Map<string, string>();
  const store = createAppLockPreferenceStore({
    async getLocalPreference(key) {
      return values.get(key) ?? null;
    },
    async setLocalPreference(key, value) {
      values.set(key, value);
    },
  });
  assert.deepEqual(await store.read(), { enabled: false, grace: 'immediate' });
  await store.write({ enabled: true, grace: 'fiveMinutes' });
  assert.deepEqual(JSON.parse(values.get(APP_LOCK_POLICY_PREFERENCE) ?? ''), {
    enabled: true,
    grace: 'fiveMinutes',
  });
  assert.deepEqual(await store.read(), { enabled: true, grace: 'fiveMinutes' });
});

test('malformed or partial policy documents are rejected instead of guessed', () => {
  for (const value of [
    '{"enabled":"yes","grace":"immediate"}',
    '{"enabled":false,"grace":"tenMinutes"}',
    '{"enabled":true}',
    '{"enabled":true,"grace":"immediate","extra":1}',
    'not-json',
  ]) {
    assert.throws(() => decodeAppLockPreferences(value), /malformed/);
  }
});

test('a write is one source update and cannot leave a partial policy', async () => {
  const writes: Array<[string, string]> = [];
  const store = createAppLockPreferenceStore({
    async getLocalPreference() {
      return null;
    },
    async setLocalPreference(key, value) {
      writes.push([key, value]);
    },
  });
  await store.write({ enabled: false, grace: 'oneMinute' });
  assert.deepEqual(writes, [
    [APP_LOCK_POLICY_PREFERENCE, JSON.stringify({ enabled: false, grace: 'oneMinute' })],
  ]);
});

test('a failed atomic write exposes one failure and no partial key updates', async () => {
  let writes = 0;
  const store = createAppLockPreferenceStore({
    async getLocalPreference() {
      return null;
    },
    async setLocalPreference() {
      writes += 1;
      throw new Error('storage unavailable');
    },
  });
  await assert.rejects(store.write({ enabled: true, grace: 'oneMinute' }), /storage unavailable/);
  assert.equal(writes, 1);
});
