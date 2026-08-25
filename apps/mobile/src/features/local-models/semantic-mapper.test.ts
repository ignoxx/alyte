import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalModelService } from './native';
import type { LocalModelSnapshot } from './model';
import { productionLocalModelManifest } from './manifest';
import { createLocalSemanticMapper, SemanticModelUnavailableError } from './semantic-mapper';
import type { VisionTextObservation } from '@alyte/domain';

const loadedState = {
  packId: productionLocalModelManifest.pack.id,
  state: 'loaded' as const,
  bytesReceived: productionLocalModelManifest.pack.artifact.bytes,
  expectedBytes: productionLocalModelManifest.pack.artifact.bytes,
  progress: 1,
  failure: null,
  storageBytes: productionLocalModelManifest.pack.artifact.bytes,
  loaded: true,
};

const observation: VisionTextObservation = {
  id: 'synthetic-ldl',
  text: 'LDL-C 3,8 mmol/L',
  alternatives: [],
  pageIndex: 0,
  orientation: 0,
  boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
  recognition: { level: 'accurate', language: 'de', internalConfidence: null },
};

function models(
  infer: (prompt: string) => Promise<string>,
  state: LocalModelSnapshot = loadedState,
): LocalModelService {
  return {
    getState: async () => state,
    load: async () => loadedState,
    infer,
  } as unknown as LocalModelService;
}

test('routes missing packs before Vision/model inference', async () => {
  const mapper = createLocalSemanticMapper({
    models: models(async () => '{"schemaVersion":"alyte.semantic-mapper.v1","proposals":[]}', {
      ...loadedState,
      state: 'not-installed',
      bytesReceived: 0,
      progress: 0,
      storageBytes: 0,
      loaded: false,
    }),
  });
  await assert.rejects(mapper.prepare!(), (error: unknown) => {
    assert.ok(error instanceof SemanticModelUnavailableError);
    return true;
  });
});

test('accepts only validated source selections and preserves versioned provenance', async () => {
  const mapper = createLocalSemanticMapper({
    models: models(async () =>
      JSON.stringify({
        schemaVersion: 'alyte.semantic-mapper.v1',
        proposals: [
          {
            sourceObservationIds: ['synthetic-ldl'],
            role: 'measurement',
            specimenType: 'serum',
            biomarkerId: 'biomarker.ldl_c',
          },
        ],
      }),
    ),
  });
  const mapped = await mapper.map({ pageIndex: 0, observations: [observation] });
  assert.deepEqual(mapped, [
    {
      sourceObservationIds: ['synthetic-ldl'],
      proposedBiomarkerId: 'biomarker.ldl_c',
      proposedSpecimenType: 'serum',
      role: 'measurement',
    },
  ]);
  assert.equal(mapper.provenance?.promptVersion, 'alyte.semantic-mapper.prompt.v1');
  assert.equal(mapper.maxRowsPerChunk, 12);
});

test('rejects a partial envelope and times out without retaining model output', async () => {
  let calls = 0;
  const mapper = createLocalSemanticMapper({
    timeoutMs: 5,
    models: models(async () => {
      calls += 1;
      if (calls === 1) {
        return JSON.stringify({
          schemaVersion: 'alyte.semantic-mapper.v1',
          proposals: [
            {
              sourceObservationIds: ['synthetic-ldl'],
              role: 'measurement',
              specimenType: 'serum',
              biomarkerId: 'biomarker.ldl_c',
            },
            {
              sourceObservationIds: ['invented-source'],
              role: 'measurement',
              specimenType: 'serum',
              biomarkerId: 'biomarker.ldl_c',
            },
          ],
        });
      }
      return new Promise<string>(() => {});
    }),
  });
  assert.deepEqual(await mapper.map({ pageIndex: 0, observations: [observation] }), []);
  await assert.rejects(
    mapper.map({ pageIndex: 0, observations: [observation] }),
    /semantic-inference-timeout/,
  );
});
