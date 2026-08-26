import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attemptProtectedStartup, createStartupRecoveryHandoff } from './protected-startup';

test('synchronous startup failure stays on recovery until the mounted gate clears and retry succeeds', async () => {
  let constructionAttempts = 0;
  let appExposures = 0;
  let shouldFail = true;
  const construct = () => {
    constructionAttempts += 1;
    if (shouldFail) throw new Error('injected service construction failure');
    appExposures += 1;
    return { privateAppMounted: true };
  };

  const failed = attemptProtectedStartup(construct);
  assert.equal(failed.kind, 'recovery');
  assert.equal(appExposures, 0);

  const events: string[] = [];
  const handoff = createStartupRecoveryHandoff({
    markReactGateMounted() {
      events.push('recovery-mounted');
    },
    async clear() {
      events.push('shield-cleared');
    },
    async isInstalled() {
      return true;
    },
  });

  assert.equal(await handoff.clearWhenActive('active'), false);
  handoff.markMounted();
  assert.equal(await handoff.clearWhenActive('background'), false);
  assert.equal(await handoff.clearWhenActive('active'), true);
  assert.deepEqual(events, ['recovery-mounted', 'shield-cleared']);
  assert.equal(appExposures, 0);

  shouldFail = false;
  const retried = attemptProtectedStartup(construct);
  assert.deepEqual(retried, { kind: 'ready', value: { privateAppMounted: true } });
  assert.equal(constructionAttempts, 2);
  assert.equal(appExposures, 1);
});
