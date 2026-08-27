import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalModelService } from './native';
import type { LocalModelSnapshot } from './model';
import type { ExtractionSemanticCancellation } from '@alyte/domain';
import { productionLocalModelManifest } from './manifest';
import { createLocalSemanticMapper, SemanticModelUnavailableError } from './semantic-mapper';
import { createSemanticMapperPrompt } from './semantic-contract';
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
  id: 'synthetic-ldl-label',
  text: 'LDL-C',
  alternatives: [],
  pageIndex: 0,
  orientation: 0,
  boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
  recognition: { level: 'accurate', language: 'de', internalConfidence: null },
};

const valueObservation: VisionTextObservation = {
  ...observation,
  id: 'synthetic-ldl-value',
  text: '3,8',
  boundingBox: { x: 0.5, y: 0.2, width: 0.3, height: 0.04 },
};

const unitObservation: VisionTextObservation = {
  ...observation,
  id: 'synthetic-ldl-unit',
  text: 'mmol/L',
  boundingBox: { x: 0.8, y: 0.2, width: 0.15, height: 0.04 },
};

const candidateRow = {
  rowId: 'synthetic-ldl-row',
  sourceObservationIds: [observation.id, valueObservation.id, unitObservation.id],
  observations: [observation, valueObservation, unitObservation],
} as const;

function models(
  infer: (prompt: string) => Promise<string>,
  state: LocalModelSnapshot = loadedState,
  cancelInference: () => void = () => undefined,
): LocalModelService {
  return {
    getState: async () => state,
    load: async () => loadedState,
    infer,
    cancelInference,
  } as unknown as LocalModelService;
}

const aliases = [
  { id: 'biomarker.ldl_c', aliases: ['LDL-C'], specimens: ['serum'], units: ['mmol/L'] },
] as const;

function cancellationController(): {
  readonly cancellation: ExtractionSemanticCancellation;
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
    aliases,
  });
  await assert.rejects(mapper.prepare!(), (error: unknown) => {
    assert.ok(error instanceof SemanticModelUnavailableError);
    return true;
  });
});

test('keeps an overlapping extraction runtime until the last lease is released', async () => {
  let state: LocalModelSnapshot = { ...loadedState, state: 'ready', loaded: false };
  let loadCalls = 0;
  let unloadCalls = 0;
  const runtimeModels = {
    getState: async () => state,
    load: async () => {
      loadCalls += 1;
      state = { ...state, state: 'loaded', loaded: true };
      return state;
    },
    unload: async () => {
      unloadCalls += 1;
      state = { ...state, state: 'ready', loaded: false };
      return state;
    },
  } as unknown as LocalModelService;
  const mapper = createLocalSemanticMapper({ models: runtimeModels, aliases });

  const first = await mapper.prepare!();
  const second = await mapper.prepare!();
  assert.equal(loadCalls, 1);
  await first.release();
  assert.equal(unloadCalls, 0);
  await second.release();
  assert.equal(unloadCalls, 1);
  await second.release();
  assert.equal(unloadCalls, 1);
});

test('translates only typed native unavailability during inference', async () => {
  const unavailable = Object.assign(new Error('synthetic model removed'), {
    failureCategory: 'unavailable' as const,
  });
  const unavailableMapper = createLocalSemanticMapper({
    models: models(async () => Promise.reject(unavailable)),
    aliases,
  });
  await assert.rejects(
    unavailableMapper.map({ pageIndex: 0, rows: [candidateRow] }),
    SemanticModelUnavailableError,
  );

  const runtimeFailure = Object.assign(new Error('synthetic runtime failure'), {
    failureCategory: 'runtime-failed' as const,
  });
  const runtimeMapper = createLocalSemanticMapper({
    models: models(async () => Promise.reject(runtimeFailure)),
    aliases,
  });
  await assert.rejects(
    runtimeMapper.map({ pageIndex: 0, rows: [candidateRow] }),
    (error: unknown) => error === runtimeFailure,
  );
});

test('accepts only validated source selections and preserves versioned provenance', async () => {
  const mapper = createLocalSemanticMapper({
    models: models(async () =>
      JSON.stringify({
        schemaVersion: 'alyte.semantic-mapper.v2',
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
            biomarkerId: 'biomarker.ldl_c',
          },
        ],
      }),
    ),
    aliases,
  });
  const mapped = await mapper.map({ pageIndex: 0, rows: [candidateRow] });
  assert.deepEqual(mapped, [
    {
      sourceObservationIds: ['synthetic-ldl-label', 'synthetic-ldl-value', 'synthetic-ldl-unit'],
      sourceFields: {
        label: 'synthetic-ldl-label',
        value: 'synthetic-ldl-value',
        unit: 'synthetic-ldl-unit',
        referenceInterval: null,
        flag: null,
      },
      proposedBiomarkerId: 'biomarker.ldl_c',
      proposedSpecimenType: 'serum',
      role: 'measurement',
    },
  ]);
  assert.equal(mapper.provenance?.promptVersion, 'alyte.semantic-mapper.prompt.v4');
  assert.equal(mapper.maxRowsPerChunk, 4);
});

