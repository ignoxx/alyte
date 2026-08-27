import { CATALOGUE_VERSION } from '@alyte/catalogue';
import {
  EXTRACTION_PARSER_VERSION,
  type ExtractionAliasEntry,
  type ExtractionSemanticCancellation,
  type ExtractionSemanticLease,
  type ExtractionSemanticMapper,
} from '@alyte/domain';
import { productionLocalModelManifest } from './production-manifest.generated';
import { canStartAutomatedExtraction } from './model';
import type { LocalModelService } from './native';
import {
  createSemanticMapperPrompt,
  SEMANTIC_MAPPER_LIMITS,
  SEMANTIC_MAPPER_PROMPT_VERSION,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  SEMANTIC_OCR_CHUNK_VERSION,
  serializeSemanticMapperChunk,
  validateSemanticMapperOutput,
} from './semantic-contract';

const PROMPT_VERSION = SEMANTIC_MAPPER_PROMPT_VERSION;
const INFERENCE_TIMEOUT_MS = 15_000;
const INFERENCE_DRAIN_TIMEOUT_MS = 1_000;

export class SemanticModelUnavailableError extends Error {
  readonly code = 'semantic-model-unavailable' as const;
}

function localModelFailureCategory(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as {
    readonly failure?: unknown;
    readonly failureCategory?: unknown;
    readonly userInfo?: { readonly failureCategory?: unknown };
  };
  return candidate.failure ?? candidate.failureCategory ?? candidate.userInfo?.failureCategory;
}

type SupportedLanguage = (typeof productionLocalModelManifest.compatibility.languages)[number];

function languageCode(value: string | null): SupportedLanguage | null {
  const code = value?.toLocaleLowerCase().split(/[-_]/u)[0];
  return code !== undefined &&
    productionLocalModelManifest.compatibility.languages.includes(code as SupportedLanguage)
    ? (code as SupportedLanguage)
    : null;
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
  onCancel: () => void,
  cancellation?: ExtractionSemanticCancellation,
  onDrainComplete?: (settled: boolean) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let cancelled = false;
  let unsubscribe: () => void = () => undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        onCancel();
      } catch {
        // A failed cancellation signal must not prevent deterministic timeout fallback.
      }
      reject(new Error('semantic-inference-timeout'));
    }, milliseconds);
  });
  const cancellationPromise =
    cancellation === undefined
      ? null
      : new Promise<never>((_, reject) => {
          unsubscribe = cancellation.subscribe(() => {
            if (timedOut || cancelled) return;
            cancelled = true;
            try {
              onCancel();
            } catch {
              // The extraction still observes the operation token below.
            }
            reject(new Error('semantic-inference-cancelled'));
          });
        });
  const raced =
    cancellationPromise === null
      ? Promise.race([work, timeout])
      : Promise.race([work, timeout, cancellationPromise]);
  return raced.finally(async () => {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
    if (timedOut || cancelled) {
      // stopCompletion is a signal, not a completion barrier. Drain briefly so normal native
      // cancellation releases promptly; a non-settling bridge is quarantined by the caller.
      onDrainComplete?.(await waitForSettlement(work, INFERENCE_DRAIN_TIMEOUT_MS));
    }
  });
}

type ActiveInference = {
  readonly generation: number;
  readonly settled: Promise<void>;
};

export type LocalSemanticMapperOptions = {
  readonly models: LocalModelService;
  readonly aliases: readonly ExtractionAliasEntry[];
  readonly timeoutMs?: number;
};

/** Production adapter for the one verified Gemma pack. The model sees only bounded OCR chunks;
 * all accepted fields remain sourced and are validated again by the report service. */
