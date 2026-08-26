import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLabsService } from './service';
import type { LabRepository } from './persistence';

test('retries a failed lab repository open on the next local read', async () => {
  let attempts = 0;
  const repository = {
    listPendingCombinedDeletions: async () => [],
    getRecord: async () => null,
  } as unknown as LabRepository;
  const labs = createLabsService({
    repositoryFactory: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary lab database open failure');
      return repository;
    },
  });

  await assert.rejects(labs.getRecord('record-1'), /temporary lab database open failure/);
  assert.equal(await labs.getRecord('record-1'), null);
  assert.equal(attempts, 2);
});
