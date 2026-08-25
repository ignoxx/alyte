import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalAuthenticationResult } from 'expo-local-authentication';
import { createAppLockAuthService, type AppLockAuthProvider } from './auth';

function providerFor(result: LocalAuthenticationResult): AppLockAuthProvider {
  return { authenticateAsync: async () => result };
}

test('auth enables device passcode fallback and maps cancellation safely', async () => {
  let received: unknown;
  const provider: AppLockAuthProvider = {
    authenticateAsync: async (options) => {
      received = options;
      return { success: false, error: 'user_cancel' };
    },
  };
  const result = await createAppLockAuthService(provider).authenticate('Unlock Alyte');
  assert.deepEqual(result, { kind: 'cancelled' });
  assert.deepEqual(received, { promptMessage: 'Unlock Alyte', disableDeviceFallback: false });
});

test('all native failures remain locked outcomes and enrollment changes are retryable', async () => {
  for (const [error, kind] of [
    ['authentication_failed', 'failed'],
    ['lockout', 'lockout'],
    ['not_available', 'unavailable'],
    ['not_enrolled', 'enrollment-changed'],
    ['passcode_not_set', 'unavailable'],
  ] as const) {
    const result = await createAppLockAuthService(
      providerFor({ success: false, error }),
    ).authenticate('Unlock Alyte');
    assert.deepEqual(result, { kind });
  }
  const thrown = await createAppLockAuthService({
    authenticateAsync: async () => {
      throw new Error('unexpected');
    },
  }).authenticate('Unlock Alyte');
  assert.deepEqual(thrown, { kind: 'failed' });
});

test('concurrent calls serialize into one fresh system attempt', async () => {
  let calls = 0;
  let resolve!: (value: LocalAuthenticationResult) => void;
  const provider: AppLockAuthProvider = {
    authenticateAsync: async () => {
      calls += 1;
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  const service = createAppLockAuthService(provider);
  const first = service.authenticate('Unlock Alyte');
  const second = service.authenticate('Unlock Alyte');
  assert.equal(calls, 1);
  resolve({ success: true });
  assert.deepEqual(await first, { kind: 'success' });
  assert.deepEqual(await second, { kind: 'success' });
});
