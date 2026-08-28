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
  type CloudRequestUploadBody,
  type CloudRequestContext,
} from './cloud-request-api';

const ACCESS_TOKEN = 'synthetic-access-token';
const REQUEST_ID = 'request-125';
const CONTEXT: CloudRequestContext = {
  requestId: REQUEST_ID,
  operation: 'intake-image',
  byteCount: 4,
  pageCount: 1,
  contractVersion: CONTRACT_VERSION,
};
const VECTOR_CONTEXT: CloudRequestContext = {
  requestId: vector.context.requestId,
  operation: 'intake-image',
  byteCount: 4,
  pageCount: 1,
  contractVersion: CONTRACT_VERSION,
};
const STATUS = {
  ...CONTEXT,
  state: 'awaiting-upload',
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
  operation: 'intake-image',
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

function header(init: RequestInit, name: string): string | undefined {
  if (init.headers instanceof Headers) return init.headers.get(name) ?? undefined;
  if (Array.isArray(init.headers)) {
    return init.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.[name] ?? headers?.[name.toLowerCase()];
}

function requestCapture(value: unknown = STATUS) {
  const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  return {
    requests,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} });
      return response(value);
    },
  };
}

function assertCode(error: unknown, code: string): void {
  assert.ok(error instanceof CloudRequestApiError);
  assert.equal(error.code, code);
}

function fileLike(bytes: number[], type = 'application/pdf'): CloudRequestUploadBody {
  const payload = Uint8Array.from(bytes);
  return {
    size: payload.byteLength,
    type,
    arrayBuffer: async () => payload.buffer.slice(0),
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
  };
}

/** SDK 57's RequestUtils.ts normalizes every arrayBuffer/type object and overrides Content-Type. */
async function sdk57NormalizeBlobLike(body: CloudRequestUploadBody): Promise<{
  readonly body: Uint8Array;
  readonly contentType: string;
}> {
  return { body: new Uint8Array(await body.arrayBuffer()), contentType: body.type };
}

