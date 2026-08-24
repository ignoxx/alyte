import {
  CATALOGUE_ARTIFACT_SCHEMA_VERSION,
  CATALOGUE_VERSION,
  catalogueManifest,
  type BiomarkerCatalogueEntry,
  type CatalogueArtifact,
  type CatalogueArtifactVerification,
  type CatalogueManifest,
} from './schema.js';
import { assertCatalogueValid, validateCatalogue } from './validation.js';

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
  const binary = atob(value);
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
): Promise<CatalogueArtifact> {
  assertCatalogueValid(entries);
  const payload = canonicalJson({
    schemaVersion: CATALOGUE_ARTIFACT_SCHEMA_VERSION,
    manifest,
    entries,
  });
  return {
    schemaVersion: CATALOGUE_ARTIFACT_SCHEMA_VERSION,
    manifest,
    entries,
    integrity: { algorithm: 'SHA-256', digest: await sha256Hex(payload) },
    signature: null,
  };
}

export async function validateCatalogueArtifact(
  artifact: CatalogueArtifact,
  options: { readonly requireSignature?: boolean } = {},
): Promise<CatalogueArtifactVerification> {
  if (artifact.schemaVersion !== CATALOGUE_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, reason: 'catalogue artifact schema mismatch' };
  }
  if (artifact.manifest.version !== CATALOGUE_VERSION) {
    return { ok: false, reason: 'catalogue version mismatch' };
  }
  const issues = validateCatalogue(artifact.entries);
  if (issues.length > 0)
    return { ok: false, reason: `catalogue validation: ${issues[0]!.message}` };
  const payload = canonicalJson({
    schemaVersion: CATALOGUE_ARTIFACT_SCHEMA_VERSION,
    manifest: artifact.manifest,
    entries: artifact.entries,
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
  try {
    const algorithm =
      artifact.signature.algorithm === 'Ed25519'
        ? { name: 'Ed25519' }
        : { name: 'ECDSA', namedCurve: 'P-256' };
    const key = await subtle.importKey('jwk', artifact.signature.publicKeyJwk, algorithm, false, [
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
