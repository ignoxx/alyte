import { OCR_CHUNK_VERSION, qwenEvaluationManifest } from './manifest';
import type { FixtureObservation } from './fixtures';

export type SerializedOCRObservation = {
  readonly id: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly pageIndex: number;
};

export type SerializedOCRChunk = {
  readonly version: typeof OCR_CHUNK_VERSION;
  readonly locale: string;
  readonly pageIndex: number;
  readonly observations: readonly SerializedOCRObservation[];
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
): string {
  if (observations.length > qwenEvaluationManifest.prompt.maxObservations) {
    throw new OCRSerializationError('too-many-observations');
  }
  const allowedBiomarkerIds: ReadonlySet<string> = new Set(
    qwenEvaluationManifest.allowedBiomarkerIds,
  );
  if (knownBiomarkerIds.some((id) => !allowedBiomarkerIds.has(id))) {
    throw new OCRSerializationError('unknown-catalogue-id');
  }

  const serialized = observations
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((observation): SerializedOCRObservation => {
      if (
        observation.id.length === 0 ||
        observation.id.length > 96 ||
        !Number.isInteger(observation.pageIndex) ||
        observation.pageIndex < 0
      ) {
        throw new OCRSerializationError('invalid-observation');
      }
      if (observation.text.length > qwenEvaluationManifest.prompt.maxObservationTextCharacters) {
        throw new OCRSerializationError('observation-text-too-long');
      }
      if (
        observation.alternatives.some(
          (alternative) =>
            alternative.length > qwenEvaluationManifest.prompt.maxAlternativeCharacters,
        )
      ) {
        throw new OCRSerializationError('observation-alternatives-too-long');
      }
      return {
        id: observation.id,
        text: observation.text,
        alternatives: [...observation.alternatives].sort((left, right) =>
          left.localeCompare(right),
        ),
        pageIndex: observation.pageIndex,
      };
    });

  const canonical: SerializedOCRChunk = {
    version: OCR_CHUNK_VERSION,
    locale,
    pageIndex: serialized[0]?.pageIndex ?? 0,
    observations: serialized,
    knownBiomarkerIds: [...new Set(knownBiomarkerIds)].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
  const result = JSON.stringify(canonical);
  if (new TextEncoder().encode(result).byteLength > qwenEvaluationManifest.prompt.maxInputBytes) {
    throw new OCRSerializationError('input-too-large');
  }
  return result;
}
