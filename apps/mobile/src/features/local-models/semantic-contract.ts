import { ALL_COMPARABLE_BIOMARKER_IDS, CATALOGUE_VERSION } from '@alyte/catalogue';
import {
  validateSemanticProposals,
  type ExtractionAliasEntry,
  type ExtractionSemanticProposal,
  type ExtractionSemanticCandidateRow,
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
export const SEMANTIC_OCR_CHUNK_VERSION = productionLocalModelManifest.compatibility.ocrChunk;
export const SEMANTIC_MAPPER_GRAMMAR = ALYTE_SEMANTIC_MAPPER_GRAMMAR;

export const SEMANTIC_MAPPER_LIMITS = Object.freeze({
  maxRows: 12,
  maxObservations: 48,
  maxHeadings: 12,
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

type SerializedCandidateRow = {
  readonly rowId: string;
  readonly sourceObservationIds: readonly string[];
  readonly cells: readonly SerializedObservation[];
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
  candidateRows: readonly ExtractionSemanticCandidateRow[],
  locale: string,
  headings: readonly VisionTextObservation[] = [],
): string {
  if (candidateRows.length > SEMANTIC_MAPPER_LIMITS.maxRows) {
    throw new Error('semantic-inference-input-too-large');
  }
  if (headings.length > SEMANTIC_MAPPER_LIMITS.maxHeadings) {
    throw new Error('semantic-inference-input-too-large');
  }
  const seenRows = new Set<string>();
  const seenObservations = new Set<string>();
  let observationCount = 0;
  const serializedRows = candidateRows
    .slice()
    .sort((left, right) => left.rowId.localeCompare(right.rowId))
    .map((row): SerializedCandidateRow => {
      if (
        row.rowId.length === 0 ||
        row.rowId.length > 96 ||
        seenRows.has(row.rowId) ||
        row.sourceObservationIds.length === 0 ||
        row.sourceObservationIds.length > 8 ||
        new Set(row.sourceObservationIds).size !== row.sourceObservationIds.length ||
        row.sourceObservationIds.some((id) => id.length === 0 || id.length > 96) ||
        row.observations.length !== row.sourceObservationIds.length ||
        row.observations.some(
          (observation, index) =>
            observation.id !== row.sourceObservationIds[index] ||
            seenObservations.has(observation.id),
        )
      ) {
        throw new Error('semantic-inference-input-invalid');
      }
      seenRows.add(row.rowId);
      row.observations.forEach((observation) => seenObservations.add(observation.id));
      observationCount += row.observations.length;
      if (observationCount > SEMANTIC_MAPPER_LIMITS.maxObservations) {
        throw new Error('semantic-inference-input-too-large');
      }
      return {
        rowId: row.rowId,
        // Preserve the deterministic source ordering: the model must copy this array exactly.
        sourceObservationIds: [...row.sourceObservationIds],
        cells: row.observations.map(observationForWire),
      };
    });
  const candidateObservationIds = new Set([...seenObservations]);
  const headingIds = new Set<string>();
  const serializedHeadings = headings
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((heading) => {
      if (candidateObservationIds.has(heading.id) || headingIds.has(heading.id)) {
        throw new Error('semantic-inference-input-invalid');
      }
      headingIds.add(heading.id);
      return observationForWire(heading);
    });
  const result = JSON.stringify({
    version: SEMANTIC_OCR_CHUNK_VERSION,
    locale,
    pageIndex: serializedRows[0]?.cells[0]?.pageIndex ?? serializedHeadings[0]?.pageIndex ?? 0,
    rows: serializedRows,
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
The OCR chunk contains deterministic candidate rows. For each unambiguous candidate row, emit at most one proposal. Copy that row's complete sourceObservationIds array exactly, in the same order; never emit a partial, reordered, cross-row, or extra-ID array. Combine the row's relevant label, value, unit, and reference-range cells into that one proposal. Never emit separate proposals for cells belonging to one row. Choose biomarkerId only from the exact allowlist. If a row is unsupported or ambiguous, omit it rather than inventing or partially mapping it.
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
  candidateRows: readonly ExtractionSemanticCandidateRow[],
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
  return validateSemanticProposals(candidate, candidateRows, aliases);
}

export const localSemanticContractMetadata = Object.freeze({
  schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
  promptVersion: SEMANTIC_MAPPER_PROMPT_VERSION,
  chunkVersion: SEMANTIC_OCR_CHUNK_VERSION,
  catalogueVersion: CATALOGUE_VERSION,
  limits: SEMANTIC_MAPPER_LIMITS,
});
