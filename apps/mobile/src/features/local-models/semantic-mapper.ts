import { CATALOGUE_VERSION } from '@alyte/catalogue';
import {
  EXTRACTION_PARSER_VERSION,
  type ExtractionAliasEntry,
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
  serializeSemanticMapperChunk,
  validateSemanticMapperOutput,
} from './semantic-contract';

const PROMPT_VERSION = SEMANTIC_MAPPER_PROMPT_VERSION;
const INFERENCE_TIMEOUT_MS = 15_000;

export class SemanticModelUnavailableError extends Error {
  readonly code = 'semantic-model-unavailable' as const;
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
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('semantic-inference-timeout'));
    }, milliseconds);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
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
  return {
    adapterVersion: 'alyte.gemma4-e2b.semantic-mapper.v1',
    schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
    maxRowsPerChunk: 12,
    maxObservationsPerChunk: SEMANTIC_MAPPER_LIMITS.maxObservations,
    provenance: {
      modelVersion: productionLocalModelManifest.pack.artifact.revision,
      runtimeVersion: productionLocalModelManifest.runtime.revision,
      promptVersion: PROMPT_VERSION,
      parserVersion: EXTRACTION_PARSER_VERSION,
      catalogueVersion: CATALOGUE_VERSION,
    },
    prepare: async () => {
      const state = await options.models.getState();
      if (!canStartAutomatedExtraction(state)) {
        throw new SemanticModelUnavailableError('The verified Gemma model pack is not installed');
      }
      if (!state.loaded) await options.models.load();
    },
    supports: (locale) => {
      const code = locale?.toLocaleLowerCase().split(/[-_]/u)[0];
      return (
        code !== undefined &&
        productionLocalModelManifest.compatibility.languages.includes(code as SupportedLanguage)
      );
    },
    map: async ({ observations, headings }) => {
      const locale =
        observations[0] === undefined
          ? 'en'
          : (languageCode(observations[0].recognition.language) ?? 'en');
      const serialized = serializeSemanticMapperChunk(observations, locale, headings ?? []);
      const prompt = createSemanticMapperPrompt(locale, serialized);
      if (new TextEncoder().encode(prompt).byteLength > SEMANTIC_MAPPER_LIMITS.maxInputBytes) {
        throw new Error('semantic-inference-input-too-large');
      }
      const raw = await withTimeout(
        options.models.infer(prompt),
        timeoutMs,
        options.models.cancelInference,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return [];
      }
      return validateSemanticMapperOutput(parsed, observations, options.aliases);
    },
  };
}

export const localSemanticMapperMetadata = Object.freeze({
  promptVersion: PROMPT_VERSION,
  schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
  maxOutputTokens: SEMANTIC_MAPPER_LIMITS.outputTokenLimit,
  maxOutputBytes: SEMANTIC_MAPPER_LIMITS.maxOutputBytes,
});
