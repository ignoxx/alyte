import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalId,
  type LabRecord,
  type Measurement,
  type MeasurementSnapshot,
} from '@alyte/domain';
import {
  buildBiomarkerHistoryViewModel,
  buildHistoryAccessibilityLabel,
  formatNormalizedTrendValue,
  getHistoryChartConnections,
  getHistoryChartLayout,
  getHistoryTimelineLayout,
  historyPointValuePresentation,
  listHistoryEntries,
  type HistoryAccessibilityCopy,
} from './biomarker-history-model';

test('history chart does not bridge an explicit missing result', () => {
  const model = buildBiomarkerHistoryViewModel(
    [
      record('r1', { kind: 'known', value: '2026-01-01' }, [
        measurement('m1', 'r1', { kind: 'numeric', value: 110 }),
      ]),
      record('r2', { kind: 'known', value: '2026-02-01' }, []),
      record('r3', { kind: 'known', value: '2026-03-01' }, [
        measurement('m3', 'r3', { kind: 'numeric', value: 90 }),
      ]),
    ],
    'biomarker.ldl_c',
  );

  assert.ok(model);
  assert.equal(model.trend.segments.length, 2);
  assert.deepEqual(
    getHistoryChartConnections(model.trend.segments).map(([start, end]) => [
      start.measurementId,
      end.measurementId,
    ]),
    [],
  );
});

test('history chart connects points inside the same measured segment', () => {
  const model = buildBiomarkerHistoryViewModel(
    [
      record('r1', { kind: 'known', value: '2026-01-01' }, [
        measurement('m1', 'r1', { kind: 'numeric', value: 110 }),
      ]),
      record('r2', { kind: 'known', value: '2026-02-01' }, [
        measurement('m2', 'r2', { kind: 'numeric', value: 100 }),
      ]),
    ],
    'biomarker.ldl_c',
  );

  assert.ok(model);
  assert.deepEqual(
    getHistoryChartConnections(model.trend.segments).map(([start, end]) => [
      start.measurementId,
      end.measurementId,
    ]),
    [['m1', 'm2']],
  );
});

test('history timeline stacks value and status at accessibility Dynamic Type sizes', () => {
  assert.equal(getHistoryTimelineLayout(1), 'inline');
  assert.equal(getHistoryTimelineLayout(1.29), 'inline');
  assert.equal(getHistoryTimelineLayout(1.3), 'stacked');
  assert.equal(getHistoryTimelineLayout(3.2), 'stacked');
  assert.equal(getHistoryTimelineLayout(Number.NaN), 'inline');
});

test('history chart keeps compact geometry and grows room for scaled annotations', () => {
  assert.deepEqual(getHistoryChartLayout(1), {
    chartHeight: 220,
    plotPadding: 28,
    axisLabelInset: 8,
  });
  assert.deepEqual(getHistoryChartLayout(1.6), {
    chartHeight: 288,
    plotPadding: 40,
    axisLabelInset: 13,
  });
  const maximum = getHistoryChartLayout(3.2);
  assert.ok(maximum.chartHeight > 500);
  assert.ok(maximum.plotPadding > 60);
  assert.ok(maximum.axisLabelInset > 20);
  assert.deepEqual(getHistoryChartLayout(Number.NaN), getHistoryChartLayout(1));
});

test('converted trend values hide floating-point noise without changing source values', () => {
  assert.equal(formatNormalizedTrendValue(99.099099099099, 'en-US'), '99.1');
  assert.equal(formatNormalizedTrendValue(146.946, 'de-DE'), '146,9');
});

