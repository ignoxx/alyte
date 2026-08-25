import { t } from '../../localization';
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

type AppLockOperationResult = { readonly ok: boolean };

export type AppLockController = {
  readonly getSnapshot: () => AppLockState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly bootstrap: () => Promise<void>;
  readonly onBackground: (reason?: 'inactive' | 'background') => void;
  readonly onForeground: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly unlock: () => Promise<void>;
  readonly setEnabled: (enabled: boolean) => Promise<AppLockOperationResult>;
  readonly setGrace: (grace: AppLockPreferences['grace']) => Promise<AppLockOperationResult>;
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
  let authenticationPromise: Promise<AppLockAuthOutcome> | null = null;
  let authenticationToken: number | null = null;
  let authenticationPromptInactive = false;
  let authenticationPromptActivePromise: Promise<void> | null = null;
  let resolveAuthenticationPromptActive: (() => void) | null = null;
  let settingsOperationPromise: Promise<AppLockOperationResult> | null = null;
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

  function beginAuthenticationPromptLifecycle(): void {
    if (authenticationPromptActivePromise !== null) return;
    authenticationPromptActivePromise = new Promise<void>((resolve) => {
      resolveAuthenticationPromptActive = resolve;
    });
  }

  function markAuthenticationPromptActive(): void {
    authenticationPromptInactive = false;
    const resolve = resolveAuthenticationPromptActive;
    resolveAuthenticationPromptActive = null;
    authenticationPromptActivePromise = null;
    resolve?.();
  }

  /**
   * All auth callers use this path so stale lifecycle generations cannot publish a result. A
   * pending system context is allowed to settle, then the current operation receives a fresh
   * context from the auth service.
   */
  async function authenticateFor(
    token: number,
    promptMessage: string,
  ): Promise<AppLockAuthOutcome | null> {
    if (authenticationPromise !== null) {
      const staleAttempt = authenticationPromise;
      try {
        await staleAttempt;
      } catch {
        // Providers are mapped to an auth outcome; injected providers may still throw.
      }
      if (token !== generation) return null;
    }

    transition({ type: 'authentication-started' });
    let attempt: Promise<AppLockAuthOutcome>;
    try {
      attempt = options.authentication.authenticate(promptMessage);
    } catch {
      const outcome = { kind: 'failed' } as const;
      transition({ type: 'authentication-finished', outcome });
      return outcome;
    }

    authenticationPromise = attempt;
    authenticationToken = token;
    let outcome: AppLockAuthOutcome;
    try {
      outcome = await attempt;
    } catch {
      outcome = { kind: 'failed' };
    } finally {
      if (authenticationPromise === attempt) authenticationPromise = null;
      if (authenticationToken === token) authenticationToken = null;
    }
    if (token !== generation) return null;
    if (outcome.kind !== 'success') markAuthenticationPromptActive();
    if (outcome.kind !== 'success') transition({ type: 'authentication-finished', outcome });
    return outcome;
  }

  async function releaseAfterAuthentication(
    token: number,
    outcome: AppLockAuthOutcome,
  ): Promise<boolean> {
    if (outcome.kind !== 'success' || token !== generation) return false;
    if (!(await waitForAuthenticationActive(token))) return false;
    try {
      // The native shield is cleared before the unlocked phase is published.
      await clearShieldOrThrow();
    } catch {
      return false;
    }
    if (token !== generation) return false;
    transition({ type: 'authentication-finished', outcome });
    return true;
  }

  async function waitForAuthenticationActive(token: number): Promise<boolean> {
    // LocalAuthentication can finish while UIKit is still transitioning its system sheet back
    // to Alyte. Wait for the matching active callback before any caller clears the shield; a true
    // background transition increments the generation and invalidates the stale operation.
    const activeTransition = authenticationPromptActivePromise;
    if (activeTransition !== null) await activeTransition;
    return token === generation;
  }

  async function persistPolicy(token: number, preferences: AppLockPreferences): Promise<boolean> {
    try {
      await options.preferences.write(preferences);
    } catch {
      if (token === generation) transition({ type: 'preference-write-failed' });
      return false;
    }
    return token === generation;
  }

  async function readForForeground(token: number): Promise<AppLockPreferences | null> {
    let preferences: AppLockPreferences;
    try {
      preferences = await options.preferences.read();
    } catch {
      if (token === generation) transition({ type: 'preference-read-failed' });
      return null;
    }
    if (token !== generation) return null;

    // Keep the background timestamp while replacing in-memory policy with the durable value.
    // This is what reconciles a write that completed after a lifecycle transition.
    if (
      state.preferences?.enabled !== preferences.enabled ||
      state.preferences?.grace !== preferences.grace
    ) {
      state = { ...state, preferences };
      notify();
    }
    return preferences;
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
      const outcome = await authenticateFor(token, t('settings.appLock.promptUnlock'));
      if (outcome !== null) await releaseAfterAuthentication(token, outcome);
    })();
    bootstrapPromise = work;
    try {
      await work;
    } finally {
      if (bootstrapPromise === work) bootstrapPromise = null;
    }
  }

  function onBackground(reason: 'inactive' | 'background' = 'background'): void {
    // LocalAuthentication presents a system sheet that temporarily makes the app inactive. The
    // native subscriber still installs the snapshot shield, but that sheet must not invalidate
    // the auth context or cause the active callback to start a second prompt.
    if (reason === 'inactive' && authenticationPromise !== null) {
      authenticationPromptInactive = true;
      beginAuthenticationPromptLifecycle();
      return;
    }
    generation += 1;
    if (reason === 'background') markAuthenticationPromptActive();
    transition({ type: 'backgrounded', at: now() });
  }

  async function onForeground(): Promise<void> {
    if (foregroundPromise !== null) return foregroundPromise;
    if (authenticationPromptInactive) {
      // This active callback belongs to the LocalAuthentication sheet, not a new unlock
      // attempt. Resolving the lifecycle waiter lets the original successful attempt clear the
      // shield exactly once without starting a duplicate system prompt.
      markAuthenticationPromptActive();
      return;
    }
    if (authenticationPromise !== null && authenticationToken === generation) return;
    // Active notifications can repeat without a background transition. They must not invalidate
    // a Settings write or prompt a second time.
    if (state.phase === 'unlocked' && state.backgroundedAt === null) return;
    if (state.phase === 'retry' || state.phase === 'loading') return;

    const token = ++generation;
    const work = (async () => {
      // A stale Settings operation may have already changed durable policy after background. Wait
      // for its single-value write to settle before reading policy or deciding whether auth is
      // required; otherwise persisted enabled=true could be exposed under old in-memory state.
      const pendingSettings = settingsOperationPromise;
      if (pendingSettings !== null) {
        try {
          await pendingSettings;
        } catch {
          // The operation reports failure to its caller; foreground still re-reads the policy.
        }
      }
      if (token !== generation) return;

      const preferences = await readForForeground(token);
      if (preferences === null || token !== generation) return;
      const at = now();
      const foregrounded = reduceAppLockState(
        { ...state, preferences },
        { type: 'foregrounded', at },
      );
      if (foregrounded.phase === 'unlocked') {
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
      const outcome = await authenticateFor(token, t('settings.appLock.promptUnlock'));
      if (outcome !== null) await releaseAfterAuthentication(token, outcome);
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
    // A gate tap cannot bypass a pending lifecycle recovery. Foreground reconciliation waits for
    // any stale Settings write, re-reads the atomic policy, and only then authenticates/clears.
    if (settingsOperationPromise !== null || state.backgroundedAt !== null) {
      await onForeground();
      return;
    }
    if (state.preferences === null || !state.preferences.enabled) {
      await bootstrap();
      return;
    }
    if (authenticationPromise !== null) {
      await authenticationPromise;
      return;
    }
    const token = ++generation;
    const outcome = await authenticateFor(token, t('settings.appLock.promptUnlock'));
    if (outcome !== null) await releaseAfterAuthentication(token, outcome);
  }

  function enqueueSettingsOperation(
    operation: () => Promise<AppLockOperationResult>,
  ): Promise<AppLockOperationResult> {
    const previous = settingsOperationPromise;
    const work = (previous === null ? Promise.resolve() : previous.catch(() => undefined)).then(
      operation,
    );
    settingsOperationPromise = work;
    void work.then(
      () => {
        if (settingsOperationPromise === work) settingsOperationPromise = null;
      },
      () => {
        if (settingsOperationPromise === work) settingsOperationPromise = null;
      },
    );
    return work;
  }

  async function setEnabledOperation(enabled: boolean): Promise<AppLockOperationResult> {
    const current = state.preferences;
    if (current === null || state.phase !== 'unlocked') return { ok: false };

    const token = ++generation;
    const outcome = await authenticateFor(
      token,
      enabled ? t('settings.appLock.promptEnable') : t('settings.appLock.promptDisable'),
    );
    if (outcome === null || outcome.kind !== 'success' || token !== generation) {
      return { ok: false };
    }

    const next = { ...current, enabled };
    if (!(await waitForAuthenticationActive(token))) return { ok: false };
    if (!(await persistPolicy(token, next))) return { ok: false };
    try {
      await clearShieldOrThrow();
    } catch {
      return { ok: false };
    }
    if (token !== generation) return { ok: false };
    transition({ type: 'preferences-updated', preferences: next });
    return { ok: true };
  }

  function setEnabled(enabled: boolean): Promise<AppLockOperationResult> {
    return enqueueSettingsOperation(() => setEnabledOperation(enabled));
  }

  async function setGraceOperation(
    grace: AppLockPreferences['grace'],
  ): Promise<AppLockOperationResult> {
    const current = state.preferences;
    if (current === null || state.phase !== 'unlocked') return { ok: false };
    const token = ++generation;
    const next = { ...current, grace };
    if (!(await persistPolicy(token, next))) return { ok: false };
    if (token !== generation) return { ok: false };
    transition({ type: 'preferences-updated', preferences: next });
    return { ok: true };
  }

  function setGrace(grace: AppLockPreferences['grace']): Promise<AppLockOperationResult> {
    return enqueueSettingsOperation(() => setGraceOperation(grace));
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
