import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparableBiomarkers, normalizeCatalogueAlias } from '@alyte/catalogue';
import type {
  ExtractionAliasEntry,
  ExtractionSemanticCandidateRow,
  VisionTextObservation,
} from '@alyte/domain';
import { productionLocalModelManifest } from './manifest';
import { PADDLEOCR_PROMPT_VERSION, PADDLEOCR_SCHEMA_VERSION } from './paddleocr';
import {
  SEMANTIC_MAPPER_LIMITS,
  SEMANTIC_MAPPER_CONTEXT,
  SEMANTIC_MAPPER_PROMPT_VERSION,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  SEMANTIC_OCR_CHUNK_VERSION,
  createSemanticMapperPrompt,
  estimateSemanticMapperTokens,
  serializeSemanticMapperChunk,
  validateSemanticMapperOutput,
  validateSemanticMapperOutputWithState,
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
  y = 0.2,
): ExtractionSemanticCandidateRow {
  const observations = values.map((text, index) =>
    cell(`${rowId}-${index}`, text, language, 0.1 + index * 0.2, y),
  );
  return {
    rowId,
    sourceObservationIds: observations.map((observation) => observation.id),
    observations,
  };
}

function rowWithAlternatives(
  rowId: string,
  language: string,
  values: readonly string[],
  alternatives: Readonly<Record<number, readonly string[]>>,
): ExtractionSemanticCandidateRow {
  const candidate = row(rowId, language, values);
  return {
    ...candidate,
    observations: candidate.observations.map((observation, index) => {
      const item = alternatives[index];
      return item === undefined ? observation : { ...observation, alternatives: item };
    }),
  };
}

const frozenLegacyPromptFixtures: readonly {
  readonly id: string;
  readonly language: string;
  readonly rows: readonly ExtractionSemanticCandidateRow[];
}[] = [
  {
    id: 'gemma-v2-en-supported',
    language: 'en',
    rows: [
      rowWithAlternatives('en-serum-ldl', 'en', ['LDL cholesterol', '118', 'mg/dL', '<115'], {
        0: ['R-017', '2026-08-17 08:42'],
      }),
    ],
  },
  {
    id: 'gemma-v2-en-unsupported',
    language: 'en',
    rows: [
      rowWithAlternatives(
        'en-urine-glucose',
        'en',
        ['Glucose', 'negative', 'qualitative', 'negative'],
        {
          0: ['Glucose (urine)'],
        },
      ),
    ],
  },
  {
    id: 'gemma-v2-de-columns',
    language: 'de',
    rows: [
      rowWithAlternatives('de-plasma-ldl', 'de', ['LDL-Cholesterin', 'mmol/L', '3,8', '<3,0'], {
        0: ['LDL Cholesterin'],
        2: ['3.8'],
      }),
    ],
  },
  {
    id: 'gemma-v2-de-reordered',
    language: 'de',
    rows: [row('de-blood-hb', 'de', ['14,2', 'Hämoglobin', '12,0–16,0', 'g/dL'])],
  },
  {
    id: 'gemma-v2-lt-supported',
    language: 'lt',
    rows: [
      rowWithAlternatives('lt-serum-ferritin', 'lt', ['Feritinas', '42', 'ng/mL', '15–150'], {
        0: ['Serumo feritinas'],
      }),
    ],
  },
  {
    id: 'gemma-v2-lt-ambiguous',
    language: 'lt',
    rows: [row('lt-ambiguous-cholesterol', 'lt', ['Cholesterolis', '5,1', 'mmol/L', '—'])],
  },
];

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
  assert.equal(serialized.version, 'alyte.semantic-ocr-chunk.v5');
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

test('preserves physical caller order when assigning compact keys and heading context', () => {
  const physicalFirst = row('z-physical-first', 'lt', ['Feritinas', '42', 'ng/mL'], 0.1);
  const lexicalFirst = row('a-lexical-first', 'lt', ['Hematokryt', '42', '%'], 0.2);
  const heading = cell('lt-serum-heading', 'Serumas', 'lt', 0.1, 0.05);
  const serialized = JSON.parse(
    serializeSemanticMapperChunk([physicalFirst, lexicalFirst], 'lt', [heading]),
  ) as {
    rows: readonly { key: string; cells: readonly { text: string }[] }[];
    headings: readonly { key: string; text: string }[];
  };

  assert.deepEqual(
    serialized.rows.map((item) => [item.key, item.cells[0]?.text]),
    [
      ['r0', 'Feritinas'],
      ['r1', 'Hematokryt'],
    ],
  );
  assert.deepEqual(serialized.headings, [{ key: 'h0', text: 'Serumas', alternatives: [] }]);
});

test('keeps surviving retry rows in physical order while compact keys are reassigned', () => {
  const first = row('z-first', 'lt', ['Feritinas', '42', 'ng/mL'], 0.1);
  const middle = row('m-middle', 'lt', ['Hematokryt', '42', '%'], 0.2);
  const last = row('a-last', 'lt', ['Triglicerydy', '1,7', 'mmol/L'], 0.3);
  const state = validateSemanticMapperOutputWithState(
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
          role: 'measurement',
          specimenType: 'serum',
          biomarkerId: 'biomarker.ferritin',
        },
      ],
    },
    [first, middle, last],
    multilingualAliases,
  );
  const retry = JSON.parse(serializeSemanticMapperChunk(state.rejectedRows, 'lt')) as {
    rows: readonly { key: string; cells: readonly { text: string }[] }[];
  };

  assert.deepEqual(
    state.rejectedRows.map((candidate) => candidate.rowId),
    ['m-middle', 'a-last'],
  );
  assert.deepEqual(
    retry.rows.map((item) => [item.key, item.cells[0]?.text]),
    [
      ['r0', 'Hematokryt'],
      ['r1', 'Triglicerydy'],
    ],
  );
});

