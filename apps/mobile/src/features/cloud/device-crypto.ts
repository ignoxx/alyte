import {
  CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES,
  decodeCloudResultEnvelope,
  serializeCloudResultEnvelope,
  serializeCloudResultEnvelopeAssociatedData,
  type CloudResultEnvelopeContext,
  type P256PublicKeyJwk,
} from '@alyte/contracts';

export type DeviceCryptoFailureCode =
  | 'cloud_result_envelope_invalid'
  | 'cloud_result_context_invalid'
  | 'cloud_result_context_mismatch'
  | 'cloud_result_key_invalid'
  | 'cloud_result_plaintext_too_large'
  | 'cloud_result_decryption_failed'
  | 'device_crypto_keychain_failure'
  | 'device_crypto_native_unavailable'
  | 'device_crypto_native_failure';

/** Closed, non-sensitive error surface for the device-result boundary. */
export class DeviceCryptoError extends Error {
  override readonly name = 'DeviceCryptoError';

  constructor(readonly code: DeviceCryptoFailureCode) {
    super(code);
  }
}

export type NativeDeviceCryptoModule = {
  readonly getDevicePublicKeyJwk: () => unknown | Promise<unknown>;
  readonly decryptCloudResult: (
    envelopeJSON: string,
    requestId: string,
    contractVersion: string,
    resultSchemaVersion: string,
    handlerVersion: number,
  ) => unknown | Promise<unknown>;
};

export type DeviceCrypto = {
  /** Returns only the canonical public P-256 JWK; private key material stays native. */
  readonly getPublicKeyJwk: () => Promise<P256PublicKeyJwk>;
  /** Decrypts and authenticates an envelope, returning transient plaintext bytes. */
  readonly decrypt: (envelope: unknown, context: CloudResultEnvelopeContext) => Promise<Uint8Array>;
};

export type DeviceCryptoOptions = {
  /** Injected native bridge (or null to exercise the unavailable path) for tests. */
  readonly native?: NativeDeviceCryptoModule | null;
  /** Allows a test or development client to resolve a bridge after service construction. */
  readonly resolveNative?: () => NativeDeviceCryptoModule | null;
};

const PUBLIC_JWK_KEYS = ['crv', 'kty', 'x', 'y'] as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
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

const P256_PRIME = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_A = P256_PRIME - 3n;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function base64urlSextet(character: number): number {
  if (character >= 0x41 && character <= 0x5a) return character - 0x41;
  if (character >= 0x61 && character <= 0x7a) return character - 0x61 + 26;
  if (character >= 0x30 && character <= 0x39) return character - 0x30 + 52;
  return character === 0x2d ? 62 : 63;
}

function decodeCanonicalBase64url(value: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    accumulator = ((accumulator << 6) | base64urlSextet(character.charCodeAt(0))) & 0x3fff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (accumulator >> bits) & 0xff;
      offset += 1;
      accumulator &= (1 << bits) - 1;
    }
  }
  return bytes;
}

function bytesToBigInt(value: Uint8Array): bigint {
  let result = 0n;
  for (const byte of value) result = (result << 8n) | BigInt(byte);
  return result;
}

function positiveMod(value: bigint, modulus: bigint): bigint {
  const remainder = value % modulus;
  return remainder >= 0n ? remainder : remainder + modulus;
}

function isP256PointCoordinates(xValue: string, yValue: string): boolean {
  const xBytes = decodeCanonicalBase64url(xValue);
  const yBytes = decodeCanonicalBase64url(yValue);
  const x = bytesToBigInt(xBytes);
  const y = bytesToBigInt(yBytes);
  if (x >= P256_PRIME || y >= P256_PRIME) return false;
  return (
    positiveMod(y * y, P256_PRIME) === positiveMod(x * x * x + P256_A * x + P256_B, P256_PRIME)
  );
}

function plaintextBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new DeviceCryptoError('device_crypto_native_failure');
  }
  if (value.byteLength < 1 || value.byteLength > CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES) {
    throw new DeviceCryptoError('cloud_result_plaintext_too_large');
  }
  return value;
}

function publicKey(value: unknown): P256PublicKeyJwk {
  if (!isRecord(value) || !hasExactlyKeys(value, PUBLIC_JWK_KEYS)) {
    throw new DeviceCryptoError('cloud_result_key_invalid');
  }
  if (
    value.kty !== 'EC' ||
    value.crv !== 'P-256' ||
    !isCanonicalBase64url(value.x, 32) ||
    !isCanonicalBase64url(value.y, 32) ||
    !isP256PointCoordinates(value.x, value.y)
  ) {
    throw new DeviceCryptoError('cloud_result_key_invalid');
  }
  return Object.freeze({ kty: 'EC', crv: 'P-256', x: value.x, y: value.y });
}