describe('mobile Cloud Request HTTP adapter', () => {
  it('uses one object input and proves every lifecycle route, method, auth, and key policy', async () => {
    const envelope = JSON.parse(vector.serializedEnvelope) as Record<string, unknown>;
    const capture = requestCapture();
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test/',
      fetchImpl: async (input, init) => {
        capture.requests.push({ url: String(input), init: init ?? {} });
        return response(String(input).endsWith('/result') ? envelope : STATUS);
      },
    });
    const artifact = fileLike([1, 2, 3, 4], CLOUD_REQUEST_UPLOAD_CONTENT_TYPE);

    await client.admit({
      accessToken: ACCESS_TOKEN,
      request: ADMISSION,
      idempotencyKey: 'admit-key',
    });
    await client.upload({
      ...CONTEXT,
      accessToken: ACCESS_TOKEN,
      artifact,
      idempotencyKey: 'upload-key',
    });
    await client.completeUpload({
      ...CONTEXT,
      accessToken: ACCESS_TOKEN,
      idempotencyKey: 'complete-key',
    });
    await client.status({ ...CONTEXT, accessToken: ACCESS_TOKEN });
    await client.retrieve({ ...VECTOR_CONTEXT, accessToken: ACCESS_TOKEN });
    await client.cancel({ ...CONTEXT, accessToken: ACCESS_TOKEN, idempotencyKey: 'cancel-key' });

    assert.deepEqual(
      capture.requests.map((request) => [request.init.method, request.url]),
      [
        ['POST', `https://api.example.test${CLOUD_REQUESTS_PATH}`],
        [
          'PUT',
          `https://api.example.test${CLOUD_REQUEST_UPLOAD_PATH.replace(':requestId', REQUEST_ID)}`,
        ],
        [
          'POST',
          `https://api.example.test${CLOUD_REQUEST_COMPLETE_UPLOAD_PATH.replace(':requestId', REQUEST_ID)}`,
        ],
        [
          'GET',
          `https://api.example.test${CLOUD_REQUEST_STATUS_PATH.replace(':requestId', REQUEST_ID)}`,
        ],
        [
          'GET',
          `https://api.example.test${CLOUD_REQUEST_RESULT_PATH.replace(':requestId', VECTOR_CONTEXT.requestId)}`,
        ],
        [
          'POST',
          `https://api.example.test${CLOUD_REQUEST_CANCEL_PATH.replace(':requestId', REQUEST_ID)}`,
        ],
      ],
    );
    assert.deepEqual(
      capture.requests.map((request) => header(request.init, 'Authorization')),
      Array.from({ length: 6 }, () => `Bearer ${ACCESS_TOKEN}`),
    );
    assert.deepEqual(
      capture.requests.map((request) => header(request.init, 'Idempotency-Key')),
      ['admit-key', 'upload-key', 'complete-key', undefined, undefined, 'cancel-key'],
    );
    assert.equal(capture.requests.length, 6);
    assert.equal(header(capture.requests[0]?.init ?? {}, 'Content-Type'), 'application/json');
    assert.equal(
      header(capture.requests[1]?.init ?? {}, 'Content-Type'),
      CLOUD_REQUEST_UPLOAD_CONTENT_TYPE,
    );
    assert.equal(capture.requests[1]?.init.body, artifact);
  });

  it('preserves a real Blob/File body and forces octet-stream through Request normalization', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const artifact = new Blob([bytes], { type: 'application/pdf' });
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async (input, init) => {
        assert.notStrictEqual(init?.body, artifact);
        const body = init?.body as CloudRequestUploadBody;
        const normalized = await sdk57NormalizeBlobLike(body);
        assert.equal(normalized.contentType, CLOUD_REQUEST_UPLOAD_CONTENT_TYPE);
        assert.deepEqual(normalized.body, bytes);
        return response(STATUS);
      },
    });

    await client.upload({
      ...CONTEXT,
      accessToken: ACCESS_TOKEN,
      artifact,
      idempotencyKey: 'blob-key',
    });
  });

  it('accepts an Expo File-shaped object without reading, converting, or replacing its bytes', async () => {
    let reads = 0;
    const original = fileLike([7, 8, 9, 10], 'image/jpeg');
    const artifact: CloudRequestUploadBody = {
      ...original,
      arrayBuffer: async () => {
        reads += 1;
        return original.arrayBuffer();
      },
    };
    let calls = 0;
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async (_input, init) => {
        calls += 1;
        assert.notStrictEqual(init?.body, artifact);
        assert.equal(
          (init?.body as CloudRequestUploadBody).type,
          CLOUD_REQUEST_UPLOAD_CONTENT_TYPE,
        );
        assert.equal(header(init ?? {}, 'Content-Type'), CLOUD_REQUEST_UPLOAD_CONTENT_TYPE);
        assert.deepEqual(
          new Uint8Array(await artifact.arrayBuffer()),
          Uint8Array.from([7, 8, 9, 10]),
        );
        return response({ ...STATUS, byteCount: 4 });
      },
    });
    await client.upload({
      ...CONTEXT,
      accessToken: ACCESS_TOKEN,
      artifact,
      idempotencyKey: 'file-key',
    });
    assert.equal(calls, 1);
    assert.equal(reads, 1);
  });

  it('re-reads a mutable File-like size immediately before fetch and fails closed', async () => {
    let sizeReads = 0;
    const artifact = fileLike([1, 2, 3, 4]);
    Object.defineProperty(artifact, 'size', {
      get() {
        sizeReads += 1;
        return sizeReads === 1 ? 4 : 5;
      },
    });
    let calls = 0;
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => {
        calls += 1;
        return response(STATUS);
      },
    });
    await assert.rejects(
      client.upload({
        ...CONTEXT,
        accessToken: ACCESS_TOKEN,
        artifact,
        idempotencyKey: 'mutable-key',
      }),
      (error: unknown) => {
        assertCode(error, 'upload_size_mismatch');
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(sizeReads, 2);
  });

  it('binds statuses to exact request context and distinguishes sibling from unsupported responses', async () => {
    for (const mismatch of [
      { ...STATUS, requestId: 'sibling-request' },
      { ...STATUS, operation: 'lab-report' },
      { ...STATUS, byteCount: 5 },
      { ...STATUS, pageCount: 2 },
    ]) {
      const client = new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => response(mismatch),
      });
      await assert.rejects(
        client.status({ ...CONTEXT, accessToken: ACCESS_TOKEN }),
        (error: unknown) => {
          assertCode(error, 'invalid_response');
          return true;
        },
      );
    }
    const oldContract = { ...STATUS, contractVersion: '2026-08-27' };
    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => response(oldContract),
      }).status({ ...CONTEXT, accessToken: ACCESS_TOKEN }),
      (error: unknown) => {
        assertCode(error, 'unsupported_contract');
        return true;
      },
    );
  });

  it('binds admission metadata before accepting a status', async () => {
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => response({ ...STATUS, pageCount: 2 }),
    });
    await assert.rejects(
      client.admit({
        accessToken: ACCESS_TOKEN,
        request: ADMISSION,
        idempotencyKey: 'admit-bind-key',
      }),
      (error: unknown) => {
        assertCode(error, 'invalid_response');
        return true;
      },
    );
  });

  it('binds retrieval to the exact requested ID and current contract', async () => {
    const envelope = JSON.parse(vector.serializedEnvelope) as Record<string, unknown>;
    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => response({ ...envelope, requestId: REQUEST_ID }),
      }).retrieve({ ...VECTOR_CONTEXT, accessToken: ACCESS_TOKEN }),
      (error: unknown) => {
        assertCode(error, 'invalid_response');
        return true;
      },
    );
    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => response({ ...envelope, contractVersion: '2026-08-27' }),
      }).retrieve({ ...VECTOR_CONTEXT, accessToken: ACCESS_TOKEN }),
      (error: unknown) => {
        assertCode(error, 'unsupported_contract');
        return true;
      },
    );
  });

  it('rejects invalid canonical timestamps and preserves an immutable canonical result', async () => {
    const badValues = [
      '2026-08-28',
      '2026-08-28T00:00:00Z',
      '2026-08-28T02:00:00.000+02:00',
      '2026-02-30T00:00:00.000Z',
      '2026-08-28T00:00:00.000',
    ];
    for (const timestamp of badValues) {
      assert.throws(
        () => {
          // Direct decoding keeps this test independent from HTTP response handling.
          decodeCloudRequestStatus({ ...STATUS, updatedAt: timestamp });
        },
        (error: unknown) =>
          error instanceof CloudRequestApiError && error.code === 'invalid_response',
      );
    }
    const envelope = JSON.parse(vector.serializedEnvelope) as Record<string, unknown>;
    const result = await new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => response(envelope),
    }).retrieve({ ...VECTOR_CONTEXT, accessToken: ACCESS_TOKEN });
    assert.equal(Object.isFrozen(result), true);
  });

  it('rejects plaintext artifact requests except through an explicit loopback development seam', async () => {
    let calls = 0;
    const artifact = fileLike([1, 2, 3, 4]);
    const remoteHttp = new CloudRequestApiClient({
      baseUrl: 'http://192.0.2.10',
      fetchImpl: async () => {
        calls += 1;
        return response(STATUS);
      },
      allowInsecureLoopbackForDevelopment: true,
    });
    assert.equal(remoteHttp.isConfigured(), false);
    await assert.rejects(
      remoteHttp.upload({
        ...CONTEXT,
        accessToken: ACCESS_TOKEN,
        artifact,
        idempotencyKey: 'http-key',
      }),
      (error: unknown) => {
        assertCode(error, 'api_unconfigured');
        return true;
      },
    );
    assert.equal(calls, 0);

    const loopback = new CloudRequestApiClient({
      baseUrl: 'http://127.0.0.1:8787',
      fetchImpl: async () => response(STATUS),
      allowInsecureLoopbackForDevelopment: true,
    });
    assert.equal(loopback.isConfigured(), true);
    await loopback.status({ ...CONTEXT, accessToken: ACCESS_TOKEN });
  });

  it('rejects invalid bodies and never retries a mutation', async () => {
    let calls = 0;
    const client = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => {
        calls += 1;
        return response(STATUS);
      },
    });
    await assert.rejects(
      client.upload({
        ...CONTEXT,
        accessToken: ACCESS_TOKEN,
        artifact: {
          size: 4,
          arrayBuffer: async () => new ArrayBuffer(4),
        } as unknown as CloudRequestUploadBody,
        idempotencyKey: 'body-key',
      }),
      (error: unknown) => {
        assertCode(error, 'upload_body_invalid');
        return true;
      },
    );
    assert.equal(calls, 0);
    const failing = new CloudRequestApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError('private health detail');
      },
    });
    await assert.rejects(
      failing.completeUpload({ ...CONTEXT, accessToken: ACCESS_TOKEN, idempotencyKey: 'same-key' }),
      (error: unknown) => {
        assertCode(error, 'offline');
        assert.ok(error instanceof CloudRequestApiError);
        assert.equal(error.message.includes('private'), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  });

  it('fails closed for chunked oversize, lying lengths, and bodies without readers', async () => {
    let cancelled = false;
    let oversizedReads = 0;
    const oversizedReader = {
      read: async () => {
        oversizedReads += 1;
        if (oversizedReads === 1) {
          return { done: false, value: new Uint8Array(MAX_CLOUD_REQUEST_RESPONSE_BYTES) };
        }
        return { done: false, value: new Uint8Array(1) };
      },
      cancel: async () => {
        cancelled = true;
      },
    };
    const oversizedResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => oversizedReader },
    } as unknown as Response;
    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => oversizedResponse,
      }).status({ ...CONTEXT, accessToken: ACCESS_TOKEN }),
      (error: unknown) => {
        assertCode(error, 'invalid_response');
        return true;
      },
    );
    assert.equal(cancelled, true);

    let lengthCancelled = false;
    const lying = new ReadableStream<Uint8Array>({
      cancel() {
        lengthCancelled = true;
      },
    });
    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () =>
          new Response(lying, {
            status: 200,
            headers: { 'content-length': String(MAX_CLOUD_REQUEST_RESPONSE_BYTES + 1) },
          }),
      }).status({ ...CONTEXT, accessToken: ACCESS_TOKEN }),
      (error: unknown) => {
        assertCode(error, 'invalid_response');
        return true;
      },
    );
    assert.equal(lengthCancelled, true);

    let noReaderCancelled = false;
    const noReaderResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        cancel: async () => {
          noReaderCancelled = true;
        },
      },
      text: () => {
        throw new Error('text fallback must not run');
      },
    } as unknown as Response;
    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => noReaderResponse,
      }).status({ ...CONTEXT, accessToken: ACCESS_TOKEN }),
      (error: unknown) => {
        assertCode(error, 'invalid_response');
        return true;
      },
    );
    assert.equal(noReaderCancelled, true);
  });

  it('cancels a stalled response reader on timeout and caller abort', async () => {
    const stalledResponse = () => {
      let cancelled = false;
      const reader = {
        read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        cancel: async () => {
          cancelled = true;
        },
      };
      return {
        response: {
          ok: true,
          status: 200,
          headers: new Headers(),
          body: { getReader: () => reader },
        } as unknown as Response,
        wasCancelled: () => cancelled,
      };
    };
    const timeout = stalledResponse();
    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        requestTimeoutMs: 5,
        fetchImpl: async () => timeout.response,
      }).status({ ...CONTEXT, accessToken: ACCESS_TOKEN }),
      (error: unknown) => {
        assertCode(error, 'request_timeout');
        return true;
      },
    );
    assert.equal(timeout.wasCancelled(), true);

    const caller = stalledResponse();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    await assert.rejects(
      new CloudRequestApiClient({
        baseUrl: 'https://api.example.test',
        fetchImpl: async () => caller.response,
      }).status({ ...CONTEXT, accessToken: ACCESS_TOKEN, signal: controller.signal }),
      (error: unknown) => {
        assertCode(error, 'request_cancelled');
        return true;
      },
    );
    assert.equal(caller.wasCancelled(), true);
  });

  it('rejects malformed status and deep JSON without retaining unknown content', () => {
    assert.throws(
      () => decodeCloudRequestStatus({ ...STATUS, unexpected: 'health-content' }),
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
});
