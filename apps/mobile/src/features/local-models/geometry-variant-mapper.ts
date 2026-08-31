import { CATALOGUE_VERSION } from '@alyte/catalogue';
import {
  EXTRACTION_PARSER_VERSION,
  type ExtractionSemanticCancellation,
  type ExtractionSemanticLease,
  type ExtractionSemanticProposal,
  type VisionTextObservation,
  type GeometryCandidateWindowGroup,
  type ExtractionSemanticCandidateRow,
} from '@alyte/domain';
import { productionLocalModelManifest } from './production-manifest.generated';
import { canStartAutomatedExtraction } from './model';
import type { LocalModelService } from './native';
import {
  createGeometryVariantSelectorPrompt,
  createGeometryVariantSelectorRetryPrompt,
  enumerateGeometryRoleVariants,
  estimateGeometryVariantSelectorTokens,
  GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION,
  GEOMETRY_VARIANT_SELECTOR_LIMITS,
  GEOMETRY_VARIANT_SELECTOR_PROMPT_VERSION,
  GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
  serializeGeometryVariantSelectorChunk,
  validateGeometryVariantSelectorOutputWithState,
  type GeometryVariantSelectorFailureCode,
  type GeometryVariantSelectorValidation,
} from './geometry-variant-contract';

/** Adapter identity persisted beside accepted source selections. */
export const GEOMETRY_VARIANT_MAPPER_ADAPTER_VERSION =
  'alyte.gemma4-e2b.geometry-variant-selector.v1' as const;
const GEOMETRY_VARIANT_MAX_OBSERVATIONS_PER_CHUNK =
  GEOMETRY_VARIANT_SELECTOR_LIMITS.maxGroups * GEOMETRY_VARIANT_SELECTOR_LIMITS.maxGroupCells;
const INFERENCE_TIMEOUT_MS = 15_000;
const INFERENCE_DRAIN_TIMEOUT_MS = 1_000;

export type GeometryVariantMapperFailureCode =
  GeometryVariantSelectorFailureCode | 'inference-failed' | 'prompt-failed';

export type GeometryVariantMapperResult = {
  /** Deterministically expanded proposals; never contains model-authored source fields. */
  readonly proposals: readonly ExtractionSemanticProposal[];
  /** True only when a model request still failed after its one bounded retry. */
  readonly incomplete: boolean;
  readonly failures: readonly GeometryVariantMapperFailureCode[];
  /** Useful for progress/debugging without retaining model output. */
  readonly attempts: number;
};

export type GeometryVariantMapperInput = {
  /** Direct evaluation/test seam. Production supplies the same groups through `rows`. */
  readonly groups?: readonly GeometryCandidateWindowGroup[];
  /** Shared ExtractionSemanticMapper seam; each row is revalidated as a geometry group. */
  readonly rows?: readonly ExtractionSemanticCandidateRow[];
  readonly pageIndex?: number;
  readonly headings?: readonly VisionTextObservation[];
  readonly locale?: string;
  readonly cancellation?: ExtractionSemanticCancellation;
};

/**
 * The wrapper owns only model-family turn framing. The plain prompt and serialized chunk remain
 * owned by geometry-variant-contract, so changing a wrapper cannot change the source-selection
 * wire contract accidentally.
 */
export type GeometryVariantPromptWrapper = (input: {
  readonly prompt: string;
  readonly serializedChunk: string;
  readonly locale: string;
  readonly retry: boolean;
}) => string;

/** Official Gemma 4 turn framing used by the verified production pack. */
export const createGemma4GeometryVariantPrompt: GeometryVariantPromptWrapper = ({ prompt }) =>
  `<bos><|turn>system
Offline laboratory source-selector. The input contains one or two exact table-local candidate groups. Select at most one existing variant per group, or null when the row is not clearly a measured laboratory result or when ambiguity remains. Use only the provided rN and vN keys. Never output source IDs, text, values, units, mappings, explanations, confidence, dates, metadata, or medical copy.
<turn|>
<|turn>user
${prompt}
<turn|>
<|turn>model
`;

export type GeometryVariantMapperOptions = {
  readonly models: LocalModelService;
  /** Defaults to the official Gemma 4 wrapper; tests and future reviewed packs may inject one. */
  readonly promptWrapper?: GeometryVariantPromptWrapper;
  /** Override for focused tests; production retains the bounded 15-second native limit. */
  readonly timeoutMs?: number;
};