function nativeFailureCode(error: unknown): DeviceCryptoFailureCode {
  if (!isRecord(error)) return 'device_crypto_native_failure';
  const candidate = error.failureCategory ?? error.userInfo;
  const value = isRecord(candidate) ? candidate.failureCategory : candidate;
  const codes: readonly DeviceCryptoFailureCode[] = [
    'cloud_result_envelope_invalid',
    'cloud_result_context_invalid',
    'cloud_result_context_mismatch',
    'cloud_result_key_invalid',
    'cloud_result_plaintext_too_large',
    'cloud_result_decryption_failed',
    'device_crypto_keychain_failure',
  ];
  return typeof value === 'string' && codes.includes(value as DeviceCryptoFailureCode)
    ? (value as DeviceCryptoFailureCode)
    : 'device_crypto_native_failure';
}

function unavailable(): never {
  throw new DeviceCryptoError('device_crypto_native_unavailable');
}

function resolveNativeModule(): NativeDeviceCryptoModule | null {
  // Keep the native-only import outside the Node test graph. Metro resolves it in an iOS
  // development client while plain Node tests take the closed unavailable path.
  if (typeof navigator === 'undefined') return null;
  try {
    const modules = require('expo-modules-core') as {
      requireOptionalNativeModule<T>(name: string): T | null;
    };
    return modules.requireOptionalNativeModule<NativeDeviceCryptoModule>('AlyteProtection');
  } catch {
    return null;
  }
}

/** Create the typed device-crypto adapter. Native output is always validated at this boundary. */
export function createDeviceCrypto(options: DeviceCryptoOptions = {}): DeviceCrypto {
  const discover = options.resolveNative ?? resolveNativeModule;
  let native: NativeDeviceCryptoModule | null =
    options.native !== undefined ? options.native : discover();

  function requireNative(): NativeDeviceCryptoModule {
    if (native === null && options.native === undefined) native = discover();
    if (native === null) unavailable();
    return native;
  }

  return {
    async getPublicKeyJwk() {
      let value: unknown;
      try {
        value = await requireNative().getDevicePublicKeyJwk();
      } catch (error) {
        if (error instanceof DeviceCryptoError) throw error;
        throw new DeviceCryptoError(nativeFailureCode(error));
      }
      return publicKey(value);
    },
    async decrypt(envelopeValue, context) {
      let envelope;
      try {
        envelope = decodeCloudResultEnvelope(envelopeValue);
      } catch (error) {
        if (error instanceof DeviceCryptoError) throw error;
        throw new DeviceCryptoError('cloud_result_envelope_invalid');
      }
      try {
        // This validates context using the exact shared contract rules before crossing native.
        serializeCloudResultEnvelopeAssociatedData(context);
      } catch (error) {
        if (error instanceof DeviceCryptoError) throw error;
        throw new DeviceCryptoError('cloud_result_context_invalid');
      }
      if (
        envelope.requestId !== context.requestId ||
        envelope.contractVersion !== context.contractVersion ||
        envelope.resultSchemaVersion !== context.resultSchemaVersion ||
        envelope.handlerVersion !== context.handlerVersion
      ) {
        throw new DeviceCryptoError('cloud_result_context_mismatch');
      }

      let encoded: unknown;
      try {
        encoded = await requireNative().decryptCloudResult(
          serializeCloudResultEnvelope(envelope),
          context.requestId,
          context.contractVersion,
          context.resultSchemaVersion,
          context.handlerVersion,
        );
      } catch (error) {
        if (error instanceof DeviceCryptoError) throw error;
        throw new DeviceCryptoError(nativeFailureCode(error));
      }
      try {
        return plaintextBytes(encoded);
      } catch (error) {
        if (error instanceof DeviceCryptoError) throw error;
        throw new DeviceCryptoError('device_crypto_native_failure');
      }
    },
  };
}

export type FakeDeviceCryptoOptions = {
  readonly publicKeyJwk?: P256PublicKeyJwk;
  readonly plaintext?: Uint8Array;
};

/** Clears a caller-owned mutable plaintext buffer after use; JavaScript GC copies are not scrubbed. */
export function clearDeviceCryptoBytes(value: Uint8Array): void {
  value.fill(0);
}

/** A deterministic bridge fake for pure mobile tests; never selected by production composition. */
export function createFakeDeviceCrypto(options: FakeDeviceCryptoOptions = {}): DeviceCrypto {
  const key = options.publicKeyJwk ?? {
    kty: 'EC' as const,
    crv: 'P-256' as const,
    x: 'JuJMOEwg-R94trj8N3pdSjQs4hj2NjOyZmM7NnbeAVM',
    y: 'iIE8qtvmlnTSYss7oBFIeirR-PC4U7Fh_QrepUrrB7Y',
  };
  const plaintext = options.plaintext ?? new TextEncoder().encode('fake-device-crypto');
  return createDeviceCrypto({
    native: {
      getDevicePublicKeyJwk: () => key,
      decryptCloudResult: () => plaintext,
    },
  });
}

export const nativeDeviceCrypto = createDeviceCrypto();
