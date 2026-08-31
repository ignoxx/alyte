import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRoleSafeDistinctOllamaSemanticFormat,
  OLLAMA_ROLE_SAFE_DISTINCT_SEMANTIC_FORMAT_MAX_ENCODED_BYTES,
  OLLAMA_ROLE_SAFE_DISTINCT_SEMANTIC_FORMAT_VERSION,
  OLLAMA_SEMANTIC_FORMAT,
  runProductionFinalAB,
} from './model-evaluation-runner';
import { productionAliases, productionV2Fixtures } from './model-evaluation-v2-fixtures';

type SchemaNode = { readonly [key: string]: unknown };
type Branch = {
  readonly properties: Record<
    string,
    { readonly const?: unknown; readonly enum?: readonly unknown[] }
  >;
};

function branchesForFixture(index = 0): readonly Branch[] {
  const format = createRoleSafeDistinctOllamaSemanticFormat([
    productionV2Fixtures[index]!.rows[0]!,
  ]);
  return (format.properties as { proposals: { items: { oneOf: readonly SchemaNode[] } } }).proposals
    .items.oneOf as readonly Branch[];
}

test('final dynamic schema enumerates only role-safe distinct compact assignments', () => {
  const branches = branchesForFixture();
  assert.equal(branches.length, 468);
  const knownIds = new Set(productionAliases.map((alias) => alias.id));
  for (const branch of branches) {
    const properties = branch.properties;
    assert.notEqual(properties.role.const, 'ignore');
    const selected = [
      properties.labelKey.const,
      properties.valueKey.const,
      properties.unitKey.const,
      properties.referenceIntervalKey.const,
      properties.flagKey.const,
    ].filter((value): value is string => typeof value === 'string');
    assert.equal(new Set(selected).size, selected.length);
    assert.equal(
      properties.role.const === 'measurement',
      properties.biomarkerId.enum !== undefined,
    );
    if (properties.role.const === 'measurement') {
      assert.ok(
        properties.biomarkerId.enum?.every((id) => typeof id === 'string' && knownIds.has(id)),
      );
    } else {
      assert.equal(properties.biomarkerId.const, null);
    }
  }
});

test('final schema fails closed before creating an oversized Ollama grammar', () => {
  const source = productionV2Fixtures[0]!.rows[0]!;
  const observations = Array.from({ length: 7 }, (_, index) => ({
    ...source.observations[index % source.observations.length]!,
    id: `oversized-c${index}`,
  }));
  assert.throws(
    () =>
      createRoleSafeDistinctOllamaSemanticFormat([
        {
          ...source,
          rowId: 'oversized-row',
          sourceObservationIds: observations.map((observation) => observation.id),
          observations,
        },
      ]),
    /model-evaluation-failed:constrained-schema-input/u,
  );
});

test('final schema keeps the supported two-row five-cell shape under its encoded byte ceiling', () => {
  const source = productionV2Fixtures[0]!.rows[0]!;
  const rows = Array.from({ length: 2 }, (_, rowIndex) => {
    const observations = Array.from({ length: 5 }, (_, cellIndex) => ({
      ...source.observations[cellIndex % source.observations.length]!,
      id: `wide-${rowIndex}-c${cellIndex}`,
    }));
    return {
      ...source,
      rowId: `wide-${rowIndex}`,
      sourceObservationIds: observations.map((observation) => observation.id),
      observations,
    };
  });
  const format = createRoleSafeDistinctOllamaSemanticFormat(rows);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(format)).byteLength <=
      OLLAMA_ROLE_SAFE_DISTINCT_SEMANTIC_FORMAT_MAX_ENCODED_BYTES,
  );
});

test('final A/B keeps the exact production prompt and separates aggregate provenance', async () => {
  const fixture = productionV2Fixtures[0]!;
  const prompts: string[] = [];
  const formats: unknown[] = [];
  const report = await runProductionFinalAB({
    fixtures: [fixture],
    transport: async (request) => {
      prompts.push(request.prompt);
      formats.push(request.format);
      if (request.format === OLLAMA_SEMANTIC_FORMAT)
        return '{"schemaVersion":"alyte.semantic-mapper.v2","proposals":[]}';
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
            role: 'measurement',
            specimenType: 'serum',
            biomarkerId: 'biomarker.ldl_c',
          },
        ],
      });
    },
    capturedAt: () => '2026-08-30T00:00:00.000Z',
  });
  assert.equal(prompts.length, 3);
  assert.notEqual(prompts[0], prompts[1]);
  assert.equal(prompts[0], prompts[2]);
  assert.equal(formats[0], OLLAMA_SEMANTIC_FORMAT);
  assert.equal(formats[1], OLLAMA_SEMANTIC_FORMAT);
  assert.notEqual(formats[2], OLLAMA_SEMANTIC_FORMAT);
  assert.equal(
    report.candidate.provenance.formatVersion,
    OLLAMA_ROLE_SAFE_DISTINCT_SEMANTIC_FORMAT_VERSION,
  );
  assert.equal(report.candidate.quality.acceptedProposals, 1);
  assert.equal(report.candidate.quality.correctAcceptedProposals, 1);
  assert.equal(report.candidate.quality.exactSourceFactsPreserved, 1);
  assert.equal(JSON.stringify(report).includes('sourceObservationIds'), false);
  assert.equal(JSON.stringify(report).includes('rawPrompt'), false);
});
