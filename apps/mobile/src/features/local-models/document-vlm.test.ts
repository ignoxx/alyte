import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalModelService } from './native';
import { productionLocalModelManifest } from './production-manifest.generated';
import {
  createDocumentVLMPrompt,
  createLocalDocumentVLM,
  decodeDocumentVLMRows,
} from './document-vlm';

function cancellationController() {
  let cancelled = false;
  const listeners = new Set<() => void>();
  return {
    cancellation: {
      isCancelled: () => cancelled,
      subscribe: (listener: () => void) => {
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

test('flat document rows decode strictly without normalizing source strings', () => {
  assert.deepEqual(
    decodeDocumentVLMRows(
      JSON.stringify({
        rows: [
          {
            label: 'Hämoglobin',
            value: '13,4',
            unit: 'g/dL',
            reference_interval: '12,0–16,0',
            flag: null,
          },
        ],
      }),
    ),
    [
      {
        label: 'Hämoglobin',
        value: '13,4',
        unit: 'g/dL',
        referenceInterval: '12,0–16,0',
        flag: null,
      },
    ],
  );
  assert.throws(
    () =>
      decodeDocumentVLMRows(
        JSON.stringify({
          rows: [
            {
              label: 'Marker',
              value: '1',
              unit: null,
              reference_interval: null,
              flag: null,
              confidence: 0.99,
            },
          ],
        }),
      ),
    /malformed/u,
  );
});

test('Qwen prompt contains one media marker and forbids association guesses', () => {
  const prompt = createDocumentVLMPrompt();
  assert.equal(prompt.match(/<__media__>/gu)?.length, 1);
  assert.match(prompt, /observed result, never a reference/u);
  assert.match(prompt, /Do not translate, normalize, calculate, infer/u);
  assert.match(prompt, /Return JSON only/u);
});

test('document extraction uses one source-verbatim pipeline for every report locale', () => {
  const models = {} as LocalModelService;
  const extractor = createLocalDocumentVLM({ models });
  assert.equal(extractor.supports('en-US'), true);
  assert.equal(extractor.supports('de-DE'), true);
  assert.equal(extractor.supports('lt-LT'), true);
  assert.equal(extractor.supports('pl-PL'), true);
  assert.equal(extractor.supports(null), true);
});

test('document runtime is cold until prepare and unloads when its lease ends', async () => {
  const calls: string[] = [];
  let loaded = false;
  let models: LocalModelService;
  models = {
    manifest: productionLocalModelManifest,
    getState: async () => ({
      packId: productionLocalModelManifest.pack.id,
      state: loaded ? ('loaded' as const) : ('ready' as const),
      bytesReceived: productionLocalModelManifest.pack.bytes,
      expectedBytes: productionLocalModelManifest.pack.bytes,
      progress: 1,
      failure: null,
      storageBytes: productionLocalModelManifest.pack.bytes,
      loaded,
    }),
    subscribe: () => () => undefined,
    startDownload: async () => {
      throw new Error('unexpected download');
    },
    cancelDownload: async () => {
      throw new Error('unexpected cancellation');
    },
    load: async () => {
      calls.push('load');
      loaded = true;
      return models.getState();
    },
    infer: async () => '{}',
    inferImage: async () => {
      calls.push('infer-image');
      return '{"rows":[]}';
    },
    cancelInference: () => calls.push('cancel'),
    unload: async () => {
      calls.push('unload');
      loaded = false;
      return models.getState();
    },
    deletePack: async () => {
      throw new Error('unexpected delete');
    },
  };

  const extractor = createLocalDocumentVLM({ models });
  assert.deepEqual(calls, []);
  await extractor.checkAvailability();
  assert.deepEqual(calls, []);
  const lease = await extractor.prepare();
  assert.deepEqual(calls, ['load']);
  assert.deepEqual(
    await extractor.extract({ pageIndex: 0, imageURI: 'file:///tmp/synthetic.jpg', locale: 'en' }),
    [],
  );
  await lease.release();
  assert.deepEqual(calls, ['load', 'infer-image', 'unload']);
});

test('overlapping leases share one load and unload only after the final release', async () => {
  let loaded = false;
  let loadCalls = 0;
  let unloadCalls = 0;
  let models: LocalModelService;
  models = {
    manifest: productionLocalModelManifest,
    getState: async () => ({
      packId: productionLocalModelManifest.pack.id,
      state: loaded ? ('loaded' as const) : ('ready' as const),
      bytesReceived: productionLocalModelManifest.pack.bytes,
      expectedBytes: productionLocalModelManifest.pack.bytes,
      progress: 1,
      failure: null,
      storageBytes: productionLocalModelManifest.pack.bytes,
      loaded,
    }),
    subscribe: () => () => undefined,
    startDownload: async () => models.getState(),
    cancelDownload: async () => models.getState(),
    load: async () => {
      loadCalls += 1;
      loaded = true;
      return models.getState();
    },
    infer: async () => '{}',
    inferImage: async () => '{"rows":[]}',
    cancelInference: () => undefined,
    unload: async () => {
      unloadCalls += 1;
      loaded = false;
      return models.getState();
    },
    deletePack: async () => models.getState(),
  };

  const extractor = createLocalDocumentVLM({ models });
  const [first, second] = await Promise.all([extractor.prepare(), extractor.prepare()]);
  assert.equal(loadCalls, 1);
  await first.release();
  assert.equal(unloadCalls, 0);
  assert.deepEqual(
    await extractor.extract({ pageIndex: 0, imageURI: 'file:///tmp/synthetic.jpg', locale: 'de' }),
    [],
  );
  await second.release();
  assert.equal(unloadCalls, 1);
});

test('quarantines a non-settling image inference and defers unload until it settles', async () => {
  const controller = cancellationController();
  let loaded = false;
  let cancelCalls = 0;
  let unloadCalls = 0;
  let resolveInference!: (value: string) => void;
  let inferenceStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    inferenceStarted = resolve;
  });
  const nativeInference = new Promise<string>((resolve) => {
    resolveInference = resolve;
  });
  let models: LocalModelService;
  models = {
    manifest: productionLocalModelManifest,
    getState: async () => ({
      packId: productionLocalModelManifest.pack.id,
      state: loaded ? ('loaded' as const) : ('ready' as const),
      bytesReceived: productionLocalModelManifest.pack.bytes,
      expectedBytes: productionLocalModelManifest.pack.bytes,
      progress: 1,
      failure: null,
      storageBytes: productionLocalModelManifest.pack.bytes,
      loaded,
    }),
    subscribe: () => () => undefined,
    startDownload: async () => models.getState(),
    cancelDownload: async () => models.getState(),
    load: async () => {
      loaded = true;
      return models.getState();
    },
    infer: async () => '{}',
    inferImage: async () => {
      inferenceStarted();
      return nativeInference;
    },
    cancelInference: () => {
      cancelCalls += 1;
    },
    unload: async () => {
      unloadCalls += 1;
      loaded = false;
      return models.getState();
    },
    deletePack: async () => models.getState(),
  };

  const extractor = createLocalDocumentVLM({ models, timeoutMs: 5_000 });
  const lease = await extractor.prepare();
  const extraction = extractor.extract({
    pageIndex: 0,
    imageURI: 'file:///tmp/synthetic.jpg',
    locale: 'en',
    cancellation: controller.cancellation,
  });
  await started;
  controller.cancel();
  controller.cancel();
  await assert.rejects(extraction, /document-vlm-cancelled/u);
  assert.equal(cancelCalls, 1);

  const releaseStarted = Date.now();
  await lease.release();
  assert.ok(Date.now() - releaseStarted < 1_500);
  assert.equal(unloadCalls, 0);
  await assert.rejects(
    extractor.extract({ pageIndex: 0, imageURI: 'file:///tmp/second.jpg', locale: 'en' }),
    /document-vlm-runtime-quarantined/u,
  );

  resolveInference('{"rows":[]}');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(unloadCalls, 1);
});
