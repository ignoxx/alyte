import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGeometryCandidateWindows,
  groupGeometryCandidateWindows,
  reconstructGeometryLattice,
  type VisionTextObservation,
} from '@alyte/domain';
import {
  buildPaddleOCRRetryPlan,
  createPaddleOCRReviewRows,
  createLocalPaddleOCR,
  deduplicatePaddleOCRRows,
  groundPaddleOCRRows,
  parsePaddleOCRText,
  PaddleOCRTruncatedError,
} from './paddleocr';
import { productionLocalModelManifest } from './production-manifest.generated';
import type { LocalModelService } from './native';
import type { LocalModelSnapshot } from './model';

const loadedState: LocalModelSnapshot = {
  packId: productionLocalModelManifest.pack.id,
  state: 'loaded',
  bytesReceived: productionLocalModelManifest.pack.bytes,
  expectedBytes: productionLocalModelManifest.pack.bytes,
  progress: 1,
  failure: null,
  storageBytes: productionLocalModelManifest.pack.bytes,
  loaded: true,
};

function models(
  inferImageRaw: (
    prompt: string,
    imageURI: string,
    limits: { maxOutputTokens: number; outputCapacity: number },
  ) => Promise<string>,
  overrides: Partial<LocalModelService> = {},
): LocalModelService {
  return {
    getState: async () => loadedState,
    load: async () => loadedState,
    unload: async () => ({ ...loadedState, state: 'ready', loaded: false }),
    inferImageRaw,
    infer: async () => '{}',
    inferImage: async () => '{}',
    cancelInference: () => undefined,
    ...overrides,
  } as LocalModelService;
}

