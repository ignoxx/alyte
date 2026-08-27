import { CATALOGUE_VERSION, comparableBiomarkers } from '@alyte/catalogue';
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
  maxRows: 4,
  maxObservations: 24,
  maxHeadings: 4,
  maxObservationTextCharacters: 240,
  maxAlternativeCharacters: 120,
  maxProposals: 4,
  maxOutputBytes: 8_192,
  maxInputBytes: 8_192,
  outputTokenLimit: 192,
});

type SerializedObservation = {
  readonly key: string;
  readonly text: string;
  readonly alternatives: readonly string[];
};

type SerializedCandidateRow = {
  readonly key: string;
  readonly cells: readonly SerializedObservation[];
};

type SerializedBiomarker = {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
};

const checkedInBiomarkers: readonly SerializedBiomarker[] = comparableBiomarkers
  .map((entry) => ({
    id: entry.id,
    label: entry.canonicalLabel ?? entry.aliases[0] ?? entry.id,
    // The catalogue owns aliases and translations. These are input hints only and never become
    // model-authored source facts.
    aliases: [...entry.aliases].sort((left, right) => left.localeCompare(right)),
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

function observationForWire(
  observation: VisionTextObservation,
  key: string,
): SerializedObservation {
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
    key,
    text: observation.text,
    alternatives: [...observation.alternatives].sort((left, right) => left.localeCompare(right)),
  };
}

function wireRows(
  candidateRows: readonly ExtractionSemanticCandidateRow[],
): readonly { readonly row: ExtractionSemanticCandidateRow; readonly key: string }[] {
  return candidateRows
    .slice()
    .sort((left, right) => left.rowId.localeCompare(right.rowId))
    .map((row, index) => ({ row, key: `r${index}` }));
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
  const serializedRows = wireRows(candidateRows).map(
    ({ row, key: rowKey }): SerializedCandidateRow => {
      if (
        row.rowId.length === 0 ||
        row.rowId.length > 96 ||
        seenRows.has(row.rowId) ||
        row.sourceObservationIds.length === 0 ||
        row.sourceObservationIds.length > SEMANTIC_MAPPER_LIMITS.maxObservations ||
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
        key: rowKey,
        cells: row.observations.map((observation, index) =>
          observationForWire(observation, `c${index}`),
        ),
      };
    },
  );
  const candidateObservationIds = new Set([...seenObservations]);
  const headingIds = new Set<string>();
  const serializedHeadings = headings
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((heading, index) => {
      if (candidateObservationIds.has(heading.id) || headingIds.has(heading.id)) {
        throw new Error('semantic-inference-input-invalid');
      }
      headingIds.add(heading.id);
      return observationForWire(heading, `h${index}`);
    });
  const result = JSON.stringify({
    version: SEMANTIC_OCR_CHUNK_VERSION,
    locale,
    rows: serializedRows,
    headings: serializedHeadings,
    biomarkers: checkedInBiomarkers,
  });
  if (new TextEncoder().encode(result).byteLength > SEMANTIC_MAPPER_LIMITS.maxInputBytes) {
    throw new Error('semantic-inference-input-too-large');
  }
  return result;
}

/** The exact Gemma 4 turn framing is part of the production prompt bundle, not an evaluator-only
 * prompt. Compact row/cell keys keep one physical row within one bounded proposal. */
export function createSemanticMapperPrompt(locale: string, serializedChunk: string): string {
  const prompt = `<bos><|turn>system
You are an offline semantic mapper. Return only the JSON object required by the grammar.
Do not provide values, units, intervals, translations, explanations or medical copy.
Each row has compact row and cell keys. For each unambiguous candidate row, emit at most one proposal. Select label, value, unit, reference interval, and optional flag cell keys only from that same row. Never invent, reorder, duplicate, or cross rows. Choose biomarkerId only from the checked-in catalogue map. Use preserve with null biomarkerId for a credible unsupported row, and ignore only a genuine non-measurement row. Omit ambiguous rows.
<turn|>
<|turn>user
Schema version: ${SEMANTIC_MAPPER_SCHEMA_VERSION}. Locale: ${locale}.
The chunk's biomarkers map provides canonical English labels and checked-in multilingual aliases. It is input context only; never author a translation.
OCR chunk: ${serializedChunk}
Select only bounded row/cell keys and semantic roles.
<turn|>
<|turn>model
`;
  const promptBytes = new TextEncoder().encode(prompt).byteLength;
  // The native runtime rejects prompt+generation that reaches its context boundary. Reserve a
  // conservative four bytes per output token so a complete JSON envelope cannot be truncated.
  if (
    promptBytes + SEMANTIC_MAPPER_LIMITS.outputTokenLimit * 4 >
    SEMANTIC_MAPPER_LIMITS.maxInputBytes
  ) {
    throw new Error('semantic-inference-input-too-large');
  }
  return prompt;
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
