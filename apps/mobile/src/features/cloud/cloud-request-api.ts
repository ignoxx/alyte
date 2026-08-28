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
  readonly requireHttps?: boolean;
  readonly requestTimeoutMs?: number;
};

export type CloudRequestAdmissionInput = {
  readonly accessToken: string;
  readonly request: CloudRequestAdmissionRequest;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal | undefined;
};

export type CloudRequestUploadInput = {
  readonly accessToken: string;
  readonly requestId: string;
  /** Blob also covers File in Expo SDK 57 and preserves the caller's exact bytes. */
  readonly artifact: Blob;
  /** The byte count admitted by the backend; it must equal artifact.size. */
  readonly byteCount: number;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal | undefined;
};

export type CloudRequestMutationInput = {
  readonly accessToken: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly signal?: AbortSignal | undefined;
};

export type CloudRequestReadInput = {
  readonly accessToken: string;
  readonly requestId: string;
  readonly signal?: AbortSignal | undefined;
};

export type CloudRequestApi = {
  readonly admit: {
    (
      accessToken: string,
      request: CloudRequestAdmissionRequest,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<CloudRequestAdmissionResponse>;
    (input: CloudRequestAdmissionInput): Promise<CloudRequestAdmissionResponse>;
  };
  readonly upload: {
    (
      accessToken: string,
      requestId: string,
      artifact: Blob,
      byteCount: number,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<CloudRequestStatusResponse>;
    (input: CloudRequestUploadInput): Promise<CloudRequestStatusResponse>;
  };
  readonly completeUpload: {
    (
      accessToken: string,
      requestId: string,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<CloudRequestStatusResponse>;
    (input: CloudRequestMutationInput): Promise<CloudRequestStatusResponse>;
  };
  readonly status: {
    (
      accessToken: string,
      requestId: string,
      signal?: AbortSignal,
    ): Promise<CloudRequestStatusResponse>;
    (input: CloudRequestReadInput): Promise<CloudRequestStatusResponse>;
  };
  readonly retrieve: {
    (accessToken: string, requestId: string, signal?: AbortSignal): Promise<CloudResultEnvelope>;
    (input: CloudRequestReadInput): Promise<CloudResultEnvelope>;
  };
  readonly cancel: {
    (
      accessToken: string,
      requestId: string,
      idempotencyKey: string,
      signal?: AbortSignal,
    ): Promise<CloudRequestCancellationResponse>;
    (input: CloudRequestMutationInput): Promise<CloudRequestCancellationResponse>;
  };
};

/** The result envelope can be close to 350 KiB at its shared 256 KiB ciphertext limit. */
export const MAX_CLOUD_REQUEST_RESPONSE_BYTES = 512 * 1024;
/** Alias kept intentionally close to the account adapter's bounded-response terminology. */
export const MAX_RESPONSE_BODY_BYTES = MAX_CLOUD_REQUEST_RESPONSE_BYTES;
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
  return (
    typeof value === 'string' &&
    value.length <= MAX_CONTEXT_TEXT_LENGTH &&
    Number.isFinite(Date.parse(value))
  );
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

/** Strictly decode the shared Cloud Request status shape without retaining unknown fields. */
export function decodeCloudRequestStatus(value: unknown): CloudRequestStatusResponse {
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
  return Object.freeze(result) as unknown as CloudRequestStatusResponse;
}

export const decodeCloudRequestStatusResponse = decodeCloudRequestStatus;

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

function configuredUrl(value: string | null | undefined, requireHttps: boolean): string | null {
  const input = value?.trim();
  if (input === undefined || input.length === 0) return null;
  try {
    const url = new URL(input);
    if (
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0 ||
      (requireHttps && url.protocol !== 'https:')
    ) {
      return null;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function cloudRequestApiUrl(): string | null {
  return configuredUrl(process.env.EXPO_PUBLIC_API_URL, false);
}

export function productionCloudRequestApiUrl(): string | null {
  return configuredUrl(process.env.EXPO_PUBLIC_API_URL, true);
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

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > MAX_CLOUD_REQUEST_RESPONSE_BYTES) {
      throw new CloudRequestApiError(502, 'invalid_response');
    }
  }
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_CLOUD_REQUEST_RESPONSE_BYTES) {
      throw new CloudRequestApiError(502, 'invalid_response');
    }
    return body;
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_CLOUD_REQUEST_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded response error is the only observable outcome.
        }
        throw new CloudRequestApiError(502, 'invalid_response');
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } catch (error) {
    if (error instanceof CloudRequestApiError) throw error;
    throw new CloudRequestApiError(502, 'invalid_response');
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

function decodeEnvelopeResponse(value: unknown, requestId: string): CloudResultEnvelope {
  let envelope: CloudResultEnvelope;
  try {
    envelope = decodeCloudResultEnvelope(value);
  } catch {
    throw new CloudRequestApiError(502, 'invalid_response');
  }
  if (envelope.requestId !== requestId) {
    throw new CloudRequestApiError(502, 'invalid_response');
  }
  if (envelope.contractVersion !== CONTRACT_VERSION) {
    throw new CloudRequestApiError(502, 'unsupported_contract');
  }
  return envelope;
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

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
      options.requireHttps === true,
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

  async admit(
    accessTokenOrInput: string | CloudRequestAdmissionInput,
    request?: CloudRequestAdmissionRequest,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<CloudRequestAdmissionResponse> {
    const input: CloudRequestAdmissionInput =
      typeof accessTokenOrInput === 'string'
        ? {
            accessToken: accessTokenOrInput,
            request: request as CloudRequestAdmissionRequest,
            idempotencyKey: idempotencyKey as string,
            signal,
          }
        : accessTokenOrInput;
    validateAccessToken(input.accessToken);
    const admission = validateAdmission(input.request);
    validateMutationKey(input.idempotencyKey);
    return this.request(
      CLOUD_REQUESTS_PATH,
      {
        method: 'POST',
        accessToken: input.accessToken,
        idempotencyKey: input.idempotencyKey,
        body: JSON.stringify({
          operation: admission.operation,
          byteCount: admission.byteCount,
          pageCount: admission.pageCount,
          devicePublicKeyJwk: admission.devicePublicKeyJwk,
          contractVersion: admission.contractVersion,
        }),
        signal: input.signal,
      },
      decodeCloudRequestStatus,
      'admit',
    );
  }

  async upload(
    accessTokenOrInput: string | CloudRequestUploadInput,
    requestId?: string,
    artifact?: Blob,
    byteCountOrKey?: number | string,
    idempotencyKeyOrSignal?: string | number | AbortSignal,
    signal?: AbortSignal,
  ): Promise<CloudRequestStatusResponse> {
    const input: CloudRequestUploadInput =
      typeof accessTokenOrInput === 'string'
        ? {
            accessToken: accessTokenOrInput,
            requestId: requestId as string,
            artifact: artifact as Blob,
            byteCount:
              typeof byteCountOrKey === 'number'
                ? byteCountOrKey
                : typeof idempotencyKeyOrSignal === 'number'
                  ? idempotencyKeyOrSignal
                  : ((artifact as Blob | undefined)?.size ?? 0),
            idempotencyKey:
              typeof byteCountOrKey === 'string'
                ? byteCountOrKey
                : (idempotencyKeyOrSignal as string),
            signal:
              typeof byteCountOrKey === 'number'
                ? signal
                : typeof idempotencyKeyOrSignal === 'number'
                  ? signal
                  : (idempotencyKeyOrSignal as AbortSignal | undefined),
          }
        : accessTokenOrInput;
    validateAccessToken(input.accessToken);
    validateRequestIdOrThrow(input.requestId);
    validateMutationKey(input.idempotencyKey);
    if (!isBlob(input.artifact)) {
      throw new CloudRequestApiError(0, 'upload_body_invalid');
    }
    if (!validInteger(input.byteCount, 1, CLOUD_REQUEST_MAX_BYTES)) {
      throw new CloudRequestApiError(0, 'upload_too_large');
    }
    if (!validInteger(input.artifact.size, 1, CLOUD_REQUEST_MAX_BYTES)) {
      throw new CloudRequestApiError(0, 'upload_too_large');
    }
    if (input.artifact.size !== input.byteCount) {
      throw new CloudRequestApiError(0, 'upload_size_mismatch');
    }
    return this.request(
      pathForRequest(CLOUD_REQUEST_UPLOAD_PATH, input.requestId),
      {
        method: 'PUT',
        accessToken: input.accessToken,
        idempotencyKey: input.idempotencyKey,
        body: input.artifact,
        contentType: CLOUD_REQUEST_UPLOAD_CONTENT_TYPE,
        signal: input.signal,
      },
      decodeCloudRequestStatus,
      'upload',
    );
  }

  async completeUpload(
    accessTokenOrInput: string | CloudRequestMutationInput,
    requestId?: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<CloudRequestStatusResponse> {
    const input: CloudRequestMutationInput =
      typeof accessTokenOrInput === 'string'
        ? {
            accessToken: accessTokenOrInput,
            requestId: requestId as string,
            idempotencyKey: idempotencyKey as string,
            signal,
          }
        : accessTokenOrInput;
    return this.mutationStatus(CLOUD_REQUEST_COMPLETE_UPLOAD_PATH, input, 'complete');
  }

  async status(
    accessTokenOrInput: string | CloudRequestReadInput,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<CloudRequestStatusResponse> {
    const input: CloudRequestReadInput =
      typeof accessTokenOrInput === 'string'
        ? { accessToken: accessTokenOrInput, requestId: requestId as string, signal }
        : accessTokenOrInput;
    validateRead(input);
    return this.request(
      pathForRequest(CLOUD_REQUEST_STATUS_PATH, input.requestId),
      { method: 'GET', accessToken: input.accessToken, signal: input.signal },
      decodeCloudRequestStatus,
      'status',
    );
  }

  async retrieve(
    accessTokenOrInput: string | CloudRequestReadInput,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<CloudResultEnvelope> {
    const input: CloudRequestReadInput =
      typeof accessTokenOrInput === 'string'
        ? { accessToken: accessTokenOrInput, requestId: requestId as string, signal }
        : accessTokenOrInput;
    validateRead(input);
    return this.request(
      pathForRequest(CLOUD_REQUEST_RESULT_PATH, input.requestId),
      { method: 'GET', accessToken: input.accessToken, signal: input.signal },
      (value) => decodeEnvelopeResponse(value, input.requestId),
      'retrieve',
    );
  }

  async cancel(
    accessTokenOrInput: string | CloudRequestMutationInput,
    requestId?: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<CloudRequestCancellationResponse> {
    const input: CloudRequestMutationInput =
      typeof accessTokenOrInput === 'string'
        ? {
            accessToken: accessTokenOrInput,
            requestId: requestId as string,
            idempotencyKey: idempotencyKey as string,
            signal,
          }
        : accessTokenOrInput;
    return this.mutationStatus(CLOUD_REQUEST_CANCEL_PATH, input, 'cancel');
  }

  private mutationStatus(
    path: string,
    input: CloudRequestMutationInput,
    operation: 'complete' | 'cancel',
  ): Promise<CloudRequestStatusResponse> {
    validateAccessToken(input.accessToken);
    validateRequestIdOrThrow(input.requestId);
    validateMutationKey(input.idempotencyKey);
    return this.request(
      pathForRequest(path, input.requestId),
      {
        method: 'POST',
        accessToken: input.accessToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      decodeCloudRequestStatus,
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
      readonly body?: string | Blob;
      readonly signal?: AbortSignal | undefined;
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
    let removeCallerAbortListener: (() => void) | null = null;
    if (options.signal !== undefined) {
      const abortCaller = () => timeoutController.abort();
      options.signal.addEventListener('abort', abortCaller, { once: true });
      removeCallerAbortListener = () => options.signal?.removeEventListener('abort', abortCaller);
    }
    const abortPromise = new Promise<never>((_, reject) => {
      timeoutController.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('cloud_request_aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });
    const init: RequestInit = { method: options.method, headers, signal: timeoutController.signal };
    if (options.body !== undefined) init.body = options.body;

    try {
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
        const textPromise = boundedResponseText(response);
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
    }
  }
}

export const CloudRequestClient = CloudRequestApiClient;

export function createCloudRequestApi(
  options: CloudRequestApiClientOptions = {},
): CloudRequestApiClient {
  return new CloudRequestApiClient(options);
}

function validateRead(input: CloudRequestReadInput): void {
  validateAccessToken(input.accessToken);
  validateRequestIdOrThrow(input.requestId);
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}
