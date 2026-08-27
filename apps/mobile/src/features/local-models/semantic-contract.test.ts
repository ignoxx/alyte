import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ExtractionAliasEntry,
  ExtractionSemanticCandidateRow,
  VisionTextObservation,
} from '@alyte/domain';
import { productionLocalModelManifest } from './manifest';
import {
  SEMANTIC_MAPPER_LIMITS,
  SEMANTIC_MAPPER_PROMPT_VERSION,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  SEMANTIC_OCR_CHUNK_VERSION,
  createSemanticMapperPrompt,
  serializeSemanticMapperChunk,
  validateSemanticMapperOutput,
} from './semantic-contract';

function cell(id: string, text: string, language: string, x = 0.1, y = 0.2): VisionTextObservation {
  return {
    id,
    text,
    alternatives: [],
    pageIndex: 0,
    orientation: 0,
    boundingBox: { x, y, width: 0.2, height: 0.03 },
    recognition: { level: 'accurate', language, internalConfidence: null },
  };
}

function row(
  rowId: string,
  language: string,
  values: readonly string[],
): ExtractionSemanticCandidateRow {
  const observations = values.map((text, index) =>
    cell(`${rowId}-${index}`, text, language, 0.1 + index * 0.2),
  );
  return {
    rowId,
    sourceObservationIds: observations.map((observation) => observation.id),
    observations,
  };
}

const multilingualAliases: readonly ExtractionAliasEntry[] = [
  { id: 'biomarker.ferritin', aliases: ['Feritinas'], specimens: ['serum'], units: ['ng/mL'] },
  { id: 'biomarker.hematocrit', aliases: ['Hematokryt'], specimens: ['blood'], units: ['%'] },
  {
    id: 'biomarker.triglycerides',
    aliases: ['Triglicerydy'],
    specimens: ['plasma'],
    units: ['mmol/L'],
  },
];

test('serializes candidate rows with compact keys and headings without source IDs', () => {
  const candidate = row('lt-ferritin', 'lt', ['Feritinas', '42', 'ng/mL', '15–150']);
  const heading = cell('lt-serum-heading', 'Serumas', 'lt', 0.1, 0.1);
  const serialized = JSON.parse(serializeSemanticMapperChunk([candidate], 'lt', [heading])) as {
    version: string;
    rows: readonly [{ key: string; cells: readonly { key: string; text: string }[] }];
    headings: readonly { key: string; text: string }[];
    observations?: unknown;
  };
  assert.equal(serialized.version, 'alyte.semantic-ocr-chunk.v3');
  assert.equal('observations' in serialized, false);
  assert.equal(serialized.rows[0]?.key, 'r0');
  assert.deepEqual(
    serialized.rows[0]?.cells.map((item) => item.key),
    ['c0', 'c1', 'c2', 'c3'],
  );
  assert.deepEqual(
    serialized.rows[0]?.cells.map((item) => item.text),
    ['Feritinas', '42', 'ng/mL', '15–150'],
  );
  assert.deepEqual(
    serialized.headings.map((item) => item.key),
    ['h0'],
  );
});

test('accepts Lithuanian ferritin while unsupported urine rows stay omitted', () => {
  const ferritin = row('lt-ferritin', 'lt', ['Feritinas', '42', 'ng/mL', '15–150']);
  const urine = row('lt-urine-glucose', 'lt', [
    'Gliukozė (šlapimas)',
    'neigiama',
    'qualitative',
    'neigiama',
  ]);
  const accepted = validateSemanticMapperOutput(
    {
      schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
      proposals: [
        {
          sourceObservationIds: ferritin.sourceObservationIds,
          role: 'measurement',
          specimenType: 'serum',
          biomarkerId: 'biomarker.ferritin',
        },
      ],
    },
    [ferritin, urine],
    multilingualAliases,
  );
  assert.deepEqual(accepted, [
    {
      sourceObservationIds: ferritin.sourceObservationIds,
      proposedBiomarkerId: 'biomarker.ferritin',
      proposedSpecimenType: 'serum',
      role: 'measurement',
    },
  ]);
});

test('accepts both supported Polish candidate rows with their complete source IDs', () => {
  const hematocrit = row('pl-hematocrit', 'pl', ['Hematokryt', '42', '%', '36–46']);
  const triglycerides = row('pl-triglycerides', 'pl', ['Triglicerydy', '1,7', 'mmol/L', '<1,7']);
  const accepted = validateSemanticMapperOutput(
    {
      schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
      proposals: [
        {
          sourceObservationIds: hematocrit.sourceObservationIds,
          role: 'measurement',
          specimenType: 'blood',
          biomarkerId: 'biomarker.hematocrit',
        },
        {
          sourceObservationIds: triglycerides.sourceObservationIds,
          role: 'measurement',
          specimenType: 'plasma',
          biomarkerId: 'biomarker.triglycerides',
        },
      ],
    },
    [hematocrit, triglycerides],
    multilingualAliases,
  );
  assert.deepEqual(
    accepted.map((proposal) => proposal.sourceObservationIds),
    [hematocrit.sourceObservationIds, triglycerides.sourceObservationIds],
  );
});

