import {
  CONTRACT_VERSION,
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
  | 'invalid_response'
  | 'identity_cancelled'
  | 'apple_unavailable'
  | 'identity_token_required'
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
  readonly exchangeApple: (
    identityToken: string,
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
};

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function configuredUrl(value: string | null | undefined): string | null {
  const url = value?.trim();
  return url === undefined || url.length === 0 ? null : url.replace(/\/+$/, '');
}

export function cloudApiUrl(): string | null {
  return configuredUrl(process.env.EXPO_PUBLIC_API_URL);
}

export function createIdempotencyKey(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === 'function') return randomUuid.call(globalThis.crypto);
  return `alyte-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  return {
    accountId: text(value.accountId, 'account_id', 256),
    createdAt: iso(value.createdAt, 'account_created_at'),
    // The Apple subject is decoded for the typed contract but is intentionally never rendered by
    // the mobile UI. It is an opaque server-side identity, not a profile field.
    appleSubject: text(value.appleSubject, 'apple_subject', 512),
    consents: value.consents.map(decodeConsent),
    sessions: value.sessions.map(decodeSessionMetadata),
    operations: value.operations.map(decodeOperation),
    auditEvents: value.auditEvents.map(decodeAuditEvent),
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

  constructor(options: CloudApiClientOptions = {}) {
    this.baseUrl = configuredUrl(options.baseUrl ?? cloudApiUrl());
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.idempotencyKey = options.idempotencyKey ?? createIdempotencyKey;
  }

  exchangeApple(identityToken: string, idempotencyKey?: string, signal?: AbortSignal) {
    return this.request(
      '/v1/auth/apple/exchange',
      {
        method: 'POST',
        body: JSON.stringify({ identityToken, consentPolicyVersion: CONTRACT_VERSION }),
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
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.accessToken !== undefined) headers.Authorization = `Bearer ${options.accessToken}`;
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;

    const init: RequestInit = { method: options.method, headers };
    if (options.body !== undefined) init.body = options.body;
    if (options.signal !== undefined) init.signal = options.signal;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (error instanceof CloudApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new CloudApiError(0, 'request_cancelled');
      }
      throw new CloudApiError(0, 'offline');
    }

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new CloudApiError(
        response.status,
        decodeApiError(payload) ?? `http_${response.status}`,
      );
    }
    return decode(payload);
  }
}
