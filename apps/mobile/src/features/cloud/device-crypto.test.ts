import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES } from '@alyte/contracts';
import vector from '../../../../../packages/contracts/test-vectors/cloud-result-envelope-v1.json';
import {
  createDeviceCrypto,
  createFakeDeviceCrypto,
  clearDeviceCryptoBytes,
  DeviceCryptoError,
  type NativeDeviceCryptoModule,
} from './device-crypto';

const envelope = JSON.parse(vector.serializedEnvelope) as unknown;
const context = vector.context;
const plaintext = new TextEncoder().encode('synthetic-result-118');

function fakeNative(overrides: Partial<NativeDeviceCryptoModule> = {}): NativeDeviceCryptoModule {
  return {
    getDevicePublicKeyJwk: () => vector.devicePublicKeyJwk,
    decryptCloudResult: () => plaintext,
    ...overrides,
  };
}

describe('device crypto adapter', () => {
  it('validates the public JWK and never exposes a private member', async () => {
    const service = createDeviceCrypto({ native: fakeNative() });
    const key = await service.getPublicKeyJwk();
    assert.deepEqual(key, vector.devicePublicKeyJwk);
    assert.equal('d' in key, false);

    await assert.rejects(
      createDeviceCrypto({
        native: fakeNative({
          getDevicePublicKeyJwk: () => ({ ...vector.devicePublicKeyJwk, d: 'private' }),
        }),
      }).getPublicKeyJwk(),
      (error: unknown) =>
        error instanceof DeviceCryptoError && error.code === 'cloud_result_key_invalid',
    );

    await assert.rejects(
      createDeviceCrypto({
        native: fakeNative({
          getDevicePublicKeyJwk: () => ({
            ...vector.devicePublicKeyJwk,
            x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          }),
        }),
      }).getPublicKeyJwk(),
      (error: unknown) =>
        error instanceof DeviceCryptoError && error.code === 'cloud_result_key_invalid',
    );
  });

  it('passes the canonical envelope and context to native and returns transient bytes', async () => {
    let received: unknown[] = [];
    const nativePlaintext = Uint8Array.from(plaintext);
    const service = createDeviceCrypto({
      native: fakeNative({
        decryptCloudResult: (...args) => {
          received = args;
          return nativePlaintext;
        },
      }),
    });

    const returned = await service.decrypt(envelope, context);
    assert.strictEqual(returned, nativePlaintext);
    clearDeviceCryptoBytes(returned);
    assert.deepEqual(nativePlaintext, new Uint8Array(nativePlaintext.byteLength));
    assert.deepEqual(received, [vector.serializedEnvelope, ...Object.values(context)]);
  });

  it('rejects malformed, tampered, and context-mismatched envelopes before native invocation', async () => {
    let calls = 0;
    const service = createDeviceCrypto({
      native: fakeNative({
        decryptCloudResult: () => {
          calls += 1;
          return plaintext;
        },
      }),
    });

    for (const invalid of [
      { ...(envelope as Record<string, unknown>), cipher: 'AES-128-GCM' },
      { ...(envelope as Record<string, unknown>), nonce: `${vector.serializedEnvelope}=` },
      { ...(envelope as Record<string, unknown>), ephemeralPublicKey: '!' },
      { ...(envelope as Record<string, unknown>), ciphertext: '' },
    ]) {
      await assert.rejects(service.decrypt(invalid, context), (error: unknown) => {
        assert.ok(error instanceof DeviceCryptoError);
        assert.equal(error.code, 'cloud_result_envelope_invalid');
        return true;
      });
    }

    await assert.rejects(
      service.decrypt(envelope, { ...context, handlerVersion: 2 }),
      (error: unknown) =>
        error instanceof DeviceCryptoError && error.code === 'cloud_result_context_mismatch',
    );
    assert.equal(calls, 0);
  });

  it('maps native failures to closed codes without preserving sensitive diagnostics', async () => {
    const secret = 'synthetic-result-118';
    const service = createDeviceCrypto({
      native: fakeNative({
        decryptCloudResult: () => {
          throw Object.assign(new Error(`native detail ${secret}`), {
            failureCategory: 'cloud_result_decryption_failed',
          });
        },
      }),
    });
    await assert.rejects(service.decrypt(envelope, context), (error: unknown) => {
      assert.ok(error instanceof DeviceCryptoError);
      assert.equal(error.code, 'cloud_result_decryption_failed');
      assert.equal(error.message.includes(secret), false);
      assert.equal(String(error).includes(secret), false);
      return true;
    });

    const oversized = createDeviceCrypto({
      native: fakeNative({
        decryptCloudResult: () => new Uint8Array(CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES + 1),
      }),
    });
    await assert.rejects(oversized.decrypt(envelope, context), (error: unknown) => {
      assert.ok(error instanceof DeviceCryptoError);
      assert.equal(error.code, 'cloud_result_plaintext_too_large');
      return true;
    });

    await assert.rejects(
      createDeviceCrypto({
        native: fakeNative({ decryptCloudResult: () => vector.plaintextBase64url }),
      }).decrypt(envelope, context),
      (error: unknown) =>
        error instanceof DeviceCryptoError && error.code === 'device_crypto_native_failure',
    );
  });

  it('has a closed missing-native state and a deterministic injected fake', async () => {
    await assert.rejects(
      createDeviceCrypto({ native: null }).getPublicKeyJwk(),
      (error: unknown) =>
        error instanceof DeviceCryptoError && error.code === 'device_crypto_native_unavailable',
    );
    const fake = createFakeDeviceCrypto({ plaintext });
    assert.deepEqual(await fake.getPublicKeyJwk(), vector.devicePublicKeyJwk);
    assert.deepEqual(await fake.decrypt(envelope, context), plaintext);

    const owned = Uint8Array.from(plaintext);
    clearDeviceCryptoBytes(owned);
    assert.deepEqual(owned, new Uint8Array(plaintext.byteLength));
  });
});
