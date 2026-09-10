import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  HeaderTableMeasurement,
  LabSourceArtifact,
  VisionTextObservation,
} from '@alyte/domain';
import { createDefaultExtractionAliases } from './report-service';
import { createHeaderTableDraftRows } from './header-table-draft';

const artifact: LabSourceArtifact = { kind: 'original', id: null, hash: 'synthetic-header-hash' };

function observation(
  id: string,
  text: string,
  y: number,
  spans?: VisionTextObservation['spans'],
): VisionTextObservation {
  return {
    id,
    text,
    alternatives: [],
    boundingBox: { x: 0.1, y, width: 0.8, height: 0.04 },
    pageIndex: 0,
    orientation: 0,
    ...(spans === undefined ? {} : { spans }),
    recognition: { level: 'accurate', language: 'en', internalConfidence: null },
  };
}

function measurement(
  overrides: Partial<HeaderTableMeasurement> & Pick<HeaderTableMeasurement, 'id'>,
): HeaderTableMeasurement {
  const { id, ...patch } = overrides;
  return {
    id,
    sourceLabel: 'LDL-C',
    valueString: '3.8',
    valueType: 'numeric',
    parsedValue: 3.8,
    comparator: null,
    unit: 'mmol/L',
    referenceInterval: '0.0 - 3.0',
    flag: null,
    collectionDate: '2026-08-22',
    collectionGroup: null,
    specimen: 'serum',
    page: 1,
    location: null,
    ambiguousFields: [],
    canonicalBiomarkerId: null,
    trendEligible: null,
    labelSourceIds: ['source-row:label'],
    valueSourceIds: ['source-row:value'],
    unitSourceIds: ['source-row:unit'],
    referenceIntervalSourceIds: ['source-row:reference'],
    flagSourceIds: [],
    collectionDateSourceIds: ['source-date'],
    specimenSourceIds: [],
    sourceIds: [
      'source-row',
      'source-row:label',
      'source-row:value',
      'source-row:unit',
      'source-row:reference',
      'source-date',
    ],
    ...patch,
  };
}

const rowSpans: VisionTextObservation['spans'] = [
  {
    id: 'source-row:label',
    parentObservationId: 'source-row',
    start: 0,
    end: 5,
    text: 'LDL-C',
    boundingBox: { x: 0.1, y: 0.2, width: 0.16, height: 0.04 },
  },
  {
    id: 'source-row:value',
    parentObservationId: 'source-row',
    start: 6,
    end: 9,
    text: '3.8',
    boundingBox: { x: 0.3, y: 0.2, width: 0.1, height: 0.04 },
  },
  {
    id: 'source-row:unit',
    parentObservationId: 'source-row',
    start: 10,
    end: 16,
    text: 'mmol/L',
    boundingBox: { x: 0.45, y: 0.2, width: 0.15, height: 0.04 },
  },
  {
    id: 'source-row:reference',
    parentObservationId: 'source-row',
    start: 17,
    end: 26,
    text: '0.0 - 3.0',
    boundingBox: { x: 0.65, y: 0.2, width: 0.2, height: 0.04 },
  },
];

const boundedSpans: VisionTextObservation['spans'] = [
  {
    id: 'source-row:label',
    parentObservationId: 'source-row',
    start: 0,
    end: 5,
    text: 'LDL-C',
    boundingBox: { x: 0.1, y: 0.2, width: 0.16, height: 0.04 },
  },
  {
    id: 'source-row:value',
    parentObservationId: 'source-row',
    start: 6,
    end: 12,
    text: '<= 4.2',
    boundingBox: { x: 0.3, y: 0.2, width: 0.15, height: 0.04 },
  },
  {
    id: 'source-row:unit',
    parentObservationId: 'source-row',
    start: 13,
    end: 19,
    text: 'mmol/L',
    boundingBox: { x: 0.5, y: 0.2, width: 0.15, height: 0.04 },
  },
];

