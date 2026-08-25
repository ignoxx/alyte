/**
 * The production adapter imports this browser-safe surface only. Keep the evaluator's Node-only
 * contract builder out of Metro; no raw OCR or model output is retained by these helpers.
 */
export {
  GEMMA_EVALUATION_MANIFEST_VERSION,
  GEMMA_EVALUATION_PROMPT_BUNDLE_VERSION,
  gemmaEvaluationManifest,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  type EvaluationManifest,
} from './manifest';
export {
  OCRSerializationError,
  serializeOCRChunk,
  type SerializedOCRChunk,
  type OCRSerializationFailureCode,
} from './serialization';
export {
  countFailures,
  validateEvaluationOutput,
  type AcceptedProposal,
  type ValidationFailure,
  type ValidationFailureCode,
  type ValidationResult,
} from './validator';
export {
  semanticMapperJsonSchema,
  type EvaluationOutput,
  type EvaluationProposal,
  type SemanticRole,
  type SemanticSpecimenType,
} from './schema';
export type { FixtureObservation } from './fixtures';
