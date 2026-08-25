import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalAuthenticationResult } from 'expo-local-authentication';
import { createAppLockAuthService, type AppLockAuthProvider } from './auth';
import { createAppLockController } from './controller';
import { createAppLockPreferenceStore } from './preferences';

function fixture(initial: { enabled: boolean; grace: 'immediate' | 'oneMinute' | 'fiveMinutes' }) {
  const values = new Map<string, string>([
    ['app.app-lock.enabled', String(initial.enabled)],
    ['app.app-lock.grace', initial.grace],
  ]);
  let now = 0;
  let clearCount = 0;
  let authCalls = 0;
  let resolveAuth!: (value: LocalAuthenticationResult) => void;
  const authProvider: AppLockAuthProvider = {
    authenticateAsync: async () => {
      authCalls += 1;
      return new Promise((resolve) => {
        resolveAuth = resolve;
      });
    },
  };
  const controller = createAppLockController({
    now: () => now,
    preferences: createAppLockPreferenceStore({
      async getLocalPreference(key) {
        return values.get(key) ?? null;
      },
      async setLocalPreference(key, value) {
        values.set(key, value);
      },
    }),
    authentication: createAppLockAuthService(authProvider),
    shield: {
      async clear() {
        clearCount += 1;
      },
      async isInstalled() {
        return true;
      },
    },
  });
  return {
    controller,
    setNow(value: number) {
      now = value;
    },
    resolveAuth: (value: LocalAuthenticationResult) => resolveAuth(value),
    get authCalls() {
      return authCalls;
    },
    get clearCount() {
      return clearCount;
    },
    values,
  };
}

test('cold start authenticates before unlock and cloud resume can observe unlocked state', async () => {
  const fixtureState = fixture({ enabled: true, grace: 'immediate' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.controller.getSnapshot().phase, 'authenticating');
  assert.equal(fixtureState.authCalls, 1);
  fixtureState.resolveAuth({ success: true });
  await bootstrap;
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
  assert.equal(fixtureState.clearCount, 1);
});

test('background during pending auth invalidates stale success and foreground retries', async () => {
  const fixtureState = fixture({ enabled: true, grace: 'immediate' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.controller.onBackground();
  fixtureState.resolveAuth({ success: true });
  await bootstrap;
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');

  fixtureState.setNow(1);
  const foreground = fixtureState.controller.onForeground();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.authCalls, 2);
  fixtureState.resolveAuth({ success: true });
  await foreground;
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
});

test('foreground waits out a stale prompt and starts a fresh authentication attempt', async () => {
  const fixtureState = fixture({ enabled: true, grace: 'immediate' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));

  fixtureState.controller.onBackground();
  const foreground = fixtureState.controller.onForeground();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.authCalls, 1);

  fixtureState.resolveAuth({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.authCalls, 2);
  fixtureState.resolveAuth({ success: true });

  await Promise.all([bootstrap, foreground]);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
});

test('foreground within one-minute grace clears once without another auth prompt', async () => {
  const fixtureState = fixture({ enabled: true, grace: 'oneMinute' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.resolveAuth({ success: true });
  await bootstrap;
  fixtureState.controller.onBackground();
  fixtureState.setNow(59_999);
  await Promise.all([
    fixtureState.controller.onForeground(),
    fixtureState.controller.onForeground(),
  ]);
  assert.equal(fixtureState.authCalls, 1);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
  assert.equal(fixtureState.clearCount, 2);
});

test('repeated active events after unlock do not prompt again', async () => {
  const fixtureState = fixture({ enabled: true, grace: 'immediate' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.resolveAuth({ success: true });
  await bootstrap;

  await Promise.all([
    fixtureState.controller.onForeground(),
    fixtureState.controller.onForeground(),
  ]);

  assert.equal(fixtureState.authCalls, 1);
  assert.equal(fixtureState.clearCount, 1);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
});

test('disabled lock stays opaque until the native shield clear completes', async () => {
  let releaseClear!: () => void;
  const clear = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const controller = createAppLockController({
    preferences: createAppLockPreferenceStore({
      async getLocalPreference(key) {
        return key === 'app.app-lock.enabled' ? 'false' : 'immediate';
      },
      async setLocalPreference() {},
    }),
    authentication: createAppLockAuthService(providerForSuccess()),
    shield: { clear: () => clear, isInstalled: async () => true },
  });

  const bootstrap = controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().phase, 'loading');
  releaseClear();
  await bootstrap;
  assert.equal(controller.getSnapshot().phase, 'unlocked');
});

test('preference read failure is a neutral retry state and disabling requires auth', async () => {
  const values = new Map<string, string>([['app.app-lock.enabled', 'malformed']]);
  const controller = createAppLockController({
    preferences: createAppLockPreferenceStore({
      async getLocalPreference(key) {
        return values.get(key) ?? null;
      },
      async setLocalPreference(key, value) {
        values.set(key, value);
      },
    }),
    authentication: createAppLockAuthService(providerForSuccess()),
    shield: { clear: async () => undefined, isInstalled: async () => true },
  });
  await controller.bootstrap();
  assert.equal(controller.getSnapshot().phase, 'retry');
  const retry = controller.retry();
  await retry;
  assert.equal(controller.getSnapshot().phase, 'retry');
});

function providerForSuccess(): AppLockAuthProvider {
  return { authenticateAsync: async () => ({ success: true }) };
}
