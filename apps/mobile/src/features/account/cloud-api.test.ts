import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTRACT_VERSION } from '@alyte/contracts';
import {
  CloudApiClient,
  CloudApiError,
  MAX_ACCOUNT_EXPORT_ITEMS,
  MAX_RESPONSE_BODY_BYTES,
  decodeAccountExport,
} from './cloud-api';

function sessionResponse() {
  return {
    accountId: 'account-1',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    accessTokenExpiresAt: '2026-08-27T12:15:00.000Z',
    refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
  };
}

describe('cloud HTTP adapter', () => {
  it('uses the configured API URL and decodes the versioned Apple exchange contract', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new CloudApiClient({
      baseUrl: 'https://api.example.test/',
      idempotencyKey: () => 'exchange-key',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify(sessionResponse()), { status: 200 });
      },
    });

    const result = await client.exchangeApple('synthetic-apple-token');
    assert.equal(result.accountId, 'account-1');
    assert.equal(requests[0]?.url, 'https://api.example.test/v1/auth/apple/exchange');
    assert.equal(requests[0]?.init.headers instanceof Headers, false);
    assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
      identityToken: 'synthetic-apple-token',
      consentPolicyVersion: CONTRACT_VERSION,
    });
    assert.deepEqual(requests[0]?.init.headers, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'exchange-key',
    });
  });

  it('turns malformed success data into a bounded adapter error', async () => {
    const client = new CloudApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () =>
        new Response(JSON.stringify({ accessToken: 'only-one-field' }), { status: 200 }),
    });

    await assert.rejects(client.refresh('refresh-token'), (error: unknown) => {
      assert.ok(error instanceof CloudApiError);
      assert.equal(error.code, 'invalid_token_type');
      assert.equal(error.message, 'invalid_token_type');
      return true;
    });
  });

  it('keeps server error messages out of the client error while preserving its safe code', async () => {
    const client = new CloudApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { code: 'session_invalid', message: 'private server detail' } }),
          { status: 401 },
        ),
    });

    await assert.rejects(client.exportAccount('access-token'), (error: unknown) => {
      assert.ok(error instanceof CloudApiError);
      assert.equal(error.code, 'session_invalid');
      assert.equal(error.message, 'session_invalid');
      assert.equal(error.message.includes('private'), false);
      return true;
    });
  });

  it('rejects account exports that contain an unknown operation or invalid metadata', () => {
    assert.throws(
      () =>
        decodeAccountExport({
          accountId: 'account-1',
          createdAt: '2026-08-27T12:00:00.000Z',
          appleSubject: 'opaque-subject',
          consents: [],
          sessions: [],
          operations: [
            { operation: 'unknown', responseStatus: 200, createdAt: 'bad', expiresAt: 'bad' },
          ],
          auditEvents: [],
        }),
      (error: unknown) => error instanceof CloudApiError && error.code === 'invalid_operation',
    );
  });

  it('bounds response bodies and account metadata arrays before decoding', async () => {
    const oversized = 'x'.repeat(MAX_RESPONSE_BODY_BYTES + 1);
    const client = new CloudApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => new Response(oversized, { status: 200 }),
    });
    await assert.rejects(client.exportAccount('access-token'), (error: unknown) => {
      assert.ok(error instanceof CloudApiError);
      assert.equal(error.code, 'invalid_response');
      return true;
    });

    const manyConsents = Array.from({ length: MAX_ACCOUNT_EXPORT_ITEMS + 1 }, () => ({}));
    assert.throws(
      () =>
        decodeAccountExport({
          accountId: 'account-1',
          createdAt: '2026-08-27T12:00:00.000Z',
          appleSubject: 'opaque-subject',
          consents: manyConsents,
          sessions: [],
          operations: [],
          auditEvents: [],
        }),
      (error: unknown) => error instanceof CloudApiError && error.code === 'invalid_consents',
    );
  });

  it('fails closed for an insecure production URL and honors an explicit null override', async () => {
    const insecure = new CloudApiClient({
      baseUrl: 'http://api.example.test',
      requireHttps: true,
    });
    assert.equal(insecure.isConfigured(), false);
    await assert.rejects(insecure.exchangeApple('synthetic-apple-token'), (error: unknown) => {
      assert.ok(error instanceof CloudApiError);
      assert.equal(error.code, 'api_unconfigured');
      return true;
    });

    const original = process.env.EXPO_PUBLIC_API_URL;
    process.env.EXPO_PUBLIC_API_URL = 'https://prod.example.test';
    try {
      const explicitNone = new CloudApiClient({ baseUrl: null });
      assert.equal(explicitNone.isConfigured(), false);
    } finally {
      if (original === undefined) delete process.env.EXPO_PUBLIC_API_URL;
      else process.env.EXPO_PUBLIC_API_URL = original;
    }
  });

  it('maps a bounded request timeout separately from caller cancellation', async () => {
    const client = new CloudApiClient({
      baseUrl: 'https://api.example.test',
      requestTimeoutMs: 5,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });
    await assert.rejects(client.exportAccount('access-token'), (error: unknown) => {
      assert.ok(error instanceof CloudApiError);
      assert.equal(error.code, 'request_timeout');
      return true;
    });
  });
});
