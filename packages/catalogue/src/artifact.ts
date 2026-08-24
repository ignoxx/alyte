import {
  ALL_COMPARABLE_BIOMARKER_IDS,
  CATALOGUE_ARTIFACT_SCHEMA_VERSION,
  CATALOGUE_SCHEMA_VERSION,
  CATALOGUE_VERSION,
  catalogueManifest,
  type BiomarkerCatalogueEntry,
  type CatalogueArtifact,
  type CatalogueArtifactVerification,
  type CatalogueConsumptionOptions,
  type CatalogueConsumptionResult,
  type CatalogueEnvironment,
  type CatalogueManifest,
  type CataloguePrivateSigningKey,
  type CatalogueSignature,
  type CatalogueSource,
  type CatalogueTrustedKey,
  type CatalogueValidationIssue,
  type CatalogueVerificationOptions,
} from './schema';
import { assertCatalogueValid, validateCatalogueRelease } from './validation';

type SubtleCryptoLike = {
  digest: (algorithm: string, data: ArrayBuffer) => Promise<ArrayBuffer>;
  importKey: (...args: any[]) => Promise<unknown>;
  sign: (...args: any[]) => Promise<ArrayBuffer>;
  verify: (...args: any[]) => Promise<boolean>;
};

/**
 * RFC-8785-shaped canonical JSON for the catalogue's JSON-safe data. Object key ordering is
 * lexical and arrays retain their semantic order. Undefined and non-finite values are rejected
 * instead of becoming ambiguous JSON, which makes malformed artifacts fail closed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('canonical JSON cannot encode a non-finite number');
    return JSON.stringify(value);
  }
  if (value === undefined) throw new Error('canonical JSON cannot encode undefined');
  if (typeof value !== 'object') throw new Error('canonical JSON cannot encode this value');
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

export function canonicalCataloguePayload(artifact: {
  readonly schemaVersion: string;
  readonly manifest: CatalogueManifest;
  readonly entries: readonly BiomarkerCatalogueEntry[];
  readonly sourceSet: readonly CatalogueSource[];
}): string {
  const normalized = normalizeArtifactParts(artifact.entries, artifact.sourceSet);
  return canonicalJson({
    schemaVersion: artifact.schemaVersion,
    manifest: artifact.manifest,
    entries: normalized.entries,
    sourceSet: normalized.sourceSet,
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error('invalid base64');
  }
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function getCryptoSubtle(): SubtleCryptoLike | null {
  const runtime = globalThis as unknown as { crypto?: { subtle?: SubtleCryptoLike } };
  return runtime.crypto?.subtle ?? null;
}

function signingAlgorithm(
  signatureAlgorithm: CatalogueSignature['algorithm'],
): Record<string, string> {
  return signatureAlgorithm === 'Ed25519'
    ? { name: 'Ed25519' }
    : { name: 'ECDSA', namedCurve: 'P-256' };
}

function signatureAlgorithmForWebCrypto(
  signatureAlgorithm: CatalogueSignature['algorithm'],
): Record<string, string> {
  return signatureAlgorithm === 'Ed25519'
    ? { name: 'Ed25519' }
    : { name: 'ECDSA', hash: 'SHA-256' };
}

function semverParts(value: string): readonly [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  if (a === null || b === null) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Compare UTF-16 code units without locale or host-locale dependence. */
export function compareCodeUnits(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftCodeUnit = left.charCodeAt(index);
    const rightCodeUnit = right.charCodeAt(index);
    if (leftCodeUnit !== rightCodeUnit) return leftCodeUnit - rightCodeUnit;
  }
  return left.length - right.length;
}

function malformedArtifactReason(artifact: unknown): string | null {
  if (!isRecord(artifact)) return 'catalogue artifact is malformed';
  if (artifact.schemaVersion !== CATALOGUE_ARTIFACT_SCHEMA_VERSION)
    return 'catalogue artifact schema mismatch';
  if (!isRecord(artifact.manifest)) return 'catalogue manifest is malformed';
  if (!isRecord(artifact.integrity)) return 'catalogue integrity metadata is malformed';
  if (!Array.isArray(artifact.entries) || !Array.isArray(artifact.sourceSet))
    return 'catalogue artifact collections are malformed';
  if (artifact.signature !== null && !isRecord(artifact.signature))
    return 'catalogue signature is malformed';

  const manifest = artifact.manifest;
  if (manifest.version !== CATALOGUE_VERSION || manifest.schemaVersion !== CATALOGUE_SCHEMA_VERSION)
    return 'catalogue version mismatch';
  if (manifest.status !== 'review-pending' && manifest.status !== 'approved')
    return 'catalogue manifest status is malformed';
  if (typeof manifest.signatureRequired !== 'boolean')
    return 'catalogue manifest signature policy is malformed';

  if (artifact.integrity.algorithm !== 'SHA-256' || typeof artifact.integrity.digest !== 'string')
    return 'catalogue integrity metadata is malformed';
  if (!/^[a-f0-9]{64}$/.test(artifact.integrity.digest))
    return 'catalogue integrity digest is malformed';

  if (artifact.signature !== null) {
    const signature = artifact.signature;
    if (
      typeof signature.keyId !== 'string' ||
      signature.keyId.trim().length === 0 ||
      (signature.algorithm !== 'Ed25519' && signature.algorithm !== 'ECDSA-P256-SHA256') ||
      typeof signature.value !== 'string' ||
      signature.value.length === 0
    )
      return 'catalogue signature is malformed';
  }
  return null;
}

