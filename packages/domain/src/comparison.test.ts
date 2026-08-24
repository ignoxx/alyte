import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findCatalogueBiomarker, lipidSources } from '@alyte/catalogue';
import { canonicalId } from './index.js';
import {
  buildMeasuredTrend,
  convertComparableValue,
  selectApplicableGeneralGuidance,
  type LabRecord,
  type Measurement,
} from './labs.js';

const ldl = findCatalogueBiomarker('biomarker.ldl_c')!;

function measurement(
  id: string,
  recordId: string,
  value: Measurement['current']['value'],
  options: Partial<Pick<Measurement, 'specimenType' | 'reviewState'>> &
    Partial<Measurement['current']> & { readonly biomarkerId?: Measurement['biomarkerId'] } = {},
): Measurement {
  const biomarkerId = options.biomarkerId ?? canonicalId('biomarker.ldl_c');
  const snapshot = {
    label: 'LDL-Cholesterin',
    value,
    valueString: options.valueString ?? String(value.kind === 'numeric' ? value.value : value),
    unit: options.unit ?? 'mg/dL',
    referenceInterval: options.referenceInterval ?? '<115',
    flag: options.flag ?? null,
  };
  return {
    id,
    labRecordId: recordId,
    biomarkerId,
    specimenType: options.specimenType ?? 'serum',
    panelLabel: 'Lipids',
    original: snapshot,
    originalState: {
      biomarkerId,
      specimenType: options.specimenType ?? 'serum',
      snapshot,
      reviewState: options.reviewState ?? 'confirmed',
      provenance: 'extracted',
      source: null,
    },
    current: snapshot,
    provenance: 'extracted',
    reviewState: options.reviewState ?? 'confirmed',
    source: null,
    corrections: [],
  };
}

function record(
  id: string,
  collectionDate: LabRecord['collectionDate'],
  measurements: readonly Measurement[],
  specimenType: LabRecord['specimenType'] = 'serum',
): LabRecord {
  return {
    id,
    labReportId: `report-${id}`,
    collectionDate,
    specimenType,
    laboratoryName: 'Synthetic Laboratory',
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    measurements,
  };
}

