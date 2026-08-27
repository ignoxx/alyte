import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ONBOARDING_COMPLETED_PREFERENCE, persistOnboardingCompletion } from './preferences';

test('onboarding completion resolves only after the durable preference write succeeds', async () => {
  const writes: Array<readonly [string, string]> = [];
  await persistOnboardingCompletion({
    setLocalPreference: async (key, value) => {
      writes.push([key, value]);
    },
  });
  assert.deepEqual(writes, [[ONBOARDING_COMPLETED_PREFERENCE, 'true']]);

  await assert.rejects(
    persistOnboardingCompletion({
      setLocalPreference: async () => {
        throw new Error('write unavailable');
      },
    }),
    /write unavailable/,
  );
});
