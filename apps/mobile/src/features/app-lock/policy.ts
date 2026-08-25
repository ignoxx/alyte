export const APP_LOCK_GRACES = ['immediate', 'oneMinute', 'fiveMinutes'] as const;
export type AppLockGrace = (typeof APP_LOCK_GRACES)[number];

export type AppLockPreferences = {
  readonly enabled: boolean;
  readonly grace: AppLockGrace;
};

export type AppLockPhase = 'loading' | 'locked' | 'authenticating' | 'unlocked' | 'retry';

export type AppLockFailureReason =
  | 'cold-start'
  | 'backgrounded'
  | 'authentication-failed'
  | 'cancelled'
  | 'lockout'
  | 'unavailable'
  | 'enrollment-changed'
  | 'preference-read-failed'
  | 'preference-write-failed'
  | 'shield-unavailable';

export type AppLockState = {
  readonly phase: AppLockPhase;
  readonly preferences: AppLockPreferences | null;
  readonly backgroundedAt: number | null;
  readonly reason: AppLockFailureReason | null;
};

export const initialAppLockState: AppLockState = {
  phase: 'loading',
  preferences: null,
  backgroundedAt: null,
  reason: null,
};

export type AppLockAuthOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'lockout' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'enrollment-changed' };

export type AppLockEvent =
  | { readonly type: 'bootstrap-resolved'; readonly preferences: AppLockPreferences }
  | { readonly type: 'preference-read-failed' }
  | { readonly type: 'backgrounded'; readonly at: number }
  | { readonly type: 'foregrounded'; readonly at: number }
  | { readonly type: 'authentication-started' }
  | { readonly type: 'authentication-finished'; readonly outcome: AppLockAuthOutcome }
  | { readonly type: 'preferences-updated'; readonly preferences: AppLockPreferences }
  | { readonly type: 'preference-write-failed' }
  | { readonly type: 'shield-unavailable' };

export function graceDurationMs(grace: AppLockGrace): number {
  switch (grace) {
    case 'immediate':
      return 0;
    case 'oneMinute':
      return 60_000;
    case 'fiveMinutes':
      return 300_000;
  }
}

/**
 * Grace is intentionally strict and monotonic-clock based: at the deadline itself we ask again.
 * The clock is supplied by the controller so wall-clock changes cannot extend access.
 */
export function canUseGracePeriod(
  preferences: AppLockPreferences,
  backgroundedAt: number | null,
  now: number,
): boolean {
  if (!preferences.enabled || backgroundedAt === null) return false;
  const elapsed = now - backgroundedAt;
  return elapsed >= 0 && elapsed < graceDurationMs(preferences.grace);
}

function locked(
  state: AppLockState,
  reason: AppLockFailureReason,
  backgroundedAt = state.backgroundedAt,
): AppLockState {
  return { ...state, phase: 'locked', reason, backgroundedAt };
}

function authFailureReason(
  outcome: Exclude<AppLockAuthOutcome, { kind: 'success' }>,
): AppLockFailureReason {
  switch (outcome.kind) {
    case 'cancelled':
      return 'cancelled';
    case 'lockout':
      return 'lockout';
    case 'unavailable':
      return 'unavailable';
    case 'enrollment-changed':
      return 'enrollment-changed';
    case 'failed':
      return 'authentication-failed';
  }
}

export function reduceAppLockState(state: AppLockState, event: AppLockEvent): AppLockState {
  switch (event.type) {
    case 'bootstrap-resolved':
      return event.preferences.enabled
        ? locked(
            { ...state, preferences: event.preferences, backgroundedAt: null },
            'cold-start',
            null,
          )
        : {
            phase: 'unlocked',
            preferences: event.preferences,
            backgroundedAt: null,
            reason: null,
          };
    case 'preference-read-failed':
      return { ...state, phase: 'retry', preferences: null, reason: 'preference-read-failed' };
    case 'backgrounded':
      return locked(state, 'backgrounded', event.at);
    case 'foregrounded': {
      if (state.preferences === null) return state;
      if (!state.preferences.enabled) {
        return { ...state, phase: 'unlocked', backgroundedAt: null, reason: null };
      }
      if (canUseGracePeriod(state.preferences, state.backgroundedAt, event.at)) {
        return { ...state, phase: 'unlocked', backgroundedAt: null, reason: null };
      }
      return { ...state, phase: 'authenticating', reason: null };
    }
    case 'authentication-started':
      return { ...state, phase: 'authenticating', reason: null };
    case 'authentication-finished':
      return event.outcome.kind === 'success'
        ? { ...state, phase: 'unlocked', backgroundedAt: null, reason: null }
        : locked(state, authFailureReason(event.outcome));
    case 'preferences-updated':
      return {
        ...state,
        phase: 'unlocked',
        preferences: event.preferences,
        backgroundedAt: null,
        reason: null,
      };
    case 'preference-write-failed':
      return { ...state, phase: 'unlocked', reason: 'preference-write-failed' };
    case 'shield-unavailable':
      return { ...state, phase: 'retry', reason: 'shield-unavailable' };
  }
}
