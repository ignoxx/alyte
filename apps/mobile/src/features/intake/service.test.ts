import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIntakeService } from './service';
import type { IntakeRepository } from './persistence';

test('retries a failed repository open for local preference reads', async () => {
  let attempts = 0;
  const repository = {
    getLocalPreference: async () => null,
    listEvents: async () => [],
    listSnapRecoveries: async () => [],
    listCloudJobs: async () => [],
  } as unknown as IntakeRepository;
  const intake = createIntakeService({
    repositoryFactory: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary database open failure');
      return repository;
    },
  });

  await assert.rejects(
    intake.getLocalPreference('app.app-lock.policy'),
    /temporary database open failure/,
  );
  assert.equal(await intake.getLocalPreference('app.app-lock.policy'), null);
  assert.equal(attempts, 2);
});
