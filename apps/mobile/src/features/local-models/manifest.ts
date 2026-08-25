/**
 * The production model contract is deliberately separate from the evaluation manifests. It is
 * an allowlist, not a general Hugging Face client: JavaScript cannot substitute another model,
 * revision, file, host, runtime, or prompt bundle.
 */
export const LOCAL_MODEL_MANIFEST_VERSION = 'alyte.local-model.manifest.v1' as const;
export const LOCAL_MODEL_PACK_ID = 'gemma-4-e2b-it-q4-0' as const;
export const LOCAL_MODEL_PROMPT_BUNDLE = 'alyte.gemma4-e2b-evaluation.prompt.v2' as const;
export const LOCAL_MODEL_SCHEMA = 'alyte.semantic-mapper.v1' as const;
export const LOCAL_MODEL_RUNTIME_REVISION = 'bb4caa7540188872173c44d161602d9271386413' as const;

export type LocalModelManifest = {
  readonly manifestVersion: typeof LOCAL_MODEL_MANIFEST_VERSION;
  readonly pack: {
    readonly id: typeof LOCAL_MODEL_PACK_ID;
    readonly source: {
      readonly repository: 'google/gemma-4-E2B-it';
      readonly revision: '3e22461f65e89153144f8adb70e3b8c2cc9845a7';
    };
    readonly artifact: {
      readonly repository: 'ggml-org/gemma-4-E2B-it-GGUF';
      readonly revision: 'b4243c156154b6dca9324415f8c7ccc098b4aed1';
      readonly filename: 'gemma-4-E2B-it-Q4_0.gguf';
      readonly url: string;
      readonly bytes: 2_841_481_184;
      readonly sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52';
    };
    readonly publisher: 'Google / ggml-org';
    readonly license: 'Apache-2.0';
    readonly format: 'GGUF';
    readonly quantization: 'Q4_0';
  };
  readonly runtime: {
    readonly id: 'llama.cpp';
    readonly repository: 'ggml-org/llama.cpp';
    readonly revision: typeof LOCAL_MODEL_RUNTIME_REVISION;
  };
  readonly compatibility: {
    readonly languages: readonly ['en', 'de', 'lt', 'fr', 'es', 'it', 'pt', 'nl', 'pl'];
    readonly promptBundle: typeof LOCAL_MODEL_PROMPT_BUNDLE;
    readonly semanticSchema: typeof LOCAL_MODEL_SCHEMA;
  };
  readonly requirements: {
    readonly minimumIOS: '26.0';
    readonly minimumFreeBytes: 6_000_000_000;
    readonly minimumMemoryBytes: 4_000_000_000;
  };
  readonly allowlist: {
    readonly hosts: readonly [
      'huggingface.co',
      'cdn-lfs.huggingface.co',
      'cdn-lfs-us-1.hf.co',
      'cdn-lfs-eu-1.hf.co',
      'cdn-lfs.hf.co',
      'cas-bridge.xethub.hf.co',
    ];
    readonly files: readonly ['gemma-4-E2B-it-Q4_0.gguf'];
  };
};

export const productionLocalModelManifest: LocalModelManifest = Object.freeze({
  manifestVersion: LOCAL_MODEL_MANIFEST_VERSION,
  pack: {
    id: LOCAL_MODEL_PACK_ID,
    source: {
      repository: 'google/gemma-4-E2B-it',
      revision: '3e22461f65e89153144f8adb70e3b8c2cc9845a7',
    },
    artifact: {
      repository: 'ggml-org/gemma-4-E2B-it-GGUF',
      revision: 'b4243c156154b6dca9324415f8c7ccc098b4aed1',
      filename: 'gemma-4-E2B-it-Q4_0.gguf',
      url: 'https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF/resolve/b4243c156154b6dca9324415f8c7ccc098b4aed1/gemma-4-E2B-it-Q4_0.gguf?download=true',
      bytes: 2_841_481_184,
      sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
    },
    publisher: 'Google / ggml-org',
    license: 'Apache-2.0',
    format: 'GGUF',
    quantization: 'Q4_0',
  },
  runtime: {
    id: 'llama.cpp',
    repository: 'ggml-org/llama.cpp',
    revision: LOCAL_MODEL_RUNTIME_REVISION,
  },
  compatibility: {
    languages: ['en', 'de', 'lt', 'fr', 'es', 'it', 'pt', 'nl', 'pl'],
    promptBundle: LOCAL_MODEL_PROMPT_BUNDLE,
    semanticSchema: LOCAL_MODEL_SCHEMA,
  },
  requirements: {
    minimumIOS: '26.0',
    minimumFreeBytes: 6_000_000_000,
    minimumMemoryBytes: 4_000_000_000,
  },
  allowlist: {
    hosts: [
      'huggingface.co',
      'cdn-lfs.huggingface.co',
      'cdn-lfs-us-1.hf.co',
      'cdn-lfs-eu-1.hf.co',
      'cdn-lfs.hf.co',
      'cas-bridge.xethub.hf.co',
    ],
    files: ['gemma-4-E2B-it-Q4_0.gguf'],
  },
} as const);

