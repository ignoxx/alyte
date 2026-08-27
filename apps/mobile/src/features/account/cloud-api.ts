import {
  APPLE_EXCHANGE_PATH,
  CONSENT_POLICY_VERSION,
  type AccountAuditEvent,
  type AccountConsent,
  type AccountDeletionResponse,
  type AccountExportResponse,
  type AccountOperation,
  type AccountSession,
  type ApiErrorResponse,
  type SessionResponse,
  type SignOutResponse,
} from '@alyte/contracts';

export type CloudApiFailureCode =
  | 'api_unconfigured'
  | 'offline'
  | 'request_cancelled'
  | 'request_timeout'
  | 'invalid_response'
  | 'identity_cancelled'
  | 'apple_unavailable'
  | 'identity_token_required'
  | 'nonce_required'
  | 'nonce_invalid'
  | 'nonce_replayed'
  | 'nonce_unavailable'
  | 'auth_contract_version_unsupported'
  | string;

export class CloudApiError extends Error {
  readonly status: number;
  readonly code: CloudApiFailureCode;

  constructor(status: number, code: CloudApiFailureCode) {
    super(code);
    this.name = 'CloudApiError';
    this.status = status;
    this.code = code;
  }
}

export type CloudApi = {
  readonly isConfigured?: () => boolean;
  readonly exchangeApple: (
    identityToken: string,
    rawNonce: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ) => Promise<SessionResponse>;
  readonly refresh: (
    refreshToken: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ) => Promise<SessionResponse>;
  readonly signOut: (
    accessToken: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ) => Promise<SignOutResponse>;
  readonly exportAccount: (
    accessToken: string,
    signal?: AbortSignal,
  ) => Promise<AccountExportResponse>;
  readonly deleteAccount: (
    accessToken: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ) => Promise<AccountDeletionResponse>;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type CloudApiClientOptions = {
  readonly baseUrl?: string | null;
  readonly fetchImpl?: FetchLike;
  readonly idempotencyKey?: () => string;
  readonly requireHttps?: boolean;
  readonly requestTimeoutMs?: number;
};

const defaultFetch: FetchLike = (input, init) => fetch(input, init);
export const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
export const MAX_ACCOUNT_EXPORT_ITEMS = 512;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

function configuredUrl(value: string | null | undefined, requireHttps = false): string | null {
  const url = value?.trim();
  if (url === undefined || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hostname.length === 0) {
      return null;
    }
    if (requireHttps && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function cloudApiUrl(): string | null {
  return configuredUrl(process.env.EXPO_PUBLIC_API_URL);
}

export function productionCloudApiUrl(): string | null {
  return configuredUrl(process.env.EXPO_PUBLIC_API_URL, true);
}

export function createIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto);
  return `alyte-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNT_EXPORT_ITEMS) {
    throw new CloudApiError(502, `invalid_${field}`);
  }
  return value;
}

function text(value: unknown, field: string, maxLength = 16_384): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new CloudApiError(502, `invalid_${field}`);
  }
  return value;
}

function iso(value: unknown, field: string): string {
  const result = text(value, field, 128);
  if (!Number.isFinite(Date.parse(result))) throw new CloudApiError(502, `invalid_${field}`);
  return result;
}

function decodeSession(value: unknown): SessionResponse {
  if (!isRecord(value)) throw new CloudApiError(502, 'invalid_response');
  if (value.tokenType !== 'Bearer') throw new CloudApiError(502, 'invalid_token_type');
  return {
    accountId: text(value.accountId, 'account_id', 256),
    accessToken: text(value.accessToken, 'access_token'),
    refreshToken: text(value.refreshToken, 'refresh_token'),
    tokenType: 'Bearer',
    accessTokenExpiresAt: iso(value.accessTokenExpiresAt, 'access_expiry'),
    refreshTokenExpiresAt: iso(value.refreshTokenExpiresAt, 'refresh_expiry'),
  };
}

function decodeSignOut(value: unknown): SignOutResponse {
  if (!isRecord(value) || value.signedOut !== true) {
    throw new CloudApiError(502, 'invalid_response');
  }
  return { signedOut: true };
}

function decodeDelete(value: unknown): AccountDeletionResponse {
  if (!isRecord(value) || value.deleted !== true) {
    throw new CloudApiError(502, 'invalid_response');
  }
  return { deleted: true };
}

function decodeConsent(value: unknown): AccountConsent {
  if (!isRecord(value)) throw new CloudApiError(502, 'invalid_consent');
  return {
    policyVersion: text(value.policyVersion, 'policy_version', 128),
    acceptedAt: iso(value.acceptedAt, 'consent_date'),
  };
}

function decodeSessionStatus(value: unknown): AccountSession['status'] {
  if (value === 'active' || value === 'revoked' || value === 'expired') return value;
  throw new CloudApiError(502, 'invalid_session_status');
}

function decodeSessionMetadata(value: unknown): AccountSession {
  if (!isRecord(value)) throw new CloudApiError(502, 'invalid_session');
  return {
    id: text(value.id, 'session_id', 256),
    familyId: text(value.familyId, 'session_family_id', 256),
    status: decodeSessionStatus(value.status),
    createdAt: iso(value.createdAt, 'session_created_at'),
    accessExpiresAt: iso(value.accessExpiresAt, 'session_access_expiry'),
    refreshExpiresAt: iso(value.refreshExpiresAt, 'session_refresh_expiry'),
    revokedAt: value.revokedAt === null ? null : iso(value.revokedAt, 'session_revoked_at'),
  };
}

function decodeOperation(value: unknown): AccountOperation {
  if (!isRecord(value)) throw new CloudApiError(502, 'invalid_operation');
  const operation = value.operation;
  if (
    operation !== 'auth.apple.exchange' &&
    operation !== 'auth.refresh' &&
    operation !== 'auth.sign-out' &&
    operation !== 'account.delete'
  ) {
    throw new CloudApiError(502, 'invalid_operation');
  }
  if (
    typeof value.responseStatus !== 'number' ||
    !Number.isInteger(value.responseStatus) ||
    value.responseStatus < 100 ||
    value.responseStatus > 599
  ) {
    throw new CloudApiError(502, 'invalid_operation_status');
  }
  return {
    operation,
    responseStatus: value.responseStatus,
    createdAt: iso(value.createdAt, 'operation_created_at'),
    expiresAt: iso(value.expiresAt, 'operation_expiry'),
  };
}

function decodeAuditEvent(value: unknown): AccountAuditEvent {
  if (!isRecord(value) || (value.type !== 'account.exported' && value.type !== 'account.deleted')) {
    throw new CloudApiError(502, 'invalid_audit_event');
  }
  return { type: value.type, occurredAt: iso(value.occurredAt, 'audit_date') };
}

export function decodeAccountExport(value: unknown): AccountExportResponse {
  if (!isRecord(value) || !Array.isArray(value.consents) || !Array.isArray(value.sessions)) {
    throw new CloudApiError(502, 'invalid_response');
  }
  if (!Array.isArray(value.operations) || !Array.isArray(value.auditEvents)) {
    throw new CloudApiError(502, 'invalid_response');
  }
  const consents = boundedArray(value.consents, 'consents');
  const sessions = boundedArray(value.sessions, 'sessions');
  const operations = boundedArray(value.operations, 'operations');
  const auditEvents = boundedArray(value.auditEvents, 'audit_events');
  return {
    accountId: text(value.accountId, 'account_id', 256),
    createdAt: iso(value.createdAt, 'account_created_at'),
    // The Apple subject is decoded for the typed contract but is intentionally never rendered by
    // the mobile UI. It is an opaque server-side identity, not a profile field.
    appleSubject: text(value.appleSubject, 'apple_subject', 512),
    consents: consents.map(decodeConsent),
    sessions: sessions.map(decodeSessionMetadata),
    operations: operations.map(decodeOperation),
    auditEvents: auditEvents.map(decodeAuditEvent),
  };
}

function decodeApiError(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const error = value as Partial<ApiErrorResponse>;
  const code = error.error?.code;
  return typeof code === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(code) ? code : null;
}

/**
 * HTTP adapter for the versioned identity/account routes. Response bodies are decoded here and
 * only bounded error codes cross into the service; raw server bodies never reach UI or logs.
 */
export class CloudApiClient implements CloudApi {
  private readonly baseUrl: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly idempotencyKey: () => string;
  private readonly requestTimeoutMs: number;

  constructor(options: CloudApiClientOptions = {}) {
    const hasBaseUrlOverride = Object.prototype.hasOwnProperty.call(options, 'baseUrl');
    const baseUrl = hasBaseUrlOverride ? options.baseUrl : cloudApiUrl();
    this.baseUrl = configuredUrl(baseUrl, options.requireHttps === true);
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.idempotencyKey = options.idempotencyKey ?? createIdempotencyKey;
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

  exchangeApple(
    identityToken: string,
    rawNonce: string,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ) {
    return this.request(
      APPLE_EXCHANGE_PATH,
      {
        method: 'POST',
        body: JSON.stringify({
          identityToken,
          rawNonce,
          consentPolicyVersion: CONSENT_POLICY_VERSION,
        }),
        idempotencyKey: idempotencyKey ?? this.idempotencyKey(),
        signal,
      },
      decodeSession,
    );
  }

  refresh(refreshToken: string, idempotencyKey?: string, signal?: AbortSignal) {
    return this.request(
      '/v1/auth/refresh',
      {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        idempotencyKey: idempotencyKey ?? this.idempotencyKey(),
        signal,
      },
      decodeSession,
    );
  }

  signOut(accessToken: string, idempotencyKey?: string, signal?: AbortSignal) {
    return this.request(
      '/v1/auth/sign-out',
      {
        method: 'POST',
        accessToken,
        idempotencyKey: idempotencyKey ?? this.idempotencyKey(),
        signal,
      },
      decodeSignOut,
    );
  }

  exportAccount(accessToken: string, signal?: AbortSignal) {
    return this.request(
      '/v1/account/export',
      { method: 'GET', accessToken, signal },
      decodeAccountExport,
    );
  }

  deleteAccount(accessToken: string, idempotencyKey?: string, signal?: AbortSignal) {
    return this.request(
      '/v1/account',
      {
        method: 'DELETE',
        accessToken,
        idempotencyKey: idempotencyKey ?? this.idempotencyKey(),
        signal,
      },
      decodeDelete,
    );
  }

  private async request<T>(
    path: string,
    options: {
      readonly method: string;
      readonly body?: string | undefined;
      readonly accessToken?: string | undefined;
      readonly idempotencyKey?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    },
    decode: (value: unknown) => T,
  ): Promise<T> {
    if (this.baseUrl === null) throw new CloudApiError(0, 'api_unconfigured');
    if (options.signal?.aborted === true) throw new CloudApiError(0, 'request_cancelled');
    const abortCode = () =>
      options.signal?.aborted === true
        ? ('request_cancelled' as const)
        : ('request_timeout' as const);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.accessToken !== undefined) headers.Authorization = `Bearer ${options.accessToken}`;
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), this.requestTimeoutMs);
    let removeCallerAbortListener: (() => void) | null = null;
    if (options.signal !== undefined) {
      const abortCaller = () => timeoutController.abort();
      options.signal.addEventListener('abort', abortCaller, { once: true });
      removeCallerAbortListener = () => options.signal?.removeEventListener('abort', abortCaller);
    }
    const init: RequestInit = { method: options.method, headers, signal: timeoutController.signal };
    if (options.body !== undefined) init.body = options.body;

    const abortPromise = new Promise<never>((_, reject) => {
      timeoutController.signal.addEventListener(
        'abort',
        () => {
          const error = new Error('The cloud request was aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });

    try {
      const fetchPromise = this.fetchImpl(`${this.baseUrl}${path}`, init);
      void fetchPromise.catch(() => undefined);
      const response = await Promise.race([fetchPromise, abortPromise]).catch((error: unknown) => {
        if (error instanceof CloudApiError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          throw new CloudApiError(0, abortCode());
        }
        throw new CloudApiError(0, 'offline');
      });

      let payload: unknown = null;
      try {
        const bodyPromise = boundedResponseText(response);
        void bodyPromise.catch(() => undefined);
        const body = await Promise.race([bodyPromise, abortPromise]);
        if (body.trim().length > 0) payload = JSON.parse(body) as unknown;
      } catch (error) {
        if (error instanceof CloudApiError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          throw new CloudApiError(0, abortCode());
        }
        // An invalid error body remains a bounded HTTP error; an invalid success body is decoded as
        // null below and receives the same stable invalid_response category.
        payload = null;
      }
      if (!response.ok) {
        throw new CloudApiError(
          response.status,
          decodeApiError(payload) ?? `http_${response.status}`,
        );
      }
      return decode(payload);
    } finally {
      clearTimeout(timeoutId);
      removeCallerAbortListener?.();
    }
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BODY_BYTES) {
      throw new CloudApiError(502, 'invalid_response');
    }
    return body;
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BODY_BYTES) {
      await reader.cancel();
      throw new CloudApiError(502, 'invalid_response');
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}
