import {
  CLOUD_REQUEST_CANCEL_PATH,
  CLOUD_REQUEST_COMPLETE_UPLOAD_PATH,
  CLOUD_REQUEST_MAX_BYTES,
  CLOUD_REQUEST_MAX_PAGES,
  CLOUD_REQUEST_RESULT_PATH,
  CLOUD_REQUEST_STATUS_PATH,
  CLOUD_REQUEST_UPLOAD_CONTENT_TYPE,
  CLOUD_REQUEST_UPLOAD_PATH,
  CLOUD_REQUESTS_PATH,
  CONTRACT_VERSION,
  decodeCloudResultEnvelope,
  type CloudRequestAdmissionRequest,
  type CloudRequestAdmissionResponse,
  type CloudRequestCancellationResponse,
  type CloudRequestOperation,
  type CloudRequestStatusResponse,
  type CloudResultEnvelope,
  type P256PublicKeyJwk,
} from '@alyte/contracts';

/**
 * The mobile transport deliberately exposes a closed, non-sensitive error surface. The server's
 * message, request identifiers, headers, tokens, and response body never become an Error field.
 */
export type CloudRequestApiFailureCode =
  | 'api_unconfigured'
  | 'auth_required'
  | 'request_cancelled'
  | 'request_timeout'
  | 'offline'
  | 'not_found'
  | 'not_ready'
  | 'expired'
  | 'failed'
  | 'unsupported_contract'
  | 'invalid_request'
  | 'upload_body_invalid'
  | 'upload_content_type_invalid'
  | 'upload_size_mismatch'
  | 'upload_too_large'
  | 'invalid_response'
  | 'request_rejected';

export class CloudRequestApiError extends Error {
  override readonly name = 'CloudRequestApiError';

