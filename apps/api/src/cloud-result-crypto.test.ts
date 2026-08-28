import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import vector from '../../../packages/contracts/test-vectors/cloud-result-envelope-v1.json' with { type: 'json' };
import {
  CLOUD_RESULT_ENVELOPE_AUTHENTICATION_TAG_BYTES,
  CLOUD_RESULT_ENVELOPE_BINARY_ENCODING,
  CLOUD_RESULT_ENVELOPE_CIPHER,
  CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES,
  CLOUD_RESULT_ENVELOPE_KDF,
  CLOUD_RESULT_ENVELOPE_KEY_AGREEMENT,
  CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES,
  CLOUD_RESULT_ENVELOPE_NONCE_BYTES,
  CLOUD_RESULT_ENVELOPE_SALT_BYTES,
  CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION,
  decodeCloudResultEnvelope,
  decodeCloudResultEnvelopeJson,
  serializeCloudResultEnvelope,
  type CloudResultEnvelopeContext,
} from '@alyte/contracts';
import {
  CloudResultCryptoFailure,
  decryptCloudResultForReference,
  encryptCloudResult,
  encryptCloudResultForTesting,
  type CloudResultEncryptionInput,
} from './cloud-result-crypto.js';

function decodeVectorBase64url(value: string, expectedBytes?: number): Buffer {
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(value, /=/);
  assert.notEqual(value.length % 4, 1);
  const decoded = Buffer.from(value, 'base64url');
  assert.equal(decoded.toString('base64url'), value);
  if (expectedBytes !== undefined) assert.equal(decoded.length, expectedBytes);
  return decoded;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const vectorPlaintext = decodeVectorBase64url(vector.plaintextBase64url);
const vectorInput = {
  ...vector.context,
  devicePublicKeyJwk: vector.devicePublicKeyJwk,
  plaintext: vectorPlaintext,
} as const;
const vectorMaterial = {
  ephemeralPrivateKeyJwk: vector.ephemeralPrivateKeyJwk,
  salt: decodeVectorBase64url(vector.salt, vector.binaryFieldLengths.salt.bytes),
  nonce: decodeVectorBase64url(vector.nonce, vector.binaryFieldLengths.nonce.bytes),
} as const;
const vectorPrivateKeyJwk = vector.devicePrivateKeyJwk;
const vectorEnvelope = decodeCloudResultEnvelopeJson(vector.serializedEnvelope);
const VECTOR_SERIALIZED = vector.serializedEnvelope;

function assertVectorDeclarations(): void {
  assert.equal(vector.schemaVersion, CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION);
  assert.equal(vector.encoding.binary, CLOUD_RESULT_ENVELOPE_BINARY_ENCODING);
  assert.equal(
    vector.encoding.jwkCoordinatesAndPrivateScalar,
    CLOUD_RESULT_ENVELOPE_BINARY_ENCODING,
  );
  assert.equal(vector.encoding.plaintext, 'base64url-unpadded-utf8');
  assert.equal(vector.encoding.serializedEnvelope, 'canonical-utf8-json');
  assert.deepEqual(vector.binaryFieldLengths, {
    ephemeralPublicKey: {
      encoding: CLOUD_RESULT_ENVELOPE_BINARY_ENCODING,
      bytes: CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES,
    },
    salt: {
      encoding: CLOUD_RESULT_ENVELOPE_BINARY_ENCODING,
      bytes: CLOUD_RESULT_ENVELOPE_SALT_BYTES,
    },
    nonce: {
      encoding: CLOUD_RESULT_ENVELOPE_BINARY_ENCODING,
      bytes: CLOUD_RESULT_ENVELOPE_NONCE_BYTES,
    },
    ciphertext: {
      encoding: CLOUD_RESULT_ENVELOPE_BINARY_ENCODING,
      minBytes: 1,
      maxBytes: CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES,
    },
    authenticationTag: {
      encoding: CLOUD_RESULT_ENVELOPE_BINARY_ENCODING,
      bytes: CLOUD_RESULT_ENVELOPE_AUTHENTICATION_TAG_BYTES,
    },
  });
  for (const key of [vector.devicePrivateKeyJwk, vector.devicePublicKeyJwk]) {
    assert.equal(key.kty, 'EC');
    assert.equal(key.crv, 'P-256');
    decodeVectorBase64url(key.x, 32);
    decodeVectorBase64url(key.y, 32);
  }
  decodeVectorBase64url(vectorPrivateKeyJwk.d, 32);
  decodeVectorBase64url(vector.ephemeralPrivateKeyJwk.x, 32);
  decodeVectorBase64url(vector.ephemeralPrivateKeyJwk.y, 32);
  decodeVectorBase64url(vector.ephemeralPrivateKeyJwk.d, 32);
  const plaintextText = new TextDecoder('utf-8', { fatal: true }).decode(vectorPlaintext);
  assert.equal(Buffer.from(plaintextText, 'utf8').toString('base64url'), vector.plaintextBase64url);
  assert.equal(vectorEnvelope.schemaVersion, vector.schemaVersion);
  assert.equal(vectorEnvelope.keyAgreement, CLOUD_RESULT_ENVELOPE_KEY_AGREEMENT);
  assert.equal(vectorEnvelope.kdf, CLOUD_RESULT_ENVELOPE_KDF);
  assert.equal(vectorEnvelope.cipher, CLOUD_RESULT_ENVELOPE_CIPHER);
  assert.equal(vectorEnvelope.requestId, vector.context.requestId);
  assert.equal(vectorEnvelope.contractVersion, vector.context.contractVersion);
  assert.equal(vectorEnvelope.resultSchemaVersion, vector.context.resultSchemaVersion);
  assert.equal(vectorEnvelope.handlerVersion, vector.context.handlerVersion);
  decodeVectorBase64url(
    vectorEnvelope.ephemeralPublicKey,
    vector.binaryFieldLengths.ephemeralPublicKey.bytes,
  );
  decodeVectorBase64url(vectorEnvelope.salt, vector.binaryFieldLengths.salt.bytes);
  decodeVectorBase64url(vectorEnvelope.nonce, vector.binaryFieldLengths.nonce.bytes);
  decodeVectorBase64url(vectorEnvelope.ciphertext);
  assert.ok(
    Buffer.from(vectorEnvelope.ciphertext, 'base64url').length >=
      vector.binaryFieldLengths.ciphertext.minBytes,
  );
  assert.ok(
    Buffer.from(vectorEnvelope.ciphertext, 'base64url').length <=
      vector.binaryFieldLengths.ciphertext.maxBytes,
  );
  decodeVectorBase64url(
    vectorEnvelope.authenticationTag,
    vector.binaryFieldLengths.authenticationTag.bytes,
  );
}

function expectCryptoFailure(
  action: () => unknown,
  code: CloudResultCryptoFailure['code'],
  sensitiveValues: readonly string[],
  label: string,
): void {
  assert.throws(
    action,
    (error: unknown) => {
      assert.ok(error instanceof CloudResultCryptoFailure);
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      for (const value of sensitiveValues) {
        if (value.length > 0) assert.doesNotMatch(error.message, new RegExp(escapeRegExp(value)));
      }
      return true;
    },
    label,
  );
}

function changeFirstBase64urlCharacter(value: string): string {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}

describe('cloud result crypto envelope', () => {
  it('uses the committed vector as the complete deterministic interoperability source', () => {
    assertVectorDeclarations();
    const result = encryptCloudResultForTesting(vectorInput, vectorMaterial);
    const serialized = serializeCloudResultEnvelope(result);
    assert.equal(serialized, VECTOR_SERIALIZED);
    assert.deepEqual(
      Buffer.from(
        decryptCloudResultForReference({
          envelope: decodeCloudResultEnvelope(result),
          devicePrivateKeyJwk: vectorPrivateKeyJwk,
          context: vectorInput,
        }),
      ),
      vectorPlaintext,
    );
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(vectorPrivateKeyJwk.d)));
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(vectorPlaintext.toString('utf8'))));
  });

  it('uses fresh ephemeral keys and nonces for production encryption', () => {
    const first = encryptCloudResult(vectorInput);
    const second = encryptCloudResult(vectorInput);
    assert.notEqual(first.ephemeralPublicKey, second.ephemeralPublicKey);
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.nonce, second.nonce);
    assert.deepEqual(
      Buffer.from(
        decryptCloudResultForReference({
          envelope: first,
          devicePrivateKeyJwk: vectorPrivateKeyJwk,
          context: vectorInput,
        }),
      ),
      vectorPlaintext,
    );
    assert.deepEqual(
      Buffer.from(
        decryptCloudResultForReference({
          envelope: second,
          devicePrivateKeyJwk: vectorPrivateKeyJwk,
          context: vectorInput,
        }),
      ),
      vectorPlaintext,
    );
  });

  it('rejects the fail-closed matrix with bounded non-sensitive errors', () => {
    assertVectorDeclarations();
    const result = encryptCloudResultForTesting(vectorInput, vectorMaterial);
    const wrongPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const wrongPrivateKeyJwk = wrongPair.privateKey.export({ format: 'jwk' });
    const offCurveCoordinate = Buffer.alloc(32).toString('base64url');
    const oversizedCiphertext = Buffer.alloc(
      CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES + 1,
    ).toString('base64url');
    const sensitiveValues = [
      vectorPrivateKeyJwk.d,
      vectorPlaintext.toString('utf8'),
      result.ciphertext,
      wrongPrivateKeyJwk.d ?? '',
    ];
    const decrypt =
      (
        envelope: unknown,
        context: CloudResultEnvelopeContext = vectorInput,
        devicePrivateKeyJwk: unknown = vectorPrivateKeyJwk,
      ) =>
      () =>
        decryptCloudResultForReference({ envelope, devicePrivateKeyJwk, context });
    const encrypt = (input: CloudResultEncryptionInput) => () =>
      encryptCloudResultForTesting(input, vectorMaterial);
    const failures: Array<{
      name: string;
      action: () => unknown;
      code: CloudResultCryptoFailure['code'];
    }> = [
      ...(
        [
          ['wrong request ID', { ...vectorInput, requestId: `${vector.context.requestId}.other` }],
          [
            'wrong contract version',
            { ...vectorInput, contractVersion: `${vector.context.contractVersion}.other` },
          ],
          [
            'wrong result schema version',
            { ...vectorInput, resultSchemaVersion: `${vector.context.resultSchemaVersion}.other` },
          ],
          [
            'wrong handler version',
            { ...vectorInput, handlerVersion: vector.context.handlerVersion + 1 },
          ],
        ] as const
      ).map(([name, context]) => ({
        name,
        action: decrypt(result, context),
        code: 'cloud_result_context_mismatch' as const,
      })),
      ...(
        [
          ['unsupported schema version', { schemaVersion: 'alyte.cloud-result-envelope.v2' }],
          ['unsupported key agreement', { keyAgreement: 'X25519-ECDH' }],
          ['unsupported KDF', { kdf: 'HKDF-SHA-512' }],
          ['unsupported cipher', { cipher: 'AES-128-GCM' }],
        ] as const
      ).map(([name, patch]) => ({
        name,
        action: decrypt({ ...result, ...patch }),
        code: 'cloud_result_envelope_invalid' as const,
      })),
      ...(
        [
          [
            'ephemeral key noncanonical encoding',
            { ephemeralPublicKey: `${result.ephemeralPublicKey}=` },
          ],
          [
            'ephemeral key wrong length',
            { ephemeralPublicKey: result.ephemeralPublicKey.slice(0, -1) },
          ],
          [
            'ephemeral key off curve',
            {
              ephemeralPublicKey: Buffer.concat([
                Buffer.from([0x04]),
                Buffer.alloc(CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES - 1),
              ]).toString('base64url'),
            },
          ],
          ['salt invalid encoding', { salt: '!' }],
          ['salt wrong length', { salt: result.salt.slice(0, -1) }],
          ['nonce invalid encoding', { nonce: '!' }],
          ['nonce wrong length', { nonce: result.nonce.slice(0, -1) }],
          ['ciphertext invalid encoding', { ciphertext: '!' }],
          ['ciphertext empty', { ciphertext: '' }],
          ['ciphertext oversized', { ciphertext: oversizedCiphertext }],
          ['authentication tag invalid encoding', { authenticationTag: '!' }],
          [
            'authentication tag noncanonical trailing bits',
            { authenticationTag: `${result.authenticationTag.slice(0, -1)}B` },
          ],
          [
            'authentication tag wrong length',
            {
              authenticationTag: result.authenticationTag.slice(0, -1),
            },
          ],
        ] as const
      ).map(([name, patch]) => ({
        name,
        action: decrypt({ ...result, ...patch }),
        code: 'cloud_result_envelope_invalid' as const,
      })),
      {
        name: 'tampered ciphertext',
        action: decrypt({
          ...result,
          ciphertext: changeFirstBase64urlCharacter(result.ciphertext),
        }),
        code: 'cloud_result_decryption_failed',
      },
      {
        name: 'tampered authentication tag',
        action: decrypt({
          ...result,
          authenticationTag: changeFirstBase64urlCharacter(result.authenticationTag),
        }),
        code: 'cloud_result_decryption_failed',
      },
      {
        name: 'wrong device key',
        action: decrypt(result, vectorInput, wrongPrivateKeyJwk),
        code: 'cloud_result_decryption_failed',
      },
      {
        name: 'alternate device curve',
        action: encrypt({
          ...vectorInput,
          devicePublicKeyJwk: { ...vectorInput.devicePublicKeyJwk, crv: 'P-384' },
        }),
        code: 'cloud_result_key_invalid',
      },
      {
        name: 'off-curve device coordinates',
        action: encrypt({
          ...vectorInput,
          devicePublicKeyJwk: {
            ...vectorInput.devicePublicKeyJwk,
            x: offCurveCoordinate,
            y: offCurveCoordinate,
          },
        }),
        code: 'cloud_result_key_invalid',
      },
      {
        name: 'malformed device coordinate encoding',
        action: encrypt({
          ...vectorInput,
          devicePublicKeyJwk: { ...vectorInput.devicePublicKeyJwk, x: '!' },
        }),
        code: 'cloud_result_key_invalid',
      },
      {
        name: 'wrong-length device coordinate',
        action: encrypt({
          ...vectorInput,
          devicePublicKeyJwk: {
            ...vectorInput.devicePublicKeyJwk,
            x: vectorInput.devicePublicKeyJwk.x.slice(0, -1),
          },
        }),
        code: 'cloud_result_key_invalid',
      },
      {
        name: 'private member injection',
        action: encrypt({
          ...vectorInput,
          devicePublicKeyJwk: { ...vectorInput.devicePublicKeyJwk, d: vectorPrivateKeyJwk.d },
        }),
        code: 'cloud_result_key_invalid',
      },
      {
        name: 'oversized plaintext',
        action: encrypt({
          ...vectorInput,
          plaintext: new Uint8Array(CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES + 1),
        }),
        code: 'cloud_result_plaintext_too_large',
      },
    ];

    for (const failure of failures) {
      expectCryptoFailure(failure.action, failure.code, sensitiveValues, failure.name);
    }
  });
});