function normalizeArtifactParts(
  entries: readonly BiomarkerCatalogueEntry[],
  sourceSet: readonly CatalogueSource[],
): {
  readonly entries: readonly BiomarkerCatalogueEntry[];
  readonly sourceSet: readonly CatalogueSource[];
} {
  // The content arrays are sets at the artifact boundary. Sorting them here means source-module
  // import order cannot affect emitted bytes, signatures, or the generated consumer module.
  return {
    entries: [...entries].sort((left, right) => compareCodeUnits(left.id, right.id)),
    sourceSet: [...sourceSet].sort((left, right) => compareCodeUnits(left.id, right.id)),
  };
}

function validateArtifactSourceReferences(
  entries: readonly BiomarkerCatalogueEntry[],
  sourceSet: readonly CatalogueSource[],
): string | null {
  const sourceIds = new Set<string>();
  const sourceById = new Map<string, CatalogueSource>();
  for (const source of sourceSet) {
    if (
      typeof source.id !== 'string' ||
      typeof source.title !== 'string' ||
      typeof source.publisher !== 'string' ||
      typeof source.url !== 'string' ||
      !/^https?:\/\//.test(source.url) ||
      typeof source.accessedAt !== 'string' ||
      (source.publicationDate !== null && typeof source.publicationDate !== 'string') ||
      !['public-health-authority', 'professional-guideline', 'reference'].includes(
        source.sourceKind,
      )
    ) {
      return 'catalogue source set is malformed';
    }
    if (sourceIds.has(source.id)) return `catalogue source is duplicated: ${source.id}`;
    sourceIds.add(source.id);
    sourceById.set(source.id, source);
  }
  for (const entry of entries) {
    for (const source of entry.sources ?? []) {
      if (!sourceIds.has(source.id)) return `catalogue source is missing: ${source.id}`;
      if (canonicalJson(source) !== canonicalJson(sourceById.get(source.id)))
        return `catalogue source metadata disagrees for ${source.id}`;
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

function validateArtifactContent(
  artifact: unknown,
):
  | { readonly ok: true; readonly artifact: CatalogueArtifact; readonly payload: string }
  | { readonly ok: false; readonly reason: string } {
  const malformed = malformedArtifactReason(artifact);
  if (malformed !== null) return { ok: false, reason: malformed };
  const candidate = artifact as CatalogueArtifact;

  let issues: readonly CatalogueValidationIssue[];
  try {
    issues = validateCatalogueRelease(candidate.entries, candidate.manifest);
  } catch {
    return { ok: false, reason: 'catalogue validation: malformed entry' };
  }
  if (issues.length > 0)
    return { ok: false, reason: `catalogue validation: ${issues[0]!.message}` };
  let localReferenceIssue: string | null;
  try {
    localReferenceIssue = validateArtifactSourceReferences(candidate.entries, candidate.sourceSet);
  } catch {
    return { ok: false, reason: 'catalogue source set is malformed' };
  }
  if (localReferenceIssue !== null) return { ok: false, reason: localReferenceIssue };

  try {
    return { ok: true, artifact: candidate, payload: canonicalCataloguePayload(candidate) };
  } catch {
    return { ok: false, reason: 'catalogue artifact cannot be canonically serialized' };
  }
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
  const releaseIssues = validateCatalogueRelease(entries, manifest);
  if (releaseIssues.length > 0) {
    throw new Error(
      `Catalogue release validation failed: ${releaseIssues[0]!.path}: ${releaseIssues[0]!.message}`,
    );
  }
  const normalized = normalizeArtifactParts(entries, sourceSet);
  const payload = canonicalCataloguePayload({
    schemaVersion: CATALOGUE_ARTIFACT_SCHEMA_VERSION,
    manifest,
    entries: normalized.entries,
    sourceSet: normalized.sourceSet,
  });
  return {
    schemaVersion: CATALOGUE_ARTIFACT_SCHEMA_VERSION,
    manifest,
    entries: normalized.entries,
    sourceSet: normalized.sourceSet,
    integrity: { algorithm: 'SHA-256', digest: await sha256Hex(payload) },
    signature: null,
  };
}

export async function signCatalogueArtifact(
  artifact: CatalogueArtifact,
  signingKey: CataloguePrivateSigningKey,
): Promise<CatalogueArtifact> {
  const content = validateArtifactContent(artifact);
  if (!content.ok) throw new Error(`Cannot sign catalogue: ${content.reason}`);
  if ((await sha256Hex(content.payload)) !== artifact.integrity.digest)
    throw new Error('Cannot sign catalogue: integrity mismatch');
  if (artifact.signature !== null)
    throw new Error('Cannot sign an already-signed catalogue artifact');
  if (signingKey.keyId.trim().length === 0) throw new Error('Catalogue signing key ID is required');
  const subtle = getCryptoSubtle();
  if (subtle === null) throw new Error('Web Crypto signing is unavailable');

  const algorithm = signingAlgorithm(signingKey.algorithm);
  const key = await subtle.importKey('jwk', signingKey.privateKeyJwk, algorithm, false, ['sign']);
  const signature = await subtle.sign(
    signatureAlgorithmForWebCrypto(signingKey.algorithm),
    key,
    new TextEncoder().encode(content.payload),
  );
  return {
    ...artifact,
    signature: {
      keyId: signingKey.keyId,
      algorithm: signingKey.algorithm,
      value: bytesToBase64(new Uint8Array(signature)),
    },
  };
}

export async function validateCatalogueArtifact(
  artifact: CatalogueArtifact,
  options: CatalogueVerificationOptions = {},
): Promise<CatalogueArtifactVerification> {
  const content = validateArtifactContent(artifact);
  if (!content.ok) return { ok: false, reason: content.reason };
  try {
    if ((await sha256Hex(content.payload)) !== content.artifact.integrity.digest)
      return { ok: false, reason: 'catalogue integrity mismatch' };
  } catch {
    return { ok: false, reason: 'Web Crypto SHA-256 is unavailable' };
  }

  const expectedVersion = options.expectedVersion ?? CATALOGUE_VERSION;
  if (content.artifact.manifest.version !== expectedVersion)
    return { ok: false, reason: 'catalogue version is not the expected release' };
  if (options.minimumVersion !== undefined) {
    const comparison = compareSemver(content.artifact.manifest.version, options.minimumVersion);
    if (!Number.isFinite(comparison) || comparison < 0)
      return { ok: false, reason: 'catalogue version is stale' };
  }

  const environment = options.environment ?? 'test';
  const releaseBoundary = environment === 'production' || environment === 'release';
  const requireSignature = options.requireSignature === true || releaseBoundary;
  const requirePublicationApproval = options.requirePublicationApproval === true || releaseBoundary;
  if (requirePublicationApproval && content.artifact.manifest.status !== 'approved') {
    return { ok: false, reason: 'catalogue publication review is still pending' };
  }

  const signature = content.artifact.signature;
  if (signature === null) {
    if (requireSignature || content.artifact.manifest.signatureRequired) {
      return { ok: false, reason: 'catalogue signature required' };
    }
    return { ok: true, signed: false };
  }
  const subtle = getCryptoSubtle();
  if (subtle === null)
    return { ok: false, reason: 'Web Crypto signature verification unavailable' };
  const trustedKey = findTrustedKey(signature, options.trustedKeys);
  if (trustedKey === undefined)
    return { ok: false, reason: 'catalogue signing key is not trusted' };
  if (trustedKey.algorithm !== signature.algorithm) {
    return { ok: false, reason: 'catalogue signing algorithm does not match trusted key' };
  }
  try {
    const key = await subtle.importKey(
      'jwk',
      trustedKey.publicKeyJwk,
      signingAlgorithm(signature.algorithm),
      false,
      ['verify'],
    );
    const verified = await subtle.verify(
      signatureAlgorithmForWebCrypto(signature.algorithm),
      key,
      base64ToBytes(signature.value),
      new TextEncoder().encode(content.payload),
    );
    return verified
      ? { ok: true, signed: true }
      : { ok: false, reason: 'catalogue signature mismatch' };
  } catch {
    return { ok: false, reason: 'catalogue signature is malformed' };
  }
}

function findTrustedKey(
  signature: CatalogueSignature,
  trustedKeys: readonly CatalogueTrustedKey[] | undefined,
): CatalogueTrustedKey | undefined {
  return trustedKeys?.find((candidate) => candidate.keyId === signature.keyId);
}

/** Explicit application boundary: development/test may use pending unsigned bundled content. */
export async function verifyCatalogueForConsumption(
  artifact: CatalogueArtifact,
  options: CatalogueConsumptionOptions = {},
): Promise<CatalogueConsumptionResult> {
  const environment: CatalogueEnvironment = options.environment ?? 'development';
  const verification = await validateCatalogueArtifact(artifact, {
    ...options,
    environment,
    requireSignature: environment === 'production' || environment === 'release',
    requirePublicationApproval: environment === 'production' || environment === 'release',
  });
  return verification.ok ? { ok: true, signed: verification.signed, artifact } : verification;
}

export const verifyCatalogueArtifact = validateCatalogueArtifact;

function deriveSourceSet(entries: readonly BiomarkerCatalogueEntry[]): readonly CatalogueSource[] {
  const sources = entries.flatMap((entry) => entry.sources ?? []);
  return [...new Map(sources.map((source) => [source.id, source])).values()].sort((a, b) =>
    compareCodeUnits(a.id, b.id),
  );
}

/** The artifact boundary owns the stable launch IDs; source modules remain build inputs only. */
export const REQUIRED_CATALOGUE_IDS = ALL_COMPARABLE_BIOMARKER_IDS;
