import {
  initialAppLockState,
  reduceAppLockState,
  type AppLockAuthOutcome,
  type AppLockPreferences,
  type AppLockState,
} from './policy';
import type { AppLockAuthService } from './auth';
import type { AppLockPreferenceStore } from './preferences';
import type { SnapshotShieldBridge } from './shield';

export type AppLockController = {
  readonly getSnapshot: () => AppLockState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly bootstrap: () => Promise<void>;
  readonly onBackground: () => void;
  readonly onForeground: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly unlock: () => Promise<void>;
  readonly setEnabled: (enabled: boolean) => Promise<{ readonly ok: boolean }>;
  readonly setGrace: (grace: AppLockPreferences['grace']) => Promise<{ readonly ok: boolean }>;
};

export type AppLockControllerOptions = {
  readonly preferences: AppLockPreferenceStore;
  readonly authentication: AppLockAuthService;
  readonly shield: SnapshotShieldBridge;
  /** A monotonic clock. `performance.now()` is used in production. */
  readonly now?: () => number;
};

function defaultMonotonicNow(): number {
  return typeof globalThis.performance?.now === 'function'
    ? globalThis.performance.now()
    : Date.now();
}

export function createAppLockController(options: AppLockControllerOptions): AppLockController {
  const now = options.now ?? defaultMonotonicNow;
  let state = initialAppLockState;
  let generation = 0;
  let bootstrapPromise: Promise<void> | null = null;
  let foregroundPromise: Promise<void> | null = null;
  let authPromise: Promise<AppLockAuthOutcome> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function transition(event: Parameters<typeof reduceAppLockState>[1]): void {
    state = reduceAppLockState(state, event);
    notify();
  }

  async function clearShieldOrThrow(): Promise<void> {
    try {
      await options.shield.clear();
    } catch {
      transition({ type: 'shield-unavailable' });
      throw new Error('The native privacy shield is unavailable');
    }
  }

  async function runAuthentication(token: number, promptMessage: string): Promise<void> {
    // A lifecycle event can invalidate a prompt while LocalAuthentication is still presenting it.
    // Wait for that stale context to settle, then request a fresh context for the current gate.
    if (authPromise !== null) {
      const staleAttempt = authPromise;
      try {
        await staleAttempt;
      } catch {
        // The service maps provider failures to a locked outcome; injected providers may throw.
      }
      if (token !== generation) return;
    }
    transition({ type: 'authentication-started' });
    let attempt: Promise<AppLockAuthOutcome>;
    try {
      attempt = options.authentication.authenticate(promptMessage);
    } catch {
      transition({ type: 'authentication-finished', outcome: { kind: 'failed' } });
      return;
    }
    authPromise = attempt;
    let outcome: AppLockAuthOutcome;
    try {
      outcome = await attempt;
    } finally {
      if (authPromise === attempt) authPromise = null;
    }
    if (token !== generation) return;
    if (outcome.kind !== 'success') {
      transition({ type: 'authentication-finished', outcome });
      return;
    }
    try {
      // Clear first, then publish unlocked, so health content cannot appear while the native
      // shield is still in place or if clearing it fails.
      await clearShieldOrThrow();
    } catch {
      return;
    }
    if (token !== generation) return;
    transition({ type: 'authentication-finished', outcome });
  }

  async function bootstrap(): Promise<void> {
    if (bootstrapPromise !== null) return bootstrapPromise;
    const token = ++generation;
    state = { ...initialAppLockState, phase: 'loading' };
    notify();
    const work = (async () => {
      let preferences: AppLockPreferences;
      try {
        preferences = await options.preferences.read();
      } catch {
        if (token === generation) transition({ type: 'preference-read-failed' });
        return;
      }
      if (token !== generation) return;
      const resolved = reduceAppLockState(state, { type: 'bootstrap-resolved', preferences });
      if (!preferences.enabled) {
        // Keep the gate opaque until the native shield is gone. The reducer's unlocked result is
        // useful policy state, but must not be published before this platform side effect.
        state = { ...resolved, phase: 'loading' };
        notify();
        try {
          await clearShieldOrThrow();
        } catch {
          return;
        }
        if (token !== generation) return;
        transition({ type: 'preferences-updated', preferences });
        return;
      }
      transition({ type: 'bootstrap-resolved', preferences });
      await runAuthentication(token, 'Unlock Alyte');
    })();
    bootstrapPromise = work;
    try {
      await work;
    } finally {
      if (bootstrapPromise === work) bootstrapPromise = null;
    }
  }

  function onBackground(): void {
    generation += 1;
    transition({ type: 'backgrounded', at: now() });
  }

  async function onForeground(): Promise<void> {
    if (foregroundPromise !== null) return foregroundPromise;
    const token = ++generation;
    const work = (async () => {
      if (state.preferences === null) {
        // If background interrupted preference bootstrap, let the stale read settle and start a
        // fresh read while the native shield remains in place.
        const pendingBootstrap = bootstrapPromise;
        if (pendingBootstrap !== null) await pendingBootstrap;
        if (state.preferences === null && state.phase !== 'retry') await bootstrap();
        return;
      }
      if (state.phase === 'retry' || state.phase === 'loading') return;
      if (state.phase === 'unlocked' && state.backgroundedAt === null) return;
      const shouldAuthenticate = state.preferences.enabled;
      const at = now();
      const foregrounded = reduceAppLockState(state, { type: 'foregrounded', at });
      if (foregrounded.phase === 'unlocked') {
        // Do not expose the mounted navigator until the native shield has been cleared. This is
        // also the path for disabled lock and in-memory grace periods.
        state = { ...foregrounded, phase: 'loading' };
        notify();
        try {
          await clearShieldOrThrow();
        } catch {
          return;
        }
        if (token !== generation || foregrounded.preferences === null) return;
        transition({ type: 'preferences-updated', preferences: foregrounded.preferences });
        return;
      }
      transition({ type: 'foregrounded', at });
      if (shouldAuthenticate) await runAuthentication(token, 'Unlock Alyte');
    })();
    foregroundPromise = work;
    try {
      await work;
    } finally {
      if (foregroundPromise === work) foregroundPromise = null;
    }
  }

  async function retry(): Promise<void> {
    if (state.reason === 'preference-read-failed' || state.reason === 'shield-unavailable') {
      await bootstrap();
      return;
    }
    await unlock();
  }

  async function unlock(): Promise<void> {
    if (state.preferences === null || !state.preferences.enabled) {
      await bootstrap();
      return;
    }
    if (authPromise !== null) {
      await authPromise;
      return;
    }
    const token = ++generation;
    await runAuthentication(token, 'Unlock Alyte');
  }

  async function setEnabled(enabled: boolean): Promise<{ readonly ok: boolean }> {
    const current = state.preferences;
    if (current === null || state.phase !== 'unlocked') return { ok: false };
    if (authPromise !== null) {
      await authPromise;
      return { ok: false };
    }
    const token = ++generation;
    transition({ type: 'authentication-started' });
    let attempt: Promise<AppLockAuthOutcome>;
    try {
      attempt = options.authentication.authenticate(
        enabled ? 'Turn on Alyte app lock' : 'Turn off Alyte app lock',
      );
    } catch {
      transition({ type: 'authentication-finished', outcome: { kind: 'failed' } });
      return { ok: false };
    }
    authPromise = attempt;
    let outcome: AppLockAuthOutcome;
    try {
      outcome = await attempt;
    } catch {
      outcome = { kind: 'failed' };
    } finally {
      if (authPromise === attempt) authPromise = null;
    }
    if (token !== generation || outcome.kind !== 'success') {
      if (token === generation) transition({ type: 'authentication-finished', outcome });
      return { ok: false };
    }
    const next = { ...current, enabled };
    try {
      await options.preferences.write(next);
    } catch {
      if (token === generation) transition({ type: 'preference-write-failed' });
      return { ok: false };
    }
    try {
      await clearShieldOrThrow();
    } catch {
      return { ok: false };
    }
    if (token !== generation) return { ok: false };
    transition({ type: 'preferences-updated', preferences: next });
    return { ok: true };
  }

  async function setGrace(grace: AppLockPreferences['grace']): Promise<{ readonly ok: boolean }> {
    const current = state.preferences;
    if (current === null || state.phase !== 'unlocked') return { ok: false };
    const next = { ...current, grace };
    try {
      await options.preferences.write(next);
    } catch {
      transition({ type: 'preference-write-failed' });
      return { ok: false };
    }
    transition({ type: 'preferences-updated', preferences: next });
    return { ok: true };
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bootstrap,
    onBackground,
    onForeground,
    retry,
    unlock,
    setEnabled,
    setGrace,
  };
}
