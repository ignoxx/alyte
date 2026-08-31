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
export const QWEN3_EVALUATION_MANIFEST_VERSION = 'alyte.qwen3-1.7b-evaluation.manifest.v1' as const;
export const QWEN3_EVALUATION_CONTRACT_VERSION = 'alyte.qwen3-1.7b-evaluation.contract.v1' as const;
export const QWEN3_EVALUATION_PROMPT_BUNDLE_VERSION =
  'alyte.qwen3-1.7b-evaluation.prompt.v1' as const;
export const LFM2_350M_SOURCE_SELECTOR_MANIFEST_VERSION =
  'alyte.lfm2-350m-extract-source-selector.manifest.v1' as const;
export const LFM2_350M_SOURCE_SELECTOR_PROMPT_BUNDLE_VERSION =
  'alyte.lfm2-350m-extract-source-selector.prompt.v1' as const;
export const LFM2_1_2B_SOURCE_SELECTOR_MANIFEST_VERSION =
  'alyte.lfm2-1.2b-extract-source-selector.manifest.v1' as const;
export const LFM2_1_2B_SOURCE_SELECTOR_PROMPT_BUNDLE_VERSION =
  'alyte.lfm2-1.2b-extract-source-selector.prompt.v1' as const;

export type EvaluationManifest = {
  readonly manifestVersion: string;
  readonly contractVersion?: string;
  readonly promptBundleVersion?: string;
  readonly sourceModel?: {
    readonly id: string;
    readonly repository: string;
    readonly revision: string;
    readonly chatTemplateUrl?: string;
    readonly chatTemplateRevision?: string;
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
    readonly chatTemplate?: 'gemma4-v1' | 'qwen3-v1' | 'lfm2-v1';
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

/** Evaluator-only Qwen3 candidate with its reviewed non-thinking raw ChatML template. */
export const qwen3EvaluationManifest = Object.freeze({
  manifestVersion: QWEN3_EVALUATION_MANIFEST_VERSION,
  contractVersion: QWEN3_EVALUATION_CONTRACT_VERSION,
  promptBundleVersion: QWEN3_EVALUATION_PROMPT_BUNDLE_VERSION,
  model: Object.freeze({
    id: 'qwen3-1.7b',
    repository: 'ggml-org/Qwen3-1.7B-GGUF',
    revision: 'daeb8e2d528a760970442092f6bf1e55c3b659eb',
    filename: 'Qwen3-1.7B-Q4_K_M.gguf',
    publisher: 'Qwen / ggml-org',
    license: 'Apache-2.0',
    format: 'GGUF',
    quantization: 'Q4_K_M',
    bytes: 1_282_439_264,
    sha256: 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
    url: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/daeb8e2d528a760970442092f6bf1e55c3b659eb/Qwen3-1.7B-Q4_K_M.gguf?download=true',
    sourceMetadataUrl: 'https://huggingface.co/api/models/ggml-org/Qwen3-1.7B-GGUF',
  }),
  runtime: qwenEvaluationManifest.runtime,
  prompt: Object.freeze({
    ...qwenEvaluationManifest.prompt,
    chatTemplate: 'qwen3-v1' as const,
    chatTemplateSource: 'explicit-pinned-qwen3-non-thinking-chatml-template-v1',
  }),
  allowedBiomarkerIds: qwenEvaluationManifest.allowedBiomarkerIds,
  languages: qwenEvaluationManifest.languages,
} as const);

export type Qwen3EvaluationManifest = typeof qwen3EvaluationManifest;

function lfm2SourceSelectorPrompt() {
  return Object.freeze({
    ...qwenEvaluationManifest.prompt,
    chatTemplate: 'lfm2-v1' as const,
    chatTemplateSource: 'explicit-pinned-liquidai-chat-template-v1',
  });
}

const LFM2_EXTRACT_SUPPORTED_LANGUAGES = Object.freeze([
  'en',
  'ar',
  'zh',
  'fr',
  'de',
  'ja',
  'ko',
  'pt',
  'es',
] as const);

export const lfm2_350mExtractEvaluationManifest = Object.freeze({
  manifestVersion: LFM2_350M_SOURCE_SELECTOR_MANIFEST_VERSION,
  promptBundleVersion: LFM2_350M_SOURCE_SELECTOR_PROMPT_BUNDLE_VERSION,
  sourceModel: Object.freeze({
    id: 'lfm2-350m-extract',
    repository: 'LiquidAI/LFM2-350M-Extract',
    revision: 'd99a6f06ea16a2f83998789389a64b66d40c4198',
    chatTemplateRevision: 'd99a6f06ea16a2f83998789389a64b66d40c4198',
    chatTemplateUrl:
      'https://huggingface.co/LiquidAI/LFM2-350M-Extract/resolve/d99a6f06ea16a2f83998789389a64b66d40c4198/chat_template.jinja',
  }),
  model: Object.freeze({
    id: 'lfm2-350m-extract',
    repository: 'LiquidAI/LFM2-350M-Extract-GGUF',
    revision: 'b8f758b9ff37b0cad9bedfc5223cb71e31aebe9c',
    filename: 'LFM2-350M-Extract-Q4_K_M.gguf',
    publisher: 'LiquidAI',
    license: 'LFM-Open-License-v1.0',
    format: 'GGUF',
    quantization: 'Q4_K_M',
    bytes: 229_310_080,
    sha256: '687a31c3e7864647aa181e1feb156e4e5da33978c174d7dbf0d289f6014a5621',
    url: 'https://huggingface.co/LiquidAI/LFM2-350M-Extract-GGUF/resolve/b8f758b9ff37b0cad9bedfc5223cb71e31aebe9c/LFM2-350M-Extract-Q4_K_M.gguf?download=true',
    sourceMetadataUrl: 'https://huggingface.co/api/models/LiquidAI/LFM2-350M-Extract-GGUF',
  }),
  runtime: qwenEvaluationManifest.runtime,
  prompt: lfm2SourceSelectorPrompt(),
  allowedBiomarkerIds: qwenEvaluationManifest.allowedBiomarkerIds,
  languages: LFM2_EXTRACT_SUPPORTED_LANGUAGES,
} as const);

export const lfm2_1_2bExtractEvaluationManifest = Object.freeze({
  manifestVersion: LFM2_1_2B_SOURCE_SELECTOR_MANIFEST_VERSION,
  promptBundleVersion: LFM2_1_2B_SOURCE_SELECTOR_PROMPT_BUNDLE_VERSION,
  sourceModel: Object.freeze({
    id: 'lfm2-1.2b-extract',
    repository: 'LiquidAI/LFM2-1.2B-Extract',
    revision: 'e68bdd9af162cfca7d806b456a7a56406e6194fa',
    chatTemplateRevision: 'e68bdd9af162cfca7d806b456a7a56406e6194fa',
    chatTemplateUrl:
      'https://huggingface.co/LiquidAI/LFM2-1.2B-Extract/resolve/e68bdd9af162cfca7d806b456a7a56406e6194fa/chat_template.jinja',
  }),
  model: Object.freeze({
    id: 'lfm2-1.2b-extract',
    repository: 'LiquidAI/LFM2-1.2B-Extract-GGUF',
    revision: 'ef65f6005f6a4de8a8e7a60279242b1c96be229a',
    filename: 'LFM2-1.2B-Extract-Q4_K_M.gguf',
    publisher: 'LiquidAI',
    license: 'LFM-Open-License-v1.0',
    format: 'GGUF',
    quantization: 'Q4_K_M',
    bytes: 730_894_048,
    sha256: '09b60b507ee7d1698b2b4dfce184c75083d7790c7701910ed60afa2801024702',
    url: 'https://huggingface.co/LiquidAI/LFM2-1.2B-Extract-GGUF/resolve/ef65f6005f6a4de8a8e7a60279242b1c96be229a/LFM2-1.2B-Extract-Q4_K_M.gguf?download=true',
    sourceMetadataUrl: 'https://huggingface.co/api/models/LiquidAI/LFM2-1.2B-Extract-GGUF',
  }),
  runtime: qwenEvaluationManifest.runtime,
  prompt: lfm2SourceSelectorPrompt(),
  allowedBiomarkerIds: qwenEvaluationManifest.allowedBiomarkerIds,
  languages: LFM2_EXTRACT_SUPPORTED_LANGUAGES,
} as const);

export type Lfm2SourceSelectorCandidate = 'lfm2-350m-extract' | 'lfm2-1.2b-extract';

/** Candidates supported by the generic semantic-mapper contract and native device runner. */
export const candidateEvaluationManifests = Object.freeze({
  qwen: qwenEvaluationManifest,
  gemma4: gemmaEvaluationManifest,
} as const);

export type EvaluationCandidate = keyof typeof candidateEvaluationManifests;
export type GenericEvaluationManifest = EvaluationManifest & {
  readonly manifestVersion:
    typeof MODEL_EVALUATION_MANIFEST_VERSION | typeof GEMMA_EVALUATION_MANIFEST_VERSION;
};

/** Source-selector-only candidates; these must not flow into generic/native contract generation. */
export const sourceSelectorCandidateManifests = Object.freeze({
  ...candidateEvaluationManifests,
  qwen3: qwen3EvaluationManifest,
  'lfm2-350m-extract': lfm2_350mExtractEvaluationManifest,
  'lfm2-1.2b-extract': lfm2_1_2bExtractEvaluationManifest,
} as const);

export type SourceSelectorCandidate = keyof typeof sourceSelectorCandidateManifests;

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
    (!['gemma4-v1', 'qwen3-v1', 'lfm2-v1'].includes(manifest.prompt.chatTemplate) ||
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

export function assertSourceSelectorCandidateManifest(manifest: EvaluationManifest): void {
  assertEvaluationManifest(manifest);
  if (
    !Object.values(sourceSelectorCandidateManifests).some(
      (candidate) => candidateIdentity(candidate) === candidateIdentity(manifest),
    )
  ) {
    throw new Error('unsupported_source_selector_candidate_manifest');
  }
}

assertSourceSelectorCandidateManifest(qwen3EvaluationManifest);
assertSourceSelectorCandidateManifest(lfm2_350mExtractEvaluationManifest);
assertSourceSelectorCandidateManifest(lfm2_1_2bExtractEvaluationManifest);
