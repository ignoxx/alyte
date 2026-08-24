import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLabDateState,
  assertMeasurementValue,
  buildLabRecordDetail,
  createSortableOpaqueId,
  formatLocaleDate,
  formatLocaleDecimal,
  formatMeasurementValue,
  parseLocalDateInput,
  parseLocaleDecimal,
  type LabRecord,
} from './labs.js';
import { canonicalId } from './index.js';

describe('manual laboratory value model', () => {
  it('accepts a missing date and rejects invalid known dates', () => {
    assert.doesNotThrow(() => assertLabDateState({ kind: 'missing' }));
    assert.doesNotThrow(() => assertLabDateState({ kind: 'known', value: '2026-08-22' }));
    assert.throws(() => assertLabDateState({ kind: 'known', value: '22/08/2026' }));
    assert.throws(() => assertLabDateState({ kind: 'known', value: '2026-02-30' }));
  });

  it('keeps bounded, categorical, and free-text values distinct', () => {
    assert.equal(formatMeasurementValue({ kind: 'bounded', comparator: '<', value: 5 }), '<5');
    assert.equal(formatMeasurementValue({ kind: 'categorical', value: 'negative' }), 'negative');
    assert.equal(
      formatMeasurementValue({ kind: 'free_text', value: 'sample hemolyzed' }),
      'sample hemolyzed',
    );
    assert.doesNotThrow(() =>
      assertMeasurementValue({ kind: 'bounded', comparator: '>', value: 0 }),
    );
    assert.throws(() => assertMeasurementValue({ kind: 'numeric', value: Number.NaN }));
  });

  it('parses locale decimals and dates without timezone drift', () => {
    assert.equal(parseLocaleDecimal('1.234,56'), 1234.56);
    assert.equal(parseLocaleDecimal('1 234,56'), 1234.56);
    assert.equal(parseLocaleDecimal('3,8'), 3.8);
    assert.equal(parseLocaleDecimal('not-a-number'), null);
    assert.equal(parseLocalDateInput('22.08.2026', 'de-DE'), '2026-08-22');
    assert.equal(parseLocalDateInput('08/22/2026', 'en-US'), '2026-08-22');
    assert.equal(parseLocalDateInput('2026-02-30', 'en-US'), null);
    assert.equal(formatLocaleDecimal(1234.5, 'de-DE'), '1.234,5');
    assert.equal(formatLocaleDate('2026-08-22', 'de-DE'), '22.08.2026');
  });

  it('creates sortable opaque identifiers with a deterministic seam', () => {
    assert.ok(
      createSortableOpaqueId('measurement', 1000, 'a'.repeat(20)) <
        createSortableOpaqueId('measurement', 1001, '0'.repeat(20)),
    );
    assert.match(
      createSortableOpaqueId('lab-record', 1000, 'b'.repeat(20)),
      /^lab-record-[0-9a-f]{12}-b{20}$/,
    );
  });
});

describe('Lab Record detail provenance', () => {
  const snapshot = {
    label: 'Synthetic LDL-C',
    value: { kind: 'numeric' as const, value: 100 },
    valueString: '100',
    unit: 'mg/dL',
    referenceInterval: '<130',
    flag: null,
  };
  const source = {
    pageIndex: 0,
    boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    orientation: 0,
  };
  const record: LabRecord = {
    id: 'record-synthetic',
    labReportId: 'report-synthetic',
    collectionDate: { kind: 'known', value: '2026-08-20' },
    specimenType: 'serum',
    laboratoryName: 'Synthetic Laboratory',
    notes: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    measurements: [
      {
        id: 'measurement-synthetic',
        labRecordId: 'record-synthetic',
        biomarkerId: canonicalId('biomarker.ldl_c'),
        specimenType: 'serum',
        panelLabel: 'Lipids',
        original: snapshot,
        originalState: {
          biomarkerId: canonicalId('biomarker.ldl_c'),
          specimenType: 'serum',
          snapshot,
          reviewState: 'confirmed',
          provenance: 'extracted',
          source,
        },
        current: snapshot,
        provenance: 'extracted',
        reviewState: 'confirmed',
        source,
        corrections: [],
      },
    ],
  };

  it('requires tested identity, exact numeric value, specimen, unit, and review state', () => {
    const catalogue = [{ id: 'biomarker.ldl_c', specimens: ['serum'] as const, units: ['mg/dL'] }];
    assert.equal(
      buildLabRecordDetail(record, { kind: 'retained', reportId: 'report-synthetic' }, catalogue)
        .measurements[0]?.support.kind,
      'comparable-supported',
    );
    assert.deepEqual(
      buildLabRecordDetail(
        { ...record, collectionDate: { kind: 'missing' } },
        { kind: 'retained', reportId: 'report-synthetic' },
        catalogue,
      ).chronology,
      { kind: 'date-missing' },
    );
    const bounded = {
      ...record,
      measurements: [
        {
          ...record.measurements[0]!,
          current: {
            ...snapshot,
            value: { kind: 'bounded' as const, comparator: '<' as const, value: 100 },
          },
        },
      ],
    };
    assert.deepEqual(
      buildLabRecordDetail(bounded, { kind: 'deleted', reportId: 'report-synthetic' }, catalogue)
        .measurements[0]?.support,
      { kind: 'preserved-only', reason: 'non-numeric-value' },
    );
    const invented = {
      ...record,
      measurements: [
        { ...record.measurements[0]!, biomarkerId: canonicalId('biomarker.invented') },
      ],
    };
    assert.deepEqual(
      buildLabRecordDetail(
        invented,
        { kind: 'deletion-failed', reportId: 'report-synthetic' },
        catalogue,
      ).measurements[0]?.support,
      { kind: 'preserved-only', reason: 'unsupported-canonical-id' },
    );
    for (const [measurement, reason] of [
      [{ ...record.measurements[0]!, biomarkerId: null }, 'unmapped'],
      [{ ...record.measurements[0]!, current: { ...snapshot, unit: null } }, 'missing-unit'],
      [
        { ...record.measurements[0]!, current: { ...snapshot, unit: 'mmol/L' } },
        'incompatible-unit',
      ],
      [{ ...record.measurements[0]!, specimenType: 'urine' as const }, 'incompatible-specimen'],
      [{ ...record.measurements[0]!, reviewState: 'needs-review' as const }, 'unconfirmed'],
    ] as const) {
      assert.deepEqual(
        buildLabRecordDetail(
          { ...record, measurements: [measurement] },
          { kind: 'retained', reportId: 'report-synthetic' },
          catalogue,
        ).measurements[0]?.support,
        { kind: 'preserved-only', reason },
      );
    }
  });
});
