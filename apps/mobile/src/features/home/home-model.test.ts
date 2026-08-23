import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent } from '@alyte/domain';
import type { IntakeCloudJob } from '../intake/outbox';
import { intakeEventMenuActions } from '../intake/ui';
import { homeHasLocalHistory, sortHomeTimeline } from './home-model';

function event(
  id: string,
  localDate: string,
  occurredAt: string,
  sourceMediaPath: string | null = null,
): IntakeEvent {
  return {
    id,
    eventType: 'food',
    occurredAt,
    localDate,
    origin: 'manual',
    provenance: 'user-entered',
    reviewState: 'confirmed',
    analysisInclusion: 'included',
    notes: null,
    sourceMediaPath,
    sourceMediaHash: null,
    sourceMediaSize: null,
    sourceMediaProtection: null,
    copiedFromEventId: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    components: [],
  };
}

const queuedJob = {
  id: 'job-1',
  eventId: 'with-image',
  operation: 'intake-image',
  mediaPath: '/protected/image',
  state: 'queued',
  consentPolicyVersion: 'fixture',
  failureCategory: null,
  createdAt: '2026-08-22T09:00:00.000Z',
  updatedAt: '2026-08-22T09:00:00.000Z',
  submittedAt: null,
  cancelledAt: null,
} satisfies IntakeCloudJob;

test('Home keeps the requested day timeline newest first', () => {
  const records = [
    event('older', '2026-08-22', '2026-08-22T08:00:00.000Z'),
    event('newer', '2026-08-22', '2026-08-22T09:00:00.000Z'),
    event('latest', '2026-08-22', '2026-08-22T11:00:00.000Z'),
  ];

  assert.deepEqual(
    sortHomeTimeline(records).map((record) => record.id),
    ['latest', 'newer', 'older'],
  );
});

test('Home only calls the first-use state empty when both local histories are empty', () => {
  assert.equal(homeHasLocalHistory([], 0), false);
  assert.equal(
    homeHasLocalHistory([event('prior', '2026-08-21', '2026-08-21T09:00:00.000Z')], 0),
    true,
  );
  assert.equal(homeHasLocalHistory([], 1), true);
});

test('Home menu keeps destructive and uncommon actions out of the row', () => {
  const record = event('with-image', '2026-08-22', '2026-08-22T09:00:00.000Z', '/protected/image');

  assert.deepEqual(intakeEventMenuActions(record, queuedJob), [
    'edit',
    'cancel-analysis',
    'toggle-inclusion',
    'remove-image',
    'delete',
  ]);
  assert.deepEqual(
    intakeEventMenuActions(event('plain', '2026-08-22', '2026-08-22T09:00:00.000Z'), null),
    ['edit', 'toggle-inclusion', 'delete'],
  );
});
