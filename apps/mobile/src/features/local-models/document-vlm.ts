import type { ExtractionSemanticCancellation, ExtractionSemanticLease } from '@alyte/domain';
import { canStartAutomatedExtraction } from './model';
import type { LocalModelService } from './native';
import { productionLocalModelManifest } from './production-manifest.generated';

export const DOCUMENT_VLM_SCHEMA_VERSION = 'alyte.document-vlm.flat-rows.v1' as const;
export const DOCUMENT_VLM_PROMPT_VERSION = 'alyte.document-vlm.prompt.v1' as const;

const INFERENCE_TIMEOUT_MS = 60_000;
const INFERENCE_DRAIN_TIMEOUT_MS = 1_000;
const MAX_ROWS = 80;
const MAX_FIELD_LENGTH = 512;

export type DocumentVLMRow = {
  readonly label: string;
  readonly value: string | null;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
};

export type DocumentVLMExtractor = {
  readonly adapterVersion: 'alyte.qwen3-vl.document-extractor.v1';
  readonly schemaVersion: typeof DOCUMENT_VLM_SCHEMA_VERSION;
  readonly provenance: {
    readonly modelVersion: string;
    readonly runtimeVersion: string;
    readonly promptVersion: typeof DOCUMENT_VLM_PROMPT_VERSION;
  };
  checkAvailability(): Promise<void>;
  prepare(): Promise<ExtractionSemanticLease>;
  supports(locale: string | null): boolean;
  extract(input: {
    readonly pageIndex: number;
    readonly imageURI: string;
    readonly locale: string;
    readonly cancellation?: ExtractionSemanticCancellation;
  }): Promise<readonly DocumentVLMRow[]>;
};

export class DocumentVLMUnavailableError extends Error {
  readonly code = 'document-vlm-unavailable' as const;
}

function failureCategory(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as {
    readonly failure?: unknown;
    readonly failureCategory?: unknown;
    readonly userInfo?: { readonly failureCategory?: unknown };
  };
  return candidate.failure ?? candidate.failureCategory ?? candidate.userInfo?.failureCategory;
}

function waitForSettlement(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    () => true,
    () => true,
  );
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  return Promise.race([settled, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  cancelNative: () => void,
  cancellation?: ExtractionSemanticCancellation,
  onDrainComplete?: (settled: boolean) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let unsubscribe: () => void = () => undefined;
  const stop = (reason: string, reject: (error: Error) => void) => {
    if (stopped) return;
    stopped = true;
    cancelNative();
    reject(new Error(reason));
  };
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => stop('document-vlm-timeout', reject), milliseconds);
  });
  const cancellationPromise =
    cancellation === undefined
      ? null
      : new Promise<never>((_, reject) => {
          unsubscribe = cancellation.subscribe(() => stop('document-vlm-cancelled', reject));
        });
  const raced =
    cancellationPromise === null
      ? Promise.race([work, timeout])
      : Promise.race([work, timeout, cancellationPromise]);
  return raced.finally(async () => {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    if (stopped) {
      onDrainComplete?.(await waitForSettlement(work, INFERENCE_DRAIN_TIMEOUT_MS));
    }
  });
}

type ActiveInference = {
  readonly generation: number;
  readonly settled: Promise<void>;
  readonly cancel: () => void;
};

function boundedNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Strictly decodes untrusted model output. It does not establish source ownership. */
export function decodeDocumentVLMRows(raw: string): readonly DocumentVLMRow[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('document-vlm-malformed-json');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded))
    throw new Error('document-vlm-malformed-envelope');
  const envelope = decoded as Record<string, unknown>;
  if (Object.keys(envelope).length !== 1 || !Array.isArray(envelope.rows))
    throw new Error('document-vlm-malformed-envelope');
  if (envelope.rows.length > MAX_ROWS) throw new Error('document-vlm-too-many-rows');

  return envelope.rows.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error(`document-vlm-row-${index}-malformed`);
    const row = value as Record<string, unknown>;
    const expected = ['label', 'value', 'unit', 'reference_interval', 'flag'];
    if (
      Object.keys(row).length !== expected.length ||
      expected.some((key) => !Object.prototype.hasOwnProperty.call(row, key))
    )
      throw new Error(`document-vlm-row-${index}-malformed`);
    const label = boundedNullableString(row.label);
    const observedValue = boundedNullableString(row.value);
    const unit = boundedNullableString(row.unit);
    const referenceInterval = boundedNullableString(row.reference_interval);
    const flag = boundedNullableString(row.flag);
    if (
      label === undefined ||
      label === null ||
      observedValue === undefined ||
      unit === undefined ||
      referenceInterval === undefined ||
      flag === undefined
    )
      throw new Error(`document-vlm-row-${index}-malformed`);
    return { label, value: observedValue, unit, referenceInterval, flag };
  });
}

export function createDocumentVLMPrompt(): string {
  const instruction = `Read this laboratory-report image. Return every patient measurement row visible in it as flat JSON.

For every row transcribe these source fields verbatim:
- label: the laboratory test or biomarker label
- value: the patient's observed result, never a reference or target number
- unit: the unit belonging to that observed result, or null
- reference_interval: the laboratory reference interval belonging to the same row, or null
- flag: the laboratory flag belonging to the same row, or null

Keep label, observed result, unit, and reference interval associated with their physical row and column. Do not translate, normalize, calculate, infer, diagnose, or copy values across rows. Ignore headers, footers, addresses, explanatory prose, and panel titles that are not measurements. If a field is not visibly present in that row, return null. Use exactly this shape: {"rows":[{"label":"...","value":"...","unit":null,"reference_interval":null,"flag":null}]}. Return JSON only.`;
  return `<|im_start|>system\nYou transcribe visible laboratory table rows without interpretation.<|im_end|>\n<|im_start|>user\n<__media__>\n${instruction}<|im_end|>\n<|im_start|>assistant\n`;
}

