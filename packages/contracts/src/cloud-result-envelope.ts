/**
 * The one device-encrypted result format shared by the backend reference adapter and a future
 * CryptoKit implementation. The envelope contains ciphertext and cryptographic metadata only;
 * result plaintext is never part of this contract.
 *
 * Key agreement uses an uncompressed SEC1 P-256 point (0x04 || X || Y), encoded as unpadded
 * base64url. ECDH produces the shared secret directly. HKDF uses SHA-256, a fresh 32-byte salt,
 * and UTF-8 info equal to `alyte/cloud-result-envelope/v1\0` followed by the canonical AAD.
 * AES-256-GCM uses a fresh 12-byte nonce and a separate 16-byte authentication tag. AAD is the
 * canonical UTF-8 JSON object containing only schemaVersion, requestId, contractVersion,
 * resultSchemaVersion, and handlerVersion, in that order.
 *
 * The serialized envelope uses the field order in `serializeCloudResultEnvelope`. JSON is an
 * interchange encoding; consumers must still decode and validate every field before use.
 */

export const CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION = 'alyte.cloud-result-envelope.v1' as const;
export const CLOUD_RESULT_ENVELOPE_KEY_AGREEMENT = 'P-256-ECDH' as const;
export const CLOUD_RESULT_ENVELOPE_KDF = 'HKDF-SHA-256' as const;
export const CLOUD_RESULT_ENVELOPE_CIPHER = 'AES-256-GCM' as const;

export const CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES = 65;
export const CLOUD_RESULT_ENVELOPE_SALT_BYTES = 32;
export const CLOUD_RESULT_ENVELOPE_NONCE_BYTES = 12;
export const CLOUD_RESULT_ENVELOPE_AUTHENTICATION_TAG_BYTES = 16;
/** Cloud results are bounded before encryption and after decryption. */
export const CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES = 256 * 1024;
export const CLOUD_RESULT_ENVELOPE_MAX_CONTEXT_TEXT_LENGTH = 128;

export interface CloudResultEnvelope {
  readonly schemaVersion: typeof CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION;
  readonly keyAgreement: typeof CLOUD_RESULT_ENVELOPE_KEY_AGREEMENT;
  readonly kdf: typeof CLOUD_RESULT_ENVELOPE_KDF;
  readonly cipher: typeof CLOUD_RESULT_ENVELOPE_CIPHER;
  readonly requestId: string;
  readonly contractVersion: string;
  readonly resultSchemaVersion: string;
  readonly handlerVersion: number;
  /** Uncompressed SEC1 P-256 public point, encoded as unpadded base64url. */
  readonly ephemeralPublicKey: string;
  readonly salt: string;
  /** 96-bit AES-GCM nonce, encoded as unpadded base64url. */
  readonly nonce: string;
  readonly ciphertext: string;
  /** AES-GCM authentication tag is transported separately from ciphertext. */
  readonly authenticationTag: string;
}

export class CloudResultEnvelopeError extends Error {
  readonly code = 'cloud_result_envelope_invalid' as const;

  constructor() {
    super('cloud_result_envelope_invalid');
    this.name = 'CloudResultEnvelopeError';
  }
}

const ENVELOPE_KEYS = [
  'authenticationTag',
  'cipher',
  'ciphertext',
  'contractVersion',
  'ephemeralPublicKey',
  'handlerVersion',
  'kdf',
  'keyAgreement',
  'nonce',
  'requestId',
  'resultSchemaVersion',
  'salt',
  'schemaVersion',
] as const;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...ENVELOPE_KEYS].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CLOUD_RESULT_ENVELOPE_MAX_CONTEXT_TEXT_LENGTH &&
    VERSION_PATTERN.test(value)
  );
}

function isCanonicalBase64url(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || !BASE64URL_PATTERN.test(value)) {
    return false;
  }
  if (value.length % 4 === 1) return false;
  if (expectedBytes !== undefined && value.length !== Math.ceil((expectedBytes * 8) / 6)) {
    return false;
  }
  const remainder = value.length % 4;
  const lastCharacter = value.charCodeAt(value.length - 1);
  const last =
    lastCharacter >= 0x41 && lastCharacter <= 0x5a
      ? lastCharacter - 0x41
      : lastCharacter >= 0x61 && lastCharacter <= 0x7a
        ? lastCharacter - 0x61 + 26
        : lastCharacter >= 0x30 && lastCharacter <= 0x39
          ? lastCharacter - 0x30 + 52
          : lastCharacter === 0x2d
            ? 62
            : 63;
  // Unpadded base64url has zero unused bits in its final sextet.
  if (remainder === 2 && (last & 0x0f) !== 0) return false;
  if (remainder === 3 && (last & 0x03) !== 0) return false;
  return true;
}

function base64urlSextet(character: number): number {
  if (character >= 0x41 && character <= 0x5a) return character - 0x41;
  if (character >= 0x61 && character <= 0x7a) return character - 0x61 + 26;
  if (character >= 0x30 && character <= 0x39) return character - 0x30 + 52;
  return character === 0x2d ? 62 : 63;
}

function startsWithUncompressedP256Point(value: string): boolean {
  return (
    ((base64urlSextet(value.charCodeAt(0)) << 2) | (base64urlSextet(value.charCodeAt(1)) >> 4)) ===
    4
  );
}