test('rejects invented compact keys while preserving an independent valid row proposal', () => {
  const first = row('first', 'lt', ['Feritinas', '42', 'ng/mL', '15–150']);
  const second = row('second', 'pl', ['Hematokryt', '42', '%', '36–46']);
  const accepted = validateSemanticMapperOutput(
    {
      schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
      proposals: [
        {
          rowKey: 'r0',
          labelKey: 'c0',
          valueKey: 'c9',
          unitKey: 'c2',
          referenceIntervalKey: 'c3',
          flagKey: null,
          role: 'measurement',
          specimenType: 'serum',
          biomarkerId: 'biomarker.ferritin',
        },
        {
          rowKey: 'r1',
          labelKey: 'c0',
          valueKey: 'c1',
          unitKey: 'c2',
          referenceIntervalKey: 'c3',
          flagKey: null,
          role: 'measurement',
          specimenType: 'blood',
          biomarkerId: 'biomarker.hematocrit',
        },
      ],
    },
    [first, second],
    multilingualAliases,
  );
  assert.deepEqual(accepted, [
    {
      sourceObservationIds: second.sourceObservationIds,
      sourceFields: {
        label: second.sourceObservationIds[0],
        value: second.sourceObservationIds[1],
        unit: second.sourceObservationIds[2],
        referenceInterval: second.sourceObservationIds[3],
        flag: null,
      },
      proposedBiomarkerId: 'biomarker.hematocrit',
      proposedSpecimenType: 'blood',
      role: 'measurement',
    },
  ]);
});

test('rejects partial, cross-row, reordered, and extra-ID proposals individually', () => {
  const first = row('first', 'en', ['Ferritin', '42', 'ng/mL', '15–150']);
  const second = row('second', 'en', ['Ferritin', '43', 'ng/mL', '15–150']);
  const base = {
    role: 'measurement',
    specimenType: 'serum',
    biomarkerId: 'biomarker.ferritin',
  } as const;
  for (const sourceObservationIds of [
    first.sourceObservationIds.slice(0, 2),
    [first.sourceObservationIds[0]!, second.sourceObservationIds[1]!],
    [...first.sourceObservationIds].reverse(),
    [...first.sourceObservationIds, 'extra-id'],
  ]) {
    assert.deepEqual(
      validateSemanticMapperOutput(
        {
          schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
          proposals: [{ ...base, sourceObservationIds }],
        },
        [first, second],
        [
          {
            id: 'biomarker.ferritin',
            aliases: ['Ferritin'],
            specimens: ['serum'],
            units: ['ng/mL'],
          },
        ],
      ),
      [],
    );
  }
});

test('does not let model-only ignore remove a candidate row', () => {
  const candidate = row('ignore-candidate', 'en', ['LDL-C', '3.8', 'mmol/L']);
  assert.deepEqual(
    validateSemanticMapperOutput(
      {
        schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
        proposals: [
          {
            rowKey: 'r0',
            labelKey: 'c0',
            valueKey: 'c1',
            unitKey: 'c2',
            referenceIntervalKey: null,
            flagKey: null,
            role: 'ignore',
            specimenType: 'unknown',
            biomarkerId: null,
          },
        ],
      },
      [candidate],
      [
        {
          id: 'biomarker.ldl_c',
          aliases: ['LDL-C'],
          specimens: ['serum'],
          units: ['mmol/L'],
        },
      ],
    ),
    [],
  );
});

test('bounds candidate rows, cells, headings, and the complete UTF-8 input', () => {
  const candidate = row('bound', 'en', ['Ferritin', '42', 'ng/mL', '15–150']);
  assert.throws(
    () =>
      serializeSemanticMapperChunk(
        Array.from({ length: SEMANTIC_MAPPER_LIMITS.maxRows + 1 }, (_, index) =>
          row(`row-${index}`, 'en', ['Ferritin', '42', 'ng/mL', '15–150']),
        ),
        'en',
      ),
    /too-large/,
  );
  assert.throws(
    () =>
      serializeSemanticMapperChunk(
        Array.from({ length: SEMANTIC_MAPPER_LIMITS.maxObservations / 4 + 1 }, (_, index) =>
          row(`row-${index}`, 'en', ['Ferritin', '42', 'ng/mL', '15–150']),
        ),
        'en',
      ),
    /too-large/,
  );
  assert.throws(
    () =>
      serializeSemanticMapperChunk(
        [candidate],
        'en',
        Array.from({ length: SEMANTIC_MAPPER_LIMITS.maxHeadings + 1 }, (_, index) =>
          cell(`heading-${index}`, 'Serum', 'en', 0.1, 0.1),
        ),
      ),
    /too-large/,
  );
  assert.match(
    createSemanticMapperPrompt('lt', serializeSemanticMapperChunk([candidate], 'lt')),
    /compact row and cell keys/u,
  );
});

test('keeps production prompt, chunk, and manifest versions aligned', () => {
  assert.equal(SEMANTIC_MAPPER_SCHEMA_VERSION, 'alyte.semantic-mapper.v2');
  assert.equal(SEMANTIC_MAPPER_PROMPT_VERSION, 'alyte.semantic-mapper.prompt.v4');
  assert.equal(SEMANTIC_OCR_CHUNK_VERSION, 'alyte.semantic-ocr-chunk.v3');
  assert.equal(
    SEMANTIC_MAPPER_PROMPT_VERSION,
    productionLocalModelManifest.compatibility.promptBundle,
  );
  assert.equal(SEMANTIC_OCR_CHUNK_VERSION, productionLocalModelManifest.compatibility.ocrChunk);
});
