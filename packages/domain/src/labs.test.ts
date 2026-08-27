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
  resolveUserMeasurementBiomarker,
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

  it('maps only a unique reviewed alias with compatible measurement facts', () => {
    const catalogue = [
      {
        id: 'biomarker.total_cholesterol',
        aliases: ['Total cholesterol'],
        specimens: ['blood', 'serum', 'plasma', 'unknown'] as const,
        units: ['mg/dL'],
        valueType: 'numeric' as const,
      },
    ];
    assert.deepEqual(
      resolveUserMeasurementBiomarker(
        {
          label: 'Total cholesterol',
          value: { kind: 'numeric', value: 205 },
          unit: 'mg/dL',
          specimenType: 'unknown',
        },
        catalogue,
      ),
      { kind: 'mapped', biomarkerId: canonicalId('biomarker.total_cholesterol') },
    );
  });

  it('preserves ambiguous, unsafe, and incompatible user labels', () => {
    const catalogue = [
      {
        id: 'biomarker.first',
        aliases: ['Shared label'],
        specimens: ['serum'] as const,
        units: ['mg/dL'],
      },
      {
        id: 'biomarker.second',
        aliases: ['Shared label'],
        specimens: ['serum'] as const,
        units: ['mg/dL'],
      },
      {
        id: 'biomarker.unsafe',
        aliases: ['Unsafe label'],
        unsafeAliases: ['Unsafe label'],
        specimens: ['serum'] as const,
        units: ['mg/dL'],
      },
      {
        id: 'biomarker.numeric',
        aliases: ['Numeric label'],
        specimens: ['serum'] as const,
        units: ['mg/dL'],
      },
    ];
    const base = {
      value: { kind: 'numeric' as const, value: 1 },
      unit: 'mg/dL',
      specimenType: 'serum' as const,
    };
    assert.deepEqual(
      resolveUserMeasurementBiomarker({ ...base, label: 'Shared label' }, catalogue),
      { kind: 'preserved-only', reason: 'unmapped' },
    );
    assert.deepEqual(
      resolveUserMeasurementBiomarker({ ...base, label: 'Unsafe label' }, catalogue),
      { kind: 'preserved-only', reason: 'unmapped' },
    );
    assert.deepEqual(
      resolveUserMeasurementBiomarker(
        { ...base, label: 'Numeric label', unit: 'mmol/L' },
        catalogue,
      ),
      { kind: 'preserved-only', reason: 'incompatible-unit' },
    );
    assert.deepEqual(
      resolveUserMeasurementBiomarker(
        { ...base, label: 'Numeric label', specimenType: 'urine' },
        catalogue,
      ),
      { kind: 'preserved-only', reason: 'incompatible-specimen' },
    );
    assert.deepEqual(
      resolveUserMeasurementBiomarker(
        { ...base, label: 'Numeric label', value: { kind: 'bounded', comparator: '<', value: 1 } },
        catalogue,
      ),
      { kind: 'preserved-only', reason: 'non-numeric-value' },
    );
  });

  it('fails closed when a reviewed biomarker requires method context', () => {
    const catalogue = [
      {
        id: 'biomarker.method-dependent',
        aliases: ['Method-dependent result'],
        specimens: ['serum'] as const,
        units: ['U/L'],
        methodPolicy: {
          version: '1',
          kind: 'requires-explicit-method' as const,
          allowedMethods: ['supported assay'],
          unsafePatterns: [],
        },
      },
    ];
    assert.deepEqual(
      resolveUserMeasurementBiomarker(
        {
          label: 'Method-dependent result',
          value: { kind: 'numeric', value: 42 },
          unit: 'U/L',
          specimenType: 'serum',
        },
        catalogue,
      ),
      { kind: 'preserved-only', reason: 'incompatible-method' },
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