export type GeometryVariantMapper = {
  readonly adapterVersion: typeof GEOMETRY_VARIANT_MAPPER_ADAPTER_VERSION;
  readonly schemaVersion: typeof GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION;
  readonly maxRowsPerChunk: typeof GEOMETRY_VARIANT_SELECTOR_LIMITS.maxGroups;
  readonly maxObservationsPerChunk: typeof GEOMETRY_VARIANT_MAX_OBSERVATIONS_PER_CHUNK;
  readonly provenance: {
    readonly modelVersion: string;
    readonly runtimeVersion: string;
    readonly promptVersion: string;
    readonly chunkVersion: string;
    readonly parserVersion: string;
    readonly catalogueVersion: string;
  };
  readonly checkAvailability: () => Promise<void>;
  readonly prepare: () => Promise<ExtractionSemanticLease>;
  readonly supports: (locale: string | null) => boolean;
  readonly map: (input: GeometryVariantMapperInput) => Promise<GeometryVariantMapperResult>;
};

type RequestResult = {
  readonly validation: GeometryVariantSelectorValidation | null;
  readonly failure: GeometryVariantMapperFailureCode | null;
  /** Request-local parsed envelope; never exposed by the mapper result or persisted. */
  readonly raw: unknown;
};

function languageCode(value: string | null): string | null {
  if (value === null) return null;
  const code = value.toLocaleLowerCase().split(/[-_]/u)[0];
  return code === undefined || code.length === 0 ? null : code;
}

function uniqueFailures(
  failures: readonly GeometryVariantMapperFailureCode[],
): readonly GeometryVariantMapperFailureCode[] {
  return [...new Set(failures)];
}

function parseModelOutput(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function allGroupsFailed(
  groups: readonly GeometryCandidateWindowGroup[],
): readonly GeometryCandidateWindowGroup[] {
  return groups;
}

/**
 * Derives retry scope from the source-free envelope after the contract validator has run.
 * Explicit null is a successful review decision and is never retried. Per-group unknown variant
 * keys are the only non-envelope failure that can be narrowed without adding source-bearing
 * diagnostics to the validator's public result.
 */
function failedGroupsForRetry(
  raw: unknown,
  groups: readonly GeometryCandidateWindowGroup[],
  validation: GeometryVariantSelectorValidation,
): readonly GeometryCandidateWindowGroup[] {
  if (validation.malformedEnvelope) return allGroupsFailed(groups);
  if (validation.failures.length === 0) return [];
  if (validation.failures.some((failure) => failure !== 'unknown-variant-key'))
    return allGroupsFailed(groups);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return allGroupsFailed(groups);
  const selections = (raw as Record<string, unknown>).selections;
  if (typeof selections !== 'object' || selections === null || Array.isArray(selections))
    return allGroupsFailed(groups);
  const selectionRecord = selections as Record<string, unknown>;
  return groups.filter((_, index) => {
    const selected = selectionRecord[`r${index}`];
    if (selected === null) return false;
    if (typeof selected !== 'string' || !/^v(?:0|[1-9]\d*)$/u.test(selected)) return true;
    return enumerateGeometryRoleVariants(groups[index]!)?.[Number(selected.slice(1))] === undefined;
  });
}

function isCancelled(cancellation: ExtractionSemanticCancellation | undefined): boolean {
  return cancellation?.isCancelled() === true;
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

/**
 * A native stop signal is advisory. The race returns to JS at the deadline, while the short drain
 * gives llama.cpp a chance to release its serialized context before the adapter reuses or unloads
 * it. A non-settling native promise is quarantined by the caller.
 */
function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  onCancel: () => void,
  cancellation: ExtractionSemanticCancellation | undefined,
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
        // A failed native cancellation signal cannot prevent the bounded timeout fallback.
      }
      reject(new Error('geometry-inference-timeout'));
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
              // The extraction still observes the cancellation error below.
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
      onDrainComplete?.(await waitForSettlement(work, INFERENCE_DRAIN_TIMEOUT_MS));
    }
  });
}

type ActiveInference = {
  readonly generation: number;
  readonly settled: Promise<void>;
};

