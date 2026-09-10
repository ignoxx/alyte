import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import type { LocalModelService } from '../../apps/mobile/src/features/local-models/native';
import { productionLocalModelManifest } from '../../apps/mobile/src/features/local-models/production-manifest.generated';
import { createEvaluationDocumentVLM } from './evaluation-document-vlm';
import {
  assertPrivateEvaluationPath,
  createDocumentVLMPrompt,
  decodeDocumentVLMRows,
  createQwenMacDocumentVLM,
  ensurePrivateDirectory,
  ensurePrivateFile,
  extractQwenMacPage,
  readProductionDocumentGrammar,
} from './qwen-mac-cli';
import {
  createQwenMacDocumentVLM as createQwen35MacDocumentVLM,
  QWEN35_MODEL_ID,
  QWEN35_MODEL_REVISION,
  QWEN35_MODEL_SHA256,
  QWEN35_PROJECTOR_SHA256,
  QWEN35_RUNTIME_REVISION,
} from './qwen35-mac-cli';

function fixture(slow = false) {
  const root = mkdtempSync(join(tmpdir(), 'alyte-qwen-mac-'));
  const image = join(root, 'page-01.png');
  const binary = join(root, 'llama-mtmd-cli');
  const model = join(root, 'model.gguf');
  const mmproj = join(root, 'mmproj.gguf');
  writeFileSync(image, 'synthetic image bytes', { mode: 0o600 });
  writeFileSync(model, 'synthetic model bytes', { mode: 0o600 });
  writeFileSync(mmproj, 'synthetic projector bytes', { mode: 0o600 });
  writeFileSync(
    binary,
    slow
      ? '#!/bin/sh\nmkdir -p "$PWD/raw"\numask 077\nprintf \'%s\\n\' "$@" > "$PWD/raw/invocation-args.txt"\nsleep 3\nprintf \'%s\' \'{"rows":[]}\'\n'
      : '#!/bin/sh\nmkdir -p "$PWD/raw"\numask 077\nprintf \'%s\\n\' "$@" > "$PWD/raw/invocation-args.txt"\nprintf \'%s\' \'{"rows":[{"label":"Hämoglobin","value":"13,4","unit":"g/dL","reference_interval":"12,0–16,0","flag":null}]}\'\n',
    { mode: 0o700 },
  );
  chmodSync(binary, 0o700);
  return { root, image, binary, model, mmproj };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fixtureProvenance(files: ReturnType<typeof fixture>) {
  return {
    modelExpectedSha256: sha256(files.model),
    projectorExpectedSha256: sha256(files.mmproj),
  } as const;
}

function syntheticEvaluationModel(settlementDelayMs: number) {
  const state = {
    packId: productionLocalModelManifest.pack.id,
    state: 'loaded' as const,
    bytesReceived: productionLocalModelManifest.pack.bytes,
    expectedBytes: productionLocalModelManifest.pack.bytes,
    progress: 1,
    failure: null,
    storageBytes: productionLocalModelManifest.pack.bytes,
    loaded: true,
  };
  let inferenceCalls = 0;
  let inFlight = 0;
  let cancelCalls = 0;
  let unloadCalls = 0;
  let rejectInference: ((reason?: unknown) => void) | null = null;
  const model = {
    manifest: productionLocalModelManifest,
    getState: async () => state,
    subscribe: () => () => undefined,
    startDownload: async () => state,
    cancelDownload: async () => state,
    load: async () => state,
    infer: async () => {
      throw new Error('unused');
    },
    inferImage: async () => {
      inferenceCalls += 1;
      inFlight += 1;
      return new Promise<string>((_resolve, reject) => {
        rejectInference = (reason) => {
          rejectInference = null;
          inFlight -= 1;
          reject(reason);
        };
      });
    },
    cancelInference: () => {
      cancelCalls += 1;
      const reject = rejectInference;
      if (reject === null) return;
      setTimeout(() => reject(new Error('synthetic-cancelled')), settlementDelayMs);
    },
    unload: async () => {
      unloadCalls += 1;
      return state;
    },
    deletePack: async () => state,
  } as LocalModelService;
  return {
    model,
    get inferenceCalls() {
      return inferenceCalls;
    },
    get inFlight() {
      return inFlight;
    },
    get cancelCalls() {
      return cancelCalls;
    },
    get unloadCalls() {
      return unloadCalls;
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('private runner uses the exact production prompt and strict decoder exports', () => {
  const prompt = createDocumentVLMPrompt();
  assert.equal(prompt.match(/<__media__>/gu)?.length, 1);
  assert.match(prompt, /Return JSON only\.<\|im_end\|>/u);
  assert.deepEqual(
    decodeDocumentVLMRows(
      '{"rows":[{"label":"Hämoglobin","value":"13,4","unit":"g/dL","reference_interval":"12,0–16,0","flag":null}]}',
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
  assert.match(readProductionDocumentGrammar(), /root ::= /u);
  assert.match(readProductionDocumentGrammar(), /reference_interval/u);
});

test('mac adapter runs a local CLI and returns decoded source rows with provenance', async () => {
  const files = fixture();
  const result = await extractQwenMacPage({
    image: files.image,
    pageIndex: 0,
    locale: 'de-DE',
    paths: {
      privateRoot: files.root,
      binary: files.binary,
      model: files.model,
      mmproj: files.mmproj,
    },
    provenance: fixtureProvenance(files),
    timeoutMs: 5_000,
  });
  assert.deepEqual(result.rows, [
    {
      label: 'Hämoglobin',
      value: '13,4',
      unit: 'g/dL',
      referenceInterval: '12,0–16,0',
      flag: null,
    },
  ]);
  assert.equal(result.pageIndex, 0);
  assert.equal(result.provenance.promptVersion, 'alyte.document-vlm.prompt.v1');
  assert.equal(result.provenance.schemaVersion, 'alyte.document-vlm.flat-rows.v1');
  assert.equal(result.provenance.cliConfiguration.computeMode, 'gpu-preferred');
  assert.equal(result.provenance.cliConfiguration.device, 'auto');
  assert.equal(result.provenance.cliConfiguration.extractorMode, 'production');
  assert.equal(result.provenance.modelSha256.length, 64);
  assert.equal(result.provenance.projectorSha256.length, 64);
  assert.equal(result.provenance.runtime.binarySha256.length, 64);
});

test('Qwen3.5 evaluation adapter records its configured artifact identity', async () => {
  const files = fixture();
  const result = await createQwen35MacDocumentVLM({
    paths: {
      privateRoot: files.root,
      binary: files.binary,
      model: files.model,
      mmproj: files.mmproj,
    },
    provenance: fixtureProvenance(files),
    maxOutputTokens: 8_192,
    contextTokens: 12_288,
    timeoutMs: 5_000,
  });
  assert.equal(result.provenance.modelId, QWEN35_MODEL_ID);
  assert.equal(result.provenance.modelRevision, QWEN35_MODEL_REVISION);
  assert.equal(result.provenance.modelExpectedSha256, sha256(files.model));
  assert.equal(result.provenance.projectorExpectedSha256, sha256(files.mmproj));
  assert.equal(result.provenance.runtimeRevision, QWEN35_RUNTIME_REVISION);
  assert.equal(result.provenance.modelSha256, result.provenance.modelExpectedSha256);
  assert.equal(result.provenance.projectorSha256, result.provenance.projectorExpectedSha256);
  assert.equal(result.provenance.cliConfiguration.maxOutputTokens, 8_192);
  assert.equal(result.provenance.cliConfiguration.contextTokens, 12_288);
  assert.equal(result.provenance.cliConfiguration.extractorMode, 'evaluation-only');
  assert.notEqual(result.provenance.modelExpectedSha256, QWEN35_MODEL_SHA256);
  assert.notEqual(result.provenance.projectorExpectedSha256, QWEN35_PROJECTOR_SHA256);
});

test('expanded-budget evaluation timeout cancels, quarantines overlap, then unloads after drain', async () => {
  const synthetic = syntheticEvaluationModel(1_200);
  const extractor = createEvaluationDocumentVLM({
    models: synthetic.model,
    timeoutMs: 10,
    maxOutputTokens: 8_192,
  });
  const lease = await extractor.prepare();
  const request = {
    pageIndex: 0,
    imageURI: 'file:///private/evaluation/page.png',
    locale: 'en-US',
    timeoutMs: 10,
    maxOutputTokens: 8_192,
  };
  await assert.rejects(extractor.extract(request), /document-vlm-timeout/u);
  assert.equal(synthetic.cancelCalls, 1);
  assert.equal(synthetic.inFlight, 1);
  await assert.rejects(extractor.extract(request), /document-vlm-runtime-quarantined/u);
  assert.equal(synthetic.inferenceCalls, 1);
  assert.equal(synthetic.inFlight, 1);
  await lease.release();
  assert.equal(synthetic.unloadCalls, 0);
  await delay(100);
  assert.equal(synthetic.unloadCalls, 0);
  await delay(300);
  assert.equal(synthetic.inFlight, 0);
  assert.equal(synthetic.unloadCalls, 1);
});

test('expanded-budget evaluation cancellation signals the native process', async () => {
  const synthetic = syntheticEvaluationModel(20);
  const extractor = createEvaluationDocumentVLM({
    models: synthetic.model,
    timeoutMs: 5_000,
    maxOutputTokens: 8_192,
  });
  const lease = await extractor.prepare();
  let cancelled = false;
  const listeners = new Set<() => void>();
  const cancellation = {
    isCancelled: () => cancelled,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const request = {
    pageIndex: 0,
    imageURI: 'file:///private/evaluation/page.png',
    locale: 'en-US',
    timeoutMs: 5_000,
    maxOutputTokens: 8_192,
    cancellation,
  };
  const work = extractor.extract(request);
  setTimeout(() => {
    cancelled = true;
    listeners.forEach((listener) => listener());
  }, 5);
  await assert.rejects(work, /document-vlm-cancelled/u);
  assert.equal(synthetic.cancelCalls, 1);
  await lease.release();
  assert.equal(synthetic.unloadCalls, 1);
});

test('production extractor passes a smaller request-local output budget to the CLI', async () => {
  const files = fixture();
  const model = await createQwenMacDocumentVLM({
    paths: {
      privateRoot: files.root,
      binary: files.binary,
      model: files.model,
      mmproj: files.mmproj,
    },
    provenance: fixtureProvenance(files),
    maxOutputTokens: 2_048,
    timeoutMs: 5_000,
  });
  const lease = await model.extractor.prepare();
  try {
    await model.extractor.extract({
      pageIndex: 0,
      imageURI: pathToFileURL(files.image).href,
      locale: 'en-US',
      timeoutMs: 5_000,
      maxOutputTokens: 384,
    });
  } finally {
    await lease.release();
  }
  const invocation = readFileSync(join(files.root, 'raw', 'invocation-args.txt'), 'utf8');
  assert.match(invocation, /--n-predict\n384\n/u);
});

test('Qwen3.5 evaluation adapter rejects a model that does not match its expected hash', async () => {
  const files = fixture();
  await assert.rejects(
    createQwen35MacDocumentVLM({
      paths: {
        privateRoot: files.root,
        binary: files.binary,
        model: files.model,
        mmproj: files.mmproj,
      },
      provenance: {
        modelExpectedSha256: QWEN35_MODEL_SHA256,
        projectorExpectedSha256: sha256(files.mmproj),
      },
      timeoutMs: 5_000,
    }),
    /model-hash-mismatch/u,
  );
});

test('timeout cancels the local process through the production extractor lifecycle', async () => {
  const files = fixture(true);
  await assert.rejects(
    extractQwenMacPage({
      image: files.image,
      pageIndex: 0,
      paths: {
        privateRoot: files.root,
        binary: files.binary,
        model: files.model,
        mmproj: files.mmproj,
      },
      provenance: fixtureProvenance(files),
      timeoutMs: 25,
    }),
    /document-vlm-timeout|qwen-mac-cancelled/u,
  );
});

test('input and output artifacts remain inside the private evaluation root', () => {
  const files = fixture();
  assert.equal(assertPrivateEvaluationPath(files.image, files.root, 'input'), files.image);
  assert.throws(
    () => assertPrivateEvaluationPath(join(files.root, '..', 'outside.png'), files.root, 'input'),
    /outside-private-root/u,
  );
  assert.throws(
    () => assertPrivateEvaluationPath(join(files.root, 'result.txt'), files.root, 'output'),
    /output-extension/u,
  );
});

test('accepts a staged path inside the root and tightens existing private modes', () => {
  const files = fixture();
  const staged = join(files.root, 'staged');
  mkdirSync(staged, { recursive: true, mode: 0o755 });
  chmodSync(staged, 0o755);
  const output = join(staged, 'nested', 'result.json');
  assert.equal(assertPrivateEvaluationPath(output, files.root, 'output'), output);

  ensurePrivateDirectory(files.root);
  ensurePrivateDirectory(staged);
  ensurePrivateDirectory(dirname(output));
  ensurePrivateFile(output, '{}\n');
  assert.equal(statSync(files.root).mode & 0o777, 0o700);
  assert.equal(statSync(staged).mode & 0o777, 0o700);
  assert.equal(statSync(dirname(output)).mode & 0o777, 0o700);
  assert.equal(statSync(output).mode & 0o777, 0o600);
});

test('accepts an in-root symlink stage but rejects live and dangling escapes', () => {
  const files = fixture();
  const safeTarget = join(files.root, 'safe-target');
  mkdirSync(safeTarget, { recursive: true });
  const stagedLink = join(files.root, 'staged-link');
  symlinkSync(safeTarget, stagedLink);
  const stagedOutput = join(stagedLink, 'result.json');
  assert.equal(assertPrivateEvaluationPath(stagedOutput, files.root, 'output'), stagedOutput);

  const outside = mkdtempSync(join(tmpdir(), 'alyte-qwen-outside-'));
  const liveEscape = join(files.root, 'live-escape');
  symlinkSync(outside, liveEscape);
  assert.throws(
    () => assertPrivateEvaluationPath(join(liveEscape, 'page.png'), files.root, 'input'),
    /input-symlink-escape/u,
  );
  assert.throws(
    () => assertPrivateEvaluationPath(join(liveEscape, 'result.json'), files.root, 'output'),
    /output-symlink-escape/u,
  );

  const dangling = join(files.root, 'dangling-escape');
  symlinkSync(join(outside, 'missing', 'nested'), dangling);
  assert.throws(
    () => assertPrivateEvaluationPath(join(dangling, 'page.png'), files.root, 'input'),
    /private-path-symlink/u,
  );
  assert.throws(
    () => assertPrivateEvaluationPath(join(dangling, 'result.json'), files.root, 'output'),
    /private-path-symlink/u,
  );
});

test('rejects an adapter-generated raw directory that resolves outside the root', async () => {
  const files = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'alyte-qwen-outside-'));
  symlinkSync(outside, join(files.root, 'raw'));
  await assert.rejects(
    createQwenMacDocumentVLM({
      paths: {
        privateRoot: files.root,
        binary: files.binary,
        model: files.model,
        mmproj: files.mmproj,
      },
      timeoutMs: 5_000,
    }),
    /generated-symlink-escape/u,
  );
});
