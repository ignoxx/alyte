import {
  CATALOGUE_ARTIFACT_SCHEMA_VERSION,
  CATALOGUE_VERSION,
  catalogueManifest,
  type BiomarkerCatalogueEntry,
  type CatalogueArtifact,
  type CatalogueArtifactVerification,
  type CatalogueManifest,
  type CatalogueSource,
  type CatalogueVerificationOptions,
} from './schema';
import { assertCatalogueValid, validateCatalogue } from './validation';

/** Stable JSON encoding keeps a digest independent of object insertion order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function getCryptoSubtle(): {
  digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer>;
  importKey: (...args: any[]) => Promise<unknown>;
  verify: (...args: any[]) => Promise<boolean>;
} | null {
  const runtime = globalThis as unknown as {
    crypto?: {
      subtle?: {
        digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer>;
        importKey: (...args: any[]) => Promise<unknown>;
        verify: (...args: any[]) => Promise<boolean>;
      };
    };
  };
  return runtime.crypto?.subtle ?? null;
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = getCryptoSubtle();
  if (subtle === null) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value).buffer);
  return bytesToHex(new Uint8Array(digest));
}

export async function createCatalogueArtifact(
  entries: readonly BiomarkerCatalogueEntry[],
  manifest: CatalogueManifest = catalogueManifest,
  sourceSet: readonly CatalogueSource[] = deriveSourceSet(entries),
): Promise<CatalogueArtifact> {
  assertCatalogueValid(entries);
  const payload = canonicalJson({
    schemaVersion: CATALOGUE_ARTIFACT_SCHEMA_VERSION,
    manifest,
    entries,
    sourceSet,
  });
  return {
    schemaVersion: CATALOGUE_ARTIFACT_SCHEMA_VERSION,
    manifest,
    entries,
    sourceSet,
    integrity: { algorithm: 'SHA-256', digest: await sha256Hex(payload) },
    signature: null,
  };
}

export async function validateCatalogueArtifact(
  artifact: CatalogueArtifact,
  options: CatalogueVerificationOptions = {},
): Promise<CatalogueArtifactVerification> {
  if (artifact.schemaVersion !== CATALOGUE_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, reason: 'catalogue artifact schema mismatch' };
  }
  if (artifact.manifest.version !== CATALOGUE_VERSION) {
    return { ok: false, reason: 'catalogue version mismatch' };
  }
  let issues;
  try {
    issues = validateCatalogue(artifact.entries);
  } catch {
    return { ok: false, reason: 'catalogue validation: malformed entry' };
  }
  if (issues.length > 0)
    return { ok: false, reason: `catalogue validation: ${issues[0]!.message}` };
  let localReferenceIssue: string | null;
  try {
    localReferenceIssue = validateArtifactSourceReferences(artifact.entries, artifact.sourceSet);
  } catch {
    return { ok: false, reason: 'catalogue source set is malformed' };
  }
  if (localReferenceIssue !== null) return { ok: false, reason: localReferenceIssue };
  const payload = canonicalJson({
    schemaVersion: CATALOGUE_ARTIFACT_SCHEMA_VERSION,
    manifest: artifact.manifest,
    entries: artifact.entries,
    sourceSet: artifact.sourceSet,
  });
  const digest = await sha256Hex(payload);
  if (digest !== artifact.integrity.digest)
    return { ok: false, reason: 'catalogue integrity mismatch' };
  if (artifact.signature === null) {
    if (options.requireSignature === true || artifact.manifest.signatureRequired) {
      return { ok: false, reason: 'catalogue signature required' };
    }
    return { ok: true, signed: false };
  }
  const subtle = getCryptoSubtle();
  if (subtle === null)
    return { ok: false, reason: 'Web Crypto signature verification unavailable' };
  const trustedKey = options.trustedKeys?.find(
    (candidate) => candidate.keyId === artifact.signature?.keyId,
  );
  if (trustedKey === undefined)
    return { ok: false, reason: 'catalogue signing key is not trusted' };
  if (trustedKey.algorithm !== artifact.signature.algorithm) {
    return { ok: false, reason: 'catalogue signing algorithm does not match trusted key' };
  }
  try {
    const algorithm =
      artifact.signature.algorithm === 'Ed25519'
        ? { name: 'Ed25519' }
        : { name: 'ECDSA', namedCurve: 'P-256' };
    const key = await subtle.importKey('jwk', trustedKey.publicKeyJwk, algorithm, false, [
      'verify',
    ]);
    const verified = await subtle.verify(
      artifact.signature.algorithm === 'Ed25519'
        ? { name: 'Ed25519' }
        : { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64ToBytes(artifact.signature.value),
      new TextEncoder().encode(payload),
    );
    return verified
      ? { ok: true, signed: true }
      : { ok: false, reason: 'catalogue signature mismatch' };
  } catch {
    return { ok: false, reason: 'catalogue signature is malformed' };
  }
}

export const verifyCatalogueArtifact = validateCatalogueArtifact;

function deriveSourceSet(entries: readonly BiomarkerCatalogueEntry[]): readonly CatalogueSource[] {
  const sources = entries.flatMap((entry) => entry.sources ?? []);
  return [...new Map(sources.map((source) => [source.id, source])).values()];
}

function validateArtifactSourceReferences(
  entries: readonly BiomarkerCatalogueEntry[],
  sourceSet: readonly CatalogueSource[],
): string | null {
  const sourceIds = new Set(sourceSet.map((source) => source.id));
  for (const entry of entries) {
    for (const source of entry.sources ?? []) {
      if (!sourceIds.has(source.id)) return `catalogue source is missing: ${source.id}`;
    }
    for (const conversion of entry.unitConversions ?? []) {
      if (!sourceIds.has(conversion.sourceId)) {
        return `catalogue conversion source is missing: ${conversion.sourceId}`;
      }
    }
    for (const guidance of entry.generalGuidance ?? []) {
      for (const sourceId of guidance.sources) {
        if (!sourceIds.has(sourceId)) return `catalogue guidance source is missing: ${sourceId}`;
      }
    }
  }
  return null;
}
