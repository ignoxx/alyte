import { CATALOGUE_VERSION } from '@alyte/catalogue';
import {
  EXTRACTION_PARSER_VERSION,
  type ExtractionAliasEntry,
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

function withTimeout<T>(work: Promise<T>, milliseconds: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      onTimeout();
      reject(new Error('semantic-inference-timeout'));
    }, milliseconds);
  });
  return Promise.race([work, timeout]).finally(async () => {
    if (timer !== undefined) clearTimeout(timer);
    // llama.rn's stopCompletion is a signal; it does not mean the native completion has
    // finished. Keep the operation owner alive until that promise settles so a queued request
    // or release can never reuse/free the context while native decoding is still in flight.
    if (timedOut) await work.catch(() => undefined);
  });
}

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
            return enqueueLifecycle(async () => {
              // Match llama.rn's stop → await completion → release discipline. The native
              // store is serialized too, but awaiting this JS owner makes that contract true
              // even when a caller races release with a direct mapper invocation.
              await inferenceQueue;
              activeLeases = Math.max(0, activeLeases - 1);
              if (activeLeases !== 0) return;
              // The pack is an extraction-scoped resource. Keep verified bytes on disk, but
              // release the llama model/context as soon as the last extraction finishes.
              const current = await options.models.getState();
              if (current.loaded) await options.models.unload();
            });
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
    map: ({ rows, headings }) =>
      enqueueInference(async () => {
        const observations = rows.flatMap((row) => row.observations);
        const locale =
          observations[0] === undefined
            ? 'en'
            : (languageCode(observations[0].recognition.language) ?? 'en');
        const serialized = serializeSemanticMapperChunk(rows, locale, headings ?? []);
        const prompt = createSemanticMapperPrompt(locale, serialized);
        if (new TextEncoder().encode(prompt).byteLength > SEMANTIC_MAPPER_LIMITS.maxInputBytes) {
          throw new Error('semantic-inference-input-too-large');
        }
        let raw: string;
        try {
          raw = await withTimeout(
            options.models.infer(prompt),
            timeoutMs,
            options.models.cancelInference,
          );
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
