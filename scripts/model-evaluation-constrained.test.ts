import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDynamicOllamaSemanticFormat,
  OLLAMA_DYNAMIC_SEMANTIC_FORMAT_VERSION,
  OLLAMA_SEMANTIC_FORMAT,
  runProductionConstrainedAB,
} from './model-evaluation-runner';
import { productionV2Fixtures } from './model-evaluation-v2-fixtures';

type SchemaNode = { readonly [key: string]: unknown };

test('dynamic transport schema binds each row to only its actual compact cells', () => {
  const rows = [productionV2Fixtures[4]!.rows[0]!, productionV2Fixtures[0]!.rows[0]!];
  const format = createDynamicOllamaSemanticFormat(rows);
  const proposals = (
    format.properties as { proposals: { items: { oneOf: readonly SchemaNode[] } } }
  ).proposals;
  const branches = proposals.items.oneOf;
  assert.deepEqual(
    branches.map((branch) => (branch.properties as { rowKey: { const: string } }).rowKey.const),
    ['r0', 'r1'],
  );
  assert.deepEqual(
    (branches[0]!.properties as { labelKey: { enum: readonly string[] } }).labelKey.enum,
    ['c0', 'c1', 'c2', 'c3'],
  );
  assert.deepEqual(
    (branches[1]!.properties as { valueKey: { enum: readonly string[] } }).valueKey.enum,
    ['c0', 'c1', 'c2', 'c3'],
  );
  assert.deepEqual(
    (branches[0]!.properties as { unitKey: { anyOf: readonly Record<string, unknown>[] } }).unitKey
      .anyOf[1],
    { type: 'null' },
  );
  assert.equal(JSON.stringify(branches[0]).includes('en-serum-ldl-c0'), false);
});

test('dynamic schema rejects empty, duplicate, oversized, and malformed chunks', () => {
  const row = productionV2Fixtures[0]!.rows[0]!;
  assert.throws(() => createDynamicOllamaSemanticFormat([]), /constrained-schema-input/);
  assert.throws(
    () => createDynamicOllamaSemanticFormat([row, { ...row }]),
    /constrained-schema-input/,
  );
  assert.throws(
    () =>
      createDynamicOllamaSemanticFormat([
        row,
        productionV2Fixtures[1]!.rows[0]!,
        productionV2Fixtures[4]!.rows[0]!,
      ]),
    /constrained-schema-input/,
  );
  const malformed = {
    ...row,
    sourceObservationIds: [...row.sourceObservationIds, 'extra'],
  };
  assert.throws(() => createDynamicOllamaSemanticFormat([malformed]), /constrained-schema-input/);
});

test('constrained A/B preserves the production prompt, validator, and aggregate separation', async () => {
  const fixture = productionV2Fixtures[1]!;
  const prompts: string[] = [];
  const formats: unknown[] = [];
  const report = await runProductionConstrainedAB({
    fixtures: [fixture],
    transport: async (request) => {
      prompts.push(request.prompt);
      formats.push(request.format);
      return JSON.stringify({
        schemaVersion: 'alyte.semantic-mapper.v2',
        proposals: [
          {
            rowKey: 'r0',
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
      });
    },
    capturedAt: () => '2026-08-30T00:00:00.000Z',
  });
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1]);
  assert.equal(formats[0], OLLAMA_SEMANTIC_FORMAT);
  assert.notEqual(formats[1], OLLAMA_SEMANTIC_FORMAT);
  assert.equal(
    report.baseline.provenance.formatVersion,
    'alyte.semantic-mapper.ollama-json-schema-envelope.v1',
  );
  assert.equal(report.candidate.provenance.formatVersion, OLLAMA_DYNAMIC_SEMANTIC_FORMAT_VERSION);
  assert.equal(report.baseline.quality.correctAcceptedProposals, 1);
  assert.equal(report.candidate.quality.correctAcceptedProposals, 1);
  assert.equal(report.baseline.quality.correctPreserveProposals, 1);
  assert.equal(report.candidate.quality.correctPreserveProposals, 1);
  assert.equal(JSON.stringify(report).includes('sourceObservationIds'), false);
  assert.equal(JSON.stringify(report).includes('rawModelOutput'), false);
});

function twoRowFixture() {
  const first = productionV2Fixtures[0]!;
  const second = productionV2Fixtures[4]!;
  const sourceRows = [first, second].map((fixture) => {
    const sourceRow = fixture.rows[0]!;
    const observations = sourceRow.observations.slice(0, 2);
    return {
      ...sourceRow,
      sourceObservationIds: observations.map((observation) => observation.id),
      observations,
    };
  });
  const rows = sourceRows.map((row, index) => {
    const observations = row.observations.map((observation, cellIndex) => ({
      ...observation,
      id: `cross-row-${index}-c${cellIndex}`,
      text: index === 0 ? (cellIndex === 0 ? 'LDL-C' : '118') : cellIndex === 0 ? 'Ferritin' : '42',
      alternatives: [],
    }));
    return {
      ...row,
      rowId: `cross-row-${index}`,
      sourceObservationIds: observations.map((observation) => observation.id),
      observations,
    };
  });
  return {
    id: 'fabricated-constrained-validator-two-row',
    language: 'en' as const,
    rows,
    observations: rows.flatMap(({ observations }) => observations),
    expected: rows.map((row, index) => ({
      rowId: row.rowId,
      sourceObservationIds: row.sourceObservationIds,
      sourceFactObservationIds: [row.sourceObservationIds[1]!],
      sourceFields: {
        label: row.sourceObservationIds[0]!,
        value: row.sourceObservationIds[1]!,
        unit: null,
        referenceInterval: null,
        flag: null,
      },
      biomarkerId: index === 0 ? 'biomarker.ldl_c' : 'biomarker.ferritin',
      role: 'measurement' as const,
      specimenType: 'serum' as const,
      sourceFacts: { valueString: row.observations[1]!.text, unit: '', referenceInterval: '' },
    })),
  };
}

