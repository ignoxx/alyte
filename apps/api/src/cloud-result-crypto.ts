import {
  CLOUD_RESULT_ENVELOPE_AUTHENTICATION_TAG_BYTES,
  CLOUD_RESULT_ENVELOPE_CIPHER,
  CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES,
  CLOUD_RESULT_ENVELOPE_KDF,
  CLOUD_RESULT_ENVELOPE_KEY_AGREEMENT,
  CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES,
  CLOUD_RESULT_ENVELOPE_MAX_CONTEXT_TEXT_LENGTH,
  CLOUD_RESULT_ENVELOPE_NONCE_BYTES,
  CLOUD_RESULT_ENVELOPE_SALT_BYTES,
  CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION,
  decodeCloudResultEnvelope,
  serializeCloudResultEnvelopeAssociatedData,
  type CloudResultEnvelope,
  type CloudResultEnvelopeContext,
} from '@alyte/contracts';
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import type { JsonWebKeyInput, KeyObject } from 'node:crypto';

const PRIVATE_KEY_BYTES = 32;
const PUBLIC_COORDINATE_BYTES = 32;
const RAW_P256_PUBLIC_KEY_PREFIX = 0x04;
const HKDF_INFO_PREFIX = Buffer.from('alyte/cloud-result-envelope/v1\0', 'utf8');
const AES_256_GCM = 'aes-256-gcm' as const;

export type CloudResultCryptoErrorCode =
  | 'cloud_result_envelope_invalid'
  | 'cloud_result_context_invalid'
  | 'cloud_result_context_mismatch'
  | 'cloud_result_key_invalid'
  | 'cloud_result_plaintext_too_large'
  | 'cloud_result_encryption_failed'
  | 'cloud_result_decryption_failed';

/** Bounded errors deliberately omit key material, plaintext, ciphertext, and parser details. */
export class CloudResultCryptoFailure extends Error {
  constructor(readonly code: CloudResultCryptoErrorCode) {
    super(code);
    this.name = 'CloudResultCryptoFailure';
  }
}

export interface CloudResultEncryptionInput extends CloudResultEnvelopeContext {
  readonly devicePublicKeyJwk: unknown;
  readonly plaintext: Uint8Array;
}

/**
 * This seam is intentionally separate from production encryption. It exists only for committed
 * interoperability vectors and is never populated from a request or environment value.
 */
export interface CloudResultDeterministicMaterial {
  readonly ephemeralPrivateKeyJwk: unknown;
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
}

const PUBLIC_JWK_KEYS = ['crv', 'kty', 'x', 'y'] as const;
const PRIVATE_JWK_KEYS = ['crv', 'd', 'kty', 'x', 'y'] as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isCanonicalBase64url(value: unknown, expectedBytes: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== Math.ceil((expectedBytes * 8) / 6) ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
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
  return !((remainder === 2 && (last & 0x0f) !== 0) || (remainder === 3 && (last & 0x03) !== 0));
}

function decodeBase64url(value: unknown, expectedBytes: number): Buffer {
  if (!isCanonicalBase64url(value, expectedBytes)) {
    throw new CloudResultCryptoFailure('cloud_result_key_invalid');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new CloudResultCryptoFailure('cloud_result_key_invalid');
  }
  return decoded;
}

function parseDevicePublicKey(value: unknown): { key: KeyObject; raw: Buffer } {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, PUBLIC_JWK_KEYS) ||
    value.kty !== 'EC' ||
    value.crv !== 'P-256'
  ) {
    throw new CloudResultCryptoFailure('cloud_result_key_invalid');
  }
  const x = decodeBase64url(value.x, PUBLIC_COORDINATE_BYTES);
  const y = decodeBase64url(value.y, PUBLIC_COORDINATE_BYTES);
  try {
    const key = createPublicKey({
      key: value as unknown as JsonWebKeyInput['key'],
      format: 'jwk',
    });
    return { key, raw: Buffer.concat([Buffer.from([RAW_P256_PUBLIC_KEY_PREFIX]), x, y]) };
  } catch {
    throw new CloudResultCryptoFailure('cloud_result_key_invalid');
  }
}

function parsePrivateKey(value: unknown): KeyObject {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, PRIVATE_JWK_KEYS) ||
    value.kty !== 'EC' ||
    value.crv !== 'P-256'
  ) {
    throw new CloudResultCryptoFailure('cloud_result_key_invalid');
  }
  decodeBase64url(value.x, PUBLIC_COORDINATE_BYTES);
  decodeBase64url(value.y, PUBLIC_COORDINATE_BYTES);
  decodeBase64url(value.d, PRIVATE_KEY_BYTES);
  try {
    const key = createPrivateKey({
      key: value as unknown as JsonWebKeyInput['key'],
      format: 'jwk',
    });
    if (key.asymmetricKeyType !== 'ec') {
      throw new Error('wrong_key_type');
    }
    const exported = key.export({ format: 'jwk' }) as { crv?: unknown; kty?: unknown };
    if (exported.kty !== 'EC' || exported.crv !== 'P-256') {
      throw new Error('wrong_curve');
    }
    return key;
  } catch {
    throw new CloudResultCryptoFailure('cloud_result_key_invalid');
  }
}

