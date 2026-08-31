import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildGeometryCandidateWindows,
  groupGeometryCandidateWindows,
  reconstructGeometryLattice,
  type GeometryCandidateWindowGroup,
  type GeometrySourceObservation,
  type VisionTextObservation,
} from '@alyte/domain';
import { productionLocalModelManifest } from './production-manifest.generated';
import type { LocalModelService } from './native';
import type { LocalModelSnapshot } from './model';
import {
  createGeometryVariantMapper,
  createGemma4GeometryVariantPrompt,
  type GeometryVariantPromptWrapper,
} from './geometry-variant-mapper';
import { GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION } from './geometry-variant-contract';

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

function observation(
  id: string,
  text: string,
  rowIndex: number,
  columnIndex: number,
): VisionTextObservation {
  return {
    id,
    text,
    alternatives: [],
    pageIndex: 0,
    orientation: 0,
    boundingBox: {
      x: 0.04 + columnIndex * 0.18,
      y: 0.12 + rowIndex * 0.07,
      width: 0.15,
      height: 0.03,
    },
    recognition: { level: 'accurate', language: 'lt', internalConfidence: null },
    structure: {
      kind: 'table-cell',
      tableId: 'results',
      rowIndex,
      columnIndex,
    },
  };
}

function groupsFrom(
  source: readonly VisionTextObservation[],
): readonly GeometryCandidateWindowGroup[] {
  const lattice = reconstructGeometryLattice(source as readonly GeometrySourceObservation[]);
  return groupGeometryCandidateWindows(buildGeometryCandidateWindows(lattice, source));
}

const groups = groupsFrom([
  observation('label-a', 'Fabricated marker A', 0, 0),
  observation('value-a', '7.2', 0, 1),
  observation('unit-a', 'mg/L', 0, 2),
  observation('label-b', 'Transferazė', 1, 0),
  observation('value-b-first', '12,4', 1, 1),
  observation('unit-b', 'U/L', 1, 2),
  observation('value-b-second', '13,1', 1, 3),
]);

assert.equal(groups.length, 2);

function models(
  infer: (
    prompt: string,
    limits?: { maxOutputTokens: number; outputCapacity: number },
  ) => Promise<string>,
): LocalModelService {
  return {
    getState: async () => loadedState,
    load: async () => loadedState,
    unload: async () => ({ ...loadedState, state: 'ready', loaded: false }),
    infer,
    cancelInference: () => undefined,
  } as unknown as LocalModelService;
}

function identityWrapper(
  calls: Array<{ prompt: string; retry: boolean; serializedChunk: string }>,
): GeometryVariantPromptWrapper {
  return ({ prompt, retry, serializedChunk }) => {
    calls.push({ prompt, retry, serializedChunk });
    return prompt;
  };
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

test('advertises the complete two-group observation bound', () => {
  const mapper = createGeometryVariantMapper({
    models: models(async () => '{}'),
  });
  assert.equal(mapper.maxRowsPerChunk, 2);
  assert.equal(mapper.maxObservationsPerChunk, 48);
});

test('uses the injectable model wrapper and exact geometry inference bounds', async () => {
  const wrapperCalls: Array<{
    prompt: string;
    retry: boolean;
    serializedChunk: string;
  }> = [];
  const inferenceCalls: Array<{
    prompt: string;
    maxOutputTokens?: number;
    outputCapacity?: number;
  }> = [];
  const mapper = createGeometryVariantMapper({
    models: models(async (prompt, limits) => {
      inferenceCalls.push({ prompt, ...limits });
      return JSON.stringify({
        schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
        selections: { r0: 'v0', r1: 'v1' },
      });
    }),
    promptWrapper: identityWrapper(wrapperCalls),
  });

  const result = await mapper.map({ groups, locale: 'lt-LT' });
  assert.equal(result.incomplete, false);
  assert.equal(result.failures.length, 0);
  assert.equal(result.attempts, 1);
  assert.equal(result.proposals.length, 2);
  assert.equal(wrapperCalls.length, 1);
  assert.equal(inferenceCalls.length, 1);
  assert.equal(inferenceCalls[0]!.maxOutputTokens, 96);
  assert.equal(inferenceCalls[0]!.outputCapacity, 8 * 1024);
  assert.equal(wrapperCalls[0]!.retry, false);
  assert.match(wrapperCalls[0]!.prompt, /Schema alyte\.geometry-variant-selector\.v2/u);
  assert.equal(wrapperCalls[0]!.serializedChunk.includes(groups[0]!.rowId), false);
});

test('treats a valid all-null envelope as complete review, without retry', async () => {
  let calls = 0;
  const mapper = createGeometryVariantMapper({
    models: models(async () => {
      calls += 1;
      return JSON.stringify({
        schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
        selections: { r0: null, r1: null },
      });
    }),
    promptWrapper: ({ prompt }) => prompt,
  });

  const result = await mapper.map({ groups, locale: 'lt-LT' });
  assert.deepEqual(result.proposals, []);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.failures, []);
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});