export function createGeometryVariantMapper(
  options: GeometryVariantMapperOptions,
): GeometryVariantMapper {
  const promptWrapper = options.promptWrapper ?? createGemma4GeometryVariantPrompt;
  const timeoutMs = options.timeoutMs ?? INFERENCE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('The geometry mapper inference timeout must be positive');
  let lifecycleQueue: Promise<void> = Promise.resolve();
  // Native llama contexts are serialized. Keep overlapping report extractions from issuing
  // concurrent calls against one loaded context while allowing each caller to retain its own
  // accepted proposals and terminal result.
  let inferenceQueue: Promise<void> = Promise.resolve();
  let activeLeases = 0;
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

  async function checkAvailability(): Promise<void> {
    const state = await options.models.getState();
    if (!canStartAutomatedExtraction(state)) {
      throw Object.assign(new Error('The verified local model pack is unavailable'), {
        failure: 'unavailable' as const,
      });
    }
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
    // stopCompletion/cancelInference is a signal, not a completion barrier. Issue it before
    // awaiting the bounded queue so the native context gets a chance to drain concurrently.
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
        // JS release must return even if a native bridge promise never settles. The runtime cannot
        // be reused or unloaded until the late native completion has actually drained.
        runtimeQuarantined = true;
        deferRuntimeRelease(inference);
        return;
      }
    }
    if (runtimeQuarantined || activeInference !== null) return;
    const current = await options.models.getState();
    if (current.loaded) await options.models.unload();
  }

  async function runNativeInference(
    prompt: string,
    cancellation: ExtractionSemanticCancellation | undefined,
  ): Promise<string> {
    if (isCancelled(cancellation)) throw new Error('semantic-inference-cancelled');
    if (runtimeQuarantined || activeInference !== null)
      throw new Error('geometry-inference-runtime-quarantined');

    const generation = ++nextInferenceGeneration;
    const nativeWork = Promise.resolve().then(() =>
      options.models.infer(prompt, {
        maxOutputTokens: GEOMETRY_VARIANT_SELECTOR_LIMITS.productionOutputTokens,
        outputCapacity: GEOMETRY_VARIANT_SELECTOR_LIMITS.maxOutputBytes,
      }),
    );
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
        // Timeout/cancellation still returns through the bounded race and drain below.
      }
    };
    return withTimeout(nativeWork, timeoutMs, cancelNative, cancellation, (settled) => {
      if (!settled && activeInference === inference) runtimeQuarantined = true;
    });
  }

  function enqueueInference<T>(work: () => Promise<T>): Promise<T> {
    const next = inferenceQueue.then(work, work);
    inferenceQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    adapterVersion: GEOMETRY_VARIANT_MAPPER_ADAPTER_VERSION,
    schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
    maxRowsPerChunk: GEOMETRY_VARIANT_SELECTOR_LIMITS.maxGroups,
    maxObservationsPerChunk: GEOMETRY_VARIANT_MAX_OBSERVATIONS_PER_CHUNK,
    provenance: {
      modelVersion: productionLocalModelManifest.pack.artifact.revision,
      runtimeVersion: productionLocalModelManifest.runtime.revision,
      promptVersion: GEOMETRY_VARIANT_SELECTOR_PROMPT_VERSION,
      chunkVersion: GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION,
      parserVersion: EXTRACTION_PARSER_VERSION,
      catalogueVersion: CATALOGUE_VERSION,
    },
    checkAvailability,
    prepare: () =>
      enqueueLifecycle(async (): Promise<ExtractionSemanticLease> => {
        await checkAvailability();
        const state = await options.models.getState();
        if (!state.loaded) await options.models.load();
        activeLeases += 1;
        let released = false;
        return {
          release: () =>
            enqueueLifecycle(async () => {
              if (released) return;
              released = true;
              await releaseRuntime();
            }),
        };
      }),
    supports: (locale) => {
      const code = languageCode(locale);
      return (
        code !== null &&
        productionLocalModelManifest.compatibility.languages.includes(
          code as (typeof productionLocalModelManifest.compatibility.languages)[number],
        )
      );
    },
    map: async (input): Promise<GeometryVariantMapperResult> => {
      const groups = (input.groups ?? input.rows ?? []) as readonly GeometryCandidateWindowGroup[];
      const headings = input.headings ?? [];
      const cancellation = input.cancellation;
      const locale = input.locale ?? groups[0]?.observations[0]?.recognition.language ?? 'en';
      if (isCancelled(cancellation)) throw new Error('semantic-inference-cancelled');
      if (groups.length === 0) {
        return { proposals: [], incomplete: true, failures: ['invalid-input'], attempts: 0 };
      }

      let attempts = 0;
      const request = async (
        requestGroups: readonly GeometryCandidateWindowGroup[],
        retry: boolean,
      ): Promise<RequestResult> => {
        if (isCancelled(cancellation)) throw new Error('semantic-inference-cancelled');
        let serializedChunk: string;
        let prompt: string;
        try {
          serializedChunk = serializeGeometryVariantSelectorChunk(requestGroups, headings, locale);
          prompt = retry
            ? createGeometryVariantSelectorRetryPrompt(locale, serializedChunk)
            : createGeometryVariantSelectorPrompt(locale, serializedChunk);
        } catch {
          return { validation: null, failure: 'prompt-failed', raw: null };
        }
        let wrappedPrompt: string;
        try {
          wrappedPrompt = promptWrapper({
            prompt,
            serializedChunk,
            locale,
            retry,
          });
        } catch {
          return { validation: null, failure: 'prompt-failed', raw: null };
        }
        if (typeof wrappedPrompt !== 'string')
          return { validation: null, failure: 'prompt-failed', raw: null };
        // The wrapper is part of the reviewed model bundle. Keep its addition bounded by the same
        // native context contract rather than allowing an injected wrapper to overflow it.
        if (
          new TextEncoder().encode(wrappedPrompt).byteLength >
            GEOMETRY_VARIANT_SELECTOR_LIMITS.maxPromptBytes ||
          estimateGeometryVariantSelectorTokens(wrappedPrompt) +
            GEOMETRY_VARIANT_SELECTOR_LIMITS.reservedOutputTokens >
            GEOMETRY_VARIANT_SELECTOR_LIMITS.contextTokens
        )
          return { validation: null, failure: 'prompt-failed', raw: null };
        attempts += 1;
        let rawOutput: string;
        try {
          rawOutput = await enqueueInference(() => runNativeInference(wrappedPrompt, cancellation));
        } catch (error) {
          if (error instanceof Error && error.message === 'semantic-inference-cancelled')
            throw error;
          return { validation: null, failure: 'inference-failed', raw: null };
        }
        if (isCancelled(cancellation)) throw new Error('semantic-inference-cancelled');
        const parsed = parseModelOutput(rawOutput);
        return {
          validation: validateGeometryVariantSelectorOutputWithState(parsed, requestGroups),
          failure: null,
          raw: parsed,
        };
      };

      const first = await request(groups, false);
      const firstValidation = first.validation;
      const firstProposals = firstValidation?.proposals ?? [];
      const firstFailures = firstValidation?.failures ?? [];
      // A request that returns no contract failures—including an explicit all-null review—is
      // complete. Only malformed output or an unknown variant warrants the one bounded retry.
      if (first.failure === null && firstValidation !== null && firstFailures.length === 0) {
        return {
          proposals: firstProposals,
          incomplete: false,
          failures: [],
          attempts,
        };
      }

      // Malformed envelopes and inference errors conservatively retry every group. A valid
      // per-group unknown variant narrows retry scope to only that failed group, preserving
      // accepted siblings and avoiding duplicate model work.
      const retryGroups =
        first.failure !== null || firstValidation === null
          ? allGroupsFailed(groups)
          : failedGroupsForRetry(first.raw, groups, firstValidation);
      if (retryGroups.length === 0) {
        // Defensive fallback for an inconsistent validator result. Never turn a non-empty failure
        // into an empty-success result.
        return {
          proposals: firstProposals,
          incomplete: true,
          failures: uniqueFailures([
            ...(first.failure === null ? firstFailures : [first.failure]),
            'malformed-envelope',
          ]),
          attempts,
        };
      }
      const retry = await request(retryGroups, true);
      const retryValidation = retry.validation;
      const retryProposals = retryValidation?.proposals ?? [];
      // A first response failure is transient once its narrowed retry succeeds. Report only the
      // terminal retry state so a recovered malformed response cannot leave the whole extraction
      // looking incomplete.
      const failures = uniqueFailures(
        retry.failure === null ? (retryValidation?.failures ?? []) : [retry.failure],
      );
      return {
        proposals: [...firstProposals, ...retryProposals],
        incomplete: failures.length > 0,
        failures,
        attempts,
      };
    },
  };
}

export const localGeometryVariantMapperMetadata = Object.freeze({
  adapterVersion: GEOMETRY_VARIANT_MAPPER_ADAPTER_VERSION,
  schemaVersion: GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
  promptVersion: GEOMETRY_VARIANT_SELECTOR_PROMPT_VERSION,
  chunkVersion: GEOMETRY_VARIANT_SELECTOR_CHUNK_VERSION,
  maxOutputTokens: GEOMETRY_VARIANT_SELECTOR_LIMITS.productionOutputTokens,
  maxOutputBytes: GEOMETRY_VARIANT_SELECTOR_LIMITS.maxOutputBytes,
});