export function createLocalSemanticMapper(
  options: LocalSemanticMapperOptions,
): ExtractionSemanticMapper {
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
    // A last-lease release is also a stop request. Like llama.rn's stopCompletion, this signal is
    // issued before awaiting the serialized operation; it never targets a runtime owned by a
    // different active lease.
    if (activeLeases === 1 && activeInference !== null) {
      try {
        options.models.cancelInference();
      } catch {
        // The bounded drain/quarantine path below still protects the native context.
      }
    }
    await inferenceQueue;
    activeLeases = Math.max(0, activeLeases - 1);
    if (activeLeases !== 0) return;

    const inference = activeInference;
    if (inference !== null) {
      const settled = await waitForSettlement(inference.settled, INFERENCE_DRAIN_TIMEOUT_MS);
      if (!settled || activeInference !== null) {
        // The JS operation must return, but the native context cannot be reused or released
        // until its call settles. A late settlement schedules cleanup without blocking the user.
        runtimeQuarantined = true;
        deferRuntimeRelease(inference);
        return;
      }
    }
    if (runtimeQuarantined || activeInference !== null) return;
    const current = await options.models.getState();
    if (current.loaded) await options.models.unload();
  }

  return {
    adapterVersion: 'alyte.gemma4-e2b.semantic-mapper.v1',
    schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
    maxRowsPerChunk: SEMANTIC_MAPPER_LIMITS.maxRows,
    maxObservationsPerChunk: SEMANTIC_MAPPER_LIMITS.maxObservations,
    provenance: {
      modelVersion: productionLocalModelManifest.pack.artifact.revision,
      runtimeVersion: productionLocalModelManifest.runtime.revision,
      promptVersion: PROMPT_VERSION,
      chunkVersion: SEMANTIC_OCR_CHUNK_VERSION,
      parserVersion: EXTRACTION_PARSER_VERSION,
      catalogueVersion: CATALOGUE_VERSION,
    },
    checkAvailability: () =>
      enqueueLifecycle(async () => {
        const state = await options.models.getState();
        if (!canStartAutomatedExtraction(state)) {
          throw new SemanticModelUnavailableError('The verified Gemma model pack is not installed');
        }
      }),
    prepare: () =>
      enqueueLifecycle(async (): Promise<ExtractionSemanticLease> => {
        const state = await options.models.getState();
        if (!canStartAutomatedExtraction(state)) {
          throw new SemanticModelUnavailableError('The verified Gemma model pack is not installed');
        }
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
    supports: (locale) => {
      const code = locale?.toLocaleLowerCase().split(/[-_]/u)[0];
      return (
        code !== undefined &&
        productionLocalModelManifest.compatibility.languages.includes(code as SupportedLanguage)
      );
    },
    map: ({ rows, headings, cancellation }) =>
      enqueueInference(async () => {
        if (cancellation?.isCancelled()) throw new Error('semantic-inference-cancelled');
        if (runtimeQuarantined || activeInference !== null) {
          throw new Error('semantic-inference-runtime-quarantined');
        }
        const observations = rows.flatMap((row) => row.observations);
        const locale =
          observations[0] === undefined
            ? 'en'
            : (languageCode(observations[0].recognition.language) ?? 'en');
        const serialized = serializeSemanticMapperChunk(rows, locale, headings ?? []);
        const prompt = createSemanticMapperPrompt(locale, serialized);
        const generation = ++nextInferenceGeneration;
        const nativeWork = Promise.resolve().then(() => options.models.infer(prompt));
        const inference: ActiveInference = {
          generation,
          settled: nativeWork.then(
            () => undefined,
            () => undefined,
          ),
        };
        activeInference = inference;
        void inference.settled.then(() => {
          if (activeInference !== inference) return;
          activeInference = null;
          runtimeQuarantined = false;
        });
        const cancelNative = () => {
          if (activeInference?.generation !== generation) return;
          try {
            options.models.cancelInference();
          } catch {
            // A cancellation callback is advisory; timeout/quarantine still protects the context.
          }
        };
        let raw: string;
        try {
          raw = await withTimeout(nativeWork, timeoutMs, cancelNative, cancellation, (settled) => {
            if (!settled && activeInference === inference) runtimeQuarantined = true;
          });
        } catch (error) {
          // Only the native typed missing/unloaded contract returns to model setup. Timeouts,
          // malformed output, and runtime failures remain ordinary per-chunk deterministic fallback.
          if (localModelFailureCategory(error) === 'unavailable') {
            throw new SemanticModelUnavailableError(
              'The verified Gemma model pack became unavailable during extraction',
            );
          }
          throw error;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          return [];
        }
        return validateSemanticMapperOutput(parsed, rows, options.aliases);
      }),
  };
}

export const localSemanticMapperMetadata = Object.freeze({
  promptVersion: PROMPT_VERSION,
  chunkVersion: SEMANTIC_OCR_CHUNK_VERSION,
  schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
  maxOutputTokens: SEMANTIC_MAPPER_LIMITS.outputTokenLimit,
  maxOutputBytes: SEMANTIC_MAPPER_LIMITS.maxOutputBytes,
});
