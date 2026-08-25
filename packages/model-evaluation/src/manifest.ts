import {
  ALL_COMPARABLE_BIOMARKER_IDS,
  CATALOGUE_SCHEMA_VERSION,
  CATALOGUE_VERSION,
} from '@alyte/catalogue';

export const MODEL_EVALUATION_MANIFEST_VERSION = 'alyte.qwen-evaluation.manifest.v1' as const;
export const QWEN_EVALUATION_CONTRACT_VERSION = 'alyte.qwen-evaluation.contract.v1' as const;
export const SEMANTIC_MAPPER_SCHEMA_VERSION = 'alyte.semantic-mapper.v1' as const;
export const OCR_CHUNK_VERSION = 'alyte.semantic-ocr-chunk.v1' as const;
export const GEMMA_EVALUATION_MANIFEST_VERSION = 'alyte.gemma4-e2b-evaluation.manifest.v1' as const;
export const GEMMA_EVALUATION_CONTRACT_VERSION = 'alyte.gemma4-e2b-evaluation.contract.v1' as const;
export const GEMMA_EVALUATION_PROMPT_BUNDLE_VERSION =
  'alyte.gemma4-e2b-evaluation.prompt.v2' as const;

export type EvaluationManifest = {
  readonly manifestVersion: string;
  readonly contractVersion?: string;
  readonly promptBundleVersion?: string;
  readonly sourceModel?: {
    readonly id: string;
    readonly repository: string;
    readonly revision: string;
  };
  readonly model: {
    readonly id: string;
    readonly repository: string;
    readonly revision: string;
    readonly filename: string;
    readonly publisher: string;
    readonly license: string;
    readonly format: string;
    readonly quantization: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly url: string;
    readonly sourceMetadataUrl: string;
  };
  readonly runtime: {
    readonly id: string;
    readonly repository: string;
    readonly release: string;
    readonly revision: string;
    readonly xcframeworkScript: string;
    readonly xcframeworkPlatforms: readonly string[];
    readonly grammar: string;
    readonly minimumRuntimeOS: string;
  };
  readonly prompt: {
    readonly schemaVersion: string;
    readonly ocrChunkVersion: string;
    readonly catalogueVersion: string;
    readonly catalogueSchemaVersion: string;
    readonly maxObservations: number;
    readonly maxObservationTextCharacters: number;
    readonly maxAlternativeCharacters: number;
    readonly maxProposals: number;
    readonly maxOutputBytes: number;
    readonly maxInputBytes: number;
    readonly contextWindowTokens: number;
    readonly outputTokenLimit: number;
    readonly temperature: number;
    readonly topP: number;
    readonly thinking: boolean;
    readonly grammarRoot: string;
    readonly chatTemplate?: 'gemma4-v1';
    readonly chatTemplateSource?: string;
  };
  readonly allowedBiomarkerIds: readonly string[];
  readonly languages: readonly string[];
};

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
    xcframeworkPlatforms: ['ios-device'] as const,
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
    maxInputBytes: 8_192,
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

/**
 * Gemma 4's published tokenizer config does not provide a usable chat template, and the pinned
 * llama.cpp revision only has the older Gemma template in its built-in template API. The evaluator
 * therefore binds the reviewed two-turn Gemma 4 template explicitly in the native runner. This
 * remains an evaluator-only allowlist; the GGUF is staged outside the repository and app binary.
 */
export const gemmaEvaluationManifest = Object.freeze({
  manifestVersion: GEMMA_EVALUATION_MANIFEST_VERSION,
  contractVersion: GEMMA_EVALUATION_CONTRACT_VERSION,
  promptBundleVersion: GEMMA_EVALUATION_PROMPT_BUNDLE_VERSION,
  sourceModel: Object.freeze({
    id: 'gemma-4-e2b-it',
    repository: 'google/gemma-4-E2B-it',
    revision: '3e22461f65e89153144f8adb70e3b8c2cc9845a7',
  }),
  model: Object.freeze({
    id: 'gemma-4-e2b-it',
    repository: 'ggml-org/gemma-4-E2B-it-GGUF',
    revision: 'b4243c156154b6dca9324415f8c7ccc098b4aed1',
    filename: 'gemma-4-E2B-it-Q4_0.gguf',
    publisher: 'Google / ggml-org',
    license: 'Apache-2.0',
    format: 'GGUF',
    quantization: 'Q4_0',
    bytes: 2_841_481_184,
    sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
    url: 'https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/b4243c156154b6dca9324415f8c7ccc098b4aed1/gemma-4-E2B-it-Q4_0.gguf?download=true',
    sourceMetadataUrl: 'https://huggingface.co/api/models/ggml-org/gemma-4-E2B-it-GGUF',
  }),
  runtime: qwenEvaluationManifest.runtime,
  prompt: Object.freeze({
    ...qwenEvaluationManifest.prompt,
    chatTemplate: 'gemma4-v1' as const,
    chatTemplateSource: 'explicit-pinned-google-gemma-4-template-v1',
  }),
  allowedBiomarkerIds: qwenEvaluationManifest.allowedBiomarkerIds,
  languages: qwenEvaluationManifest.languages,
} as const);