test('serializes only distinct biomarker aliases and preserves the Feritinas hint', () => {
  const serialized = JSON.parse(serializeSemanticMapperChunk([], 'en')) as {
    readonly biomarkers: readonly {
      readonly id: string;
      readonly label: string;
      readonly aliases: readonly string[];
    }[];
  };

  for (const entry of comparableBiomarkers) {
    const label = entry.canonicalLabel ?? entry.aliases[0] ?? entry.id;
    const hint = serialized.biomarkers.find((biomarker) => biomarker.id === entry.id);
    assert.ok(hint, `missing serialized biomarker ${entry.id}`);
    assert.deepEqual(
      hint.aliases,
      entry.aliases
        .filter((alias) => normalizeCatalogueAlias(alias) !== normalizeCatalogueAlias(label))
        .sort((left, right) => left.localeCompare(right)),
    );
  }

  const ferritin = comparableBiomarkers.find((entry) => entry.id === 'biomarker.ferritin');
  const ferritinHint = serialized.biomarkers.find(
    (biomarker) => biomarker.id === 'biomarker.ferritin',
  );
  assert.ok(ferritin);
  assert.ok(ferritinHint);
  assert.ok(ferritin.aliases.includes('ferritin'));
  assert.equal(ferritinHint.aliases.includes('ferritin'), false);
  assert.equal(ferritinHint.aliases.includes('Feritinas'), true);
});

test('keeps all six frozen legacy prompts within the unchanged context gate', () => {
  assert.equal(SEMANTIC_MAPPER_CONTEXT.maxTokens, 2_048);
  assert.equal(SEMANTIC_MAPPER_LIMITS.outputTokenLimit, 192);
  for (const fixture of frozenLegacyPromptFixtures) {
    const prompt = createSemanticMapperPrompt(
      fixture.language,
      serializeSemanticMapperChunk(fixture.rows, fixture.language),
    );
    assert.ok(
      estimateSemanticMapperTokens(prompt) + SEMANTIC_MAPPER_LIMITS.outputTokenLimit <=
        SEMANTIC_MAPPER_CONTEXT.maxTokens,
      `${fixture.id} exceeds the reserved context gate`,
    );
  }
});

test('requires one exhaustive proposal and preserves an unsupported urine row', () => {
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
          rowKey: 'r0',
          labelKey: 'c0',
          valueKey: 'c1',
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
          role: 'preserve',
          specimenType: 'urine',
          biomarkerId: null,
        },
      ],
    },
    [ferritin, urine],
    multilingualAliases,
  );
  assert.deepEqual(accepted, [
    {
      sourceObservationIds: ferritin.sourceObservationIds,
      sourceFields: {
        label: ferritin.sourceObservationIds[0]!,
        value: ferritin.sourceObservationIds[1]!,
        unit: ferritin.sourceObservationIds[2]!,
        referenceInterval: ferritin.sourceObservationIds[3]!,
        flag: null,
      },
      proposedBiomarkerId: 'biomarker.ferritin',
      proposedSpecimenType: 'serum',
      role: 'measurement',
    },
    {
      sourceObservationIds: urine.sourceObservationIds,
      sourceFields: {
        label: urine.sourceObservationIds[0]!,
        value: urine.sourceObservationIds[1]!,
        unit: urine.sourceObservationIds[2]!,
        referenceInterval: urine.sourceObservationIds[3]!,
        flag: null,
      },
      proposedBiomarkerId: null,
      proposedSpecimenType: 'urine',
      role: 'preserve',
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
          rowKey: 'r0',
          labelKey: 'c0',
          valueKey: 'c1',
          unitKey: 'c2',
          referenceIntervalKey: 'c3',
          flagKey: null,
          role: 'measurement',
          specimenType: 'blood',
          biomarkerId: 'biomarker.hematocrit',
        },
        {
          rowKey: 'r1',
          labelKey: 'c0',
          valueKey: 'c1',
          unitKey: 'c2',
          referenceIntervalKey: 'c3',
          flagKey: null,
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

test('keeps a valid sibling when one compact row proposal is malformed', () => {
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
  assert.deepEqual(
    accepted.map((proposal) => proposal.sourceObservationIds),
    [second.sourceObservationIds],
  );
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
    /row\/cell/u,
  );
});

test('keeps the legacy semantic contract versioned while production uses PaddleOCR', () => {
  assert.equal(SEMANTIC_MAPPER_SCHEMA_VERSION, 'alyte.semantic-mapper.v2');
  assert.equal(SEMANTIC_MAPPER_PROMPT_VERSION, 'alyte.semantic-mapper.prompt.v6');
  assert.equal(SEMANTIC_OCR_CHUNK_VERSION, 'alyte.semantic-ocr-chunk.v5');
  assert.equal(
    productionLocalModelManifest.compatibility.promptBundle,
    'alyte.document-ocr.raw.v1',
  );
  assert.equal(productionLocalModelManifest.compatibility.ocrChunk, 'alyte.document-band.v1');
  assert.equal(
    PADDLEOCR_SCHEMA_VERSION,
    productionLocalModelManifest.compatibility.semanticSchema,
  );
  assert.equal(PADDLEOCR_PROMPT_VERSION, 'alyte.paddleocr-vl.prompt.v1');
});
