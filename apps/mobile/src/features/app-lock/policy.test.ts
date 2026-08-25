import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canUseGracePeriod,
  initialAppLockState,
  reduceAppLockState,
  type AppLockPreferences,
} from './policy';

const enabled: AppLockPreferences = { enabled: true, grace: 'oneMinute' };

test('cold start with lock enabled stays behind authentication', () => {
  const state = reduceAppLockState(initialAppLockState, {
    type: 'bootstrap-resolved',
    preferences: enabled,
  });
  assert.equal(state.phase, 'locked');
  assert.equal(state.reason, 'cold-start');
});

test('disabled lock opens after bootstrap without an auth state', () => {
  const state = reduceAppLockState(initialAppLockState, {
    type: 'bootstrap-resolved',
    preferences: { enabled: false, grace: 'immediate' },
  });
  assert.equal(state.phase, 'unlocked');
});

test('background records a monotonic deadline and foreground uses only strict grace', () => {
  const unlocked = reduceAppLockState(initialAppLockState, {
    type: 'bootstrap-resolved',
    preferences: enabled,
  });
  const backgrounded = reduceAppLockState(unlocked, { type: 'backgrounded', at: 10_000 });
  assert.equal(backgrounded.phase, 'locked');
  assert.equal(backgrounded.backgroundedAt, 10_000);
  assert.equal(canUseGracePeriod(enabled, 10_000, 10_999), true);
  assert.equal(canUseGracePeriod(enabled, 10_000, 70_000), false);
  const resumed = reduceAppLockState(backgrounded, { type: 'foregrounded', at: 10_999 });
  assert.equal(resumed.phase, 'unlocked');
  const expired = reduceAppLockState(backgrounded, { type: 'foregrounded', at: 70_000 });
  assert.equal(expired.phase, 'authenticating');
});

test('immediate grace always authenticates and every failed outcome stays retryable', () => {
  const state = reduceAppLockState(initialAppLockState, {
    type: 'bootstrap-resolved',
    preferences: { enabled: true, grace: 'immediate' },
  });
  const backgrounded = reduceAppLockState(state, { type: 'backgrounded', at: 1 });
  const foregrounded = reduceAppLockState(backgrounded, { type: 'foregrounded', at: 1 });
  assert.equal(foregrounded.phase, 'authenticating');
  for (const kind of [
    'cancelled',
    'failed',
    'lockout',
    'unavailable',
    'enrollment-changed',
  ] as const) {
    const failed = reduceAppLockState(foregrounded, {
      type: 'authentication-finished',
      outcome: { kind },
    });
    assert.equal(failed.phase, 'locked');
    assert.notEqual(failed.reason, null);
  }
});

test('authentication success is the only path to a locked-state release', () => {
  const locked = reduceAppLockState(initialAppLockState, {
    type: 'bootstrap-resolved',
    preferences: enabled,
  });
  const authenticated = reduceAppLockState(locked, {
    type: 'authentication-finished',
    outcome: { kind: 'success' },
  });
  assert.equal(authenticated.phase, 'unlocked');
});

test('malformed preference and shield failures remain neutral retry gates', () => {
  assert.equal(
    reduceAppLockState(initialAppLockState, { type: 'preference-read-failed' }).phase,
    'retry',
  );
  assert.equal(
    reduceAppLockState(initialAppLockState, { type: 'shield-unavailable' }).phase,
    'retry',
  );
});