test('history leads with the saved result and labels a derived chart conversion', () => {
  const model = buildBiomarkerHistoryViewModel(
    [
      record('r-converted', { kind: 'known', value: '2026-01-01' }, [
        measurement(
          'm-converted',
          'r-converted',
          { kind: 'numeric', value: 3.8 },
          { unit: 'mmol/L', valueString: '3,8' },
        ),
      ]),
    ],
    'biomarker.ldl_c',
  );
  assert.ok(model);
  const item = model.timeline[0];
  assert.ok(item?.kind === 'point');
  assert.deepEqual(historyPointValuePresentation(item.point, item.current, 'de-DE'), {
    result: '3,8 mmol/L',
    chartValue: '146,9 mg/dL',
  });

  const sameUnitModel = buildBiomarkerHistoryViewModel(
    [
      record('r-same-unit', { kind: 'known', value: '2026-01-01' }, [
        measurement('m-same-unit', 'r-same-unit', { kind: 'numeric', value: 110 }),
      ]),
    ],
    'biomarker.ldl_c',
  );
  assert.ok(sameUnitModel);
  const sameUnit = sameUnitModel.timeline[0];
  assert.ok(sameUnit?.kind === 'point');
  assert.deepEqual(historyPointValuePresentation(sameUnit.point, sameUnit.current, 'en-US'), {
    result: '110 mg/dL',
    chartValue: null,
  });
});

const copy: HistoryAccessibilityCopy = {
  chart: 'Measured trend',
  measuredPoint: 'Measured point',
  current: 'Current result',
  chartValue: 'Chart value',
  nonPoint: {
    'not-measured': 'Not measured',
    'date-missing': 'Collection date missing',
    bounded: 'Bounded result',
    incompatible: 'Incompatible result',
    unsupported: 'Unsupported result',
  },
  date: 'Collection date',
  source: 'Original source',
  sourceEntry: 'Original entry',
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
      readonly specimenType?: Measurement['specimenType'];
      readonly panelLabel?: string | null;
      readonly current?: Partial<MeasurementSnapshot>;
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
  const current = {
    ...snapshot,
    ...options.current,
    value: options.current?.value ?? snapshot.value,
    valueString: options.current?.valueString ?? snapshot.valueString,
    unit: options.current?.unit ?? snapshot.unit,
    referenceInterval: options.current?.referenceInterval ?? snapshot.referenceInterval,
    flag: options.current?.flag ?? snapshot.flag,
  };
  return {
    id,
    labRecordId: recordId,
    biomarkerId,
    specimenType: options.specimenType ?? 'serum',
    panelLabel: options.panelLabel ?? 'Lipids',
    original: snapshot,
    originalState: {
      biomarkerId,
      specimenType: options.specimenType ?? 'serum',
      snapshot,
      reviewState: options.reviewState ?? 'confirmed',
      provenance: options.provenance ?? 'extracted',
      source: null,
    },
    current,
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
        {
          valueString: '<100',
          provenance: 'user-corrected',
          current: {
            value: { kind: 'bounded', comparator: '<', value: 90 },
            valueString: '<90',
            referenceInterval: '<80',
            flag: 'H',
          },
        },
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
  const corrected = model.timeline.find(
    (item) => item.kind === 'non-point' && item.nonPoint.measurementId === 'm3',
  );
  assert.ok(corrected && corrected.kind === 'non-point');
  assert.equal(corrected.current?.valueString, '<90');
  assert.equal(corrected.original?.valueString, '<100');
  assert.equal(corrected.provenance, 'user-corrected');
  assert.deepEqual(corrected.laboratoryReference, { interval: '<80', flag: 'H' });
  const correctedLabel = buildHistoryAccessibilityLabel(model, copy, 'en-US');
  assert.ok(
    correctedLabel.indexOf('Current result LDL-C: <90') <
      correctedLabel.indexOf('Original source LDL-C: <100'),
  );
  assert.match(correctedLabel, /Laboratory interval <80, Laboratory flag H, User-corrected/);
  assert.deepEqual(
    model.trend.generalGuidance.map((guidance) => guidance.guidanceId),
    ['guidance.ldl-c.screening-us'],
  );
  assert.deepEqual(model.guidance, { kind: 'not-applicable', reason: 'pending-review' });
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
  const label = buildHistoryAccessibilityLabel(model, copy, 'en-US');
  assert.ok(label.indexOf('Measured point') < label.indexOf('Not measured'));
  assert.ok(label.indexOf('Not measured') < label.indexOf('Collection date missing'));
  assert.match(label, /Original source LDL-C: 110 mg\/dL/);
  assert.match(label, /Laboratory interval <100/);
});

