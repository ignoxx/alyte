import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalId, type LabRecord, type Measurement } from '@alyte/domain';
import { loadShowcaseSnapshot } from '@alyte/fixtures';
import {
  buildBiomarkerHistoryViewModel,
  listHistoryEntries,
} from '../features/labs/biomarker-history-model';
import {
  missingShowcaseIntakeInputs,
  missingShowcaseLabRecordInputs,
  showcaseIntakeInputs,
  showcaseLabRecordInputs,
} from './showcase-seed';

const nonLipidIds = [
  'biomarker.glucose',
  'biomarker.hba1c',
  'biomarker.ferritin',
  'biomarker.vitamin_d_total',
  'biomarker.vitamin_b12_total',
  'biomarker.hemoglobin',
  'biomarker.hematocrit',
  'biomarker.mcv',
  'biomarker.alt',
  'biomarker.ast',
  'biomarker.ggt',
] as const;

function recordsFromShowcaseInputs(): readonly LabRecord[] {
  return showcaseLabRecordInputs().map((input, recordIndex) => ({
    id: input.id ?? `showcase-record-${recordIndex}`,
    labReportId: input.labReportId ?? null,
    collectionDate: input.collectionDate,
    specimenType: input.specimenType ?? 'unknown',
    laboratoryName: input.laboratoryName ?? null,
    notes: input.notes ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    measurements: input.measurements.map((candidate, measurementIndex): Measurement => {
      const id = candidate.id ?? `showcase-measurement-${recordIndex}-${measurementIndex}`;
      const snapshot = {
        label: candidate.label,
        value: candidate.value,
        valueString:
          candidate.valueString ??
          (candidate.value.kind === 'bounded'
            ? `${candidate.value.comparator}${candidate.value.value}`
            : String(candidate.value.value)),
        unit: candidate.unit ?? null,
        referenceInterval: candidate.referenceInterval ?? null,
        flag: candidate.flag ?? null,
      };
      const specimenType = candidate.specimenType ?? input.specimenType ?? 'unknown';
      const provenance = candidate.provenance ?? 'user-entered';
      const reviewState = candidate.reviewState ?? 'confirmed';
      return {
        id,
        labRecordId: input.id ?? `showcase-record-${recordIndex}`,
        biomarkerId: candidate.biomarkerId ?? null,
        specimenType,
        panelLabel: candidate.panelLabel ?? null,
        original: snapshot,
        originalState: {
          biomarkerId: candidate.biomarkerId ?? null,
          specimenType,
          snapshot,
          reviewState,
          provenance,
          source: null,
        },
        current: snapshot,
        provenance,
        reviewState,
        source: null,
        corrections: [],
      };
    }),
  }));
}

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

