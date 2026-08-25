import {
  ALL_COMPARABLE_BIOMARKER_IDS,
  CATALOGUE_SCHEMA_VERSION,
  CATALOGUE_VERSION,
} from '@alyte/catalogue';

export const MODEL_EVALUATION_MANIFEST_VERSION = 'alyte.qwen-evaluation.manifest.v1' as const;
export const SEMANTIC_MAPPER_SCHEMA_VERSION = 'alyte.semantic-mapper.v1' as const;
export const OCR_CHUNK_VERSION = 'alyte.semantic-ocr-chunk.v1' as const;

/**
 * This is an allowlist, not a model downloader. The GGUF is deliberately absent from the
 * repository and must be staged by the operator in a task-specific external cache.
 */
export const qwenEvaluationManifest = Object.freeze({
  manifestVersion: MODEL_EVALUATION_MANIFEST_VERSION,
  model: Object.freeze({
    id: 'qwen3.5-0.8b',
    repository: 'ggml-org/Qwen3.5-0.8B-GGUF',
    revision: '8fea620810c4afa23dd6443f999a48574c1611a3',
    filename: 'Qwen3.5-0.8B-Q4_0.gguf',
    publisher: 'Qwen / ggml-org',
    license: 'Apache-2.0',
    format: 'GGUF',
    quantization: 'Q4_0',
    bytes: 563036064,
    sha256: '57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf',
    url: 'https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/8fea620810c4afa23dd6443f999a48574c1611a3/Qwen3.5-0.8B-Q4_0.gguf?download=true',
    sourceMetadataUrl: 'https://huggingface.co/api/models/ggml-org/Qwen3.5-0.8B-GGUF',
  }),
  runtime: Object.freeze({
    id: 'llama.cpp',
    repository: 'ggml-org/llama.cpp',
    release: 'v0.2.0',
    revision: 'bb4caa7540188872173c44d161602d9271386413',
    xcframeworkScript: 'build-xcframework.sh',
    xcframeworkPlatforms: ['ios-device', 'ios-sim'] as const,
    grammar: 'GBNF via llama_sampler_init_grammar',
    minimumRuntimeOS: '16.4',
  }),
  prompt: Object.freeze({
    schemaVersion: SEMANTIC_MAPPER_SCHEMA_VERSION,
    ocrChunkVersion: OCR_CHUNK_VERSION,
    catalogueVersion: CATALOGUE_VERSION,
    catalogueSchemaVersion: CATALOGUE_SCHEMA_VERSION,
    maxObservations: 48,
    maxObservationTextCharacters: 240,
    maxAlternativeCharacters: 120,
    maxProposals: 24,
    maxOutputBytes: 16_384,
    contextWindowTokens: 2_048,
    outputTokenLimit: 256,
    temperature: 0,
    topP: 1,
    thinking: false,
    grammarRoot: 'root',
  }),
  allowedBiomarkerIds: Object.freeze([...ALL_COMPARABLE_BIOMARKER_IDS]),
  languages: Object.freeze(['en', 'de', 'lt', 'pl', 'fr', 'es']),
} as const);

export type QwenEvaluationManifest = typeof qwenEvaluationManifest;

export function modelArtifactUrl(
  manifest: QwenEvaluationManifest = qwenEvaluationManifest,
): string {
  return manifest.model.url;
}

export function assertEvaluationManifest(manifest: QwenEvaluationManifest): void {
  if (manifest.manifestVersion !== MODEL_EVALUATION_MANIFEST_VERSION) {
    throw new Error('unsupported_evaluation_manifest');
  }
  if (manifest.model.revision.length !== 40 || manifest.runtime.revision.length !== 40) {
    throw new Error('evaluation_revisions_must_be_immutable_commits');
  }
  if (manifest.model.bytes <= 0 || !/^[a-f0-9]{64}$/.test(manifest.model.sha256)) {
    throw new Error('invalid_model_integrity_metadata');
  }
  if (!manifest.model.url.includes(`/${manifest.model.revision}/`)) {
    throw new Error('model_url_must_pin_revision');
  }
  if (manifest.prompt.thinking) {
    throw new Error('thinking_must_be_disabled_for_grammar_evaluation');
  }
  if (manifest.prompt.temperature !== 0 || manifest.prompt.maxOutputBytes <= 0) {
    throw new Error('nondeterministic_or_unbounded_prompt_settings');
  }
}

assertEvaluationManifest(qwenEvaluationManifest);