export type GemmaEvaluationManifest = typeof gemmaEvaluationManifest;

export const candidateEvaluationManifests = Object.freeze({
  qwen: qwenEvaluationManifest,
  gemma4: gemmaEvaluationManifest,
} as const);

export type EvaluationCandidate = keyof typeof candidateEvaluationManifests;

function candidateIdentity(manifest: EvaluationManifest): string {
  return JSON.stringify({
    contractVersion: manifest.contractVersion ?? QWEN_EVALUATION_CONTRACT_VERSION,
    manifestVersion: manifest.manifestVersion,
    promptBundleVersion: manifest.promptBundleVersion ?? null,
    sourceModel: manifest.sourceModel ?? null,
    model: {
      id: manifest.model.id,
      repository: manifest.model.repository,
      revision: manifest.model.revision,
      filename: manifest.model.filename,
      bytes: manifest.model.bytes,
      sha256: manifest.model.sha256,
    },
    runtime: {
      id: manifest.runtime.id,
      repository: manifest.runtime.repository,
      release: manifest.runtime.release,
      revision: manifest.runtime.revision,
    },
    prompt: {
      schemaVersion: manifest.prompt.schemaVersion,
      ocrChunkVersion: manifest.prompt.ocrChunkVersion,
      catalogueVersion: manifest.prompt.catalogueVersion,
      catalogueSchemaVersion: manifest.prompt.catalogueSchemaVersion,
      contextWindowTokens: manifest.prompt.contextWindowTokens,
      outputTokenLimit: manifest.prompt.outputTokenLimit,
      maxInputBytes: manifest.prompt.maxInputBytes,
      maxOutputBytes: manifest.prompt.maxOutputBytes,
      maxProposals: manifest.prompt.maxProposals,
      temperature: manifest.prompt.temperature,
      topP: manifest.prompt.topP,
      thinking: manifest.prompt.thinking,
      grammarRoot: manifest.prompt.grammarRoot,
      chatTemplate: manifest.prompt.chatTemplate ?? null,
      chatTemplateSource: manifest.prompt.chatTemplateSource ?? null,
    },
  });
}

export function modelArtifactUrl(manifest: EvaluationManifest = qwenEvaluationManifest): string {
  return manifest.model.url;
}

export function assertEvaluationManifest(manifest: EvaluationManifest): void {
  if (!manifest.manifestVersion.startsWith('alyte.') || manifest.model.id.length === 0) {
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
  if (
    manifest.prompt.temperature !== 0 ||
    manifest.prompt.maxOutputBytes <= 0 ||
    manifest.prompt.maxInputBytes <= 0 ||
    manifest.prompt.maxInputBytes > 8_192
  ) {
    throw new Error('nondeterministic_or_unbounded_prompt_settings');
  }
  if (
    manifest.prompt.chatTemplate !== undefined &&
    (manifest.prompt.chatTemplate !== 'gemma4-v1' ||
      manifest.prompt.chatTemplateSource === undefined ||
      manifest.prompt.chatTemplateSource.length === 0)
  ) {
    throw new Error('invalid_chat_template_metadata');
  }
}

export function assertEvaluationCandidateManifest(manifest: EvaluationManifest): void {
  assertEvaluationManifest(manifest);
  if (
    !Object.values(candidateEvaluationManifests).some(
      (candidate) => candidateIdentity(candidate) === candidateIdentity(manifest),
    )
  ) {
    throw new Error('unsupported_evaluation_candidate_manifest');
  }
}

assertEvaluationCandidateManifest(qwenEvaluationManifest);
assertEvaluationCandidateManifest(gemmaEvaluationManifest);