describe('lipid comparison core', () => {
  it('converts only known exact units with deterministic biomarker-specific factors', () => {
    assert.deepEqual(convertComparableValue(3.1, 'mmol/L', ldl!), {
      value: 119.877,
      unit: 'mg/dL',
      catalogueVersion: '0.2.0',
      conversionSourceIds: [lipidSources[0]!.id],
    });
    assert.deepEqual(convertComparableValue(119.877, 'mg/dL', ldl!, 'mmol/L'), {
      value: 3.1,
      unit: 'mmol/L',
      catalogueVersion: '0.2.0',
      conversionSourceIds: [lipidSources[0]!.id],
    });
    assert.equal(convertComparableValue(3.1, 'nmol/L', ldl!), null);
  });

  it('keeps exact dated numeric points and preserves every non-point state without interpolation', () => {
    const records = [
      record('r1', { kind: 'known', value: '2026-01-01' }, [
        measurement('m1', 'r1', { kind: 'numeric', value: 100 }, { valueString: '100' }),
      ]),
      record('r2', { kind: 'known', value: '2026-02-01' }, []),
      record('r3', { kind: 'known', value: '2026-03-01' }, [
        measurement(
          'm3',
          'r3',
          { kind: 'numeric', value: 3.1 },
          {
            unit: 'mmol/L',
            valueString: '3,1',
          },
        ),
      ]),
      record('r4', { kind: 'missing' }, [measurement('m4', 'r4', { kind: 'numeric', value: 120 })]),
      record('r5', { kind: 'known', value: '2026-05-01' }, [
        measurement(
          'm5',
          'r5',
          { kind: 'bounded', comparator: '<', value: 3.8 },
          {
            unit: 'mmol/L',
            valueString: '<3,8',
          },
        ),
      ]),
      record('r6', { kind: 'known', value: '2026-06-01' }, [
        measurement('m6', 'r6', { kind: 'numeric', value: 90 }, { specimenType: 'urine' }),
      ]),
    ];
    const trend = buildMeasuredTrend(records, canonicalId('biomarker.ldl_c'), [ldl]);
    assert.deepEqual(
      trend.points.map((point) => point.measurementId),
      ['m1', 'm3'],
    );
    assert.equal(trend.points[0]?.source.valueString, '100');
    assert.equal(trend.points[1]?.source.unit, 'mmol/L');
    assert.equal(trend.points[1]?.normalized.unit, 'mg/dL');
    assert.equal(trend.direction, 'increased');
    assert.equal(trend.segments.length, 2, 'a missing intervening report cannot be bridged');
    assert.deepEqual(
      trend.nonPoints.map((item) => item.kind),
      ['not-measured', 'bounded', 'incompatible', 'date-missing'],
    );
    assert.equal(trend.points[0]?.catalogueVersion, '0.2.0');
    assert.deepEqual(trend.points[1]?.normalized.conversionSourceIds, [lipidSources[0]!.id]);
    assert.equal(trend.generalGuidance.length, 0, 'guidance requires explicit context');
  });

  it('returns not-comparable when two exact points are unavailable', () => {
    const trend = buildMeasuredTrend(
      [
        record('r1', { kind: 'known', value: '2026-01-01' }, [
          measurement('m1', 'r1', { kind: 'bounded', comparator: '>', value: 10 }),
        ]),
      ],
      canonicalId('biomarker.ldl_c'),
      [ldl],
    );
    assert.equal(trend.direction, 'not-comparable');
    assert.equal(trend.points.length, 0);
    assert.equal(trend.nonPoints[0]?.kind, 'bounded');
  });

  it('does not surface guidance for unknown context and only selects matching applicability', () => {
    const hdl = findCatalogueBiomarker('biomarker.hdl_c')!;
    assert.deepEqual(
      selectApplicableGeneralGuidance(hdl, {
        population: 'adults',
        jurisdiction: 'US',
        sex: 'unknown',
        fasting: 'fasting',
      }),
      [],
    );
    const female = selectApplicableGeneralGuidance(hdl, {
      population: 'adults',
      jurisdiction: 'US',
      sex: 'female',
      fasting: 'non-fasting',
    });
    assert.deepEqual(
      female.map((guidance) => guidance.guidanceId),
      ['guidance.hdl-c.screening-us-female'],
    );
    assert.equal(female[0]?.catalogueVersion, '0.2.0');
    assert.deepEqual(female[0]?.sourceIds, [
      'source.cdc.ldl-hdl-triglycerides',
      'source.nhlbi.blood-cholesterol-diagnosis',
    ]);
  });

  it('keeps compatible specimen groups together and preserves mixed groups as non-points', () => {
    const compatible = buildMeasuredTrend(
      [
        record(
          'serum',
          { kind: 'known', value: '2026-01-01' },
          [measurement('serum-m', 'serum', { kind: 'numeric', value: 100 })],
          'serum',
        ),
        record(
          'plasma',
          { kind: 'known', value: '2026-02-01' },
          [
            measurement(
              'plasma-m',
              'plasma',
              { kind: 'numeric', value: 110 },
              { specimenType: 'plasma' },
            ),
          ],
          'plasma',
        ),
      ],
      canonicalId('biomarker.ldl_c'),
      [ldl],
    );
    assert.deepEqual(
      compatible.points.map((point) => point.measurementId),
      ['serum-m', 'plasma-m'],
    );
    assert.equal(compatible.direction, 'increased');

    const mixed = buildMeasuredTrend(
      [
        record(
          'serum',
          { kind: 'known', value: '2026-01-01' },
          [measurement('serum-m', 'serum', { kind: 'numeric', value: 100 })],
          'serum',
        ),
        record(
          'unknown',
          { kind: 'known', value: '2026-02-01' },
          [
            measurement(
              'unknown-m',
              'unknown',
              { kind: 'numeric', value: 110 },
              { specimenType: 'unknown' },
            ),
          ],
          'unknown',
        ),
      ],
      canonicalId('biomarker.ldl_c'),
      [ldl],
    );
    assert.deepEqual(
      mixed.points.map((point) => point.measurementId),
      ['serum-m'],
    );
    assert.equal(mixed.nonPoints[0]?.measurementId, 'unknown-m');
    assert.equal(mixed.nonPoints[0]?.reason, 'incompatible-specimen');
    assert.equal(mixed.direction, 'not-comparable');
  });

  it('surfaces matching guidance only when a complete context is explicit', () => {
    const trend = buildMeasuredTrend(
      [
        record('r1', { kind: 'known', value: '2026-01-01' }, [
          measurement('m1', 'r1', { kind: 'numeric', value: 100 }),
        ]),
      ],
      canonicalId('biomarker.ldl_c'),
      [ldl],
      {
        guidanceContext: {
          population: 'adults',
          jurisdiction: 'US',
          sex: 'female',
          fasting: 'non-fasting',
        },
      },
    );
    assert.deepEqual(
      trend.generalGuidance.map((guidance) => guidance.guidanceId),
      ['guidance.ldl-c.screening-us'],
    );
  });
});
