import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vector from '../../../../../packages/contracts/test-vectors/cloud-result-envelope-v1.json';
import {
  CLOUD_REQUEST_CANCEL_PATH,
  CLOUD_REQUEST_COMPLETE_UPLOAD_PATH,
  CLOUD_REQUEST_RESULT_PATH,
  CLOUD_REQUEST_STATUS_PATH,
  CLOUD_REQUEST_UPLOAD_CONTENT_TYPE,
  CLOUD_REQUEST_UPLOAD_PATH,
  CLOUD_REQUESTS_PATH,
  CONTRACT_VERSION,
  type CloudRequestAdmissionRequest,
  type P256PublicKeyJwk,
} from '@alyte/contracts';
import {
  CloudRequestApiClient,
  CloudRequestApiError,
  MAX_CLOUD_REQUEST_RESPONSE_BYTES,
  MAX_CLOUD_REQUEST_JSON_DEPTH,
  decodeCloudRequestStatus,
} from './cloud-request-api';

const ACCESS_TOKEN = 'synthetic-access-token';
const REQUEST_ID = 'request-125';
const STATUS = {
  requestId: REQUEST_ID,
  operation: 'intake-image',
  state: 'awaiting-upload',
  byteCount: 4,
  pageCount: 1,
  contractVersion: CONTRACT_VERSION,
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  cancelledAt: null,
  uploadedAt: null,
  queuedAt: null,
  resultAvailable: false,
  resultExpiresAt: null,
  failureCategory: null,
  expiresAt: '2026-08-29T00:00:00.000Z',
  expiredAt: null,
} as const;

const ADMISSION: CloudRequestAdmissionRequest = {
  operation: 'intake-image' as const,
  byteCount: 4,
  pageCount: 1,
  devicePublicKeyJwk: vector.devicePublicKeyJwk as P256PublicKeyJwk,
  contractVersion: CONTRACT_VERSION,
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestCapture() {
  const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  return {
    requests,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return response(STATUS);
    },
  };
}

function assertError(code: string, expected: string): void {
  assert.equal(code, expected);
}

