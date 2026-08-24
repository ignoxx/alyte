import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { metabolicMicronutrientBiomarkers, findCatalogueBiomarker } from '@alyte/catalogue';
import { canonicalId } from './index.js';
import {
  buildMeasuredTrend,
  convertComparableValue,
  selectApplicableGeneralGuidance,
  type LabRecord,
  type Measurement,
  type MeasurementSnapshot,
} from './labs.js';

function measurement(
  id: string,
  recordId: string,
  biomarkerId: string,
  value: Measurement['current']['value'],
  unit: string | null,
  specimenType: Measurement['specimenType'],
  valueString = String(value.kind === 'numeric' ? value.value : value),
  label = biomarkerId,
): Measurement {
  const canonical = canonicalId(biomarkerId);
  const snapshot: MeasurementSnapshot = {
    label,
    value,
    valueString,
    unit,
    referenceInterval: 'laboratory interval',
    flag: null,
  };
  const state = {
    biomarkerId: canonical,
    specimenType,
    snapshot,
    reviewState: 'confirmed' as const,
    provenance: 'extracted' as const,
    source: null,
  };
  return {
    id,
    labRecordId: recordId,
    biomarkerId: canonical,
    specimenType,
    panelLabel: null,
    original: snapshot,
    originalState: state,
    current: snapshot,
    provenance: 'extracted',
    reviewState: 'confirmed',
    source: null,
    corrections: [],
  };
}

