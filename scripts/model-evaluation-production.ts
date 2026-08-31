/** Script-only bridge to production-owned v2 serializer, prompt, retry, and validator. */
export {
  createSemanticMapperPrompt,
  createSemanticMapperRetryPrompt,
  estimateSemanticMapperTokens,
  SEMANTIC_MAPPER_CONTEXT,
  SEMANTIC_MAPPER_GRAMMAR,
  SEMANTIC_MAPPER_LIMITS,
  SEMANTIC_MAPPER_PROMPT_VERSION,
  SEMANTIC_MAPPER_SCHEMA_VERSION,
  SEMANTIC_OCR_CHUNK_VERSION,
  serializeSemanticMapperChunk,
  validateSemanticMapperOutputWithState,
} from '../apps/mobile/src/features/local-models/semantic-contract';
export { productionLocalModelManifest } from '../apps/mobile/src/features/local-models/production-manifest.generated';
