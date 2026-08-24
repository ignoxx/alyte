import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadShowcaseSnapshot } from '@alyte/fixtures';
import {
  missingShowcaseIntakeInputs,
  missingShowcaseLabRecordInputs,
  showcaseIntakeInputs,
  showcaseLabRecordInputs,
} from './showcase-seed';

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

test('showcase lab inputs cover all four lipid entries without inventing intermediate values', () => {
  const inputs = showcaseLabRecordInputs();
  assert.equal(inputs.length, 4);
  assert.deepEqual(
    new Set(
      inputs.flatMap((record) => record.measurements.map((measurement) => measurement.biomarkerId)),
    ),
    new Set([
      'biomarker.total_cholesterol',
      'biomarker.ldl_c',
      'biomarker.hdl_c',
      'biomarker.triglycerides',
    ]),
  );
  assert.equal(inputs[2]?.collectionDate.kind, 'missing');
  assert.equal(inputs[3]?.measurements[0]?.value.kind, 'bounded');
  assert.deepEqual(
    missingShowcaseLabRecordInputs(inputs, new Set([inputs[0]!.id!])).map((record) => record.id),
    [
      'showcase-lab-record-2026-03',
      'showcase-lab-record-date-missing',
      'showcase-lab-record-2026-05',
    ],
  );
});
