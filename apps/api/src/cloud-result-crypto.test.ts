import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import vector from '../../../packages/contracts/test-vectors/cloud-result-envelope-v1.json' with { type: 'json' };
import {
  CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES,
  decodeCloudResultEnvelope,
  serializeCloudResultEnvelope,
  type P256PublicKeyJwk,
} from '@alyte/contracts';
import {
  CloudResultCryptoFailure,
  decryptCloudResultForReference,
  encryptCloudResult,
  encryptCloudResultForTesting,
} from './cloud-result-crypto.js';

const devicePrivateKeyJwk = {
  kty: 'EC',
  x: 'JuJMOEwg-R94trj8N3pdSjQs4hj2NjOyZmM7NnbeAVM',
  y: 'iIE8qtvmlnTSYss7oBFIeirR-PC4U7Fh_QrepUrrB7Y',
  crv: 'P-256',
  d: 'iVc6XRGEi2REfPKFkBs4qaKABCgryiRJnjkteW6nm3o',
} as const;

const devicePublicKeyJwk: P256PublicKeyJwk = {
  kty: 'EC',
  x: devicePrivateKeyJwk.x,
  y: devicePrivateKeyJwk.y,
  crv: devicePrivateKeyJwk.crv,
};

const vectorInput = {
  requestId: 'vector.request-118',
  contractVersion: '2026-08-28',
  resultSchemaVersion: 'alyte.synthetic.result.v1',
  handlerVersion: 1,
  devicePublicKeyJwk,
  plaintext: Buffer.from('synthetic-result-118'),
} as const;

const vectorMaterial = {
  ephemeralPrivateKeyJwk: {
    kty: 'EC',
    x: 'er-JGYPuzBOTpjMfWkp7jzgsFIFzkK6Zl7zd-bzbQRY',
    y: '0sIZslr9wom8qjn59gLCgfCU31hfnMRB-RWDrBEkb34',
    crv: 'P-256',
    d: 'O29RBgx_g_vr8iGhhquFNrmaSn2CIzL6_7v69qM2bdk',
  },
  salt: Buffer.from('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
  nonce: Buffer.from('0102030405060708090a0b0c', 'hex'),
} as const;

const VECTOR_SERIALIZED = vector.serializedEnvelope;

function expectCryptoFailure(action: () => unknown, code: CloudResultCryptoFailure['code']): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CloudResultCryptoFailure);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

describe('cloud result crypto envelope', () => {
  it('matches the deterministic synthetic interoperability vector and round-trips', () => {
    const result = encryptCloudResultForTesting(vectorInput, vectorMaterial);
    const serialized = serializeCloudResultEnvelope(result);
    assert.equal(serialized, VECTOR_SERIALIZED);
    assert.deepEqual(
      Buffer.from(
        decryptCloudResultForReference({
          envelope: decodeCloudResultEnvelope(result),
          devicePrivateKeyJwk,
          context: vectorInput,
        }),
      ),
      vectorInput.plaintext,
    );
    assert.doesNotMatch(serialized, new RegExp(devicePrivateKeyJwk.d));
    assert.doesNotMatch(serialized, /synthetic-result-118/);
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
          devicePrivateKeyJwk,
          context: vectorInput,
        }),
      ),
      vectorInput.plaintext,
    );
    assert.deepEqual(
      Buffer.from(
        decryptCloudResultForReference({
          envelope: second,
          devicePrivateKeyJwk,
          context: vectorInput,
        }),
      ),
      vectorInput.plaintext,
    );
  });

  it('fails closed for wrong keys, context, tampering, malformed keys, and oversized plaintext', () => {
    const result = encryptCloudResultForTesting(vectorInput, vectorMaterial);
    const wrongPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const wrongPrivateKeyJwk = wrongPair.privateKey.export({ format: 'jwk' });
    expectCryptoFailure(
      () =>
        decryptCloudResultForReference({
          envelope: result,
          devicePrivateKeyJwk: wrongPrivateKeyJwk,
          context: vectorInput,
        }),
      'cloud_result_decryption_failed',
    );
    expectCryptoFailure(
      () =>
        decryptCloudResultForReference({
          envelope: result,
          devicePrivateKeyJwk,
          context: { ...vectorInput, requestId: 'different-request' },
        }),
      'cloud_result_context_mismatch',
    );
    expectCryptoFailure(
      () =>
        decryptCloudResultForReference({
          envelope: { ...result, ciphertext: `${result.ciphertext.slice(0, -1)}A` },
          devicePrivateKeyJwk,
          context: vectorInput,
        }),
      'cloud_result_decryption_failed',
    );
    expectCryptoFailure(
      () =>
        encryptCloudResultForTesting(
          {
            ...vectorInput,
            devicePublicKeyJwk: { ...devicePublicKeyJwk, d: devicePrivateKeyJwk.d },
          },
          vectorMaterial,
        ),
      'cloud_result_key_invalid',
    );
    expectCryptoFailure(
      () =>
        encryptCloudResultForTesting(
          {
            ...vectorInput,
            devicePublicKeyJwk: { ...devicePublicKeyJwk, x: 'not-base64url' },
          },
          vectorMaterial,
        ),
      'cloud_result_key_invalid',
    );
    expectCryptoFailure(
      () =>
        encryptCloudResultForTesting(
          {
            ...vectorInput,
            plaintext: new Uint8Array(CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES + 1),
          },
          vectorMaterial,
        ),
      'cloud_result_plaintext_too_large',
    );
  });
});