function nullOptionalFixture() {
  const source = productionV2Fixtures[0]!;
  const sourceRow = source.rows[0]!;
  const observations = sourceRow.observations.slice(0, 2);
  const row = {
    ...sourceRow,
    sourceObservationIds: observations.map((observation) => observation.id),
    observations,
  };
  return {
    id: 'fabricated-constrained-validator-null-optionals',
    language: source.language,
    rows: [row],
    observations,
    expected: [
      {
        rowId: row.rowId,
        sourceObservationIds: row.sourceObservationIds,
        sourceFactObservationIds: [row.sourceObservationIds[1]!],
        sourceFields: {
          label: row.sourceObservationIds[0]!,
          value: row.sourceObservationIds[1]!,
          unit: null,
          referenceInterval: null,
          flag: null,
        },
        biomarkerId: 'biomarker.ldl_c',
        role: 'measurement' as const,
        specimenType: 'serum' as const,
        sourceFacts: { valueString: '118', unit: '', referenceInterval: '' },
      },
    ],
  };
}

async function candidateQuality(payload: unknown, fixtures = [productionV2Fixtures[0]!]) {
  const report = await runProductionConstrainedAB({
    fixtures,
    transport: async (request) =>
      request.format === OLLAMA_SEMANTIC_FORMAT
        ? '{"schemaVersion":"alyte.semantic-mapper.v2","proposals":[]}'
        : JSON.stringify(payload),
  });
  return report.candidate.quality;
}

test('constrained transport responses still pass through validator safety checks', async () => {
  const valid = {
    rowKey: 'r0',
    labelKey: 'c0',
    valueKey: 'c1',
    unitKey: 'c2',
    referenceIntervalKey: 'c3',
    flagKey: null,
    role: 'measurement',
    specimenType: 'serum',
    biomarkerId: 'biomarker.ldl_c',
  };
  const invalidPayloads: readonly [string, unknown][] = [
    [
      'duplicate proposals for one physical row',
      { schemaVersion: 'alyte.semantic-mapper.v2', proposals: [valid, valid] },
    ],
    [
      'duplicate selected cells',
      {
        schemaVersion: 'alyte.semantic-mapper.v2',
        proposals: [{ ...valid, valueKey: 'c0' }],
      },
    ],
    [
      'invalid optional cell selection',
      {
        schemaVersion: 'alyte.semantic-mapper.v2',
        proposals: [{ ...valid, unitKey: 'c99' }],
      },
    ],
    [
      'authoritative or extra field',
      {
        schemaVersion: 'alyte.semantic-mapper.v2',
        proposals: [{ ...valid, value: '999' }],
      },
    ],
    [
      'incompatible measurement role and null biomarker',
      {
        schemaVersion: 'alyte.semantic-mapper.v2',
        proposals: [{ ...valid, biomarkerId: null }],
      },
    ],
    [
      'incompatible preserve role and known biomarker',
      {
        schemaVersion: 'alyte.semantic-mapper.v2',
        proposals: [{ ...valid, role: 'preserve' }],
      },
    ],
  ];
  for (const [description, payload] of invalidPayloads) {
    const quality = await candidateQuality(payload);
    assert.equal(quality.acceptedProposals, 0, description);
    assert.equal(quality.correctAcceptedProposals, 0, description);
  }

  const crossRowPayload = {
    schemaVersion: 'alyte.semantic-mapper.v2',
    proposals: [
      {
        sourceObservationIds: [
          twoRowFixture().rows[0]!.sourceObservationIds[0]!,
          twoRowFixture().rows[1]!.sourceObservationIds[1]!,
        ],
        proposedBiomarkerId: 'biomarker.ferritin',
        proposedSpecimenType: 'serum',
        role: 'measurement',
      },
    ],
  };
  const crossRowQuality = await candidateQuality(crossRowPayload, [twoRowFixture()]);
  assert.equal(crossRowQuality.acceptedProposals, 0);
  assert.equal(crossRowQuality.correctAcceptedProposals, 0);
});

test('null optional selections and unsupported preserve mappings remain accepted', async () => {
  const fixture = nullOptionalFixture();
  const quality = await candidateQuality(
    {
      schemaVersion: 'alyte.semantic-mapper.v2',
      proposals: [
        {
          rowKey: 'r0',
          labelKey: 'c0',
          valueKey: 'c1',
          unitKey: null,
          referenceIntervalKey: null,
          flagKey: null,
          role: 'measurement',
          specimenType: 'serum',
          biomarkerId: 'biomarker.ldl_c',
        },
      ],
    },
    [fixture],
  );
  assert.equal(quality.acceptedProposals, 1);
  assert.equal(quality.correctAcceptedProposals, 1);
  assert.equal(quality.exactSourceFactsPreserved, 1);

  const unsupported = productionV2Fixtures[1]!;
  const preserveQuality = await candidateQuality(
    {
      schemaVersion: 'alyte.semantic-mapper.v2',
      proposals: [
        {
          rowKey: 'r0',
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
    [unsupported],
  );
  assert.equal(preserveQuality.acceptedPreserveProposals, 1);
  assert.equal(preserveQuality.correctPreserveProposals, 1);
});
