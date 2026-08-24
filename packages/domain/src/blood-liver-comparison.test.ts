import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bloodLiverBiomarkers,
  bloodLiverSources,
  findCatalogueBiomarker,
  resolveBiomarkerAlias,
} from '@alyte/catalogue';
import { canonicalId } from './index.js';
import {
  buildMeasuredTrend,
  convertComparableValue,
  type LabRecord,
  type Measurement,
} from './labs.js';

function measurement(
  id: string,
  recordId: string,
  biomarkerId: string,
  value: Measurement['current']['value'],
  unit: string | null,
  specimenType: Measurement['specimenType'],
  options: { readonly label?: string; readonly valueString?: string } = {},
): Measurement {
  const canonical = canonicalId(biomarkerId);
  const snapshot = {
    label: options.label ?? biomarkerId,
    value,
    valueString:
      options.valueString ?? String(value.kind === 'numeric' ? value.value : value.value),
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

describe('blood-count and liver comparison fixtures', () => {
  it('converts only exact Hb/Hct units and records conversion provenance', () => {
    const hemoglobin = findCatalogueBiomarker('biomarker.hemoglobin')!;
    const hematocrit = findCatalogueBiomarker('biomarker.hematocrit')!;
    const alt = findCatalogueBiomarker('biomarker.alt')!;

    assert.deepEqual(convertComparableValue(140, 'g/L', hemoglobin), {
      value: 14,
      unit: 'g/dL',
      catalogueVersion: '0.2.0',
      conversionSourceIds: ['source.medlineplus.hemoglobin-test'],
    });
    assert.deepEqual(convertComparableValue(0.45, 'L/L', hematocrit), {
      value: 45,
      unit: '%',
      catalogueVersion: '0.2.0',
      conversionSourceIds: ['source.medlineplus.hematocrit-test'],
    });
    assert.equal(convertComparableValue(1, 'µkat/L', alt), null);
    assert.ok(
      bloodLiverSources.some((source) => source.id === 'source.medlineplus.hematocrit-test'),
    );
  });

  it('maps multilingual aliases and keeps sibling identities distinct', () => {
    const aliases: readonly (readonly [string, string])[] = [
      ['HGB', 'biomarker.hemoglobin'],
      ['Hämatokrit', 'biomarker.hematocrit'],
      ['MCV', 'biomarker.mcv'],
      ['ALAT', 'biomarker.alt'],
      ['ASAT', 'biomarker.ast'],
      ['Gamma-GT', 'biomarker.ggt'],
    ];
    for (const [label, id] of aliases) assert.equal(resolveBiomarkerAlias(label), id, label);
    assert.notEqual(resolveBiomarkerAlias('AST'), 'biomarker.alt');
    assert.notEqual(resolveBiomarkerAlias('ALT'), 'biomarker.ast');
    assert.notEqual(resolveBiomarkerAlias('MCH'), 'biomarker.mcv');
  });

  it('compares compatible Hb points while retaining source intervals and deterministic units', () => {
    const trend = buildMeasuredTrend(
      [
        record('hb-1', { kind: 'known', value: '2026-01-01' }, 'blood', [
          measurement(
            'hb-m1',
            'hb-1',
            'biomarker.hemoglobin',
            { kind: 'numeric', value: 13.5 },
            'g/dL',
            'blood',
          ),
        ]),
        record('hb-2', { kind: 'known', value: '2026-02-01' }, 'blood', [
          measurement(
            'hb-m2',
            'hb-2',
            'biomarker.hemoglobin',
            { kind: 'numeric', value: 140 },
            'g/L',
            'blood',
            { valueString: '140' },
          ),
        ]),
      ],
      canonicalId('biomarker.hemoglobin'),
      bloodLiverBiomarkers,
    );
    assert.deepEqual(
      trend.points.map((point) => point.measurementId),
      ['hb-m1', 'hb-m2'],
    );
    assert.equal(trend.direction, 'increased');
    assert.equal(trend.points[1]?.normalized.value, 14);
    assert.equal(trend.points[1]?.source.unit, 'g/L');
    assert.equal(trend.points[1]?.laboratoryReference.interval, 'laboratory interval');
    assert.deepEqual(trend.points[1]?.normalized.conversionSourceIds, [
      'source.medlineplus.hemoglobin-test',
    ]);
    assert.equal(trend.generalGuidance.length, 0);
  });

  it('requires specimen and explicit assay compatibility for enzyme points', () => {
    const trend = buildMeasuredTrend(
      [
        record('alt-1', { kind: 'known', value: '2026-01-01' }, 'serum', [
          measurement(
            'alt-m1',
            'alt-1',
            'biomarker.alt',
            { kind: 'numeric', value: 20 },
            'U/L',
            'serum',
            { label: 'ALT IFCC' },
          ),
        ]),
        record('alt-2', { kind: 'known', value: '2026-02-01' }, 'plasma', [
          measurement(
            'alt-m2',
            'alt-2',
            'biomarker.alt',
            { kind: 'numeric', value: 30 },
            'U/L',
            'plasma',
            { label: 'ALT IFCC' },
          ),
        ]),
        record('alt-3', { kind: 'known', value: '2026-03-01' }, 'blood', [
          measurement(
            'alt-m3',
            'alt-3',
            'biomarker.alt',
            { kind: 'numeric', value: 40 },
            'U/L',
            'blood',
            { label: 'ALT IFCC' },
          ),
        ]),
        record('alt-4', { kind: 'known', value: '2026-04-01' }, 'serum', [
          measurement(
            'alt-m4',
            'alt-4',
            'biomarker.alt',
            { kind: 'numeric', value: 50 },
            'U/L',
            'serum',
            { label: 'ALT' },
          ),
        ]),
      ],
      canonicalId('biomarker.alt'),
      bloodLiverBiomarkers,
    );
    assert.deepEqual(
      trend.points.map((point) => point.measurementId),
      ['alt-m1', 'alt-m2'],
    );
    assert.deepEqual(
      trend.nonPoints.map((nonPoint) => [nonPoint.measurementId, nonPoint.reason]),
      [
        ['alt-m3', 'incompatible-specimen'],
        ['alt-m4', 'incompatible-method'],
      ],
    );
    assert.equal(trend.direction, 'increased');
  });

  it('preserves bounded, categorical, unsupported-unit, and date-missing values as non-points', () => {
    const trend = buildMeasuredTrend(
      [
        record('mcv-1', { kind: 'known', value: '2026-01-01' }, 'blood', [
          measurement(
            'mcv-bounded',
            'mcv-1',
            'biomarker.mcv',
            { kind: 'bounded', comparator: '<', value: 80 },
            'fL',
            'blood',
          ),
        ]),
        record('mcv-2', { kind: 'known', value: '2026-02-01' }, 'blood', [
          measurement(
            'mcv-categorical',
            'mcv-2',
            'biomarker.mcv',
            { kind: 'categorical', value: 'not reported numerically' },
            'fL',
            'blood',
          ),
        ]),
        record('mcv-3', { kind: 'known', value: '2026-03-01' }, 'blood', [
          measurement(
            'mcv-unit',
            'mcv-3',
            'biomarker.mcv',
            { kind: 'numeric', value: 90 },
            'unsupported-unit',
            'blood',
          ),
        ]),
        record('mcv-4', { kind: 'missing' }, 'blood', [
          measurement(
            'mcv-date',
            'mcv-4',
            'biomarker.mcv',
            { kind: 'numeric', value: 90 },
            'fL',
            'blood',
          ),
        ]),
      ],
      canonicalId('biomarker.mcv'),
      bloodLiverBiomarkers,
    );
    assert.equal(trend.points.length, 0);
    assert.deepEqual(
      trend.nonPoints.map((nonPoint) => [nonPoint.kind, nonPoint.reason]),
      [
        ['bounded', undefined],
        ['incompatible', 'non-numeric-value'],
        ['incompatible', 'incompatible-unit'],
        ['date-missing', undefined],
      ],
    );
    assert.equal(trend.direction, 'not-comparable');
  });

  it('keeps unknown and unsupported identities outside a measured series', () => {
    const unknownSpecimen = buildMeasuredTrend(
      [
        record('ggt-1', { kind: 'known', value: '2026-01-01' }, 'serum', [
          measurement(
            'ggt-m1',
            'ggt-1',
            'biomarker.ggt',
            { kind: 'numeric', value: 20 },
            'U/L',
            'serum',
            { label: 'GGT IFCC' },
          ),
        ]),
        record('ggt-2', { kind: 'known', value: '2026-02-01' }, 'unknown', [
          measurement(
            'ggt-m2',
            'ggt-2',
            'biomarker.ggt',
            { kind: 'numeric', value: 25 },
            'U/L',
            'unknown',
            { label: 'GGT IFCC' },
          ),
        ]),
      ],
      canonicalId('biomarker.ggt'),
      bloodLiverBiomarkers,
    );
    assert.deepEqual(
      unknownSpecimen.points.map((point) => point.measurementId),
      ['ggt-m1'],
    );
    assert.equal(unknownSpecimen.nonPoints[0]?.reason, 'incompatible-specimen');

    const unsupported = buildMeasuredTrend(
      [
        record('unsupported', { kind: 'known', value: '2026-01-01' }, 'blood', [
          measurement(
            'unsupported-m',
            'unsupported',
            'biomarker.future_marker',
            { kind: 'numeric', value: 1 },
            'unit',
            'blood',
          ),
        ]),
      ],
      canonicalId('biomarker.future_marker'),
      bloodLiverBiomarkers,
    );
    assert.equal(unsupported.nonPoints[0]?.kind, 'unsupported');
    assert.equal(unsupported.nonPoints[0]?.reason, 'unsupported-canonical-id');
  });
});
