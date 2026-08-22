import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShowcaseSnapshot } from '@alyte/fixtures';
import { missingShowcaseIntakeInputs, showcaseIntakeInputs } from './showcase-seed';

test('showcase intake inputs use stable same-day identifiers and times', () => {
  const snapshot = loadShowcaseSnapshot('development', true);
  assert.ok(snapshot !== null);
  const inputs = showcaseIntakeInputs(snapshot, '2026-08-22');

  assert.deepEqual(
    inputs.map((input) => ({
      id: input.id,
      localDate: input.localDate,
      occurredAt: input.occurredAt,
    })),
    [
      {
        id: 'showcase-intake-breakfast',
        localDate: '2026-08-22',
        occurredAt: new Date(2026, 7, 22, 9, 0, 0, 0).toISOString(),
      },
      {
        id: 'showcase-intake-drink',
        localDate: '2026-08-22',
        occurredAt: new Date(2026, 7, 22, 12, 0, 0, 0).toISOString(),
      },
    ],
  );

  assert.deepEqual(
    missingShowcaseIntakeInputs(inputs, new Set(['showcase-intake-breakfast'])).map(
      (input) => input.id,
    ),
    ['showcase-intake-drink'],
  );
});
