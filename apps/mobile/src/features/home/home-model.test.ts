import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IntakeEvent } from '@alyte/domain';
import type { IntakeCloudJob } from '../intake/outbox';
import { intakeEventMenuActions } from '../intake/ui';
import { groupIntakeTimeline } from './home-model';

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

test('Home groups timeline records by local day and keeps newest first', () => {
  const records = [
    event('older', '2026-08-21', '2026-08-21T08:00:00.000Z'),
    event('newer', '2026-08-22', '2026-08-22T09:00:00.000Z'),
    event('latest', '2026-08-22', '2026-08-22T11:00:00.000Z'),
  ];

  assert.deepEqual(
    groupIntakeTimeline(records).map((group) => [
      group.localDate,
      group.events.map((record) => record.id),
    ]),
    [
      ['2026-08-22', ['latest', 'newer']],
      ['2026-08-21', ['older']],
    ],
  );
});

test('Home menu keeps destructive and uncommon actions out of the row', () => {
  const record = event('with-image', '2026-08-22', '2026-08-22T09:00:00.000Z', '/protected/image');

  assert.deepEqual(intakeEventMenuActions(record, queuedJob), [
    'cancel-analysis',
    'toggle-inclusion',
    'remove-image',
    'delete',
  ]);
  assert.deepEqual(
    intakeEventMenuActions(event('plain', '2026-08-22', '2026-08-22T09:00:00.000Z'), null),
    ['toggle-inclusion', 'delete'],
  );
});