function hasDuplicateJsonObjectKeys(value: string): boolean {
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index);
    if (character === 0x22) {
      const start = index;
      index += 1;
      for (; index < value.length; index += 1) {
        if (value.charCodeAt(index) === 0x5c) {
          index += 1;
        } else if (value.charCodeAt(index) === 0x22) {
          break;
        }
      }
      let next = index + 1;
      while (next < value.length && /\s/.test(value[next] ?? '')) next += 1;
      const objectKeys = stack.at(-1);
      if (objectKeys !== null && objectKeys !== undefined && value[next] === ':') {
        let key: string;
        try {
          key = JSON.parse(value.slice(start, index + 1)) as string;
        } catch {
          continue;
        }
        if (objectKeys.has(key)) return true;
        objectKeys.add(key);
      }
      continue;
    }
    if (character === 0x7b) stack.push(new Set<string>());
    else if (character === 0x5b) stack.push(null);
    else if (character === 0x7d || character === 0x5d) stack.pop();
  }
  return false;
}

function base64urlByteLength(value: string): number {
  return Math.floor((value.length * 6) / 8);
}

function isRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CLOUD_RESULT_ENVELOPE_MAX_CONTEXT_TEXT_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

function invalid(): never {
  throw new CloudResultEnvelopeError();
}

/** Decode and strictly validate the object form of a v1 Cloud Result Envelope. */
export function decodeCloudResultEnvelope(value: unknown): CloudResultEnvelope {
  if (!isRecord(value) || !hasExactlyKeys(value)) invalid();
  if (
    value.schemaVersion !== CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION ||
    value.keyAgreement !== CLOUD_RESULT_ENVELOPE_KEY_AGREEMENT ||
    value.kdf !== CLOUD_RESULT_ENVELOPE_KDF ||
    value.cipher !== CLOUD_RESULT_ENVELOPE_CIPHER ||
    !isRequestId(value.requestId) ||
    !isBoundedVersion(value.contractVersion) ||
    !isBoundedVersion(value.resultSchemaVersion) ||
    typeof value.handlerVersion !== 'number' ||
    !Number.isSafeInteger(value.handlerVersion) ||
    value.handlerVersion < 1 ||
    value.handlerVersion > 1_000 ||
    !isCanonicalBase64url(
      value.ephemeralPublicKey,
      CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES,
    ) ||
    !startsWithUncompressedP256Point(value.ephemeralPublicKey) ||
    !isCanonicalBase64url(value.salt, CLOUD_RESULT_ENVELOPE_SALT_BYTES) ||
    !isCanonicalBase64url(value.nonce, CLOUD_RESULT_ENVELOPE_NONCE_BYTES) ||
    !isCanonicalBase64url(
      value.authenticationTag,
      CLOUD_RESULT_ENVELOPE_AUTHENTICATION_TAG_BYTES,
    ) ||
    !isCanonicalBase64url(value.ciphertext) ||
    base64urlByteLength(value.ciphertext) < 1 ||
    base64urlByteLength(value.ciphertext) > CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES
  ) {
    invalid();
  }
  return Object.freeze({
    schemaVersion: CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION,
    keyAgreement: CLOUD_RESULT_ENVELOPE_KEY_AGREEMENT,
    kdf: CLOUD_RESULT_ENVELOPE_KDF,
    cipher: CLOUD_RESULT_ENVELOPE_CIPHER,
    requestId: value.requestId,
    contractVersion: value.contractVersion,
    resultSchemaVersion: value.resultSchemaVersion,
    handlerVersion: value.handlerVersion,
    ephemeralPublicKey: value.ephemeralPublicKey,
    salt: value.salt,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    authenticationTag: value.authenticationTag,
  });
}

/** Decode a serialized envelope without accepting unknown fields or unsupported encodings. */
export function decodeCloudResultEnvelopeJson(value: string): CloudResultEnvelope {
  if (typeof value !== 'string' || value.length > 2_000_000) invalid();
  if (hasDuplicateJsonObjectKeys(value)) invalid();
  try {
    return decodeCloudResultEnvelope(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof CloudResultEnvelopeError) throw error;
    invalid();
  }
}

/** Serialize with the canonical field order used by deterministic interoperability vectors. */
export function serializeCloudResultEnvelope(value: CloudResultEnvelope): string {
  const envelope = decodeCloudResultEnvelope(value);
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    keyAgreement: envelope.keyAgreement,
    kdf: envelope.kdf,
    cipher: envelope.cipher,
    requestId: envelope.requestId,
    contractVersion: envelope.contractVersion,
    resultSchemaVersion: envelope.resultSchemaVersion,
    handlerVersion: envelope.handlerVersion,
    ephemeralPublicKey: envelope.ephemeralPublicKey,
    salt: envelope.salt,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    authenticationTag: envelope.authenticationTag,
  });
}

export interface CloudResultEnvelopeContext {
  readonly requestId: string;
  readonly contractVersion: string;
  readonly resultSchemaVersion: string;
  readonly handlerVersion: number;
}

/**
 * Return the canonical AAD fields. The backend and iOS must UTF-8 encode the returned JSON
 * exactly; algorithm fields are already fixed by schemaVersion and are not duplicated here.
 */
export function serializeCloudResultEnvelopeAssociatedData(
  context: CloudResultEnvelopeContext,
): string {
  if (
    !isRequestId(context.requestId) ||
    !isBoundedVersion(context.contractVersion) ||
    !isBoundedVersion(context.resultSchemaVersion) ||
    !Number.isSafeInteger(context.handlerVersion) ||
    context.handlerVersion < 1 ||
    context.handlerVersion > 1_000
  ) {
    invalid();
  }
  return JSON.stringify({
    schemaVersion: CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION,
    requestId: context.requestId,
    contractVersion: context.contractVersion,
    resultSchemaVersion: context.resultSchemaVersion,
    handlerVersion: context.handlerVersion,
  });
}