function cancellationController(): {
  readonly cancellation: {
    readonly isCancelled: () => boolean;
    readonly subscribe: (listener: () => void) => () => void;
  };
  readonly cancel: () => void;
} {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    cancellation: {
      isCancelled: () => cancelled,
      subscribe: (listener) => {
        if (cancelled) {
          listener();
          return () => undefined;
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      for (const listener of listeners) listener();
    },
  };
}

function cell(id: string, text: string, x: number, columnIndex: number): VisionTextObservation {
  return {
    id,
    text,
    boundingBox: { x, y: 0.25, width: 0.18, height: 0.035 },
    pageIndex: 0,
    orientation: 0,
    alternatives: [],
    recognition: { level: 'accurate', language: 'en', internalConfidence: null },
    structure: {
      kind: 'table-cell',
      tableId: 'results',
      rowIndex: 0,
      columnIndex,
    },
  };
}

test('parses numeric, bounded, categorical, and result-text rows while retaining source strings', () => {
  const rows = parsePaddleOCRText(
    [
      'Hemoglobin 13.4 g/dL 12.0-16.0',
      'Vitamin D <20 ng/mL Low',
      'Urinalysis protein Negative Negative/Trace',
      'Culture Pending',
      'Note: 42 is not a patient result',
    ].join('\n'),
  );
  assert.deepEqual(rows[0], {
    label: 'Hemoglobin',
    value: '13.4',
    unit: 'g/dL',
    referenceInterval: '12.0-16.0',
    flag: null,
    valueType: 'numeric',
    parsedValue: 13.4,
    comparator: null,
  });
  assert.deepEqual(rows[1], {
    label: 'Vitamin D',
    value: '<20',
    unit: 'ng/mL',
    referenceInterval: null,
    flag: null,
    valueType: 'bounded',
    parsedValue: 20,
    comparator: '<',
  });
  assert.equal(rows[2]?.valueType, 'categorical');
  assert.equal(rows[2]?.value, 'Negative');
  assert.equal(rows[3]?.valueType, 'text');
  assert.equal(rows[3]?.value, 'Pending');
  assert.equal(
    rows.some((row) => row.label.startsWith('Note')),
    false,
  );
});

test('parses Lithuanian rows when the measured value follows the unit and range', () => {
  const rows = parsePaddleOCRText('Vitaminas B12 µmol/l 11,1–19,5 12,96');

  assert.deepEqual(rows, [
    {
      label: 'Vitaminas B12',
      value: '12,96',
      unit: 'µmol/l',
      referenceInterval: '11,1–19,5',
      flag: null,
      valueType: 'numeric',
      parsedValue: 12.96,
      comparator: null,
    },
  ]);
});

test('binds the measured value after a spaced reference range', () => {
  for (const dash of ['-', '–', '—']) {
    const rows = parsePaddleOCRText(
      `AB Vitaminas B12 pmol/l 145,0 ${dash} 569,0 594,0 BT001744 NV`,
    );
    assert.deepEqual(rows, [
      {
        label: 'AB Vitaminas B12',
        value: '594,0',
        unit: 'pmol/l',
        referenceInterval: `145,0 ${dash} 569,0`,
        flag: null,
        valueType: 'numeric',
        parsedValue: 594,
        comparator: null,
      },
    ]);
  }
});

test('rejects unbounded flattened prose numbers and caps untrusted output', () => {
  assert.deepEqual(parsePaddleOCRText('The patient is 42 years old'), []);
  assert.throws(() => parsePaddleOCRText('x'.repeat(200_001)), /too-large/);
  assert.throws(() => parsePaddleOCRText(`${'x\n'.repeat(4_096)}x`), /too-many-lines/);
});

test('rejects repetitive model output before it can become review work', () => {
  assert.throws(
    () =>
      parsePaddleOCRText(
        ['Marker A 1 mg/L', 'Marker B 2 mg/L', 'Marker A 1 mg/L', 'Marker B 2 mg/L'].join('\n'),
      ),
    /pathological-repetition/,
  );
});

test('preserves an ungrounded OCR row only as page-level mandatory review work', () => {
  const rows = createPaddleOCRReviewRows(
    new Map([
      [
        3,
        [
          {
            label: 'Novel Marker',
            value: '7.4',
            unit: 'U/L',
            referenceInterval: '4.0-8.0',
            flag: null,
          },
        ],
      ],
    ]),
    {
      locale: 'en-US',
      collectionDate: { kind: 'known', value: '2026-08-31' },
      collectionDateDefaulted: false,
      collectionDateContexts: [],
      aliases: [],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.reviewState, 'needs-review');
  assert.equal(rows[0]?.decision, 'preserve');
  assert.ok(rows[0]?.reviewReasons.includes('unsupported-layout'));
  assert.equal(rows[0]?.source.pageIndex, 3);
  assert.deepEqual(rows[0]?.source.boundingBox, { x: 0, y: 0, width: 1, height: 1 });
  assert.equal(rows[0]?.source.semantic?.schemaVersion, 'alyte.paddleocr-vl.flat-rows.v1');
});

test('canonicalizes a mapped ungrounded Lithuanian label while preserving source provenance', () => {
  const sourceLabel = 'AB Vitaminas B12';
  const rows = createPaddleOCRReviewRows(
    new Map([
      [
        0,
        [
          {
            label: sourceLabel,
            value: '594,0',
            unit: 'pmol/l',
            referenceInterval: '145,0 - 569,0',
            flag: null,
          },
        ],
      ],
    ]),
    {
      locale: 'lt-LT',
      collectionDate: { kind: 'known', value: '2026-08-31' },
      collectionDateDefaulted: false,
      collectionDateContexts: [],
      aliases: [
        {
          id: 'biomarker.vitamin_b12_total',
          canonicalLabel: 'Total vitamin B12',
          aliases: [sourceLabel],
          specimens: ['serum'],
          units: ['pmol/L'],
        },
      ],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );

  const row = rows[0];
  assert.equal(row?.sourceLabel, sourceLabel);
  assert.equal(row?.proposedLabel, 'Total vitamin B12');
  assert.equal(row?.proposedBiomarkerId, 'biomarker.vitamin_b12_total');
  assert.equal(row?.source.raw?.label, sourceLabel);
  assert.equal(row?.source.observations?.[0]?.text, sourceLabel);
  assert.equal(row?.reviewState, 'needs-review');
  assert.equal(row?.decision, 'preserve');
});

test('rejects a flattened candidate that repeats the complete row as label and value', () => {
  const flattened = 'Cinkas µmol/L 10,0 - 20,0 13,2';
  const rows = createPaddleOCRReviewRows(
    new Map([
      [
        0,
        [{ label: flattened, value: flattened, unit: null, referenceInterval: null, flag: null }],
      ],
    ]),
    {
      locale: 'lt-LT',
      collectionDate: { kind: 'missing' },
      collectionDateDefaulted: false,
      collectionDateContexts: [],
      aliases: [],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );

  assert.deepEqual(rows, []);
});

test('keeps the defaulted collection date marker on model-only OCR rows', () => {
  const rows = createPaddleOCRReviewRows(
    new Map([
      [
        4,
        [
          {
            label: 'Synthetic marker',
            value: '7.4',
            unit: 'U/L',
            referenceInterval: '4.0-8.0',
            flag: null,
          },
        ],
      ],
    ]),
    {
      locale: 'en-US',
      collectionDate: { kind: 'known', value: '2026-08-31' },
      collectionDateDefaulted: true,
      collectionDateContexts: [],
      aliases: [],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );

  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.reviewReasons.includes('defaulted-collection-date'));
});

test('retry plan runs one full-page capture before overlapping 600px bands', () => {
  const plan = buildPaddleOCRRetryPlan({ pageIndex: 2, pageHeightPx: 1_800 });
  assert.equal(plan.requests[0]?.kind, 'full-page');
  assert.deepEqual(
    plan.requests.slice(1).map((request) => [request.yPx, request.heightPx]),
    [
      [0, 600],
      [400, 600],
      [800, 600],
      [1200, 600],
      [1600, 200],
    ],
  );
  assert.equal(plan.requests.at(-1)?.overlapPx, 200);
});

test('grounds one Paddle row to exactly one same-page source row and discards model fields', () => {
  const observations = [
    cell('label', 'Novel Marker', 0.05, 0),
    cell('value', '7.4', 0.35, 1),
    cell('unit', 'U/L', 0.55, 2),
    cell('reference', '4.0 - 8.0', 0.73, 3),
  ];
  const groups = groupGeometryCandidateWindows(
    buildGeometryCandidateWindows(reconstructGeometryLattice(observations), observations),
  );
  const result = groundPaddleOCRRows(
    new Map([
      [
        0,
        [
          {
            label: 'novel marker',
            value: '7.4',
            unit: 'U/L',
            referenceInterval: '4.0 - 8.0',
            flag: null,
            valueType: 'numeric',
            parsedValue: 7.4,
            comparator: null,
          },
        ],
      ],
    ]),
    groups,
    {
      locale: 'en-US',
      collectionDate: { kind: 'known', value: '2026-08-31' },
      collectionDateDefaulted: false,
      collectionDateContexts: [],
      aliases: [],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );
  assert.equal(result.matchedPhysicalRows, 1);
  assert.deepEqual([...result.matchedProposalKeys], ['0:0']);
  assert.equal(result.rows[0]?.sourceLabel, 'Novel Marker');
  assert.equal(result.rows[0]?.sourceValueString, '7.4');
  assert.equal(result.rows[0]?.sourceUnit, 'U/L');
  assert.equal(result.rows[0]?.proposedBiomarkerId, null);
  assert.equal(
    result.rows[0]?.source.semantic?.adapterVersion,
    'alyte.paddleocr-vl16.text-extractor.v1',
  );
  assert.deepEqual(result.rows[0]?.source.semantic?.sourceObservationIds, [
    'label',
    'value',
    'unit',
    'reference',
  ]);
  assert.equal(result.rows[0]?.reviewState, 'needs-review');
});

test('refuses ambiguous or cross-row proposals instead of selecting a plausible source', () => {
  const first = [cell('label-a', 'Marker A', 0.05, 0), cell('value-a', '7.4', 0.35, 1)];
  const second = [cell('label-b', 'Marker B', 0.05, 0), cell('value-b', '7.4', 0.35, 1)];
  const source = [
    ...first,
    ...second.map((item) => ({ ...item, boundingBox: { ...item.boundingBox, y: 0.45 } })),
  ];
  const groups = groupGeometryCandidateWindows(
    buildGeometryCandidateWindows(reconstructGeometryLattice(source), source),
  );
  const result = groundPaddleOCRRows(
    new Map([
      [
        0,
        [
          {
            label: 'Marker',
            value: '7.4',
            unit: null,
            referenceInterval: null,
            flag: null,
            valueType: 'numeric',
            parsedValue: 7.4,
            comparator: null,
          },
        ],
      ],
    ]),
    groups,
    {
      locale: 'en-US',
      collectionDate: { kind: 'missing' },
      collectionDateDefaulted: false,
      collectionDateContexts: [],
      aliases: [],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );
  assert.equal(result.rows.length, 0);
  assert.equal(result.ambiguousPhysicalRows, 1);
});

test('keeps proven flattened-row parsing boundaries and source-shaped fields', () => {
  const rows = parsePaddleOCRText(
    [
      'Reference Interval <sup>ignored</sup> Hemoglobin \\(Hgb\\) 13.4 g/dL 12.0-16.0',
      'Urinalysis protein Negative Negative/Trace',
      'Blood Group A',
      'Culture Pending',
      'Vitamin D 22 x10e3/uL 20-50',
      'Comment 42 mg/L This is explanatory prose.',
    ].join('\n'),
  );
  assert.deepEqual(rows.slice(0, 5), [
    {
      label: 'Hemoglobin',
      value: '13.4',
      unit: 'g/dL',
      referenceInterval: '12.0-16.0',
      flag: null,
      valueType: 'numeric',
      parsedValue: 13.4,
      comparator: null,
    },
    {
      label: 'Urinalysis protein',
      value: 'Negative',
      unit: null,
      referenceInterval: 'Negative/Trace',
      flag: null,
      valueType: 'categorical',
      parsedValue: 'Negative',
      comparator: null,
    },
    {
      label: 'Blood Group',
      value: 'A',
      unit: null,
      referenceInterval: null,
      flag: null,
      valueType: 'categorical',
      parsedValue: 'A',
      comparator: null,
    },
    {
      label: 'Culture',
      value: 'Pending',
      unit: null,
      referenceInterval: null,
      flag: null,
      valueType: 'text',
      parsedValue: 'Pending',
      comparator: null,
    },
    {
      label: 'Vitamin D',
      value: '22',
      unit: 'x10e3/uL',
      referenceInterval: '20-50',
      flag: null,
      valueType: 'numeric',
      parsedValue: 22,
      comparator: null,
    },
  ]);
  assert.equal(
    rows.some((row) => row.label.startsWith('Comment')),
    false,
  );
});

test('recognizes generic units and text statuses without crossing line boundaries', () => {
  const rows = parsePaddleOCRText(
    [
      'Albumin 4.2 g/dL 3.5-5.0',
      'Creatinine 0.9 mg/g creat 0-1',
      'Body composition 12 % by wt 5-20',
      'Microscopy 3 /HPF 0-5',
      'Organism U/L Detected on the submitted specimen.',
      'Molecular Test not performed.',
      'Culture See below:',
      'Pathogen Will Follow',
    ].join('\n'),
  );
  assert.equal(rows.find((row) => row.label === 'Creatinine')?.unit, 'mg/g creat');
  assert.equal(rows.find((row) => row.label === 'Body composition')?.unit, '% by wt');
  assert.equal(rows.find((row) => row.label === 'Microscopy')?.unit, '/HPF');
  assert.equal(rows.find((row) => row.label === 'Molecular')?.value, 'Test not performed.');
  assert.equal(rows.find((row) => row.label === 'Culture')?.value, 'See below:');
  assert.equal(rows.find((row) => row.label === 'Pathogen')?.value, 'Will Follow');
  assert.equal(rows.find((row) => row.label === 'Organism')?.valueType, 'text');
});

test('status rows consume preceding numeric anchors before selecting their label', () => {
  const rows = parsePaddleOCRText('Prior marker 7.0 mg/L Follow-up status Pending');
  const status = rows.find((row) => row.value === 'Pending');
  assert.equal(status?.valueType, 'text');
  assert.equal(status?.label, 'mg/L Follow-up status');
});

test('deduplicates exact retry rows and drops conflicting same-label rows', () => {
  const row = {
    label: 'Marker',
    value: '7.4',
    unit: 'U/L',
    referenceInterval: '4-8',
    flag: null,
    valueType: 'numeric' as const,
    parsedValue: 7.4,
    comparator: null,
  };
  assert.deepEqual(deduplicatePaddleOCRRows([row, { ...row }]), [row]);
  assert.deepEqual(deduplicatePaddleOCRRows([row, { ...row, value: '7.5', parsedValue: 7.5 }]), []);
});

test('projects categorical, free-text, and comparator rows without reparsing or dropping them', () => {
  const rows = createPaddleOCRReviewRows(
    new Map([
      [
        1,
        [
          {
            label: 'Synthetic categorical marker',
            value: 'None seen',
            unit: null,
            referenceInterval: null,
            flag: null,
          },
          {
            label: 'Synthetic status marker',
            value: 'Pending review by laboratory',
            unit: null,
            referenceInterval: null,
            flag: null,
            valueType: 'text',
            parsedValue: 'Pending review by laboratory',
            comparator: null,
          },
          {
            label: 'Synthetic bounded marker',
            value: '<=3.8',
            unit: 'mmol/L',
            referenceInterval: null,
            flag: null,
            valueType: 'bounded',
            parsedValue: 3.8,
            comparator: '<=',
          },
        ],
      ],
    ]),
    {
      locale: 'en-US',
      collectionDate: { kind: 'missing' },
      collectionDateDefaulted: false,
      collectionDateContexts: [],
      aliases: [],
      artifact: { kind: 'original', id: null, hash: 'synthetic-hash' },
    },
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0]?.sourceValue, { kind: 'categorical', value: 'None seen' });
  assert.equal(rows[0]?.sourceValueString, 'None seen');
  assert.deepEqual(rows[1]?.sourceValue, {
    kind: 'free_text',
    value: 'Pending review by laboratory',
  });
  assert.deepEqual(rows[2]?.sourceValue, { kind: 'free_text', value: '<=3.8' });
  assert.equal(rows[2]?.sourceValueString, '<=3.8');
  assert.equal(rows[2]?.sourceUnit, 'mmol/L');
  assert.ok(rows[2]?.reviewReasons.includes('unparseable-value'));
  for (const row of rows) {
    assert.equal(row.reviewState, 'needs-review');
    assert.equal(row.decision, 'preserve');
    assert.equal(row.editState, 'automatic');
    assert.equal(row.source.pageIndex, 1);
    assert.equal(row.source.observations?.length, row.source.observationIds.length);
    assert.ok(row.source.semantic?.sourceObservationIds.length);
    assert.equal(row.source.semantic?.sourceFieldObservationIds?.value, `${row.id}:value`);
  }
});

test('loads, extracts with literal OCR prompt and 4096-token bound, then unloads once', async () => {
  const calls: Array<{ prompt: string; maxOutputTokens: number }> = [];
  let unloadCalls = 0;
  const extractor = createLocalPaddleOCR({
    models: models(
      async (prompt, _imageURI, limits) => {
        calls.push({ prompt, maxOutputTokens: limits.maxOutputTokens });
        return 'Hemoglobin 13.4 g/dL 12.0-16.0';
      },
      {
        unload: async () => {
          unloadCalls += 1;
          return { ...loadedState, state: 'ready', loaded: false };
        },
      },
    ),
  });
  assert.equal(extractor.supports('de-DE'), true);
  assert.equal(extractor.supports('fr-FR'), false);
  const lease = await extractor.prepare();
  const rows = await extractor.extract({
    pageIndex: 0,
    imageURI: 'file:///synthetic.png',
    locale: 'en-US',
  });
  await lease.release();
  assert.equal(rows[0]?.value, '13.4');
  assert.deepEqual(calls, [{ prompt: 'OCR:', maxOutputTokens: 4096 }]);
  assert.equal(unloadCalls, 1);
});

test('classifies native truncation as a recoverable crop-retry failure', async () => {
  const extractor = createLocalPaddleOCR({
    models: models(async () => {
      throw Object.assign(new Error('RuntimeError.truncated'), { failure: 'runtime-failed' });
    }),
  });
  const lease = await extractor.prepare();
  await assert.rejects(
    extractor.extract({ pageIndex: 0, imageURI: 'file:///synthetic.png', locale: 'en-US' }),
    (error: unknown) => error instanceof PaddleOCRTruncatedError && error.recoverable,
  );
  await lease.release();
});

test('cancellation signals native stop and rejects the extraction', async () => {
  let startedResolve: (() => void) | undefined;
  let cancelCalls = 0;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const extractor = createLocalPaddleOCR({
    timeoutMs: 500,
    models: models(
      async () => {
        startedResolve?.();
        return new Promise<string>(() => undefined);
      },
      { cancelInference: () => void (cancelCalls += 1) },
    ),
  });
  const lease = await extractor.prepare();
  const controller = cancellationController();
  const extraction = extractor.extract({
    pageIndex: 0,
    imageURI: 'file:///synthetic.png',
    locale: 'en-US',
    cancellation: controller.cancellation,
  });
  await started;
  controller.cancel();
  await assert.rejects(extraction, /paddleocr-cancelled/u);
  assert.equal(cancelCalls, 1);
  await lease.release();
});

test('quarantines a hung request and unloads only after the late native settlement', async () => {
  let resolveNative: ((value: string) => void) | undefined;
  let cancelCalls = 0;
  let unloadCalls = 0;
  const extractor = createLocalPaddleOCR({
    timeoutMs: 10,
    models: models(
      async () =>
        new Promise<string>((resolve) => {
          resolveNative = resolve;
        }),
      {
        cancelInference: () => void (cancelCalls += 1),
        unload: async () => {
          unloadCalls += 1;
          return { ...loadedState, state: 'ready', loaded: false };
        },
      },
    ),
  });
  const lease = await extractor.prepare();
  const extraction = extractor.extract({
    pageIndex: 0,
    imageURI: 'file:///synthetic.png',
    locale: 'en-US',
  });
  await assert.rejects(extraction, /paddleocr-timeout/u);
  await lease.release();
  assert.equal(unloadCalls, 0);
  assert.equal(cancelCalls, 1);
  await assert.rejects(
    extractor.extract({ pageIndex: 0, imageURI: 'file:///synthetic.png', locale: 'en-US' }),
    /not loaded|previous PaddleOCR/u,
  );
  resolveNative?.('Culture Pending');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(unloadCalls, 1);
});

test('serializes overlapping retry requests and unloads after the final lease only', async () => {
  let running = 0;
  let maximumRunning = 0;
  let inferCalls = 0;
  let unloadCalls = 0;
  const extractor = createLocalPaddleOCR({
    models: models(
      async () => {
        running += 1;
        maximumRunning = Math.max(maximumRunning, running);
        inferCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return `Marker ${inferCalls} U/L`;
      },
      {
        unload: async () => {
          unloadCalls += 1;
          return { ...loadedState, state: 'ready', loaded: false };
        },
      },
    ),
  });
  const firstLease = await extractor.prepare();
  const secondLease = await extractor.prepare();
  const first = extractor.extract({ pageIndex: 0, imageURI: 'file:///one.png', locale: 'en-US' });
  const second = extractor.extract({ pageIndex: 0, imageURI: 'file:///two.png', locale: 'en-US' });
  await firstLease.release();
  assert.equal(unloadCalls, 0);
  await Promise.all([first, second]);
  await secondLease.release();
  assert.equal(maximumRunning, 1);
  assert.equal(unloadCalls, 1);
});