  constructor(
    readonly status: number,
    readonly code: CloudRequestApiFailureCode,
  ) {
    super(code);
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CloudRequestApiClientOptions = {
  readonly baseUrl?: string | null;
  readonly fetchImpl?: FetchLike;
  /** Development-only seam for an HTTP server bound to localhost. HTTPS remains the default. */
  readonly allowInsecureLoopbackForDevelopment?: boolean;
  readonly requestTimeoutMs?: number;
};

/** The complete request context that every successful status must match. */
export type CloudRequestContext = {
  readonly requestId: string;
  readonly operation: CloudRequestOperation;
  readonly byteCount: number;
  readonly pageCount: number;
  readonly contractVersion: typeof CONTRACT_VERSION;
};

type CloudRequestStatusContext = Pick<CloudRequestContext, 'requestId' | 'contractVersion'> &
  Partial<Pick<CloudRequestContext, 'operation' | 'byteCount' | 'pageCount'>>;

/**
 * A Blob/File-shaped body accepted by Expo's fetch implementation. The structural check is
 * intentional: expo-file-system File instances can come from a different JS realm than Blob.
 */
export type CloudRequestUploadBody = {
  readonly size: number;
  readonly type: string;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
  readonly stream?: (() => ReadableStream<Uint8Array>) | undefined;
};

export type CloudRequestAdmissionInput = {
  readonly accessToken: string;
  readonly request: CloudRequestAdmissionRequest;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal | undefined;
};

export type CloudRequestUploadInput = CloudRequestStatusContext & {
  readonly accessToken: string;
  readonly byteCount: number;
  readonly artifact: CloudRequestUploadBody;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal | undefined;
};

export type CloudRequestMutationInput = CloudRequestStatusContext & {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal | undefined;
};

export type CloudRequestReadInput = CloudRequestStatusContext & {
  readonly accessToken: string;
  readonly signal?: AbortSignal | undefined;
};

export type CloudRequestApi = {
  readonly admit: (input: CloudRequestAdmissionInput) => Promise<CloudRequestAdmissionResponse>;
  readonly upload: (input: CloudRequestUploadInput) => Promise<CloudRequestStatusResponse>;
  readonly completeUpload: (
    input: CloudRequestMutationInput,
  ) => Promise<CloudRequestStatusResponse>;
  readonly status: (input: CloudRequestReadInput) => Promise<CloudRequestStatusResponse>;
  readonly retrieve: (input: CloudRequestReadInput) => Promise<CloudResultEnvelope>;
  readonly cancel: (input: CloudRequestMutationInput) => Promise<CloudRequestCancellationResponse>;
};

/** The result envelope can be close to 350 KiB at its shared 256 KiB ciphertext limit. */
export const MAX_CLOUD_REQUEST_RESPONSE_BYTES = 512 * 1024;
export const MAX_CLOUD_REQUEST_JSON_DEPTH = 16;
export const MAX_CLOUD_REQUEST_JSON_VALUES = 4_096;
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
export const MAX_CONTEXT_TEXT_LENGTH = 128;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PRINTABLE_HEADER_PATTERN = /^[\x21-\x7E]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UTC_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const STATUS_KEYS = [
  'byteCount',
  'cancelledAt',
  'contractVersion',
  'createdAt',
  'expiredAt',
  'expiresAt',
  'failureCategory',
  'operation',
  'pageCount',
  'queuedAt',
  'requestId',
  'resultAvailable',
  'resultExpiresAt',
  'state',
  'updatedAt',
  'uploadedAt',
] as const;

const REQUIRED_STATUS_KEYS = [
  'byteCount',
  'cancelledAt',
  'contractVersion',
  'createdAt',
  'operation',
  'pageCount',
  'requestId',
  'state',
  'updatedAt',
] as const;

const REQUEST_STATES = [
  'awaiting-upload',
  'uploaded',
  'queued',
  'ready',
  'retrieved',
  'failed',
  'cancelled',
  'expired',
] as const;

const FAILURE_CATEGORIES = new Set([
  'provider_failure',
  'timeout',
  'safety_refusal',
  'malformed_output',
  'unusable_output',
  'cloud_result_cache_missing',
  'cloud_result_cache_invalid',
  'cloud_result_cache_conflict',
]);

type StatusRecord = Record<string, unknown>;

function isRecord(value: unknown): value is StatusRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: StatusRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function hasOnlyKnownKeys(value: StatusRecord, expected: readonly string[]): boolean {
  const keys = new Set(expected);
  return Object.keys(value).every((key) => keys.has(key));
}

function validBoundedText(
  value: unknown,
  maxLength: number,
  pattern = VERSION_PATTERN,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    pattern.test(value)
  );
}

function validRequestId(value: unknown): value is string {
  return validBoundedText(value, MAX_REQUEST_ID_LENGTH, REQUEST_ID_PATTERN);
}

function validIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    PRINTABLE_HEADER_PATTERN.test(value)
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function validBase64url(value: unknown, bytes: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== Math.ceil((bytes * 8) / 6) ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    return false;
  }
  const remainder = value.length % 4;
  if (remainder === 0) return true;
  const last = value.charCodeAt(value.length - 1);
  const sextet =
    last >= 0x41 && last <= 0x5a
      ? last - 0x41
      : last >= 0x61 && last <= 0x7a
        ? last - 0x61 + 26
        : last >= 0x30 && last <= 0x39
          ? last - 0x30 + 52
          : last === 0x2d
            ? 62
            : 63;
  return (remainder === 2 && (sextet & 0x0f) === 0) || (remainder === 3 && (sextet & 0x03) === 0);
}

function validPublicKey(value: unknown): value is P256PublicKeyJwk {
  return (
    isRecord(value) &&
    hasExactlyKeys(value, ['crv', 'kty', 'x', 'y']) &&
    value.kty === 'EC' &&
    value.crv === 'P-256' &&
    validBase64url(value.x, 32) &&
    validBase64url(value.y, 32)
  );
}

function invalidRequest(): never {
  throw new CloudRequestApiError(0, 'invalid_request');
}

function validateAccessToken(value: unknown): asserts value is string {
  if (!validBoundedText(value, 16_384, PRINTABLE_HEADER_PATTERN)) invalidRequest();
}