function publicRawFromPrivateKey(key: KeyObject): Buffer {
  try {
    const publicJwk = createPublicKey(key).export({ format: 'jwk' }) as {
      x?: unknown;
      y?: unknown;
    };
    const x = decodeBase64url(publicJwk.x, PUBLIC_COORDINATE_BYTES);
    const y = decodeBase64url(publicJwk.y, PUBLIC_COORDINATE_BYTES);
    return Buffer.concat([Buffer.from([RAW_P256_PUBLIC_KEY_PREFIX]), x, y]);
  } catch (error) {
    if (error instanceof CloudResultCryptoFailure) throw error;
    throw new CloudResultCryptoFailure('cloud_result_key_invalid');
  }
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new CloudResultCryptoFailure('cloud_result_envelope_invalid');
  }
  try {
    return createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
  } catch {
    throw new CloudResultCryptoFailure('cloud_result_envelope_invalid');
  }
}

function associatedData(context: CloudResultEnvelopeContext): Buffer {
  try {
    return Buffer.from(serializeCloudResultEnvelopeAssociatedData(context), 'utf8');
  } catch {
    throw new CloudResultCryptoFailure('cloud_result_context_invalid');
  }
}

function validateContext(context: CloudResultEnvelopeContext): void {
  if (
    typeof context.requestId !== 'string' ||
    context.requestId.length === 0 ||
    context.requestId.length > CLOUD_RESULT_ENVELOPE_MAX_CONTEXT_TEXT_LENGTH ||
    !REQUEST_ID_PATTERN.test(context.requestId) ||
    typeof context.contractVersion !== 'string' ||
    context.contractVersion.length === 0 ||
    context.contractVersion.length > CLOUD_RESULT_ENVELOPE_MAX_CONTEXT_TEXT_LENGTH ||
    !VERSION_PATTERN.test(context.contractVersion) ||
    typeof context.resultSchemaVersion !== 'string' ||
    context.resultSchemaVersion.length === 0 ||
    context.resultSchemaVersion.length > CLOUD_RESULT_ENVELOPE_MAX_CONTEXT_TEXT_LENGTH ||
    !VERSION_PATTERN.test(context.resultSchemaVersion) ||
    !Number.isSafeInteger(context.handlerVersion) ||
    context.handlerVersion < 1 ||
    context.handlerVersion > 1_000
  ) {
    throw new CloudResultCryptoFailure('cloud_result_context_invalid');
  }
}

function exactBytes(
  value: Uint8Array,
  expectedBytes: number,
  errorCode: CloudResultCryptoErrorCode,
): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedBytes) {
    throw new CloudResultCryptoFailure(errorCode);
  }
  return Buffer.from(value);
}

function validatePlaintext(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    throw new CloudResultCryptoFailure('cloud_result_plaintext_too_large');
  }
  if (value.byteLength > CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES) {
    throw new CloudResultCryptoFailure('cloud_result_plaintext_too_large');
  }
  return Buffer.from(value);
}

function hkdfKey(sharedSecret: Buffer, salt: Buffer, aad: Buffer): Buffer {
  const info = Buffer.concat([HKDF_INFO_PREFIX, aad]);
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, info, 32));
}