test('VoiceOver uses localized dates and decimals for a converted comma-decimal source', () => {
  const model = buildBiomarkerHistoryViewModel(
    [
      record('r-comma', { kind: 'known', value: '2026-01-01' }, [
        measurement(
          'm-comma',
          'r-comma',
          { kind: 'numeric', value: 3.8 },
          { unit: 'mmol/L', valueString: '3,8' },
        ),
      ]),
    ],
    'biomarker.ldl_c',
  );
  assert.ok(model);
  const label = buildHistoryAccessibilityLabel(model, copy, 'de-DE');
  assert.match(label, /01\.01\.2026/);
  assert.match(label, /Current result 3,8 mmol\/L; Chart value 146,9 mg\/dL/);
});

test('VoiceOver does not describe a manual result as an Original Report', () => {
  const entered = measurement(
    'm-manual',
    'r-manual',
    { kind: 'numeric', value: 92 },
    { provenance: 'user-entered' },
  );
  const manual = {
    ...entered,
    source: null,
    originalState: { ...entered.originalState, source: null },
  };
  const enteredModel = buildBiomarkerHistoryViewModel(
    [record('r-manual', { kind: 'known', value: '2026-01-01' }, [manual])],
    'biomarker.ldl_c',
  );
  assert.ok(enteredModel);
  const enteredLabel = buildHistoryAccessibilityLabel(enteredModel, copy, 'en-US');
  assert.doesNotMatch(enteredLabel, /Original source|Original entry/);

  const corrected = {
    ...manual,
    provenance: 'user-corrected' as const,
    current: {
      ...manual.current,
      value: { kind: 'numeric' as const, value: 93 },
      valueString: '93',
    },
  };
  const correctedModel = buildBiomarkerHistoryViewModel(
    [record('r-corrected', { kind: 'known', value: '2026-02-01' }, [corrected])],
    'biomarker.ldl_c',
  );
  assert.ok(correctedModel);
  assert.match(
    buildHistoryAccessibilityLabel(correctedModel, copy, 'en-US'),
    /Original entry LDL-C: 92 mg\/dL/,
  );
});

