import { CATALOGUE_VERSION } from '@alyte/catalogue';
import {
  EXTRACTION_PARSER_VERSION,
  type ExtractionSemanticMapper,
  type ExtractionSemanticProposal,
  type VisionTextObservation,
} from '@alyte/domain';
import {
  gemmaEvaluationManifest,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  serializeOCRChunk,
  validateEvaluationOutput,
  type FixtureObservation,
} from '@alyte/model-evaluation/runtime';
import { canStartAutomatedExtraction } from './model';
import type { LocalModelService } from './native';

const PROMPT_VERSION = 'alyte.semantic-mapper.prompt.v1' as const;
const MAX_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_BYTES = 16_384;
const INFERENCE_TIMEOUT_MS = 15_000;

type RuntimeObservation = FixtureObservation;

export class SemanticModelUnavailableError extends Error {
  readonly code = 'semantic-model-unavailable' as const;
}

function languageCode(value: string | null): RuntimeObservation['locale'] | null {
  const code = value?.toLocaleLowerCase().split(/[-_]/u)[0];
  return code !== undefined && ['en', 'de', 'lt', 'pl', 'fr', 'es'].includes(code)
    ? (code as RuntimeObservation['locale'])
    : null;
}

function rowKey(observation: VisionTextObservation): string {
  const structure = observation.structure;
  if (structure?.tableId !== null && structure?.tableId !== undefined) {
    return `${observation.pageIndex}:${structure.tableId}:${structure.rowIndex ?? 'unknown'}`;
  }
  return `${observation.pageIndex}:loose:${Math.round(observation.boundingBox.y * 1000)}`;
}

function runtimeObservation(observation: VisionTextObservation): RuntimeObservation {
  return {
    id: observation.id,
    rowId: rowKey(observation),
    text: observation.text,
    alternatives: observation.alternatives,
    pageIndex: observation.pageIndex,
    locale: languageCode(observation.recognition.language) ?? 'en',
    specimenType: 'unknown',
    boundingBox: observation.boundingBox,
    ...(observation.structure === undefined ? {} : { structure: observation.structure }),
  };
}

function promptFor(locale: string, serializedChunk: string): string {
  return `<|im_start|>system
You are Alyte's offline semantic mapper. Return only one JSON object accepted by schema ${SEMANTIC_MAPPER_SCHEMA_VERSION}.
Select existing source observation IDs and propose only bounded roles, specimen context, and known canonical Biomarker IDs.
Never author values, units, intervals, conversions, translations, explanations, diagnoses, or medical copy.<|im_end|>
<|im_start|>user
Prompt version: ${PROMPT_VERSION}. Locale: ${locale}.
Known biomarker IDs are restricted to Alyte's checked-in catalogue allowlist.
OCR candidate chunk: ${serializedChunk}<|im_end|>
<|im_start|>assistant
`;
}

function withTimeout<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('semantic-inference-timeout')), milliseconds);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export type LocalSemanticMapperOptions = {
  readonly models: LocalModelService;
  readonly timeoutMs?: number;
};

/**
 * Provider-neutral ExtractionSemanticMapper adapter for the single verified Gemma pack. Model
 * output is decoded, bounded, and validated here; report-service code only receives source IDs and
 * semantic candidates. The raw prompt and response are intentionally not retained.
 */
export function createLocalSemanticMapper(
  options: LocalSemanticMapperOptions,
): ExtractionSemanticMapper {
  const timeoutMs = options.timeoutMs ?? INFERENCE_TIMEOUT_MS;
  return {
    adapterVersion: 'alyte.gemma4-e2b.semantic-mapper.v1',
    schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
    maxRowsPerChunk: 12,
    maxObservationsPerChunk: 48,
    provenance: {
      modelVersion: gemmaEvaluationManifest.model.revision,
      runtimeVersion: gemmaEvaluationManifest.runtime.revision,
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
        (gemmaEvaluationManifest.languages as readonly string[]).includes(code)
      );
    },
    map: async ({ observations, headings }) => {
      const locale = languageCode(observations[0]?.recognition.language ?? null) ?? 'en';
      const runtimeObservations = observations.map(runtimeObservation);
      const runtimeHeadings = (headings ?? []).map(runtimeObservation);
      const serialized = serializeOCRChunk(
        runtimeObservations,
        locale,
        gemmaEvaluationManifest.allowedBiomarkerIds,
        gemmaEvaluationManifest,
        runtimeHeadings,
      );
      const prompt = promptFor(locale, serialized);
      if (
        new TextEncoder().encode(prompt).byteLength > gemmaEvaluationManifest.prompt.maxInputBytes
      ) {
        throw new Error('semantic-inference-input-too-large');
      }
      const raw = await withTimeout(options.models.infer(prompt), timeoutMs);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        return [];
      }
      const validation = validateEvaluationOutput(
        parsed,
        runtimeObservations,
        gemmaEvaluationManifest,
      );
      if (validation.rejected || validation.outputBytes === null) return [];
      return validation.accepted.map((proposal): ExtractionSemanticProposal => ({
        sourceObservationIds: proposal.sourceObservationIds,
        proposedBiomarkerId:
          proposal.biomarkerId as ExtractionSemanticProposal['proposedBiomarkerId'],
        proposedSpecimenType: proposal.specimenType === 'other' ? 'other' : proposal.specimenType,
        role: proposal.role,
      }));
    },
  };
}

export const localSemanticMapperMetadata = Object.freeze({
  promptVersion: PROMPT_VERSION,
  schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
});