function validateRequestIdOrThrow(value: unknown): asserts value is string {
  if (!validRequestId(value)) invalidRequest();
}

function validateMutationKey(value: unknown): asserts value is string {
  if (!validIdempotencyKey(value)) invalidRequest();
}

function validateAdmission(value: unknown): CloudRequestAdmissionRequest {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, [
      'byteCount',
      'contractVersion',
      'devicePublicKeyJwk',
      'operation',
      'pageCount',
    ])
  ) {
    invalidRequest();
  }
  if (value.contractVersion !== CONTRACT_VERSION) {
    throw new CloudRequestApiError(0, 'unsupported_contract');
  }
  if (value.operation !== 'intake-image' && value.operation !== 'lab-report') invalidRequest();
  if (!validInteger(value.byteCount, 1, CLOUD_REQUEST_MAX_BYTES)) invalidRequest();
  if (!validInteger(value.pageCount, 1, CLOUD_REQUEST_MAX_PAGES)) invalidRequest();
  if (!validPublicKey(value.devicePublicKeyJwk)) invalidRequest();
  return {
    operation: value.operation,
    byteCount: value.byteCount,
    pageCount: value.pageCount,
    devicePublicKeyJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: value.devicePublicKeyJwk.x,
      y: value.devicePublicKeyJwk.y,
    },
    contractVersion: CONTRACT_VERSION,
  };
}

function statusKeys(value: StatusRecord): boolean {
  return (
    hasOnlyKnownKeys(value, STATUS_KEYS) &&
    REQUIRED_STATUS_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (!validTimestamp(value)) throw new CloudRequestApiError(502, 'invalid_response');
  return value;
}

type ExpectedStatusContext = Readonly<Partial<CloudRequestContext>>;

function ensureStatusContext(
  status: CloudRequestStatusResponse,
  expected: ExpectedStatusContext | undefined,
): void {
  // A well-formed response from another contract is not a sibling request response.
  if (status.contractVersion !== CONTRACT_VERSION) {
    throw new CloudRequestApiError(502, 'unsupported_contract');
  }
  if (
    (expected?.requestId !== undefined && status.requestId !== expected.requestId) ||
    (expected?.operation !== undefined && status.operation !== expected.operation) ||
    (expected?.byteCount !== undefined && status.byteCount !== expected.byteCount) ||
    (expected?.pageCount !== undefined && status.pageCount !== expected.pageCount) ||
    (expected?.contractVersion !== undefined && status.contractVersion !== expected.contractVersion)
  ) {
    throw new CloudRequestApiError(502, 'invalid_response');
  }
}

/** Strictly decode the shared Cloud Request status shape without retaining unknown fields. */
export function decodeCloudRequestStatus(
  value: unknown,
  expectedContext?: ExpectedStatusContext,
): CloudRequestStatusResponse {
  if (!isRecord(value) || !statusKeys(value)) {
    throw new CloudRequestApiError(502, 'invalid_response');
  }
  if (
    !validRequestId(value.requestId) ||
    (value.operation !== 'intake-image' && value.operation !== 'lab-report') ||
    !(REQUEST_STATES as readonly unknown[]).includes(value.state) ||
    !validInteger(value.byteCount, 1, CLOUD_REQUEST_MAX_BYTES) ||
    !validInteger(value.pageCount, 1, CLOUD_REQUEST_MAX_PAGES) ||
    !validBoundedText(value.contractVersion, MAX_CONTEXT_TEXT_LENGTH) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt) ||
    (value.cancelledAt !== null && !validTimestamp(value.cancelledAt))
  ) {
    throw new CloudRequestApiError(502, 'invalid_response');
  }

  const result: Record<string, unknown> = {
    requestId: value.requestId,
    operation: value.operation,
    state: value.state as CloudRequestStatusResponse['state'],
    byteCount: value.byteCount,
    pageCount: value.pageCount,
    contractVersion: value.contractVersion,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    cancelledAt: value.cancelledAt,
  };
  if (Object.prototype.hasOwnProperty.call(value, 'uploadedAt')) {
    result.uploadedAt = optionalTimestamp(value.uploadedAt);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'queuedAt')) {
    result.queuedAt = optionalTimestamp(value.queuedAt);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'resultAvailable')) {
    if (typeof value.resultAvailable !== 'boolean') {
      throw new CloudRequestApiError(502, 'invalid_response');
    }
    result.resultAvailable = value.resultAvailable;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'resultExpiresAt')) {
    result.resultExpiresAt = optionalTimestamp(value.resultExpiresAt);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'failureCategory')) {
    if (
      value.failureCategory !== null &&
      (typeof value.failureCategory !== 'string' ||
        value.failureCategory.length > MAX_CONTEXT_TEXT_LENGTH ||
        !FAILURE_CATEGORIES.has(value.failureCategory))
    ) {
      throw new CloudRequestApiError(502, 'invalid_response');
    }
    result.failureCategory = value.failureCategory;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'expiresAt')) {
    if (!validTimestamp(value.expiresAt)) throw new CloudRequestApiError(502, 'invalid_response');
    result.expiresAt = value.expiresAt;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'expiredAt')) {
    result.expiredAt = optionalTimestamp(value.expiredAt);
  }
  if (result.resultAvailable === true && result.state !== 'ready') {
    throw new CloudRequestApiError(502, 'invalid_response');
  }
  if (result.state === 'ready' && result.resultAvailable === false) {
    throw new CloudRequestApiError(502, 'invalid_response');
  }
  const status = Object.freeze(result) as unknown as CloudRequestStatusResponse;
  ensureStatusContext(status, expectedContext);
  return status;
}