test('rejects invented root keys before semantic validation', async () => {
  const mapper = createLocalSemanticMapper({
    models: models(async () =>
      JSON.stringify({
        schemaVersion: 'alyte.semantic-mapper.v1',
        proposals: [],
        medicalExplanation: 'not allowed',
      }),
    ),
    aliases,
  });
  assert.deepEqual(await mapper.map({ pageIndex: 0, rows: [candidateRow] }), []);
});

test('rejects a partial envelope and times out without retaining model output', async () => {
  let calls = 0;
  let cancelled = 0;
  let finishSecondInference: (() => void) | undefined;
  const mapper = createLocalSemanticMapper({
    timeoutMs: 5,
    models: models(
      async () => {
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
        return new Promise<string>((resolve) => {
          finishSecondInference = () =>
            resolve('{"schemaVersion":"alyte.semantic-mapper.v1","proposals":[]}');
        });
      },
      loadedState,
      () => {
        cancelled += 1;
        finishSecondInference?.();
      },
    ),
    aliases,
  });
  assert.deepEqual(await mapper.map({ pageIndex: 0, rows: [candidateRow] }), []);
  await assert.rejects(
    mapper.map({ pageIndex: 0, rows: [candidateRow] }),
    /semantic-inference-timeout/,
  );
  // The timeout is a cooperative native cancellation request, not only a JS race.
  assert.equal(cancelled, 1);
});

test('waits for the active inference before releasing the last runtime lease', async () => {
  let resolveInference!: (value: string) => void;
  let inferenceStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    inferenceStarted = resolve;
  });
  const inference = new Promise<string>((resolve) => {
    resolveInference = resolve;
  });
  let unloadCalls = 0;
  const runtimeModels = {
    ...models(async () => {
      inferenceStarted();
      return inference;
    }),
    unload: async () => {
      unloadCalls += 1;
      return { ...loadedState, state: 'ready' as const, loaded: false };
    },
  } as LocalModelService;
  const mapper = createLocalSemanticMapper({ models: runtimeModels, aliases });
  const lease = await mapper.prepare!();
  const mapped = mapper.map({ pageIndex: 0, rows: [candidateRow] });
  await started;

  let released = false;
  const release = lease.release().then(() => {
    released = true;
  });
  await Promise.resolve();
  assert.equal(released, false);
  assert.equal(unloadCalls, 0);

  resolveInference('{"schemaVersion":"alyte.semantic-mapper.v1","proposals":[]}');
  await mapped;
  await release;
  assert.equal(released, true);
  assert.equal(unloadCalls, 1);
});

test('signals the active generation and quarantines a non-settling native call', async () => {
  const controller = cancellationController();
  let cancelCalls = 0;
  let resolveInference!: (value: string) => void;
  let inferenceStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    inferenceStarted = resolve;
  });
  const inference = new Promise<string>((resolve) => {
    resolveInference = resolve;
  });
  let unloadCalls = 0;
  const runtimeModels = {
    ...models(
      async () => {
        inferenceStarted();
        return inference;
      },
      loadedState,
      () => {
        cancelCalls += 1;
      },
    ),
    unload: async () => {
      unloadCalls += 1;
      return { ...loadedState, state: 'ready' as const, loaded: false };
    },
  } as LocalModelService;
  const mapper = createLocalSemanticMapper({
    models: runtimeModels,
    aliases,
    timeoutMs: 5_000,
  });
  const lease = await mapper.prepare!();
  const mapped = mapper.map({
    pageIndex: 0,
    rows: [candidateRow],
    cancellation: controller.cancellation,
  });
  await started;
  controller.cancel();
  await assert.rejects(mapped, /semantic-inference-cancelled/);
  assert.equal(cancelCalls, 1);

  const releaseStarted = Date.now();
  await lease.release();
  assert.ok(Date.now() - releaseStarted < 1_500);
  assert.equal(unloadCalls, 0);
  await assert.rejects(
    mapper.map({ pageIndex: 0, rows: [candidateRow] }),
    /semantic-inference-runtime-quarantined/,
  );

  resolveInference('{"schemaVersion":"alyte.semantic-mapper.v1","proposals":[]}');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unloadCalls, 1);
});

test('uses the production Gemma turn template and reviewed row instruction', () => {
  const prompt = createSemanticMapperPrompt('lt', '{"observations":[]}');
  assert.match(prompt, /^<bos><\|turn>system\n/u);
  assert.match(prompt, /<\|turn>user\n/u);
  assert.match(prompt, /<\|turn>model\n$/u);
  assert.match(prompt, /one proposal/u);
  assert.doesNotMatch(prompt, /<\|im_start>|<think>/u);
});