function immutableRevision(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

/** Validates the production contract before a native boundary can consume it. */
export function assertLocalModelManifest(
  manifest: LocalModelManifest = productionLocalModelManifest,
): void {
  const artifact = manifest.pack.artifact;
  if (manifest.manifestVersion !== LOCAL_MODEL_MANIFEST_VERSION)
    throw new Error('unsupported_manifest');
  if (manifest.pack.id !== LOCAL_MODEL_PACK_ID) throw new Error('unsupported_pack');
  if (
    !immutableRevision(manifest.pack.source.revision) ||
    manifest.pack.source.revision !== '3e22461f65e89153144f8adb70e3b8c2cc9845a7' ||
    !immutableRevision(artifact.revision) ||
    artifact.revision !== 'b4243c156154b6dca9324415f8c7ccc098b4aed1'
  ) {
    throw new Error('artifact_revision_must_be_exact_and_immutable');
  }
  if (
    manifest.pack.source.repository !== 'google/gemma-4-E2B-it' ||
    artifact.repository !== 'ggml-org/gemma-4-E2B-it-GGUF' ||
    artifact.filename !== 'gemma-4-E2B-it-Q4_0.gguf' ||
    manifest.runtime.id !== 'llama.cpp' ||
    manifest.runtime.repository !== 'ggml-org/llama.cpp' ||
    manifest.runtime.revision !== LOCAL_MODEL_RUNTIME_REVISION
  ) {
    throw new Error('model_identity_mismatch');
  }
  if (manifest.pack.publisher !== 'Google / ggml-org') {
    throw new Error('model_publisher_mismatch');
  }
  if (manifest.pack.license !== 'Apache-2.0' || manifest.pack.format !== 'GGUF') {
    throw new Error('unsupported_license_or_format');
  }
  if (manifest.pack.quantization !== 'Q4_0') {
    throw new Error('unsupported_quantization');
  }
  if (
    artifact.bytes !== 2_841_481_184 ||
    artifact.sha256 !== '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52'
  ) {
    throw new Error('artifact_integrity_metadata_mismatch');
  }
  if (
    manifest.compatibility.promptBundle !== LOCAL_MODEL_PROMPT_BUNDLE ||
    manifest.compatibility.semanticSchema !== LOCAL_MODEL_SCHEMA ||
    manifest.requirements.minimumIOS !== '26.0' ||
    manifest.requirements.minimumFreeBytes !== 6_000_000_000 ||
    manifest.requirements.minimumMemoryBytes !== 4_000_000_000
  ) {
    throw new Error('incompatible_runtime_requirements');
  }
  if (manifest.compatibility.languages.join(',') !== 'en,de,lt,fr,es,it,pt,nl,pl') {
    throw new Error('unsupported_language_contract');
  }
  if (artifact.filename !== manifest.allowlist.files[0])
    throw new Error('artifact_not_allowlisted');
  const url = new URL(artifact.url);
  const expectedPath = `/ggml-org/gemma-4-E2B-it-GGUF/resolve/${artifact.revision}/${artifact.filename}`;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'huggingface.co' ||
    url.pathname !== expectedPath ||
    url.search !== '?download=true' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('artifact_url_must_be_immutable_and_public');
  }
  if (
    manifest.allowlist.hosts.join(',') !==
      'huggingface.co,cdn-lfs.huggingface.co,cdn-lfs-us-1.hf.co,cdn-lfs-eu-1.hf.co,cdn-lfs.hf.co,cas-bridge.xethub.hf.co' ||
    manifest.allowlist.files.length !== 1
  ) {
    throw new Error('allowlist_must_be_narrow');
  }
}

assertLocalModelManifest();

export function formatModelBytes(bytes: number): string {
  const gibibytes = bytes / 1024 ** 3;
  return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GB`;
}
