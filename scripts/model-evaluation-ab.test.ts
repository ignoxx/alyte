import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createSemanticMapperPrompt,
  serializeSemanticMapperChunk,
} from './model-evaluation-production';
import {
  COMPACT_KEY_CANDIDATE_PROMPT_VERSION,
  createCompactKeyCandidatePrompt,
} from './model-evaluation-compact-key-candidate';
import {
  OLLAMA_SEMANTIC_FORMAT_VERSION,
  isExternalAggregatePath,
  runProductionAB,
} from './model-evaluation-runner';
import { productionV2Fixtures } from './model-evaluation-v2-fixtures';

test('compact-key candidate changes only its one prompt clarification', () => {
  const fixture = productionV2Fixtures[0]!;
  const serialized = serializeSemanticMapperChunk(fixture.rows, fixture.language);
  const production = createSemanticMapperPrompt(fixture.language, serialized);
  const candidate = createCompactKeyCandidatePrompt(fixture.language, serialized);
  assert.equal(production.includes('each *Key is a row-local compact cell key'), false);
  assert.match(candidate, /each \*Key is a row-local compact cell key such as c0\/c1\/c2/u);
  assert.notEqual(candidate, production);
  assert.equal(
    candidate.replace(
      /with compact grammar keys only \(rowKey r0\/r1; each \*Key is a row-local compact cell key such as c0\/c1\/c2\), never source text, and no extra fields\./u,
      'with grammar keys only and no extra fields.',
    ),
    production,
  );
  assert.equal(
    COMPACT_KEY_CANDIDATE_PROMPT_VERSION,
    'alyte.semantic-mapper.production-compact-key-candidate.v1',
  );
});

test('documented neutral A/B output path is accepted as an external aggregate path', () => {
  assert.equal(isExternalAggregatePath('/tmp/model-evaluation-aggregate-gemma-v2-ab.json'), true);
});

test('A/B runner keeps separate aggregate provenance and metrics over identical fixtures', async () => {
  let candidateFixtureIndex = 0;
  let baselinePrompt: string | undefined;
  let candidateRequest: { model: string; format: unknown; options: unknown } | undefined;
  const report = await runProductionAB({
    transport: async (request) => {
      if (!request.prompt.includes('each *Key is a row-local compact cell key')) {
        baselinePrompt ??= request.prompt;
        return '{}';
      }
      candidateRequest ??= {
        model: request.model,
        format: request.format,
        options: request.options,
      };
      const fixture = productionV2Fixtures[candidateFixtureIndex++]!;
      const row = fixture.rows[0]!;
      const expected = fixture.expected[0]!;
      const key = (sourceId: string | null) =>
        sourceId === null ? null : `c${row.sourceObservationIds.indexOf(sourceId)}`;
      return JSON.stringify({
        schemaVersion: 'alyte.semantic-mapper.v2',
        proposals: [
          {
            rowKey: 'r0',
            labelKey: key(expected.sourceFields.label),
            valueKey: key(expected.sourceFields.value),
            unitKey: key(expected.sourceFields.unit),
            referenceIntervalKey: key(expected.sourceFields.referenceInterval),
            flagKey: key(expected.sourceFields.flag),
            role: expected.role,
            specimenType: expected.specimenType,
            biomarkerId: expected.biomarkerId,
          },
        ],
      });
    },
  });
  assert.equal(report.baseline.provenance.promptBundleVersion, 'alyte.semantic-mapper.prompt.v6');
  assert.equal(
    report.candidate.provenance.promptBundleVersion,
    COMPACT_KEY_CANDIDATE_PROMPT_VERSION,
  );
  assert.equal(report.baseline.provenance.formatVersion, OLLAMA_SEMANTIC_FORMAT_VERSION);
  assert.equal(report.candidate.provenance.formatVersion, OLLAMA_SEMANTIC_FORMAT_VERSION);
  assert.equal(
    report.baseline.provenance.fixtureVersion,
    report.candidate.provenance.fixtureVersion,
  );
  assert.equal(report.baseline.quality.expectedRows, report.candidate.quality.expectedRows);
  assert.equal(report.baseline.quality.expectedPreserveRows, 2);
  assert.equal(report.candidate.quality.expectedPreserveRows, 2);
  assert.equal(report.baseline.quality.acceptedProposals, 0);
  assert.equal(report.candidate.quality.acceptedProposals, productionV2Fixtures.length);
  assert.equal(report.candidate.quality.correctAcceptedProposals, productionV2Fixtures.length);
  assert.equal(report.baseline.quality.acceptedPreserveProposals, 0);
  assert.equal(report.baseline.quality.correctPreserveProposals, 0);
  assert.equal(report.candidate.quality.acceptedPreserveProposals, 2);
  assert.equal(report.candidate.quality.correctPreserveProposals, 2);
  assert.equal(report.baseline.retryCount, productionV2Fixtures.length);
  assert.equal(report.candidate.retryCount, 0);
  const firstFixture = productionV2Fixtures[0]!;
  assert.equal(
    baselinePrompt,
    createSemanticMapperPrompt(
      firstFixture.language,
      serializeSemanticMapperChunk(firstFixture.rows, firstFixture.language),
    ),
  );
  assert.equal(candidateRequest?.model, 'alyte-gemma-4-e2b-evaluation-v2');
  assert.deepEqual(candidateRequest?.options, {
    num_ctx: 2_048,
    num_predict: 192,
    temperature: 0,
    top_p: 1,
  });
  assert.equal(JSON.stringify(report).includes('prompt'), true);
  assert.equal(JSON.stringify(report).includes('sourceObservationIds'), false);
});
