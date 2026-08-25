import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_LOCK_ENABLED_PREFERENCE,
  APP_LOCK_GRACE_PREFERENCE,
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
  assert.equal(values.get(APP_LOCK_ENABLED_PREFERENCE), 'true');
  assert.equal(values.get(APP_LOCK_GRACE_PREFERENCE), 'fiveMinutes');
  assert.deepEqual(await store.read(), { enabled: true, grace: 'fiveMinutes' });
});

test('malformed values are rejected instead of guessed', () => {
  assert.throws(
    () => decodeAppLockPreferences({ enabled: 'yes', grace: 'immediate' }),
    /malformed/,
  );
  assert.throws(
    () => decodeAppLockPreferences({ enabled: 'false', grace: 'tenMinutes' }),
    /malformed/,
  );
});