test('retries only an unknown variant group and preserves the accepted sibling', async () => {
  const calls: Array<{ prompt: string; retry: boolean }> = [];
  let inference = 0;
  const mapper = createGeometryVariantMapper({
    models: models(async () => {
      inference += 1;
      return inference === 1
        ? JSON.stringify({
            schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
            selections: { r0: 'v0', r1: 'v999' },
          })
        : JSON.stringify({
            schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
            selections: { r0: 'v1' },
          });
    }),
    promptWrapper: ({ prompt, retry, serializedChunk }) => {
      calls.push({ prompt: `${prompt}\n${serializedChunk}`, retry });
      return prompt;
    },
  });

  const result = await mapper.map({ groups, locale: 'lt-LT' });
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.failures, []);
  assert.equal(result.attempts, 2);
  assert.equal(result.proposals.length, 2);
  assert.deepEqual(result.proposals[0]!.sourceObservationIds, groups[0]!.sourceObservationIds);
  assert.deepEqual(result.proposals[1]!.sourceObservationIds, groups[1]!.sourceObservationIds);
  assert.equal(calls[0]!.retry, false);
  assert.equal(calls[1]!.retry, true);
  // The retry serializes only the failed second group, re-indexed as r0. The accepted sibling's
  // source text must not be sent again.
  assert.equal(calls[1]!.prompt.includes('Fabricated marker A'), false);
  assert.equal(calls[1]!.prompt.includes('Transferazė'), true);
});

test('retries malformed output once, then reports terminal incompleteness without dropping siblings', async () => {
  let inference = 0;
  const mapper = createGeometryVariantMapper({
    models: models(async () => {
      inference += 1;
      return inference === 1
        ? 'not-json'
        : JSON.stringify({
            schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
            selections: { r0: 'v0', r1: null },
          });
    }),
    promptWrapper: ({ prompt }) => prompt,
  });

  const result = await mapper.map({ groups, locale: 'lt-LT' });
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.failures, []);
  assert.equal(result.attempts, 2);
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.proposals[0]!.sourceObservationIds, groups[0]!.sourceObservationIds);
});

test('keeps accepted siblings when the failed retry remains malformed', async () => {
  let inference = 0;
  const mapper = createGeometryVariantMapper({
    models: models(async () => {
      inference += 1;
      return inference === 1
        ? JSON.stringify({
            schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
            selections: { r0: 'v0', r1: 'v999' },
          })
        : 'not-json';
    }),
    promptWrapper: ({ prompt }) => prompt,
  });

  const result = await mapper.map({ groups, locale: 'lt-LT' });
  assert.equal(result.incomplete, true);
  assert.ok(result.failures.includes('malformed-envelope'));
  assert.equal(result.attempts, 2);
  assert.equal(result.proposals.length, 1);
  assert.deepEqual(result.proposals[0]!.sourceObservationIds, groups[0]!.sourceObservationIds);
});

test('uses the reviewed Gemma turn wrapper by default', () => {
  const wrapped = createGemma4GeometryVariantPrompt({
    prompt: 'JSON only.',
    serializedChunk: '{}',
    locale: 'en-US',
    retry: false,
  });
  assert.match(wrapped, /^<bos><\|turn>system\n/u);
  assert.match(wrapped, /<\|turn>user\nJSON only\./u);
  assert.match(wrapped, /<\|turn>model\n$/u);
});

test('times out a hung native call, quarantines the runtime, and never reuses it', async () => {
  let inferCalls = 0;
  let cancelCalls = 0;
  let unloadCalls = 0;
  let resolveNative: ((value: string) => void) | undefined;
  const mapper = createGeometryVariantMapper({
    timeoutMs: 10,
    models: {
      ...models(async () => {
        inferCalls += 1;
        return new Promise<string>((resolve) => {
          resolveNative = resolve;
        });
      }),
      cancelInference: () => {
        cancelCalls += 1;
      },
      unload: async () => {
        unloadCalls += 1;
        return { ...loadedState, state: 'ready', loaded: false };
      },
    },
  });

  const lease = await mapper.prepare();
  const result = await mapper.map({ groups, locale: 'lt-LT' });
  assert.equal(result.incomplete, true);
  assert.ok(result.failures.includes('inference-failed'));
  assert.equal(result.attempts, 2);
  // The retry is rejected by quarantine before it reaches native inference.
  assert.equal(inferCalls, 1);
  assert.ok(cancelCalls >= 1);
  await lease.release();
  assert.equal(unloadCalls, 0);

  // Let the late bridge promise settle so the active inference can leave quarantine cleanly.
  resolveNative?.(
    JSON.stringify({
      schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: null, r1: null },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(unloadCalls, 1);
});

test('cancellation signals native stop, drains briefly, and rejects the mapping', async () => {
  let resolveNative: ((value: string) => void) | undefined;
  let startedResolve: (() => void) | undefined;
  let cancelCalls = 0;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const mapper = createGeometryVariantMapper({
    models: {
      ...models(async () => {
        startedResolve?.();
        return new Promise<string>((resolve) => {
          resolveNative = resolve;
        });
      }),
      cancelInference: () => {
        cancelCalls += 1;
      },
    },
  });
  const controller = cancellationController();
  const mapping = mapper.map({
    groups,
    locale: 'lt-LT',
    cancellation: controller.cancellation,
  });
  await started;
  controller.cancel();
  await assert.rejects(mapping, /semantic-inference-cancelled/u);
  assert.ok(cancelCalls >= 1);

  resolveNative?.(
    JSON.stringify({
      schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
      selections: { r0: null, r1: null },
    }),
  );
});
