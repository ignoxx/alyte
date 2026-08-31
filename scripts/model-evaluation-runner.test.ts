import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OLLAMA_SEMANTIC_FORMAT,
  runProductionBaseline,
  type OllamaGenerateRequest,
} from './model-evaluation-runner';
import { productionV2Fixtures, type V2Fixture } from './model-evaluation-v2-fixtures';

test('sends the production raw-generation bounds and exact v2 prompt through the injected transport', async () => {
  const requests: OllamaGenerateRequest[] = [];
  const report = await runProductionBaseline({
    transport: async (request) => {
      requests.push(request);
      return '{"schemaVersion":"alyte.semantic-mapper.v2","proposals":[]}';
    },
    now: (() => {
      let value = 0;
      return () => (value += 4);
    })(),
    capturedAt: () => '2026-08-29T00:00:00.000Z',
  });
  assert.equal(requests[0]?.model, 'alyte-gemma-4-e2b-evaluation-v2');
  assert.equal(requests[0]?.raw, true);
  assert.equal(requests[0]?.stream, false);
  assert.equal(requests[0]?.think, false);
  assert.equal(requests[0]?.format, OLLAMA_SEMANTIC_FORMAT);
  assert.deepEqual(requests[0]?.format.properties.schemaVersion, {
    const: 'alyte.semantic-mapper.v2',
  });
  assert.equal(requests[0]?.format.properties.proposals.maxItems, 2);
  assert.deepEqual(requests[0]?.options, {
    num_ctx: 2_048,
    num_predict: 192,
    temperature: 0,
    top_p: 1,
  });
  assert.match(requests[0]?.prompt ?? '', /alyte\.semantic-mapper\.v2/u);
  assert.match(requests[0]?.prompt ?? '', /<bos><\|turn>system/u);
  assert.equal(JSON.stringify(report).includes('rawModelOutput'), false);
  assert.equal(JSON.stringify(report).includes('sourceObservationIds'), false);
  assert.equal(report.provenance.contextWindowTokens, 2_048);
  assert.equal(report.provenance.outputTokenLimit, 192);
  assert.equal(report.provenance.catalogueVersion, '0.2.0');
  assert.equal(report.provenance.catalogueSchemaVersion, 'alyte.catalogue.v1');
});

test('retries a malformed row with the production retry prompt', async () => {
  let calls = 0;
  const fixture = productionV2Fixtures[0]!;
  const prompts: string[] = [];
  const report = await runProductionBaseline({
    transport: async (request) => {
      calls += 1;
      prompts.push(request.prompt);
      if (calls === 1) {
        return '{}';
      }
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
    fixtures: [fixture],
  });
  assert.equal(report.retryCount, 1);
  assert.equal(report.quality.acceptedProposals, 1);
  assert.equal(report.quality.correctAcceptedProposals, 1);
  assert.equal(report.quality.failureCounts.malformedEnvelope, 1);
  assert.match(prompts[1]!, /Required shape/u);
});

function twoRowProductionFixture(): V2Fixture {
  const source = [productionV2Fixtures[0]!, productionV2Fixtures[4]!];
  const rows = source.map((fixture, index) => {
    const row = fixture.rows[0]!;
    const observations = row.observations.slice(0, 2).map((observation, cellIndex) => ({
      ...observation,
      id: `two-row-${index}-c${cellIndex}`,
      text: index === 0 ? (cellIndex === 0 ? 'LDL-C' : '118') : cellIndex === 0 ? 'Ferritin' : '42',
      alternatives: [],
    }));
    return {
      rowId: `two-row-${index}`,
      sourceObservationIds: observations.map((observation) => observation.id),
      observations,
    };
  });
  return {
    id: 'fabricated-two-row-production-request',
    language: 'en',
    rows,
    observations: rows.flatMap((row) => row.observations),
    expected: [
      {
        rowId: 'two-row-0',
        sourceObservationIds: rows[0]!.sourceObservationIds,
        sourceFactObservationIds: [rows[0]!.sourceObservationIds[1]!],
        sourceFields: {
          label: rows[0]!.sourceObservationIds[0]!,
          value: rows[0]!.sourceObservationIds[1]!,
          unit: null,
          referenceInterval: null,
          flag: null,
        },
        biomarkerId: 'biomarker.ldl_c',
        role: 'measurement',
        specimenType: 'serum',
        sourceFacts: { valueString: '118', unit: '', referenceInterval: '' },
      },
      {
        rowId: 'two-row-1',
        sourceObservationIds: rows[1]!.sourceObservationIds,
        sourceFactObservationIds: [rows[1]!.sourceObservationIds[1]!],
        sourceFields: {
          label: rows[1]!.sourceObservationIds[0]!,
          value: rows[1]!.sourceObservationIds[1]!,
          unit: null,
          referenceInterval: null,
          flag: null,
        },
        biomarkerId: 'biomarker.ferritin',
        role: 'measurement',
        specimenType: 'serum',
        sourceFacts: { valueString: '42', unit: '', referenceInterval: '' },
      },
    ],
  };
}

test('keeps a valid sibling and retries only the malformed cross-row sibling', async () => {
  const fixture = twoRowProductionFixture();
  const prompts: string[] = [];
  let calls = 0;
  const report = await runProductionBaseline({
    fixtures: [fixture],
    transport: async (request) => {
      calls += 1;
      prompts.push(request.prompt);
      if (calls === 1)
        return JSON.stringify({
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
            {
              sourceObservationIds: [
                fixture.rows[1]!.sourceObservationIds[0]!,
                fixture.rows[0]!.sourceObservationIds[1]!,
              ],
              proposedBiomarkerId: 'biomarker.ferritin',
              proposedSpecimenType: 'serum',
              role: 'measurement',
            },
          ],
        });
      return JSON.stringify({
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
            biomarkerId: 'biomarker.ferritin',
          },
        ],
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(report.retryCount, 1);
  assert.equal(report.quality.acceptedProposals, 2);
  assert.equal(report.quality.correctAcceptedProposals, 2);
  assert.equal(report.quality.exactSourceFactsPreserved, 2);
  assert.doesNotMatch(prompts[1]!, /"text":"LDL-C"/u);
});

test('fails before fixture inference when the fixed Ollama alias preflight fails', async () => {
  let requests = 0;
  await assert.rejects(
    runProductionBaseline({
      transport: async () => {
        requests += 1;
        return '{}';
      },
      preflight: async () => {
        throw new Error('caller payload /private/health/report');
      },
    }),
    /model-evaluation-failed:ollama-identity/,
  );
  assert.equal(requests, 0);
});

test('does not award source preservation or perfect correctness for a wrong selected cell', async () => {
  const fixture = productionV2Fixtures[0]!;
  const report = await runProductionBaseline({
    fixtures: [fixture],
    transport: async () =>
      JSON.stringify({
        schemaVersion: 'alyte.semantic-mapper.v2',
        proposals: [
          {
            rowKey: 'r0',
            labelKey: 'c1',
            valueKey: 'c0',
            unitKey: 'c2',
            referenceIntervalKey: 'c3',
            flagKey: null,
            role: 'measurement',
            specimenType: 'serum',
            biomarkerId: 'biomarker.ldl_c',
          },
        ],
      }),
  });
  assert.equal(report.quality.acceptedProposals, 1);
  assert.equal(report.quality.correctAcceptedProposals, 0);
  assert.equal(report.quality.exactSourceFactsPreserved, 0);
});
