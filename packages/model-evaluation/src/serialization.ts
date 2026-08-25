import { OCR_CHUNK_VERSION, qwenEvaluationManifest, type EvaluationManifest } from './manifest';
import type { FixtureObservation } from './fixtures';

export type SerializedOCRObservation = {
  readonly id: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly pageIndex: number;
  readonly boundingBox: FixtureObservation['boundingBox'] | null;
  readonly structure: NonNullable<FixtureObservation['structure']> | null;
};

export type SerializedOCRChunk = {
  readonly version: typeof OCR_CHUNK_VERSION;
  readonly locale: string;
  readonly pageIndex: number;
  readonly observations: readonly SerializedOCRObservation[];
  readonly headings: readonly SerializedOCRObservation[];
  readonly knownBiomarkerIds: readonly string[];
};

export type OCRSerializationFailureCode =
  | 'too-many-observations'
  | 'observation-text-too-long'
  | 'observation-alternatives-too-long'
  | 'invalid-observation'
  | 'unknown-catalogue-id'
  | 'input-too-large';

export class OCRSerializationError extends Error {
  readonly code: OCRSerializationFailureCode;

  constructor(code: OCRSerializationFailureCode) {
    super(code);
    this.name = 'OCRSerializationError';
    this.code = code;
  }
}

/**
 * The serialized chunk is the only input shape the native runner should hand to Qwen. It is
 * bounded, sorted, and excludes source-row bookkeeping and exact source facts.
 */
export function serializeOCRChunk(
  observations: readonly FixtureObservation[],
  locale: string,
  knownBiomarkerIds: readonly string[] = qwenEvaluationManifest.allowedBiomarkerIds,
  manifest: EvaluationManifest = qwenEvaluationManifest,
  headings: readonly FixtureObservation[] = [],
): string {
  if (observations.length > manifest.prompt.maxObservations) {
    throw new OCRSerializationError('too-many-observations');
  }
  const allowedBiomarkerIds: ReadonlySet<string> = new Set(manifest.allowedBiomarkerIds);
  if (knownBiomarkerIds.some((id) => !allowedBiomarkerIds.has(id))) {
    throw new OCRSerializationError('unknown-catalogue-id');
  }

  const serialize = (observation: FixtureObservation): SerializedOCRObservation => {
    if (
      observation.id.length === 0 ||
      observation.id.length > 96 ||
      !Number.isInteger(observation.pageIndex) ||
      observation.pageIndex < 0
    ) {
      throw new OCRSerializationError('invalid-observation');
    }
    if (observation.text.length > manifest.prompt.maxObservationTextCharacters) {
      throw new OCRSerializationError('observation-text-too-long');
    }
    if (
      observation.alternatives.some(
        (alternative) => alternative.length > manifest.prompt.maxAlternativeCharacters,
      )
    ) {
      throw new OCRSerializationError('observation-alternatives-too-long');
    }
    return {
      id: observation.id,
      text: observation.text,
      alternatives: [...observation.alternatives].sort((left, right) => left.localeCompare(right)),
      pageIndex: observation.pageIndex,
      boundingBox: observation.boundingBox ?? null,
      structure: observation.structure ?? null,
    };
  };
  const serialized = observations
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(serialize);
  const serializedHeadings = headings
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(serialize);

  const canonical: SerializedOCRChunk = {
    version: OCR_CHUNK_VERSION,
    locale,
    pageIndex: serialized[0]?.pageIndex ?? 0,
    observations: serialized,
    headings: serializedHeadings,
    knownBiomarkerIds: [...new Set(knownBiomarkerIds)].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
  const result = JSON.stringify(canonical);
  if (new TextEncoder().encode(result).byteLength > manifest.prompt.maxInputBytes) {
    throw new OCRSerializationError('input-too-large');
  }
  return result;
}