function parseErrorCode(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['error']) ||
    !isRecord(value.error) ||
    !hasExactlyKeys(value.error, ['code', 'message'])
  ) {
    return null;
  }
  const code = value.error.code;
  const message = value.error.message;
  return typeof code === 'string' &&
    code.length > 0 &&
    code.length <= MAX_CONTEXT_TEXT_LENGTH &&
    VERSION_PATTERN.test(code) &&
    typeof message === 'string' &&
    message.length > 0 &&
    message.length <= MAX_CONTEXT_TEXT_LENGTH
    ? code
    : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function callerAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function pathForRequest(path: string, requestId: string): string {
  return path.replace(':requestId', encodeURIComponent(requestId));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function configuredUrl(
  value: string | null | undefined,
  allowInsecureLoopbackForDevelopment: boolean,
): string | null {
  const input = value?.trim();
  if (input === undefined || input.length === 0) return null;
  try {
    const url = new URL(input);
    const secure = url.protocol === 'https:';
    const allowedDevelopmentLoopback =
      allowInsecureLoopbackForDevelopment &&
      url.protocol === 'http:' &&
      isLoopbackHostname(url.hostname);
    if (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0 ||
      (!secure && !allowedDevelopmentLoopback)
    ) {
      return null;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function inspectJson(value: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let values = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    values += 1;
    if (values > MAX_CLOUD_REQUEST_JSON_VALUES || current.depth > MAX_CLOUD_REQUEST_JSON_DEPTH) {
      throw new CloudRequestApiError(502, 'invalid_response');
    }
    if (!isRecord(current.value) && !Array.isArray(current.value)) continue;
    const children = Array.isArray(current.value) ? current.value : Object.values(current.value);
    if (children.length > MAX_CLOUD_REQUEST_JSON_VALUES) {
      throw new CloudRequestApiError(502, 'invalid_response');
    }
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
}

function hasDuplicateJsonObjectKeys(value: string): boolean {
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 0x22) {
      const start = index;
      index += 1;
      for (; index < value.length; index += 1) {
        if (value.charCodeAt(index) === 0x5c) index += 1;
        else if (value.charCodeAt(index) === 0x22) break;
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
    if (value.charCodeAt(index) === 0x7b) stack.push(new Set<string>());
    else if (value.charCodeAt(index) === 0x5b) stack.push(null);
    else if (value.charCodeAt(index) === 0x7d || value.charCodeAt(index) === 0x5d) stack.pop();
  }
  return false;
}

function parseBoundedJson(value: string): unknown {
  try {
    if (hasDuplicateJsonObjectKeys(value)) {
      throw new CloudRequestApiError(502, 'invalid_response');
    }
    const parsed = JSON.parse(value) as unknown;
    inspectJson(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof CloudRequestApiError) throw error;
    throw new CloudRequestApiError(502, 'invalid_response');
  }
}

type ResponseReader = ReadableStreamDefaultReader<Uint8Array>;

async function cancelResponseBody(response: Response, reader?: ResponseReader): Promise<void> {
  try {
    if (reader !== undefined) {
      await reader.cancel();
      return;
    }
    const cancel = response.body?.cancel;
    if (typeof cancel === 'function') await cancel.call(response.body);
  } catch {
    // The closed transport error is the only observable outcome.
  }
}

/** Read only through a streaming reader; an unbounded text() fallback is deliberately forbidden. */
async function boundedResponseText(response: Response, abortSignal?: AbortSignal): Promise<string> {
  let reader: ResponseReader | undefined;
  let removeAbortListener: (() => void) | undefined;
  let completed = false;
  const cancelReader = (): Promise<void> => cancelResponseBody(response, reader);

  try {
    try {
      reader = response.body?.getReader?.() as ResponseReader | undefined;
    } catch {
      await cancelResponseBody(response);
      throw new CloudRequestApiError(502, 'invalid_response');
    }
    if (reader === undefined) {
      await cancelResponseBody(response);
      throw new CloudRequestApiError(502, 'invalid_response');
    }

    if (abortSignal !== undefined) {
      const abortBodyRead = () => {
        // Remove the listener immediately on abort so a stalled native reader cannot retain it.
        removeAbortListener?.();
        removeAbortListener = undefined;
        void cancelReader();
      };
      if (abortSignal.aborted) abortBodyRead();
      else {
        abortSignal.addEventListener('abort', abortBodyRead, { once: true });
        removeAbortListener = () => abortSignal.removeEventListener('abort', abortBodyRead);
      }
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength)) {
        await cancelReader();
        throw new CloudRequestApiError(502, 'invalid_response');
      }
      const declared = Number(contentLength);
      if (!Number.isSafeInteger(declared) || declared > MAX_CLOUD_REQUEST_RESPONSE_BYTES) {
        await cancelReader();
        throw new CloudRequestApiError(502, 'invalid_response');
      }
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let body = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CLOUD_REQUEST_RESPONSE_BYTES) {
        await cancelReader();
        throw new CloudRequestApiError(502, 'invalid_response');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    completed = true;
    return body;
  } catch (error) {
    if (!completed) await cancelReader();
    if (error instanceof CloudRequestApiError) throw error;
    throw new CloudRequestApiError(502, 'invalid_response');
  } finally {
    removeAbortListener?.();
  }
}

function mapHttpFailure(
  status: number,
  serverCode: string | null,
  operation: 'admit' | 'upload' | 'complete' | 'status' | 'retrieve' | 'cancel',
): CloudRequestApiFailureCode {
  if (serverCode === 'cloud_request_contract_version_unsupported' || status === 426) {
    return 'unsupported_contract';
  }
  if (serverCode === 'cloud_request_not_found') return 'not_found';
  if (serverCode === 'cloud_request_expired') return 'expired';
  if (serverCode === 'cloud_upload_body_invalid') return 'upload_body_invalid';
  if (serverCode === 'cloud_upload_content_type_invalid') return 'upload_content_type_invalid';
  if (serverCode === 'cloud_upload_too_large') return 'upload_too_large';
  if (serverCode === 'cloud_upload_too_small') return 'upload_size_mismatch';
  if (serverCode === 'cloud_result_not_available') {
    return operation === 'retrieve' ? 'not_ready' : 'request_rejected';
  }
  if (serverCode === 'cloud_request_not_cancellable') return 'request_rejected';
  if (
    serverCode === 'provider_failure' ||
    serverCode === 'timeout' ||
    serverCode === 'safety_refusal' ||
    serverCode === 'malformed_output' ||
    serverCode === 'unusable_output'
  ) {
    return 'failed';
  }
  if (status === 401) return 'auth_required';
  if (status === 404) return operation === 'retrieve' ? 'not_ready' : 'not_found';
  return 'request_rejected';
}

function decodeEnvelopeResponse(
  value: unknown,
  expected: CloudRequestStatusContext,
): CloudResultEnvelope {
  let envelope: CloudResultEnvelope;
  try {
    envelope = decodeCloudResultEnvelope(value);
  } catch {
    throw new CloudRequestApiError(502, 'invalid_response');
  }
  if (
    envelope.contractVersion !== CONTRACT_VERSION ||
    envelope.contractVersion !== expected.contractVersion
  ) {
    throw new CloudRequestApiError(502, 'unsupported_contract');
  }
  if (envelope.requestId !== expected.requestId) {
    throw new CloudRequestApiError(502, 'invalid_response');
  }
  return envelope;
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function isUploadBody(value: unknown): value is CloudRequestUploadBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CloudRequestUploadBody>;
  return (
    'size' in candidate &&
    typeof candidate.type === 'string' &&
    typeof candidate.arrayBuffer === 'function' &&
    (candidate.stream === undefined || typeof candidate.stream === 'function')
  );
}

function octetStreamBody(body: CloudRequestUploadBody): CloudRequestUploadBody {
  if (body.type === CLOUD_REQUEST_UPLOAD_CONTENT_TYPE) return body;
  // Expo SDK 57's fetch intentionally overrides Content-Type with body.type for Blob-like bodies.
  // Keep the original bytes and delegate arrayBuffer without base64/JSON conversion; this single
  // structural wrapper changes only the media-type metadata that Expo uses for its native request.
  return {
    get size() {
      return body.size;
    },
    type: CLOUD_REQUEST_UPLOAD_CONTENT_TYPE,
    arrayBuffer: () => body.arrayBuffer(),
    stream: body.stream === undefined ? undefined : () => body.stream!(),
  };
}

function readUploadBodySize(body: CloudRequestUploadBody): number {
  try {
    return body.size;
  } catch {
    throw new CloudRequestApiError(0, 'upload_body_invalid');
  }
}

/**
 * Focused HTTP adapter for the Cloud Request admission/upload/result lifecycle. It has no
 * persistence, scheduler, retry, authentication refresh, decryption, or result application.
 */
export class CloudRequestApiClient implements CloudRequestApi {
  private readonly baseUrl: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: CloudRequestApiClientOptions = {}) {
    const hasBaseUrlOverride = Object.prototype.hasOwnProperty.call(options, 'baseUrl');
    this.baseUrl = configuredUrl(
      hasBaseUrlOverride ? options.baseUrl : process.env.EXPO_PUBLIC_API_URL,
      options.allowInsecureLoopbackForDevelopment === true,
    );
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.requestTimeoutMs =
      typeof options.requestTimeoutMs === 'number' &&
      Number.isFinite(options.requestTimeoutMs) &&
      options.requestTimeoutMs > 0
        ? Math.min(options.requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS)
        : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  isConfigured(): boolean {
    return this.baseUrl !== null;
  }

  async admit(input: CloudRequestAdmissionInput): Promise<CloudRequestAdmissionResponse> {
    validateAccessToken(input.accessToken);
    const admission = validateAdmission(input.request);
    validateMutationKey(input.idempotencyKey);
    return this.request(
      CLOUD_REQUESTS_PATH,
      {
        method: 'POST',
        accessToken: input.accessToken,
        idempotencyKey: input.idempotencyKey,
        body: JSON.stringify(admission),
        signal: input.signal,
      },
      (value) =>
        decodeCloudRequestStatus(value, {
          operation: admission.operation,
          byteCount: admission.byteCount,
          pageCount: admission.pageCount,
          contractVersion: CONTRACT_VERSION,
        }),
      'admit',
    );
  }

  async upload(input: CloudRequestUploadInput): Promise<CloudRequestStatusResponse> {
    validateContext(input);
    validateMutationKey(input.idempotencyKey);
    if (!isUploadBody(input.artifact)) {
      throw new CloudRequestApiError(0, 'upload_body_invalid');
    }
    const initialSize = readUploadBodySize(input.artifact);
    if (!validInteger(input.byteCount, 1, CLOUD_REQUEST_MAX_BYTES)) {
      throw new CloudRequestApiError(0, 'upload_too_large');
    }
    if (!validInteger(initialSize, 1, CLOUD_REQUEST_MAX_BYTES)) {
      throw new CloudRequestApiError(0, 'upload_too_large');
    }
    if (initialSize !== input.byteCount) {
      throw new CloudRequestApiError(0, 'upload_size_mismatch');
    }
    let bodyForFetch: CloudRequestUploadBody;
    try {
      bodyForFetch = octetStreamBody(input.artifact);
    } catch {
      throw new CloudRequestApiError(0, 'upload_body_invalid');
    }
    return this.request(
      pathForRequest(CLOUD_REQUEST_UPLOAD_PATH, input.requestId),
      {
        method: 'PUT',
        accessToken: input.accessToken,
        idempotencyKey: input.idempotencyKey,
        body: bodyForFetch,
        contentType: CLOUD_REQUEST_UPLOAD_CONTENT_TYPE,
        signal: input.signal,
        beforeFetch: () => {
          // Re-read at the last safe moment. A mutable File-like body must fail closed.
          const finalSize = readUploadBodySize(input.artifact);
          if (finalSize !== initialSize || finalSize !== input.byteCount) {
            throw new CloudRequestApiError(0, 'upload_size_mismatch');
          }
        },
      },
      (value) => decodeCloudRequestStatus(value, input),
      'upload',
    );
  }

  async completeUpload(input: CloudRequestMutationInput): Promise<CloudRequestStatusResponse> {
    return this.mutationStatus(CLOUD_REQUEST_COMPLETE_UPLOAD_PATH, input, 'complete');
  }

  async status(input: CloudRequestReadInput): Promise<CloudRequestStatusResponse> {
    validateRead(input);
    return this.request(
      pathForRequest(CLOUD_REQUEST_STATUS_PATH, input.requestId),
      { method: 'GET', accessToken: input.accessToken, signal: input.signal },
      (value) => decodeCloudRequestStatus(value, input),
      'status',
    );
  }

  async retrieve(input: CloudRequestReadInput): Promise<CloudResultEnvelope> {
    validateRead(input);
    return this.request(
      pathForRequest(CLOUD_REQUEST_RESULT_PATH, input.requestId),
      { method: 'GET', accessToken: input.accessToken, signal: input.signal },
      (value) => decodeEnvelopeResponse(value, input),
      'retrieve',
    );
  }

  async cancel(input: CloudRequestMutationInput): Promise<CloudRequestCancellationResponse> {
    return this.mutationStatus(CLOUD_REQUEST_CANCEL_PATH, input, 'cancel');
  }

  private mutationStatus(
    path: string,
    input: CloudRequestMutationInput,
    operation: 'complete' | 'cancel',
  ): Promise<CloudRequestStatusResponse> {
    validateContext(input);
    validateMutationKey(input.idempotencyKey);
    return this.request(
      pathForRequest(path, input.requestId),
      {
        method: 'POST',
        accessToken: input.accessToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      (value) => decodeCloudRequestStatus(value, input),
      operation,
    );
  }

  private async request<T>(
    path: string,
    options: {
      readonly method: 'GET' | 'POST' | 'PUT';
      readonly accessToken: string;
      readonly idempotencyKey?: string;
      readonly contentType?: string;
      readonly body?: string | CloudRequestUploadBody;
      readonly signal?: AbortSignal | undefined;
      readonly beforeFetch?: () => void;
    },
    decode: (value: unknown) => T,
    operation: 'admit' | 'upload' | 'complete' | 'status' | 'retrieve' | 'cancel',
  ): Promise<T> {
    if (this.baseUrl === null) throw new CloudRequestApiError(0, 'api_unconfigured');
    if (options.signal?.aborted === true) {
      throw new CloudRequestApiError(0, 'request_cancelled');
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${options.accessToken}`,
    };
    if (options.contentType !== undefined) headers['Content-Type'] = options.contentType;
    else if (typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    let removeCallerAbortListener: (() => void) | undefined;
    if (options.signal !== undefined) {
      const abortCaller = () => timeoutController.abort();
      options.signal.addEventListener('abort', abortCaller, { once: true });
      removeCallerAbortListener = () => options.signal?.removeEventListener('abort', abortCaller);
    }
    let removeAbortPromiseListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      const rejectAbort = () => {
        const error = new Error('cloud_request_aborted');
        error.name = 'AbortError';
        reject(error);
      };
      timeoutController.signal.addEventListener('abort', rejectAbort, { once: true });
      removeAbortPromiseListener = () =>
        timeoutController.signal.removeEventListener('abort', rejectAbort);
    });
    const init: RequestInit = { method: options.method, headers, signal: timeoutController.signal };
    if (options.body !== undefined) init.body = options.body as BodyInit;

    try {
      options.beforeFetch?.();
      let fetchPromise: Promise<Response>;
      try {
        fetchPromise = Promise.resolve(this.fetchImpl(`${this.baseUrl}${path}`, init));
      } catch {
        throw new CloudRequestApiError(0, 'offline');
      }
      void fetchPromise.catch(() => undefined);
      const response = await Promise.race([fetchPromise, abortPromise]).catch((error: unknown) => {
        if (isAbortError(error)) {
          throw new CloudRequestApiError(
            0,
            callerAborted(options.signal) ? 'request_cancelled' : 'request_timeout',
          );
        }
        throw new CloudRequestApiError(0, 'offline');
      });

      let payload: unknown;
      try {
        const textPromise = boundedResponseText(response, timeoutController.signal);
        void textPromise.catch(() => undefined);
        const body = await Promise.race([textPromise, abortPromise]);
        if (body.trim().length === 0) {
          throw new CloudRequestApiError(502, 'invalid_response');
        }
        payload = parseBoundedJson(body);
      } catch (error) {
        if (error instanceof CloudRequestApiError) throw error;
        if (isAbortError(error)) {
          throw new CloudRequestApiError(
            0,
            callerAborted(options.signal) ? 'request_cancelled' : 'request_timeout',
          );
        }
        throw new CloudRequestApiError(502, 'invalid_response');
      }
      if (!response.ok) {
        throw new CloudRequestApiError(
          response.status,
          mapHttpFailure(response.status, parseErrorCode(payload), operation),
        );
      }
      return decode(payload);
    } finally {
      clearTimeout(timeoutId);
      removeCallerAbortListener?.();
      removeAbortPromiseListener?.();
    }
  }
}

function validateContext(
  input: CloudRequestStatusContext & { readonly accessToken: string },
): void {
  validateAccessToken(input.accessToken);
  validateRequestIdOrThrow(input.requestId);
  if (input.contractVersion !== CONTRACT_VERSION) {
    throw new CloudRequestApiError(0, 'unsupported_contract');
  }
  if (
    input.operation !== undefined &&
    input.operation !== 'intake-image' &&
    input.operation !== 'lab-report'
  ) {
    invalidRequest();
  }
  if (input.byteCount !== undefined && !validInteger(input.byteCount, 1, CLOUD_REQUEST_MAX_BYTES)) {
    invalidRequest();
  }
  if (input.pageCount !== undefined && !validInteger(input.pageCount, 1, CLOUD_REQUEST_MAX_PAGES)) {
    invalidRequest();
  }
}

function validateRead(input: CloudRequestReadInput): void {
  validateContext(input);
}
