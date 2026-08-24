import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalId, type LabRecord, type Measurement } from '@alyte/domain';
import {
  buildBiomarkerHistoryViewModel,
  buildHistoryAccessibilityLabel,
  listHistoryEntries,
  type HistoryAccessibilityCopy,
} from './biomarker-history-model';

const copy: HistoryAccessibilityCopy = {
  chart: 'Measured trend',
  measuredPoint: 'Measured point',
  nonPoint: {
    'not-measured': 'Not measured',
    'date-missing': 'Collection date missing',
    bounded: 'Bounded result',
    incompatible: 'Incompatible result',
    unsupported: 'Unsupported result',
  },
  date: 'Collection date',
  source: 'Original source',
  unit: 'Unit',
  laboratoryInterval: 'Laboratory interval',
  laboratoryFlag: 'Laboratory flag',
  provenance: {
    extracted: 'Extracted',
    'user-entered': 'User-entered',
    'user-corrected': 'User-corrected',
  },
  noValue: 'Not provided',
};

function measurement(
  id: string,
  recordId: string,
  value: Measurement['current']['value'],
  options: Partial<Pick<Measurement, 'reviewState' | 'provenance' | 'biomarkerId'>> &
    Partial<Pick<Measurement['current'], 'unit' | 'valueString' | 'referenceInterval' | 'flag'>> & {
      readonly label?: string;
    } = {},
): Measurement {
  const biomarkerId = options.biomarkerId ?? canonicalId('biomarker.ldl_c');
  const snapshot = {
    label: options.label ?? 'LDL-C',
    value,
    valueString:
      options.valueString ?? (value.kind === 'numeric' ? String(value.value) : String(value.value)),
    unit: options.unit ?? 'mg/dL',
    referenceInterval: options.referenceInterval ?? '<100',
    flag: options.flag ?? null,
  };
  return {
    id,
    labRecordId: recordId,
    biomarkerId,
    specimenType: 'serum',
    panelLabel: 'Lipids',
    original: snapshot,
    originalState: {
      biomarkerId,
      specimenType: 'serum',
      snapshot,
      reviewState: options.reviewState ?? 'confirmed',
      provenance: options.provenance ?? 'extracted',
      source: null,
    },
    current: snapshot,
    provenance: options.provenance ?? 'extracted',
    reviewState: options.reviewState ?? 'confirmed',
    source: {
      pageIndex: 1,
      boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
      orientation: 0,
    },
    corrections: [],
  };
}

function record(
  id: string,
  collectionDate: LabRecord['collectionDate'],
  measurements: readonly Measurement[],
): LabRecord {
  return {
    id,
    labReportId: `report-${id}`,
    collectionDate,
    specimenType: 'serum',
    laboratoryName: 'Synthetic Laboratory',
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    measurements,
  };
}

test('history entries are generic, catalogue-labelled, and sourced only from confirmed measurements', () => {
  const records = [
    record('r1', { kind: 'known', value: '2026-01-01' }, [
      measurement('m1', 'r1', { kind: 'numeric', value: 110 }),
      measurement(
        'm2',
        'r1',
        { kind: 'numeric', value: 55 },
        { biomarkerId: canonicalId('biomarker.hdl_c') },
      ),
      measurement('m3', 'r1', { kind: 'numeric', value: 9 }, { reviewState: 'needs-review' }),
      measurement(
        'm4',
        'r1',
        { kind: 'numeric', value: 1 },
        {
          biomarkerId: canonicalId('biomarker.future_marker'),
          label: 'Future marker',
        },
      ),
    ]),
  ];

  assert.deepEqual(
    listHistoryEntries(records).map((entry) => entry.canonicalLabel),
    ['Future marker', 'HDL-C', 'LDL-C'],
  );
  assert.equal(listHistoryEntries(records)[2]?.measurementCount, 1);
});

test('view model keeps points, missing states, source metadata, and guidance separate', () => {
  const records = [
    record('r1', { kind: 'known', value: '2026-01-01' }, [
      measurement('m1', 'r1', { kind: 'numeric', value: 110 }),
    ]),
    record('r2', { kind: 'known', value: '2026-02-01' }, []),
    record('r3', { kind: 'known', value: '2026-03-01' }, [
      measurement(
        'm3',
        'r3',
        { kind: 'bounded', comparator: '<', value: 100 },
        { valueString: '<100' },
      ),
    ]),
    record('r4', { kind: 'missing' }, [measurement('m4', 'r4', { kind: 'numeric', value: 90 })]),
  ];

  const model = buildBiomarkerHistoryViewModel(records, 'biomarker.ldl_c', {
    population: 'adults',
    jurisdiction: 'US',
    sex: 'female',
    fasting: 'non-fasting',
  });
  assert.ok(model);
  assert.deepEqual(
    model.timeline.map((item) => (item.kind === 'point' ? 'point' : item.nonPoint.kind)),
    ['point', 'not-measured', 'bounded', 'date-missing'],
  );
  assert.equal(model.timeline[0]?.kind, 'point');
  if (model.timeline[0]?.kind === 'point') {
    assert.equal(model.timeline[0].provenance, 'extracted');
    assert.equal(model.timeline[0].sourceLocation?.pageIndex, 1);
    assert.equal(model.timeline[0].point.laboratoryReference.interval, '<100');
  }
  assert.deepEqual(
    model.trend.generalGuidance.map((guidance) => guidance.guidanceId),
    ['guidance.ldl-c.screening-us'],
  );
});

test('VoiceOver alternative orders every measured point and non-point state', () => {
  const model = buildBiomarkerHistoryViewModel(
    [
      record('r1', { kind: 'known', value: '2026-01-01' }, [
        measurement('m1', 'r1', { kind: 'numeric', value: 110 }),
      ]),
      record('r2', { kind: 'known', value: '2026-02-01' }, []),
      record('r3', { kind: 'missing' }, [measurement('m3', 'r3', { kind: 'numeric', value: 90 })]),
    ],
    'biomarker.ldl_c',
  );
  assert.ok(model);
  const label = buildHistoryAccessibilityLabel(model, copy);
  assert.ok(label.indexOf('Measured point') < label.indexOf('Not measured'));
  assert.ok(label.indexOf('Not measured') < label.indexOf('Collection date missing'));
  assert.match(label, /Original source LDL-C: 110 mg\/dL/);
  assert.match(label, /Laboratory interval <100/);
});

test('unsupported canonical measurements stay visible as non-points', () => {
  const unsupported = buildBiomarkerHistoryViewModel(
    [
      record('r-unsupported', { kind: 'known', value: '2026-04-01' }, [
        measurement(
          'm-unsupported',
          'r-unsupported',
          { kind: 'numeric', value: 1 },
          {
            biomarkerId: canonicalId('biomarker.future_marker'),
            label: 'Future marker',
          },
        ),
      ]),
    ],
    'biomarker.future_marker',
  );
  assert.ok(unsupported);
  assert.equal(unsupported.canonicalLabel, 'Future marker');
  assert.equal(unsupported.timeline[0]?.kind, 'non-point');
  if (unsupported.timeline[0]?.kind === 'non-point') {
    assert.equal(unsupported.timeline[0].nonPoint.kind, 'unsupported');
  }
});
