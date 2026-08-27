/** Version of the shared API/contract artifact. */
export const CONTRACT_VERSION = '2026-08-27';

/** Consent copy remains independently versioned from transport/schema compatibility. */
export const CONSENT_POLICY_VERSION = '2026-08-01';

export const API_VERSION = 'v1';

/** Number of printable random characters generated for each Apple authorization attempt. */
export const APPLE_RAW_NONCE_LENGTH = 32;

/** Breaking nonce-bound Apple exchange protocol; shared by the mobile and backend adapters. */
export const APPLE_EXCHANGE_PATH = '/v2/auth/apple/exchange';

export function isValidAppleRawNonce(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === APPLE_RAW_NONCE_LENGTH &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly environment: 'local' | 'production';
}

export interface ShowcaseRequest {
  readonly operation: 'showcase';
  readonly fixtureId: string;
}

export interface AppleExchangeRequest {
  readonly identityToken?: string | null;
  /** The one-time nonce generated on-device; Apple receives its SHA-256 digest. */
  readonly rawNonce: string;
  readonly consentPolicyVersion: string;
}

export interface RefreshSessionRequest {
  readonly refreshToken: string;
}

export interface SessionResponse {
  readonly accountId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly accessTokenExpiresAt: string;
  readonly refreshTokenExpiresAt: string;
}

export interface SignOutResponse {
  readonly signedOut: true;
}

export interface AccountConsent {
  readonly policyVersion: string;
  readonly acceptedAt: string;
}

export type AccountAuditEventType = 'account.exported' | 'account.deleted';

export interface AccountAuditEvent {
  readonly type: AccountAuditEventType;
  readonly occurredAt: string;
}

export interface AccountExportResponse {
  readonly accountId: string;
  readonly createdAt: string;
  readonly appleSubject: string;
  readonly consents: readonly AccountConsent[];
  readonly sessions: readonly AccountSession[];
  readonly operations: readonly AccountOperation[];
  readonly auditEvents: readonly AccountAuditEvent[];
}

export type AccountSessionStatus = 'active' | 'revoked' | 'expired';

export interface AccountSession {
  readonly id: string;
  readonly familyId: string;
  readonly status: AccountSessionStatus;
  readonly createdAt: string;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string;
  readonly revokedAt: string | null;
}

export interface AccountOperation {
  readonly operation: 'auth.apple.exchange' | 'auth.refresh' | 'auth.sign-out' | 'account.delete';
  readonly responseStatus: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface AccountDeletionResponse {
  readonly deleted: true;
}

export interface AccountDeletionRequest {
  readonly idempotencyKey?: string;
}

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
