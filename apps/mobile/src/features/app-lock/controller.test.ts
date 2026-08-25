import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalAuthenticationResult } from 'expo-local-authentication';
import { createAppLockAuthService, type AppLockAuthProvider } from './auth';
import { createAppLockController } from './controller';
import { createAppLockPreferenceStore } from './preferences';

function fixture(initial: { enabled: boolean; grace: 'immediate' | 'oneMinute' | 'fiveMinutes' }) {
  const values = new Map<string, string>([['app.app-lock.policy', JSON.stringify(initial)]]);
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

test('system-auth inactive transition does not invalidate the pending auth context', async () => {
  const fixtureState = fixture({ enabled: true, grace: 'immediate' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));

  fixtureState.controller.onBackground('inactive');
  await fixtureState.controller.onForeground();
  assert.equal(fixtureState.authCalls, 1);

  fixtureState.resolveAuth({ success: true });
  await bootstrap;
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
  assert.equal(fixtureState.clearCount, 1);
});

test('system-auth success waits for the matching active callback before clearing', async () => {
  const fixtureState = fixture({ enabled: true, grace: 'immediate' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));

  fixtureState.controller.onBackground('inactive');
  fixtureState.resolveAuth({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.clearCount, 0);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'authenticating');

  await fixtureState.controller.onForeground();
  await bootstrap;
  assert.equal(fixtureState.authCalls, 1);
  assert.equal(fixtureState.clearCount, 1);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
});

test('true background after auth success never auto-clears and requires a fresh foreground auth', async () => {
  const fixtureState = fixture({ enabled: true, grace: 'immediate' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));

  fixtureState.controller.onBackground('inactive');
  fixtureState.resolveAuth({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.controller.onBackground('background');
  await bootstrap;

  assert.equal(fixtureState.clearCount, 0);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');

  const foreground = fixtureState.controller.onForeground();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.authCalls, 2);
  fixtureState.resolveAuth({ success: true });
  await foreground;
  assert.equal(fixtureState.clearCount, 1);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
});

test('enabling app lock waits for the auth-sheet active callback before clearing', async () => {
  const fixtureState = settingsAuthSheetFixture({ enabled: false, grace: 'immediate' });
  await unlockSettingsFixture(fixtureState);

  const operation = fixtureState.controller.setEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.controller.onBackground('inactive');
  fixtureState.resolveAuth({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.clearCount, 1);

  await fixtureState.controller.onForeground();
  assert.deepEqual(await operation, { ok: true });
  assert.equal(fixtureState.clearCount, 2);
  assert.deepEqual(fixtureState.persisted, { enabled: true, grace: 'immediate' });
});

test('disabling app lock waits for the auth-sheet active callback before clearing', async () => {
  const fixtureState = settingsAuthSheetFixture({ enabled: true, grace: 'immediate' });
  const bootstrap = fixtureState.controller.bootstrap();
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.controller.onBackground('inactive');
  fixtureState.resolveAuth({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  await fixtureState.controller.onForeground();
  await bootstrap;

  const operation = fixtureState.controller.setEnabled(false);
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.controller.onBackground('inactive');
  fixtureState.resolveAuth({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.clearCount, 1);

  await fixtureState.controller.onForeground();
  assert.deepEqual(await operation, { ok: true });
  assert.equal(fixtureState.clearCount, 2);
  assert.deepEqual(fixtureState.persisted, { enabled: false, grace: 'immediate' });
});

test('true background during Settings authentication invalidates the stale clear and write', async () => {
  const fixtureState = settingsAuthSheetFixture({ enabled: false, grace: 'immediate' });
  await unlockSettingsFixture(fixtureState);

  const operation = fixtureState.controller.setEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  fixtureState.controller.onBackground('background');
  fixtureState.resolveAuth({ success: true });

  assert.deepEqual(await operation, { ok: false });
  assert.equal(fixtureState.clearCount, 1);
  assert.deepEqual(fixtureState.persisted, { enabled: false, grace: 'immediate' });
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
        return key === 'app.app-lock.policy'
          ? JSON.stringify({ enabled: false, grace: 'immediate' })
          : null;
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

test('background during a deferred clear keeps the gate locked and retries after foreground', async () => {
  let active = true;
  let clearCount = 0;
  const clearStarted = deferred<void>();
  const releaseClear = deferred<void>();
  const controller = createAppLockController({
    preferences: createAppLockPreferenceStore({
      async getLocalPreference() {
        return JSON.stringify({ enabled: false, grace: 'immediate' });
      },
      async setLocalPreference() {},
    }),
    authentication: createAppLockAuthService(providerForSuccess()),
    shield: {
      async clear() {
        clearStarted.resolve();
        await releaseClear.promise;
        if (active) clearCount += 1;
      },
      async isInstalled() {
        return true;
      },
    },
  });

  const bootstrap = controller.bootstrap();
  await clearStarted.promise;
  active = false;
  controller.onBackground();
  releaseClear.resolve();
  await bootstrap;

  assert.equal(clearCount, 0);
  assert.equal(controller.getSnapshot().phase, 'locked');

  active = true;
  await controller.onForeground();
  assert.equal(clearCount, 1);
  assert.equal(controller.getSnapshot().phase, 'unlocked');
});

test('preference read failure is a neutral retry state and disabling requires auth', async () => {
  const values = new Map<string, string>([['app.app-lock.policy', 'malformed']]);
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function settingsFixture(initial: {
  enabled: boolean;
  grace: 'immediate' | 'oneMinute' | 'fiveMinutes';
}) {
  let persisted = initial;
  let clearCount = 0;
  let authCalls = 0;
  let blockedWrite: ReturnType<typeof deferred<void>> | null = null;
  let writeStarted: ReturnType<typeof deferred<void>> | null = null;
  const controller = createAppLockController({
    preferences: createAppLockPreferenceStore({
      async getLocalPreference() {
        return JSON.stringify(persisted);
      },
      async setLocalPreference(_key, value) {
        if (blockedWrite !== null && writeStarted !== null) {
          const gate = blockedWrite;
          const started = writeStarted;
          blockedWrite = null;
          writeStarted = null;
          started.resolve();
          await gate.promise;
        }
        persisted = JSON.parse(value) as typeof persisted;
      },
    }),
    authentication: createAppLockAuthService({
      authenticateAsync: async () => {
        authCalls += 1;
        return { success: true };
      },
    }),
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
    get authCalls() {
      return authCalls;
    },
    get clearCount() {
      return clearCount;
    },
    get persisted() {
      return persisted;
    },
    blockNextWrite() {
      const gate = deferred<void>();
      const started = deferred<void>();
      blockedWrite = gate;
      writeStarted = started;
      return { started: started.promise, release: () => gate.resolve() };
    },
  };
}

function settingsAuthSheetFixture(initial: {
  enabled: boolean;
  grace: 'immediate' | 'oneMinute' | 'fiveMinutes';
}) {
  let persisted = initial;
  let resolveAuth!: (value: LocalAuthenticationResult) => void;
  let clearCount = 0;
  let authCalls = 0;
  const controller = createAppLockController({
    preferences: createAppLockPreferenceStore({
      async getLocalPreference() {
        return JSON.stringify(persisted);
      },
      async setLocalPreference(_key, value) {
        persisted = JSON.parse(value) as typeof persisted;
      },
    }),
    authentication: createAppLockAuthService({
      authenticateAsync: async () => {
        authCalls += 1;
        return new Promise((resolve) => {
          resolveAuth = resolve;
        });
      },
    }),
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
    resolveAuth: (value: LocalAuthenticationResult) => resolveAuth(value),
    get authCalls() {
      return authCalls;
    },
    get clearCount() {
      return clearCount;
    },
    get persisted() {
      return persisted;
    },
  };
}

async function unlockSettingsFixture(fixtureState: {
  readonly controller: ReturnType<typeof createAppLockController>;
}) {
  const bootstrap = fixtureState.controller.bootstrap();
  await bootstrap;
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
}

test('background during enable persistence keeps the stale completion locked and reconciles durable state', async () => {
  const fixtureState = settingsFixture({ enabled: false, grace: 'immediate' });
  await unlockSettingsFixture(fixtureState);
  const write = fixtureState.blockNextWrite();
  const operation = fixtureState.controller.setEnabled(true);
  await write.started;

  fixtureState.controller.onBackground();
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');
  const foreground = fixtureState.controller.onForeground();
  let foregroundFinished = false;
  void foreground.then(() => {
    foregroundFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(foregroundFinished, false);
  assert.equal(fixtureState.clearCount, 1);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');

  write.release();
  assert.deepEqual(await operation, { ok: false });
  await foreground;
  assert.deepEqual(fixtureState.persisted, { enabled: true, grace: 'immediate' });
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
  assert.equal(fixtureState.clearCount, 2);
});

test('background during disable persistence never clears the shield until durable reconciliation', async () => {
  const fixtureState = settingsFixture({ enabled: true, grace: 'immediate' });
  await unlockSettingsFixture(fixtureState);
  const write = fixtureState.blockNextWrite();
  const operation = fixtureState.controller.setEnabled(false);
  await write.started;

  fixtureState.controller.onBackground();
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');
  const foreground = fixtureState.controller.onForeground();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.clearCount, 1);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');

  write.release();
  assert.deepEqual(await operation, { ok: false });
  await foreground;
  assert.deepEqual(fixtureState.persisted, { enabled: false, grace: 'immediate' });
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
  assert.equal(fixtureState.clearCount, 2);
  assert.equal(fixtureState.authCalls, 2);
});

test('background during grace persistence ignores stale completion and applies the durable grace on recovery', async () => {
  const fixtureState = settingsFixture({ enabled: true, grace: 'immediate' });
  await unlockSettingsFixture(fixtureState);
  const write = fixtureState.blockNextWrite();
  const operation = fixtureState.controller.setGrace('fiveMinutes');
  await write.started;

  fixtureState.controller.onBackground();
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');
  const foreground = fixtureState.controller.onForeground();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixtureState.clearCount, 1);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');

  write.release();
  assert.deepEqual(await operation, { ok: false });
  await foreground;
  assert.deepEqual(fixtureState.persisted, { enabled: true, grace: 'fiveMinutes' });
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
  assert.equal(fixtureState.clearCount, 2);
  assert.equal(fixtureState.authCalls, 1);
});

test('a gate unlock cannot bypass pending Settings persistence or expose stale policy', async () => {
  const fixtureState = settingsFixture({ enabled: false, grace: 'immediate' });
  await unlockSettingsFixture(fixtureState);
  const write = fixtureState.blockNextWrite();
  const operation = fixtureState.controller.setEnabled(true);
  await write.started;

  fixtureState.controller.onBackground();
  const unlock = fixtureState.controller.unlock();
  let unlockFinished = false;
  void unlock.then(() => {
    unlockFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unlockFinished, false);
  assert.equal(fixtureState.clearCount, 1);
  assert.equal(fixtureState.controller.getSnapshot().phase, 'locked');

  write.release();
  assert.deepEqual(await operation, { ok: false });
  await unlock;
  assert.deepEqual(fixtureState.persisted, { enabled: true, grace: 'immediate' });
  assert.equal(fixtureState.controller.getSnapshot().phase, 'unlocked');
  assert.equal(fixtureState.clearCount, 2);
  assert.equal(fixtureState.authCalls, 2);
});