function record(
  id: string,
  collectionDate: LabRecord['collectionDate'],
  specimenType: LabRecord['specimenType'],
  measurements: readonly Measurement[],
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

describe('metabolic and micronutrient comparison fixtures', () => {
  it('converts each family only through its authoritative deterministic unit paths', () => {
    const glucose = findCatalogueBiomarker('biomarker.glucose')!;
    const hba1c = findCatalogueBiomarker('biomarker.hba1c')!;
    const ferritin = findCatalogueBiomarker('biomarker.ferritin')!;
    const vitaminD = findCatalogueBiomarker('biomarker.vitamin_d_total')!;
    const vitaminB12 = findCatalogueBiomarker('biomarker.vitamin_b12_total')!;

    assert.equal(convertComparableValue(126, 'mg/dL', glucose, 'mmol/L')?.value, 6.993);
    assert.equal(convertComparableValue(6.993, 'mmol/L', glucose)?.value, 126);
    assert.equal(convertComparableValue(6.5, '%', hba1c, 'mmol/mol')?.value, 47.545);
    assert.equal(convertComparableValue(53, 'mmol/mol', hba1c)?.value, 7.00044);
    assert.equal(convertComparableValue(25, 'µg/L', ferritin)?.value, 25);
    assert.equal(convertComparableValue(20, 'ng/mL', vitaminD, 'nmol/L')?.value, 50);
    assert.equal(convertComparableValue(200, 'pg/mL', vitaminB12, 'pmol/L')?.value, 147.6);
    assert.equal(convertComparableValue(200, 'mg/dL', glucose, 'ng/mL'), null);
  });

  it('suppresses guidance for unknown applicability and for families whose thresholds are not safely portable', () => {
    const glucose = findCatalogueBiomarker('biomarker.glucose')!;
    const hba1c = findCatalogueBiomarker('biomarker.hba1c')!;
    const ferritin = findCatalogueBiomarker('biomarker.ferritin')!;
    const vitaminD = findCatalogueBiomarker('biomarker.vitamin_d_total')!;
    const vitaminB12 = findCatalogueBiomarker('biomarker.vitamin_b12_total')!;
    const unknown = {
      population: 'adults' as const,
      jurisdiction: 'US',
      sex: 'unknown' as const,
      fasting: 'unknown' as const,
    };

    assert.deepEqual(selectApplicableGeneralGuidance(glucose, unknown), []);
    assert.deepEqual(selectApplicableGeneralGuidance(hba1c, unknown), []);
    assert.deepEqual(
      selectApplicableGeneralGuidance(ferritin, { ...unknown, sex: 'female', fasting: 'fasting' }),
      [],
    );
    assert.deepEqual(
      selectApplicableGeneralGuidance(vitaminD, {
        ...unknown,
        sex: 'male',
        fasting: 'non-fasting',
      }),
      [],
    );
    assert.deepEqual(
      selectApplicableGeneralGuidance(vitaminB12, {
        ...unknown,
        sex: 'female',
        fasting: 'non-fasting',
      }),
      [],
    );
    assert.equal(
      selectApplicableGeneralGuidance(glucose, {
        population: 'adults',
        jurisdiction: 'US',
        sex: 'female',
        fasting: 'fasting',
        purpose: 'screening',
        specimen: 'plasma',
      })[0]?.guidanceId,
      'guidance.glucose.fasting-screening-us',
    );
    assert.equal(
      selectApplicableGeneralGuidance(hba1c, {
        population: 'adults',
        jurisdiction: 'US',
        sex: 'male',
        fasting: 'non-fasting',
        purpose: 'screening',
        specimen: 'blood',
      })[0]?.guidanceId,
      'guidance.hba1c.screening-us',
    );
  });

  it('does not invent a direction when exact glucose quantities use different units', () => {
    const records = [
      record('same-quantity-1', { kind: 'known', value: '2026-01-01' }, 'serum', [
        measurement(
          'same-quantity-mg',
          'same-quantity-1',
          'biomarker.glucose',
          { kind: 'numeric', value: 126 },
          'mg/dL',
          'serum',
        ),
      ]),
      record('same-quantity-2', { kind: 'known', value: '2026-02-01' }, 'plasma', [
        measurement(
          'same-quantity-mmol',
          'same-quantity-2',
          'biomarker.glucose',
          { kind: 'numeric', value: 6.993 },
          'mmol/L',
          'plasma',
        ),
      ]),
    ];
    const trend = buildMeasuredTrend(
      records,
      canonicalId('biomarker.glucose'),
      metabolicMicronutrientBiomarkers,
    );
    assert.equal(trend.points.length, 2);
    assert.equal(trend.direction, 'stable');
  });

  it('keeps required-method families as typed non-points when source method details are absent', () => {
    const trend = buildMeasuredTrend(
      [
        record('methodless', { kind: 'known', value: '2026-01-01' }, 'serum', [
          measurement(
            'methodless-vitamin-d',
            'methodless',
            'biomarker.vitamin_d_total',
            { kind: 'numeric', value: 20 },
            'ng/mL',
            'serum',
            '20',
            '25-OH Vitamin D',
          ),
        ]),
      ],
      canonicalId('biomarker.vitamin_d_total'),
      metabolicMicronutrientBiomarkers,
    );
    assert.equal(trend.points.length, 0);
    assert.equal(trend.nonPoints[0]?.reason, 'incompatible-method');
  });

  it('keeps specimen ambiguity, bounds, missing dates, and absent tests outside an interpolated trend', () => {
    const glucoseId = 'biomarker.glucose';
    const records = [
      record('r1', { kind: 'known', value: '2026-01-01' }, 'serum', [
        measurement('m1', 'r1', glucoseId, { kind: 'numeric', value: 90 }, 'mg/dL', 'serum', '90'),
      ]),
      record('r2', { kind: 'known', value: '2026-02-01' }, 'serum', []),
      record('r3', { kind: 'known', value: '2026-03-01' }, 'plasma', [
        measurement(
          'm3',
          'r3',
          glucoseId,
          { kind: 'numeric', value: 6.993 },
          'mmol/L',
          'plasma',
          '6,993',
        ),
      ]),
      record('r4', { kind: 'known', value: '2026-04-01' }, 'serum', [
        measurement(
          'm4',
          'r4',
          glucoseId,
          { kind: 'bounded', comparator: '<', value: 5.6 },
          'mmol/L',
          'serum',
          '<5,6',
        ),
      ]),
      record('r5', { kind: 'missing' }, 'serum', [
        measurement('m5', 'r5', glucoseId, { kind: 'numeric', value: 95 }, 'mg/dL', 'serum', '95'),
      ]),
      record('r6', { kind: 'known', value: '2026-06-01' }, 'urine', [
        measurement('m6', 'r6', glucoseId, { kind: 'numeric', value: 95 }, 'mg/dL', 'urine', '95'),
      ]),
    ];
    const trend = buildMeasuredTrend(
      records,
      canonicalId(glucoseId),
      metabolicMicronutrientBiomarkers,
    );
    assert.deepEqual(
      trend.points.map((point) => point.measurementId),
      ['m1', 'm3'],
    );
    assert.equal(trend.points[1]?.source.valueString, '6,993');
    assert.equal(trend.points[1]?.normalized.value, 126);
    assert.equal(trend.segments.length, 2);
    assert.deepEqual(
      trend.nonPoints.map((item) => item.kind),
      ['not-measured', 'bounded', 'incompatible', 'date-missing'],
    );
    assert.equal(trend.nonPoints[2]?.reason, 'incompatible-specimen');
  });

  it('keeps categorical, bounded, date-missing, and unsupported-unit cases honest for every family', () => {
    for (const [index, entry] of metabolicMicronutrientBiomarkers.entries()) {
      const specimen = entry.specimens[0]!;
      const unit = entry.canonicalUnit!;
      const label =
        entry.id === 'biomarker.vitamin_d_total'
          ? '25-OH Vitamin D LC-MS/MS'
          : entry.id === 'biomarker.vitamin_b12_total'
            ? 'Vitamin B12 immunoassay'
            : entry.canonicalLabel!;
      const records = [
        record(`family-${index}-point`, { kind: 'known', value: '2026-01-01' }, specimen, [
          measurement(
            `family-${index}-point-measurement`,
            `family-${index}-point`,
            entry.id,
            { kind: 'numeric', value: 10 },
            unit,
            specimen,
            undefined,
            label,
          ),
        ]),
        record(`family-${index}-bounded`, { kind: 'known', value: '2026-02-01' }, specimen, [
          measurement(
            `family-${index}-bounded-measurement`,
            `family-${index}-bounded`,
            entry.id,
            { kind: 'bounded', comparator: '<', value: 10 },
            unit,
            specimen,
          ),
        ]),
        record(`family-${index}-categorical`, { kind: 'known', value: '2026-03-01' }, specimen, [
          measurement(
            `family-${index}-categorical-measurement`,
            `family-${index}-categorical`,
            entry.id,
            { kind: 'categorical', value: 'not reported as a number' },
            unit,
            specimen,
          ),
        ]),
        record(`family-${index}-date-missing`, { kind: 'missing' }, specimen, [
          measurement(
            `family-${index}-date-missing-measurement`,
            `family-${index}-date-missing`,
            entry.id,
            { kind: 'numeric', value: 10 },
            unit,
            specimen,
          ),
        ]),
        record(
          `family-${index}-unsupported-unit`,
          { kind: 'known', value: '2026-05-01' },
          specimen,
          [
            measurement(
              `family-${index}-unsupported-unit-measurement`,
              `family-${index}-unsupported-unit`,
              entry.id,
              { kind: 'numeric', value: 10 },
              'unsupported-unit',
              specimen,
            ),
          ],
        ),
      ];
      const trend = buildMeasuredTrend(
        records,
        canonicalId(entry.id),
        metabolicMicronutrientBiomarkers,
      );
      assert.equal(trend.points.length, 1, entry.id);
      assert.deepEqual(
        trend.nonPoints.map((item) => item.kind),
        ['bounded', 'incompatible', 'incompatible', 'date-missing'],
        entry.id,
      );
      assert.equal(trend.nonPoints[1]?.reason, 'non-numeric-value', entry.id);
      assert.equal(trend.nonPoints[2]?.reason, 'incompatible-unit', entry.id);
    }
  });
});
