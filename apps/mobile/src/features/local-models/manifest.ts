import { productionLocalModelManifest } from './production-manifest.generated';

export { productionLocalModelManifest };
export type LocalModelManifest = typeof productionLocalModelManifest;
export const LOCAL_MODEL_MANIFEST_VERSION = productionLocalModelManifest.manifestVersion;
export const LOCAL_MODEL_PACK_ID = productionLocalModelManifest.pack.id;
export const LOCAL_MODEL_PROMPT_BUNDLE = productionLocalModelManifest.compatibility.promptBundle;
export const LOCAL_MODEL_SCHEMA = productionLocalModelManifest.compatibility.semanticSchema;
export const LOCAL_MODEL_RUNTIME_REVISION = productionLocalModelManifest.runtime.revision;

function immutableRevision(value: string): boolean {
  return /^[a-f0-9]{40}$/.test(value);
}

/** Validates a production contract before a native boundary can consume it. */
export function assertLocalModelManifest(
  manifest: LocalModelManifest = productionLocalModelManifest,
): void {
  const expected = productionLocalModelManifest;
  const artifact = manifest.pack.artifact;
  if (manifest.manifestVersion !== expected.manifestVersion)
    throw new Error('unsupported_manifest');
  if (manifest.pack.id !== expected.pack.id) throw new Error('unsupported_pack');
  if (
    !immutableRevision(manifest.pack.source.revision) ||
    manifest.pack.source.revision !== expected.pack.source.revision ||
    !immutableRevision(artifact.revision) ||
    artifact.revision !== expected.pack.artifact.revision
  ) {
    throw new Error('artifact_revision_must_be_exact_and_immutable');
  }
  if (
    manifest.pack.source.repository !== expected.pack.source.repository ||
    artifact.repository !== expected.pack.artifact.repository ||
    artifact.filename !== expected.pack.artifact.filename ||
    manifest.runtime.id !== expected.runtime.id ||
    manifest.runtime.repository !== expected.runtime.repository ||
    manifest.runtime.revision !== expected.runtime.revision
  ) {
    throw new Error('model_identity_mismatch');
  }
  if (manifest.pack.publisher !== expected.pack.publisher)
    throw new Error('model_publisher_mismatch');
  if (
    manifest.pack.license !== expected.pack.license ||
    manifest.pack.format !== expected.pack.format
  ) {
    throw new Error('unsupported_license_or_format');
  }
  if (manifest.pack.quantization !== expected.pack.quantization)
    throw new Error('unsupported_quantization');
  if (
    artifact.bytes !== expected.pack.artifact.bytes ||
    artifact.sha256 !== expected.pack.artifact.sha256
  ) {
    throw new Error('artifact_integrity_metadata_mismatch');
  }
  if (
    manifest.compatibility.promptBundle !== expected.compatibility.promptBundle ||
    manifest.compatibility.semanticSchema !== expected.compatibility.semanticSchema ||
    manifest.requirements.minimumIOS !== expected.requirements.minimumIOS ||
    manifest.requirements.minimumFreeBytes !== expected.requirements.minimumFreeBytes ||
    manifest.requirements.minimumMemoryBytes !== expected.requirements.minimumMemoryBytes
  ) {
    throw new Error('incompatible_runtime_requirements');
  }
  if (manifest.compatibility.languages.join(',') !== expected.compatibility.languages.join(',')) {
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
    manifest.allowlist.hosts.join(',') !== expected.allowlist.hosts.join(',') ||
    manifest.allowlist.files.length !== expected.allowlist.files.length
  ) {
    throw new Error('allowlist_must_be_narrow');
  }
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error('manifest_identity_mismatch');
}

assertLocalModelManifest();

export function formatModelBytes(bytes: number): string {
  const gibibytes = bytes / 1024 ** 3;
  return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GB`;
}