test('showcase lab inputs cover every catalogue family with stable route fixtures', () => {
  const inputs = showcaseLabRecordInputs();
  assert.equal(inputs.length, 14);
  assert.deepEqual(
    new Set(
      inputs.flatMap((record) => record.measurements.map((measurement) => measurement.biomarkerId)),
    ),
    new Set([
      'biomarker.total_cholesterol',
      'biomarker.ldl_c',
      'biomarker.hdl_c',
      'biomarker.triglycerides',
      'biomarker.glucose',
      'biomarker.hba1c',
      'biomarker.ferritin',
      'biomarker.vitamin_d_total',
      'biomarker.vitamin_b12_total',
      'biomarker.hemoglobin',
      'biomarker.hematocrit',
      'biomarker.mcv',
      'biomarker.alt',
      'biomarker.ast',
      'biomarker.ggt',
    ]),
  );
  assert.equal(inputs[2]?.collectionDate.kind, 'missing');
  assert.equal(inputs[3]?.measurements[0]?.value.kind, 'bounded');
  const nonLipids = new Set([
    'biomarker.glucose',
    'biomarker.hba1c',
    'biomarker.ferritin',
    'biomarker.vitamin_d_total',
    'biomarker.vitamin_b12_total',
    'biomarker.hemoglobin',
    'biomarker.hematocrit',
    'biomarker.mcv',
    'biomarker.alt',
    'biomarker.ast',
    'biomarker.ggt',
  ]);
  const exactDatedCounts = new Map<string, number>();
  for (const record of inputs) {
    if (record.collectionDate.kind !== 'known') continue;
    for (const measurement of record.measurements) {
      if (nonLipids.has(measurement.biomarkerId ?? '')) {
        if (measurement.value.kind === 'numeric') {
          exactDatedCounts.set(
            measurement.biomarkerId!,
            (exactDatedCounts.get(measurement.biomarkerId!) ?? 0) + 1,
          );
        }
      }
    }
  }
  for (const biomarkerId of nonLipids) {
    assert.ok((exactDatedCounts.get(biomarkerId) ?? 0) >= 2, `${biomarkerId} has two points`);
  }
  assert.ok(
    inputs.some((record) =>
      record.measurements.some(
        (measurement) => measurement.value.kind === 'bounded' && measurement.biomarkerId !== null,
      ),
    ),
  );
  assert.ok(inputs.some((record) => record.collectionDate.kind === 'missing'));
  assert.ok(
    inputs.some((record) =>
      record.measurements.some(
        (measurement) =>
          measurement.biomarkerId === 'biomarker.glucose' && measurement.unit === 'g/L',
      ),
    ),
  );
  assert.ok(
    inputs.some((record) =>
      record.measurements.some(
        (measurement) =>
          measurement.biomarkerId === 'biomarker.ferritin' && measurement.specimenType === 'blood',
      ),
    ),
  );
  assert.ok(
    inputs.some((record) =>
      record.measurements.some(
        (measurement) => measurement.biomarkerId === 'biomarker.ast' && measurement.label === 'AST',
      ),
    ),
  );
  assert.deepEqual(
    missingShowcaseLabRecordInputs(inputs, new Set([inputs[0]!.id!])).map((record) => record.id),
    [
      'showcase-lab-record-2026-03',
      'showcase-lab-record-date-missing',
      'showcase-lab-record-2026-05',
      'showcase-lab-record-metabolic-2026-01',
      'showcase-lab-record-metabolic-2026-03',
      'showcase-lab-record-metabolic-date-missing',
      'showcase-lab-record-metabolic-2026-05',
      'showcase-lab-record-metabolic-2026-06',
      'showcase-lab-record-blood-2026-01',
      'showcase-lab-record-blood-2026-03',
      'showcase-lab-record-blood-date-missing',
      'showcase-lab-record-blood-2026-05',
      'showcase-lab-record-blood-2026-06',
    ],
  );
});

test('showcase non-lipid fixtures render through the canonical Labs history model', () => {
  const records = recordsFromShowcaseInputs();
  const entries = listHistoryEntries(records);
  assert.deepEqual(
    new Set(nonLipidIds.map(canonicalId)),
    new Set(
      entries
        .map((entry) => entry.biomarkerId)
        .filter((id) => nonLipidIds.includes(id as (typeof nonLipidIds)[number])),
    ),
  );

  for (const biomarkerId of nonLipidIds) {
    const model = buildBiomarkerHistoryViewModel(records, biomarkerId);
    assert.ok(model, biomarkerId);
    assert.equal(model.trend.points.length, 2, biomarkerId);
    assert.ok(
      model.trend.nonPoints.some((item) => item.kind === 'bounded'),
      biomarkerId,
    );
    assert.ok(
      model.trend.nonPoints.some((item) => item.kind === 'date-missing'),
      biomarkerId,
    );
    assert.ok(
      model.trend.nonPoints.some((item) => item.kind === 'incompatible'),
      biomarkerId,
    );
    assert.equal(model.explanation, null, biomarkerId);
    assert.equal(model.explanationReviewPending, true, biomarkerId);
    assert.equal(model.guidance.kind, 'not-applicable', biomarkerId);
  }
});
