import { ALL_COMPARABLE_BIOMARKER_IDS, CATALOGUE_VERSION } from '@alyte/catalogue';
import {
  validateSemanticProposals,
  type ExtractionAliasEntry,
  type ExtractionSemanticProposal,
  type VisionTextObservation,
} from '@alyte/domain';
import { productionLocalModelManifest } from './production-manifest.generated';
import { ALYTE_SEMANTIC_MAPPER_GRAMMAR } from './semantic-mapper-grammar.generated';

/** Production-owned semantic mapper wire contract. Evaluation code may compare against it, but
 * the application must not depend on the evaluation package at runtime. */
export const SEMANTIC_MAPPER_SCHEMA_VERSION =
  productionLocalModelManifest.compatibility.semanticSchema;
export const SEMANTIC_MAPPER_PROMPT_VERSION =
  productionLocalModelManifest.compatibility.promptBundle;
export const SEMANTIC_OCR_CHUNK_VERSION = 'alyte.semantic-ocr-chunk.v1' as const;
export const SEMANTIC_MAPPER_GRAMMAR = ALYTE_SEMANTIC_MAPPER_GRAMMAR;

export const SEMANTIC_MAPPER_LIMITS = Object.freeze({
  maxObservations: 48,
  maxObservationTextCharacters: 240,
  maxAlternativeCharacters: 120,
  maxProposals: 24,
  maxOutputBytes: 16_384,
  maxInputBytes: 8_192,
  outputTokenLimit: 256,
});

type SerializedObservation = {
  readonly id: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly pageIndex: number;
  readonly boundingBox: VisionTextObservation['boundingBox'];
  readonly structure: VisionTextObservation['structure'] | null;
};

function observationForWire(observation: VisionTextObservation): SerializedObservation {
  if (
    observation.id.length === 0 ||
    observation.id.length > 96 ||
    observation.text.length > SEMANTIC_MAPPER_LIMITS.maxObservationTextCharacters ||
    observation.alternatives.some(
      (alternative) => alternative.length > SEMANTIC_MAPPER_LIMITS.maxAlternativeCharacters,
    )
  ) {
    throw new Error('semantic-inference-input-invalid');
  }
  return {
    id: observation.id,
    text: observation.text,
    alternatives: [...observation.alternatives].sort((left, right) => left.localeCompare(right)),
    pageIndex: observation.pageIndex,
    boundingBox: observation.boundingBox,
    structure: observation.structure ?? null,
  };
}

export function serializeSemanticMapperChunk(
  observations: readonly VisionTextObservation[],
  locale: string,
  headings: readonly VisionTextObservation[] = [],
): string {
  if (observations.length > SEMANTIC_MAPPER_LIMITS.maxObservations) {
    throw new Error('semantic-inference-input-too-large');
  }
  const serializedObservations = observations
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(observationForWire);
  const serializedHeadings = headings
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(observationForWire);
  const result = JSON.stringify({
    version: SEMANTIC_OCR_CHUNK_VERSION,
    locale,
    pageIndex: serializedObservations[0]?.pageIndex ?? 0,
    observations: serializedObservations,
    headings: serializedHeadings,
    knownBiomarkerIds: [...ALL_COMPARABLE_BIOMARKER_IDS].sort((left, right) =>
      left.localeCompare(right),
    ),
  });
  if (new TextEncoder().encode(result).byteLength > SEMANTIC_MAPPER_LIMITS.maxInputBytes) {
    throw new Error('semantic-inference-input-too-large');
  }
  return result;
}

/** The exact Gemma 4 turn framing is part of the production prompt bundle, not an evaluator-only
 * prompt. Row grouping is explicit so one physical row consumes one bounded proposal. */
export function createSemanticMapperPrompt(locale: string, serializedChunk: string): string {
  return `<bos><|turn>system
You are an offline semantic mapper. Return only the JSON object required by the grammar.
Do not provide values, units, intervals, translations, explanations or medical copy.
For each unambiguous physical measurement row, emit exactly one proposal. Combine all relevant source observation IDs/cells from that row (including label, value, unit, and reference-range cells) into that single proposal. Never emit separate proposals for label, value, unit, or range cells belonging to one row. If grouping a row is ambiguous, omit that row rather than duplicate-consuming any source row.
<turn|>
<|turn>user
Schema version: ${SEMANTIC_MAPPER_SCHEMA_VERSION}. Locale: ${locale}.
Known biomarker IDs are restricted to the checked-in catalogue allowlist.
OCR chunk: ${serializedChunk}
Select source IDs and propose only bounded semantic fields.
<turn|>
<|turn>model
`;
}

export function validateSemanticMapperOutput(
  raw: unknown,
  observations: readonly VisionTextObservation[],
  aliases: readonly ExtractionAliasEntry[],
): readonly ExtractionSemanticProposal[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
    if (bytes > SEMANTIC_MAPPER_LIMITS.maxOutputBytes) return [];
  } catch {
    return [];
  }
  const candidate = raw as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !['schemaVersion', 'proposals'].includes(key)))
    return [];
  if (candidate.schemaVersion !== SEMANTIC_MAPPER_SCHEMA_VERSION) return [];
  if (
    !Array.isArray(candidate.proposals) ||
    candidate.proposals.length > SEMANTIC_MAPPER_LIMITS.maxProposals
  )
    return [];
  return validateSemanticProposals(candidate, observations, aliases);
}

export const localSemanticContractMetadata = Object.freeze({
  schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
  promptVersion: SEMANTIC_MAPPER_PROMPT_VERSION,
  catalogueVersion: CATALOGUE_VERSION,
  limits: SEMANTIC_MAPPER_LIMITS,
});