export function createLocalDocumentVLM(options: {
  readonly models: LocalModelService;
  readonly timeoutMs?: number;
}): DocumentVLMExtractor {
  const timeoutMs = options.timeoutMs ?? INFERENCE_TIMEOUT_MS;
  let activeLeases = 0;
  let lifecycleQueue: Promise<void> = Promise.resolve();
  let inferenceQueue: Promise<void> = Promise.resolve();
  let nextInferenceGeneration = 0;
  let activeInference: ActiveInference | null = null;
  let runtimeQuarantined = false;
  let deferredReleaseGeneration: number | null = null;

  function enqueueLifecycle<T>(work: () => Promise<T>): Promise<T> {
    const next = lifecycleQueue.then(work, work);
    lifecycleQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function enqueueInference<T>(work: () => Promise<T>): Promise<T> {
    const next = inferenceQueue.then(work, work);
    inferenceQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function deferRuntimeRelease(inference: ActiveInference): void {
    if (deferredReleaseGeneration === inference.generation) return;
    deferredReleaseGeneration = inference.generation;
    void inference.settled.then(() => {
      if (deferredReleaseGeneration !== inference.generation) return;
      deferredReleaseGeneration = null;
      if (activeLeases !== 0 || activeInference !== null) return;
      void enqueueLifecycle(async () => {
        if (activeLeases !== 0 || activeInference !== null || runtimeQuarantined) return;
        const current = await options.models.getState();
        if (current.loaded) await options.models.unload();
      }).catch(() => undefined);
    });
  }

  async function releaseRuntime(): Promise<void> {
    if (activeLeases === 1) activeInference?.cancel();
    await inferenceQueue;
    activeLeases = Math.max(0, activeLeases - 1);
    if (activeLeases !== 0) return;

    const inference = activeInference;
    if (inference !== null) {
      const settled = await waitForSettlement(inference.settled, INFERENCE_DRAIN_TIMEOUT_MS);
      if (!settled || activeInference !== null) {
        runtimeQuarantined = true;
        deferRuntimeRelease(inference);
        return;
      }
    }
    if (runtimeQuarantined || activeInference !== null) return;
    const current = await options.models.getState();
    if (current.loaded) await options.models.unload();
  }

  async function requireReady(): Promise<void> {
    const state = await options.models.getState();
    if (!canStartAutomatedExtraction(state)) {
      throw new DocumentVLMUnavailableError('The verified document model pack is not installed');
    }
  }

  return {
    adapterVersion: 'alyte.qwen3-vl.document-extractor.v1',
    schemaVersion: DOCUMENT_VLM_SCHEMA_VERSION,
    provenance: {
      modelVersion: productionLocalModelManifest.pack.artifact.revision,
      runtimeVersion: productionLocalModelManifest.runtime.revision,
      promptVersion: DOCUMENT_VLM_PROMPT_VERSION,
    },
    checkAvailability: () => enqueueLifecycle(requireReady),
    // Qwen transcribes source text verbatim for every locale. Manifest languages are benchmark
    // targets, not a routing gate; catalogue alias resolution remains deterministic afterward.
    supports: () => true,
    prepare: () =>
      enqueueLifecycle(async (): Promise<ExtractionSemanticLease> => {
        await requireReady();
        if (runtimeQuarantined || activeInference !== null) {
          throw new Error('document-vlm-runtime-quarantined');
        }
        const state = await options.models.getState();
        if (!state.loaded) await options.models.load();
        activeLeases += 1;
        let released = false;
        return {
          release: () => {
            if (released) return Promise.resolve();
            released = true;
            return enqueueLifecycle(releaseRuntime);
          },
        };
      }),
    extract: (input) =>
      enqueueInference(async () => {
        if (input.cancellation?.isCancelled()) throw new Error('document-vlm-cancelled');
        if (runtimeQuarantined || activeInference !== null) {
          throw new Error('document-vlm-runtime-quarantined');
        }
        if (activeLeases === 0) {
          throw new DocumentVLMUnavailableError('The document model is not loaded');
        }
        const generation = ++nextInferenceGeneration;
        const nativeWork = Promise.resolve().then(() =>
          options.models.inferImage(createDocumentVLMPrompt(), input.imageURI, {
            maxOutputTokens: 2_048,
            outputCapacity: 131_072,
          }),
        );
        let cancellationSignalled = false;
        const inference: ActiveInference = {
          generation,
          settled: nativeWork.then(
            () => undefined,
            () => undefined,
          ),
          cancel: () => {
            if (cancellationSignalled || activeInference?.generation !== generation) return;
            cancellationSignalled = true;
            try {
              options.models.cancelInference();
            } catch {
              // The bounded drain and quarantine still protect the native context.
            }
          },
        };
        activeInference = inference;
        void inference.settled.then(() => {
          if (activeInference !== inference) return;
          activeInference = null;
          runtimeQuarantined = false;
        });
        try {
          const raw = await withTimeout(
            nativeWork,
            timeoutMs,
            inference.cancel,
            input.cancellation,
            (settled) => {
              if (!settled && activeInference === inference) runtimeQuarantined = true;
            },
          );
          return decodeDocumentVLMRows(raw);
        } catch (error) {
          if (failureCategory(error) === 'unavailable') {
            throw new DocumentVLMUnavailableError(
              'The verified document model became unavailable during import',
            );
          }
          throw error;
        }
      }),
  };
}