test('production history keeps guidance ambiguity explicit when context is absent', () => {
  const model = buildBiomarkerHistoryViewModel(
    [
      record('r-context', { kind: 'known', value: '2026-01-01' }, [
        measurement('m-context', 'r-context', { kind: 'numeric', value: 110 }),
      ]),
    ],
    'biomarker.ldl_c',
  );
  assert.ok(model);
  assert.deepEqual(model.guidance, { kind: 'not-applicable', reason: 'context-unavailable' });
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

test('unknown history without a source measurement is unavailable', () => {
  assert.equal(buildBiomarkerHistoryViewModel([], 'biomarker.missing'), null);
});

test('non-lipid history keeps every representative non-point state and source range visible', () => {
  const model = buildBiomarkerHistoryViewModel(
    [
      record(
        'alt-exact',
        { kind: 'known', value: '2026-01-01' },
        [
          measurement(
            'alt-exact-measurement',
            'alt-exact',
            { kind: 'numeric', value: 22 },
            {
              biomarkerId: canonicalId('biomarker.alt'),
              label: 'ALT (IFCC 37 C with P5P)',
              unit: 'U/L',
              referenceInterval: '<40 U/L',
              flag: 'H',
              specimenType: 'blood',
              provenance: 'user-corrected',
              current: {
                value: { kind: 'numeric', value: 24 },
                valueString: '24',
                referenceInterval: '<35 U/L',
                flag: 'H',
              },
            },
          ),
        ],
        'blood',
      ),
      record('alt-missing', { kind: 'known', value: '2026-02-01' }, [], 'blood'),
      record(
        'alt-bounded',
        { kind: 'known', value: '2026-03-01' },
        [
          measurement(
            'alt-bounded-measurement',
            'alt-bounded',
            { kind: 'bounded', comparator: '<', value: 40 },
            {
              biomarkerId: canonicalId('biomarker.alt'),
              label: 'ALT (IFCC 37 C with P5P)',
              unit: 'U/L',
              referenceInterval: '<40 U/L',
              specimenType: 'blood',
            },
          ),
        ],
        'blood',
      ),
      record(
        'alt-incompatible-specimen',
        { kind: 'known', value: '2026-04-01' },
        [
          measurement(
            'alt-incompatible-specimen-measurement',
            'alt-incompatible-specimen',
            {
              kind: 'numeric',
              value: 24,
            },
            {
              biomarkerId: canonicalId('biomarker.alt'),
              label: 'ALT (IFCC 37 C with P5P)',
              unit: 'U/L',
              referenceInterval: '<40 U/L',
              specimenType: 'serum',
            },
          ),
        ],
        'blood',
      ),
      record(
        'alt-incompatible-method',
        { kind: 'known', value: '2026-05-01' },
        [
          measurement(
            'alt-incompatible-method-measurement',
            'alt-incompatible-method',
            {
              kind: 'numeric',
              value: 25,
            },
            {
              biomarkerId: canonicalId('biomarker.alt'),
              label: 'ALT',
              unit: 'U/L',
              referenceInterval: '<40 U/L',
              specimenType: 'blood',
            },
          ),
        ],
        'blood',
      ),
      record(
        'alt-date-missing',
        { kind: 'missing' },
        [
          measurement(
            'alt-date-missing-measurement',
            'alt-date-missing',
            {
              kind: 'numeric',
              value: 23,
            },
            {
              biomarkerId: canonicalId('biomarker.alt'),
              label: 'ALT (IFCC 37 C with P5P)',
              unit: 'U/L',
              referenceInterval: '<40 U/L',
              specimenType: 'blood',
            },
          ),
        ],
        'blood',
      ),
    ],
    'biomarker.alt',
  );

  assert.ok(model);
  assert.deepEqual(
    model.timeline.map((item) => (item.kind === 'point' ? 'point' : item.nonPoint.kind)),
    ['point', 'not-measured', 'bounded', 'incompatible', 'incompatible', 'date-missing'],
  );
  assert.equal(model.timeline[0]?.kind, 'point');
  if (model.timeline[0]?.kind === 'point') {
    assert.deepEqual(model.timeline[0].point.laboratoryReference, {
      interval: '<35 U/L',
      flag: 'H',
    });
    assert.equal(model.timeline[0].current?.valueString, '24');
    assert.equal(model.timeline[0].original?.valueString, '22');
    assert.equal(model.timeline[0].provenance, 'user-corrected');
  }
  assert.deepEqual(
    model.timeline
      .filter(
        (item): item is Extract<typeof item, { kind: 'non-point' }> => item.kind === 'non-point',
      )
      .map((item) => item.nonPoint.reason),
    [undefined, undefined, 'incompatible-specimen', 'incompatible-method', undefined],
  );
  assert.equal(model.guidance.kind, 'not-applicable');
  assert.equal(model.guidance.reason, 'context-unavailable');
  const accessibilityLabel = buildHistoryAccessibilityLabel(model, copy, 'en-US');
  assert.ok(
    accessibilityLabel.indexOf('Current result ALT: 24 U/L') <
      accessibilityLabel.indexOf('Original source ALT (IFCC 37 C with P5P): 22 U/L'),
  );
  assert.match(
    accessibilityLabel,
    /Laboratory interval <35 U\/L, Laboratory flag H, User-corrected/,
  );
  assert.match(accessibilityLabel, /Incompatible result/);
});