function encryptWithMaterial(
  input: CloudResultEncryptionInput,
  material: CloudResultDeterministicMaterial,
): CloudResultEnvelope {
  validateContext(input);
  const aad = associatedData(input);
  const plaintext = validatePlaintext(input.plaintext);
  const devicePublicKey = parseDevicePublicKey(input.devicePublicKeyJwk);
  const ephemeralPrivateKey = parsePrivateKey(material.ephemeralPrivateKeyJwk);
  const salt = exactBytes(
    material.salt,
    CLOUD_RESULT_ENVELOPE_SALT_BYTES,
    'cloud_result_encryption_failed',
  );
  const nonce = exactBytes(
    material.nonce,
    CLOUD_RESULT_ENVELOPE_NONCE_BYTES,
    'cloud_result_encryption_failed',
  );
  let sharedSecret: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    sharedSecret = Buffer.from(
      diffieHellman({ privateKey: ephemeralPrivateKey, publicKey: devicePublicKey.key }),
    );
    key = hkdfKey(sharedSecret, salt, aad);
    const cipher = createCipheriv(AES_256_GCM, key, nonce, {
      authTagLength: CLOUD_RESULT_ENVELOPE_AUTHENTICATION_TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    if (ciphertext.length < 1 || ciphertext.length > CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES) {
      throw new CloudResultCryptoFailure('cloud_result_plaintext_too_large');
    }
    return Object.freeze({
      schemaVersion: CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION,
      keyAgreement: CLOUD_RESULT_ENVELOPE_KEY_AGREEMENT,
      kdf: CLOUD_RESULT_ENVELOPE_KDF,
      cipher: CLOUD_RESULT_ENVELOPE_CIPHER,
      requestId: input.requestId,
      contractVersion: input.contractVersion,
      resultSchemaVersion: input.resultSchemaVersion,
      handlerVersion: input.handlerVersion,
      ephemeralPublicKey: publicRawFromPrivateKey(ephemeralPrivateKey).toString('base64url'),
      salt: salt.toString('base64url'),
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      authenticationTag: authenticationTag.toString('base64url'),
    });
  } catch (error) {
    if (error instanceof CloudResultCryptoFailure) throw error;
    throw new CloudResultCryptoFailure('cloud_result_encryption_failed');
  } finally {
    plaintext.fill(0);
    sharedSecret?.fill(0);
    key?.fill(0);
  }
}

/** Encrypt using a new ephemeral key, fresh salt, and fresh nonce for every result. */
export function encryptCloudResult(input: CloudResultEncryptionInput): CloudResultEnvelope {
  const ephemeral = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ephemeralPrivateKeyJwk = ephemeral.privateKey.export({ format: 'jwk' });
  return encryptWithMaterial(input, {
    ephemeralPrivateKeyJwk,
    salt: randomBytes(CLOUD_RESULT_ENVELOPE_SALT_BYTES),
    nonce: randomBytes(CLOUD_RESULT_ENVELOPE_NONCE_BYTES),
  });
}

/** @internal Test-only deterministic seam for committed cross-language vectors. */
export function encryptCloudResultForTesting(
  input: CloudResultEncryptionInput,
  material: CloudResultDeterministicMaterial,
): CloudResultEnvelope {
  return encryptWithMaterial(input, material);
}

export interface CloudResultReferenceDecryptionInput {
  readonly envelope: unknown;
  readonly devicePrivateKeyJwk: unknown;
  readonly context: CloudResultEnvelopeContext;
}

/**
 * Reference/test decryption only. Production result retrieval will hand this envelope to the
 * device CryptoKit module; the backend does not expose a decryption route.
 */
export function decryptCloudResultForReference(
  input: CloudResultReferenceDecryptionInput,
): Uint8Array {
  let envelope: CloudResultEnvelope;
  try {
    envelope = decodeCloudResultEnvelope(input.envelope);
  } catch {
    throw new CloudResultCryptoFailure('cloud_result_envelope_invalid');
  }
  validateContext(input.context);
  if (
    envelope.requestId !== input.context.requestId ||
    envelope.contractVersion !== input.context.contractVersion ||
    envelope.resultSchemaVersion !== input.context.resultSchemaVersion ||
    envelope.handlerVersion !== input.context.handlerVersion
  ) {
    throw new CloudResultCryptoFailure('cloud_result_context_mismatch');
  }
  const privateKey = parsePrivateKey(input.devicePrivateKeyJwk);
  const aad = associatedData(input.context);
  const ephemeralPublicKey = publicKeyFromRaw(
    Buffer.from(envelope.ephemeralPublicKey, 'base64url'),
  );
  const salt = Buffer.from(envelope.salt, 'base64url');
  const nonce = Buffer.from(envelope.nonce, 'base64url');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
  const authenticationTag = Buffer.from(envelope.authenticationTag, 'base64url');
  let sharedSecret: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    sharedSecret = Buffer.from(diffieHellman({ privateKey, publicKey: ephemeralPublicKey }));
    key = hkdfKey(sharedSecret, salt, aad);
    const decipher = createDecipheriv(AES_256_GCM, key, nonce, {
      authTagLength: CLOUD_RESULT_ENVELOPE_AUTHENTICATION_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(authenticationTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length < 1 || plaintext.length > CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES) {
      throw new CloudResultCryptoFailure('cloud_result_plaintext_too_large');
    }
    return Uint8Array.from(plaintext);
  } catch (error) {
    if (error instanceof CloudResultCryptoFailure) throw error;
    throw new CloudResultCryptoFailure('cloud_result_decryption_failed');
  } finally {
    sharedSecret?.fill(0);
    key?.fill(0);
  }
}
