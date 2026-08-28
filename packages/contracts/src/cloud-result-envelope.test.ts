import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vector from '../test-vectors/cloud-result-envelope-v1.json';
import {
  CLOUD_RESULT_ENVELOPE_AUTHENTICATION_TAG_BYTES,
  CLOUD_RESULT_ENVELOPE_BINARY_ENCODING,
  CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES,
  CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES,
  CLOUD_RESULT_ENVELOPE_NONCE_BYTES,
  CLOUD_RESULT_ENVELOPE_SALT_BYTES,
  CLOUD_RESULT_ENVELOPE_SCHEMA_VERSION,
  CloudResultEnvelopeError,
  decodeCloudResultEnvelope,
  decodeCloudResultEnvelopeJson,
  serializeCloudResultEnvelope,
  serializeCloudResultEnvelopeAssociatedData,
} from './cloud-result-envelope.js';

const envelope = decodeCloudResultEnvelopeJson(vector.serializedEnvelope);

describe('cloud result envelope contract', () => {
  it('accepts the exact v1 shape and emits canonical JSON/AAD', () => {
    const decoded = decodeCloudResultEnvelope(envelope);
    assert.deepEqual(decoded, envelope);
    assert.equal(
      decodeCloudResultEnvelopeJson(serializeCloudResultEnvelope(envelope)).requestId,
      envelope.requestId,
    );
    assert.equal(
      serializeCloudResultEnvelopeAssociatedData({
        requestId: envelope.requestId,
        contractVersion: envelope.contractVersion,
        resultSchemaVersion: envelope.resultSchemaVersion,
        handlerVersion: envelope.handlerVersion,
      }),
      '{"schemaVersion":"alyte.cloud-result-envelope.v1","requestId":"vector.request-118","contractVersion":"2026-08-28","resultSchemaVersion":"alyte.synthetic.result.v1","handlerVersion":1}',
    );
  });

  it('rejects unknown fields, unsupported algorithms, malformed encodings, and oversized ciphertext', () => {
    assert.throws(
      () => decodeCloudResultEnvelope({ ...envelope, unexpected: true }),
      CloudResultEnvelopeError,
    );
    assert.throws(
      () => decodeCloudResultEnvelope({ ...envelope, cipher: 'AES-128-GCM' }),
      CloudResultEnvelopeError,
    );
    assert.throws(
      () => decodeCloudResultEnvelope({ ...envelope, nonce: `${envelope.nonce}=` }),
      CloudResultEnvelopeError,
    );
    assert.throws(
      () =>
        decodeCloudResultEnvelope({
          ...envelope,
          ciphertext: Buffer.alloc(CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES + 1).toString(
            'base64url',
          ),
        }),
      CloudResultEnvelopeError,
    );
    assert.throws(() => decodeCloudResultEnvelopeJson('{"cipher":1}'), CloudResultEnvelopeError);
    assert.throws(
      () =>
        decodeCloudResultEnvelopeJson(
          `${serializeCloudResultEnvelope(envelope).slice(0, -1)},"cipher":"AES-256-GCM"}`,
        ),
      CloudResultEnvelopeError,
    );
  });

  it('keeps a portable committed vector with the documented context and serialized shape', () => {
    const decoded = decodeCloudResultEnvelopeJson(vector.serializedEnvelope);
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
    assert.equal(decoded.requestId, vector.context.requestId);
    assert.equal(decoded.contractVersion, vector.context.contractVersion);
    assert.equal(decoded.resultSchemaVersion, vector.context.resultSchemaVersion);
    assert.equal(decoded.handlerVersion, vector.context.handlerVersion);
    assert.equal(
      decoded.ephemeralPublicKey.length,
      Math.ceil((CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES * 8) / 6),
    );
  });

  it('accepts the vector point and rejects an off-curve P-256 point', () => {
    assert.doesNotThrow(() => decodeCloudResultEnvelopeJson(vector.serializedEnvelope));
    const offCurvePoint = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.alloc(CLOUD_RESULT_ENVELOPE_EPHEMERAL_PUBLIC_KEY_BYTES - 1),
    ]).toString('base64url');
    assert.throws(
      () => decodeCloudResultEnvelope({ ...envelope, ephemeralPublicKey: offCurvePoint }),
      CloudResultEnvelopeError,
    );
  });
});