function header(init: RequestInit, name: string): string | undefined {
  if (init.headers instanceof Headers) return init.headers.get(name) ?? undefined;
  if (Array.isArray(init.headers)) {
    return init.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe('mobile Cloud Request HTTP adapter', () => {
  it('sends exact admission metadata, bearer auth, and the caller-owned idempotency key', async () => {
    const capture = requestCapture();
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test/',
      fetchImpl: capture.fetchImpl,
    });

    const result = await client.admit(ACCESS_TOKEN, ADMISSION, 'admit-stable-key');
    assert.equal(result.requestId, REQUEST_ID);
    assert.equal(capture.requests[0]?.url, `https://api.example.test${CLOUD_REQUESTS_PATH}`);
    assert.deepEqual(capture.requests[0]?.init.headers, {
      Accept: 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'admit-stable-key',
    });
    assert.deepEqual(JSON.parse(String(capture.requests[0]?.init.body)), ADMISSION);
  });

  it('uses the exact Blob identity for one bounded octet-stream upload', async () => {
    const capture = requestCapture();
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: capture.fetchImpl,
    });
    const artifact = new Blob([Uint8Array.from([1, 2, 3, 4])]);

    await client.upload(ACCESS_TOKEN, REQUEST_ID, artifact, artifact.size, 'upload-stable-key');
    const request = capture.requests[0];
    assert.equal(
      request?.url,
      `https://api.example.test${CLOUD_REQUEST_UPLOAD_PATH.replace(':requestId', REQUEST_ID)}`,
    );
    assert.equal(request?.init.method, 'PUT');
    assert.deepEqual(request?.init.headers, {
      Accept: 'application/json',
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': CLOUD_REQUEST_UPLOAD_CONTENT_TYPE,
      'Idempotency-Key': 'upload-stable-key',
    });
    assert.strictEqual(request?.init.body, artifact);
  });

  it('keeps complete-upload and cancellation as keyed mutations and reads status without a key', async () => {
    const capture = requestCapture();
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: capture.fetchImpl,
    });

    await client.completeUpload(ACCESS_TOKEN, REQUEST_ID, 'complete-stable-key');
    await client.status(ACCESS_TOKEN, REQUEST_ID);
    await client.cancel(ACCESS_TOKEN, REQUEST_ID, 'cancel-stable-key');

    assert.deepEqual(
      capture.requests.map((request) => request.url),
      [
        `https://api.example.test${CLOUD_REQUEST_COMPLETE_UPLOAD_PATH.replace(':requestId', REQUEST_ID)}`,
        `https://api.example.test${CLOUD_REQUEST_STATUS_PATH.replace(':requestId', REQUEST_ID)}`,
        `https://api.example.test${CLOUD_REQUEST_CANCEL_PATH.replace(':requestId', REQUEST_ID)}`,
      ],
    );
    assert.equal(header(capture.requests[0]?.init ?? {}, 'Idempotency-Key'), 'complete-stable-key');
    assert.equal(header(capture.requests[1]?.init ?? {}, 'Idempotency-Key'), undefined);
    assert.equal(header(capture.requests[2]?.init ?? {}, 'Idempotency-Key'), 'cancel-stable-key');
  });

  it('returns only a strict canonical envelope tied to the requested ID', async () => {
    const envelope = JSON.parse(vector.serializedEnvelope) as Record<string, unknown>;
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => response(envelope),
    });
    const result = await client.retrieve(ACCESS_TOKEN, vector.context.requestId);
    assert.deepEqual(result, envelope);
    assert.equal(Object.isFrozen(result), true);

    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => response({ ...envelope, unexpected: true }),
      }).retrieve(ACCESS_TOKEN, vector.context.requestId),
      (error: unknown) =>
        error instanceof CloudRequestApiError && error.code === 'invalid_response',
    );
  });

  it('rejects malformed status shapes, unknown failure categories, and deep JSON', () => {
    assert.throws(
      () => decodeCloudRequestStatus({ ...STATUS, unexpected: 'health-content' }),
      (error: unknown) =>
        error instanceof CloudRequestApiError && error.code === 'invalid_response',
    );
    assert.throws(
      () => decodeCloudRequestStatus({ ...STATUS, failureCategory: 'server-private-detail' }),
      (error: unknown) =>
        error instanceof CloudRequestApiError && error.code === 'invalid_response',
    );

    let nested: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_CLOUD_REQUEST_JSON_DEPTH; index += 1) nested = { nested };
    assert.throws(
      () => decodeCloudRequestStatus(nested),
      (error: unknown) =>
        error instanceof CloudRequestApiError && error.code === 'invalid_response',
    );
  });

  it('rejects duplicate response keys before JSON decoding can choose one value', async () => {
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () =>
        new Response(
          `{"requestId":"${REQUEST_ID}","requestId":"health-leak","operation":"intake-image"}`,
          { status: 200 },
        ),
    });
    await assert.rejects(
      client.status(ACCESS_TOKEN, REQUEST_ID),
      (error: unknown) =>
        error instanceof CloudRequestApiError && error.code === 'invalid_response',
    );
  });

  it('rejects body/key/metadata violations before fetch and never retries a mutation', async () => {
    let calls = 0;
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => {
        calls += 1;
        return response(STATUS);
      },
    });
    const artifact = new Blob([Uint8Array.from([1, 2, 3, 4])]);
    await assert.rejects(
      client.upload(ACCESS_TOKEN, REQUEST_ID, artifact, 3, 'stable-upload-key'),
      (error: unknown) =>
        error instanceof CloudRequestApiError && error.code === 'upload_size_mismatch',
    );
    await assert.rejects(
      client.admit(ACCESS_TOKEN, ADMISSION, ''),
      (error: unknown) => error instanceof CloudRequestApiError && error.code === 'invalid_request',
    );
    assert.equal(calls, 0);

    const failing = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError('offline detail with synthetic health payload');
      },
    });
    await assert.rejects(
      failing.completeUpload(ACCESS_TOKEN, REQUEST_ID, 'same-stable-key'),
      (error: unknown) => {
        assert.ok(error instanceof CloudRequestApiError);
        assertError(error.code, 'offline');
        assert.equal(error.message.includes('offline detail'), false);
        return true;
      },
    );
    assert.equal(calls, 1);

    const synchronousFailure = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: () => {
        throw new Error('synchronous private health detail');
      },
    });
    await assert.rejects(
      synchronousFailure.status(ACCESS_TOKEN, REQUEST_ID),
      (error: unknown) =>
        error instanceof CloudRequestApiError &&
        error.code === 'offline' &&
        !error.message.includes('private health detail'),
    );
  });

  it('maps contract, not-found, not-ready, expired, and failed responses to closed codes', async () => {
    const cases: Array<{
      readonly status: number;
      readonly serverCode: string;
      readonly expected: string;
      readonly method: 'status' | 'retrieve';
    }> = [
      {
        status: 426,
        serverCode: 'cloud_request_contract_version_unsupported',
        expected: 'unsupported_contract',
        method: 'status',
      },
      {
        status: 404,
        serverCode: 'cloud_request_not_found',
        expected: 'not_found',
        method: 'status',
      },
      {
        status: 404,
        serverCode: 'cloud_result_not_available',
        expected: 'not_ready',
        method: 'retrieve',
      },
      { status: 409, serverCode: 'cloud_request_expired', expected: 'expired', method: 'status' },
      { status: 409, serverCode: 'provider_failure', expected: 'failed', method: 'status' },
    ];
    for (const testCase of cases) {
      const client = new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () =>
          response(
            { error: { code: testCase.serverCode, message: 'private health detail' } },
            testCase.status,
          ),
      });
      await assert.rejects(
        testCase.method === 'status'
          ? client.status(ACCESS_TOKEN, REQUEST_ID)
          : client.retrieve(ACCESS_TOKEN, REQUEST_ID),
        (error: unknown) => {
          assert.ok(error instanceof CloudRequestApiError);
          assert.equal(error.code, testCase.expected);
          assert.equal(error.message.includes('private'), false);
          assert.equal(String(error).includes(REQUEST_ID), false);
          return true;
        },
      );
    }
  });

  it('separates caller cancellation from adapter timeout', async () => {
    const timeoutClient = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      requestTimeoutMs: 5,
      fetchImpl: async () => new Promise<Response>(() => undefined),
    });
    await assert.rejects(
      timeoutClient.status(ACCESS_TOKEN, REQUEST_ID),
      (error: unknown) => error instanceof CloudRequestApiError && error.code === 'request_timeout',
    );

    const controller = new AbortController();
    const cancelledClient = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      requestTimeoutMs: 120_000,
      fetchImpl: async () => {
        controller.abort();
        return new Promise<Response>(() => undefined);
      },
    });
    await assert.rejects(
      cancelledClient.status(ACCESS_TOKEN, REQUEST_ID, controller.signal),
      (error: unknown) =>
        error instanceof CloudRequestApiError && error.code === 'request_cancelled',
    );
  });

  it('bounds streaming response reads and does not expose server body content', async () => {
    const oversized = 'x'.repeat(MAX_CLOUD_REQUEST_RESPONSE_BYTES + 1);
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => new Response(oversized, { status: 200 }),
    });
    await assert.rejects(client.status(ACCESS_TOKEN, REQUEST_ID), (error: unknown) => {
      assert.ok(error instanceof CloudRequestApiError);
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.message.includes('x'.repeat(32)), false);
      return true;
    });
  });

  it('supports object-form calls while keeping the exact binary body', async () => {
    const capture = requestCapture();
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: capture.fetchImpl,
    });
    const artifact = new Blob([Uint8Array.from([1, 2, 3, 4])]);
    await client.upload({
      accessToken: ACCESS_TOKEN,
      requestId: REQUEST_ID,
      artifact,
      byteCount: 4,
      idempotencyKey: 'object-upload-key',
    });
    assert.strictEqual(capture.requests[0]?.init.body, artifact);
    assert.equal(header(capture.requests[0]?.init ?? {}, 'Idempotency-Key'), 'object-upload-key');
    assert.equal(capture.requests[0]?.init.method, 'PUT');
    assert.equal(
      capture.requests[0]?.url.endsWith(
        CLOUD_REQUEST_UPLOAD_PATH.replace(':requestId', REQUEST_ID),
      ),
      true,
    );
    assert.equal(CLOUD_REQUEST_RESULT_PATH.includes(':requestId'), true);
  });
});