test('projects every HeaderTable source parent and span without losing exact fields', () => {
  const rows = createHeaderTableDraftRows([measurement({ id: 'header-row' })], {
    locale: 'en-US',
    observations: [
      observation('source-row', 'LDL-C 3.8 mmol/L 0.0 - 3.0', 0.2, rowSpans),
      observation('source-date', 'Collection date 22.08.2026', 0.1),
    ],
    aliases: createDefaultExtractionAliases(),
    artifact,
  });

  const row = rows[0]!;
  assert.deepEqual(row.source.observationIds, [
    'source-row',
    'source-row:label',
    'source-row:value',
    'source-row:unit',
    'source-row:reference',
    'source-date',
  ]);
  assert.deepEqual(
    row.source.observations?.map(({ id, text, sourceSpan }) => ({
      id,
      text,
      parent: sourceSpan?.parentObservationId ?? null,
    })),
    [
      { id: 'source-row', text: 'LDL-C 3.8 mmol/L 0.0 - 3.0', parent: null },
      { id: 'source-row:label', text: 'LDL-C', parent: 'source-row' },
      { id: 'source-row:value', text: '3.8', parent: 'source-row' },
      { id: 'source-row:unit', text: 'mmol/L', parent: 'source-row' },
      { id: 'source-row:reference', text: '0.0 - 3.0', parent: 'source-row' },
      { id: 'source-date', text: 'Collection date 22.08.2026', parent: null },
    ],
  );
  assert.equal(row.source.raw?.label, 'LDL-C');
  assert.equal(row.source.raw?.value, '3.8');
  assert.equal(row.source.raw?.referenceInterval, '0.0 - 3.0');
  assert.equal(row.source.raw?.collectionDate, '22.08.2026');
  assert.equal(row.sourceValue.kind, 'numeric');
  assert.equal(row.proposedBiomarkerId, 'biomarker.ldl_c');
});

test('uses a reviewed English label while preserving the HeaderTable source label', () => {
  const fields = [
    observation('zinc-label', 'Cinkas', 0.2),
    observation('zinc-value', '13,2', 0.2),
    observation('zinc-unit', 'µmol/L', 0.2),
    observation('zinc-range', '10,0 - 20,0', 0.2),
    observation('zinc-date', 'Collection date 2026-08-22', 0.1),
  ];
  const rows = createHeaderTableDraftRows(
    [
      measurement({
        id: 'zinc-row',
        sourceLabel: 'Cinkas',
        valueString: '13,2',
        parsedValue: 13.2,
        unit: 'µmol/L',
        referenceInterval: '10,0 - 20,0',
        labelSourceIds: ['zinc-label'],
        valueSourceIds: ['zinc-value'],
        unitSourceIds: ['zinc-unit'],
        referenceIntervalSourceIds: ['zinc-range'],
        collectionDateSourceIds: ['zinc-date'],
        sourceIds: fields.map(({ id }) => id),
      }),
    ],
    {
      locale: 'lt-LT',
      observations: fields,
      aliases: createDefaultExtractionAliases(),
      artifact,
    },
  );

  assert.equal(rows[0]?.sourceLabel, 'Cinkas');
  assert.equal(rows[0]?.proposedLabel, 'Zinc');
  assert.equal(rows[0]?.proposedBiomarkerId, 'biomarker.zinc');
});

test('keeps <= and >= source values as exact reviewable free text', () => {
  const rows = createHeaderTableDraftRows(
    [
      measurement({
        id: 'bounded-header-row',
        valueString: '<= 4.2',
        valueType: 'bounded',
        parsedValue: 4.2,
        comparator: '<=',
      }),
    ],
    {
      locale: 'en-US',
      observations: [
        observation('source-row', 'LDL-C <= 4.2 mmol/L', 0.2, boundedSpans),
        observation('source-date', 'Collection date 2026-08-22', 0.1),
      ],
      aliases: createDefaultExtractionAliases(),
      artifact,
    },
  );

  const row = rows[0]!;
  assert.deepEqual(row.sourceValue, { kind: 'free_text', value: '<= 4.2' });
  assert.deepEqual(row.proposedValue, { kind: 'free_text', value: '<= 4.2' });
  assert.ok(row.reviewReasons.includes('unparseable-value'));
  assert.equal(row.sourceValueString, '<= 4.2');
});

test('leaves ambiguous or absent dates missing and keeps distinct sibling events', () => {
  const rows = createHeaderTableDraftRows(
    [
      measurement({
        id: 'current-event',
        collectionDate: null,
        collectionDateSourceIds: [],
        sourceIds: ['source-row', 'source-row:value'],
        ambiguousFields: ['collectionDate'],
      }),
      measurement({
        id: 'previous-event',
        collectionDate: null,
        collectionDateSourceIds: [],
        sourceIds: ['source-row', 'source-row:previous-value'],
        valueString: '3.8',
      }),
    ],
    {
      locale: 'en-US',
      observations: [observation('source-row', 'LDL-C 3.8 mmol/L', 0.2, rowSpans)],
      aliases: createDefaultExtractionAliases(),
      artifact,
    },
  );

  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.collectionDate.kind === 'missing'));
  assert.ok(rows.every((row) => row.reviewReasons.includes('missing-collection-date')));
  assert.ok(rows[0]?.reviewReasons.includes('ambiguous-date'));
  assert.equal(rows[0]?.source.raw?.collectionDate, null);
});
