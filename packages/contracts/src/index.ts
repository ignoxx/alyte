/** Version of the shared API/contract artifact. */
export const CONTRACT_VERSION = '2026-08-28';

/** Consent copy remains independently versioned from transport/schema compatibility. */
export const CONSENT_POLICY_VERSION = '2026-08-01';

export const API_VERSION = 'v1';

/** Number of printable random characters generated for each Apple authorization attempt. */
export const APPLE_RAW_NONCE_LENGTH = 32;

/** Breaking nonce-bound Apple exchange protocol; shared by the mobile and backend adapters. */
export const APPLE_EXCHANGE_PATH = '/v2/auth/apple/exchange';

/** Cloud commerce routes are versioned separately from the identity exchange. */
export const CLOUD_ALLOWANCES_PATH = '/v1/cloud/allowances';
export const CLOUD_ALLOWANCES_RECONCILE_PATH = '/v1/cloud/allowances/reconcile';
export const REVENUECAT_WEBHOOK_PATH = '/v1/webhooks/revenuecat';

/** Versioned admission frontier for the first asynchronous cloud request slice. */
export const CLOUD_REQUESTS_PATH = '/v1/cloud-requests';
export const CLOUD_REQUEST_STATUS_PATH = '/v1/cloud-requests/:requestId';
/** Owner-only retrieval of a device-encrypted result envelope. */
export const CLOUD_REQUEST_RESULT_PATH = '/v1/cloud-requests/:requestId/result';
export const CLOUD_REQUEST_CANCEL_PATH = '/v1/cloud-requests/:requestId/cancel';
/** Binary upload is intentionally a separate route from JSON admission. */
export const CLOUD_REQUEST_UPLOAD_PATH = '/v1/cloud-requests/:requestId/upload';
/** Sealing an uploaded artifact is a distinct idempotent mutation. */
export const CLOUD_REQUEST_COMPLETE_UPLOAD_PATH = '/v1/cloud-requests/:requestId/complete-upload';
export const CLOUD_REQUEST_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

export const CLOUD_REQUEST_MAX_BYTES = 25 * 1024 * 1024;
export const CLOUD_REQUEST_MAX_PAGES = 20;

export const CLOUD_PRODUCT_IDS = {
  starterPack: 'alyte_starter_pack',
  cloudPlusMonthly: 'alyte_cloud_plus_monthly',
  cloudPlusAnnual: 'alyte_cloud_plus_annual',
  cloudMaxMonthly: 'alyte_cloud_max_monthly',
  cloudMaxAnnual: 'alyte_cloud_max_annual',
} as const;

export const CLOUD_ENTITLEMENT_IDS = {
  cloudPlus: 'alyte_cloud_plus',
  cloudMax: 'alyte_cloud_max',
} as const;

/** Provisional launch offers. StoreKit supplies the localized display price at runtime. */
export const CLOUD_PLAN_OFFERS = [
  {
    planId: 'starter_pack',
    productId: CLOUD_PRODUCT_IDS.starterPack,
    price: 'EUR 0.99',
    snapAllowance: 5,
    reportAllowance: 1,
    recurring: false,
  },
  {
    planId: 'cloud_plus',
    productId: CLOUD_PRODUCT_IDS.cloudPlusMonthly,
    annualProductId: CLOUD_PRODUCT_IDS.cloudPlusAnnual,
    price: 'EUR 6.99/month',
    annualPrice: 'EUR 59.99/year',
    snapAllowance: 500,
    reportAllowance: 4,
    recurring: true,
  },
  {
    planId: 'cloud_max',
    productId: CLOUD_PRODUCT_IDS.cloudMaxMonthly,
    annualProductId: CLOUD_PRODUCT_IDS.cloudMaxAnnual,
    price: 'EUR 12.99/month',
    annualPrice: 'EUR 109.99/year',
    snapAllowance: 1_500,
    reportAllowance: 12,
    recurring: true,
  },
] as const;

export type CloudProductId = (typeof CLOUD_PRODUCT_IDS)[keyof typeof CLOUD_PRODUCT_IDS];
export type CloudPlanId = 'starter_pack' | 'cloud_plus' | 'cloud_max';
export type CloudAllowanceKind = 'snap' | 'report';
export type CloudEntitlementStatus = 'pending' | 'active' | 'exhausted' | 'expired' | 'revoked';
export type CloudAllowanceWarning = 'normal' | 'near-limit' | 'critical' | 'exhausted';

export type CloudRequestOperation = 'intake-image' | 'lab-report';

/** States owned by the admission/upload/queue frontier. */
export type CloudRequestState =
  | 'awaiting-upload'
  | 'uploaded'
  | 'queued'
  | 'ready'
  | 'retrieved'
  | 'failed'
  | 'cancelled'
  | 'expired';

/** Persisted request rows keep the contract version they were admitted under. */
export type CloudRequestContractVersion = string;

export type CloudRequestErrorCode =
  | 'cloud_request_invalid'
  | 'cloud_request_operation_invalid'
  | 'cloud_request_metadata_invalid'
  | 'cloud_request_contract_version_unsupported'
  | 'device_public_key_invalid'
  | 'idempotency_key_required'
  | 'idempotency_key_invalid'
  | 'idempotency_key_conflict'
  | 'cloud_request_not_found'
  | 'cloud_request_not_cancellable'
  | 'allowance_exhausted'
  | 'cloud_upload_content_type_invalid'
  | 'cloud_upload_body_invalid'
  | 'cloud_upload_too_large'
  | 'cloud_upload_too_small'
  | 'cloud_upload_conflict'
  | 'cloud_upload_filesystem_failure'
  | 'cloud_upload_artifact_missing'
  | 'cloud_upload_not_completeable'
  | 'cloud_upload_required'
  | 'cloud_request_expired'
  | 'cloud_account_cleanup_incomplete'
  | 'cloud_result_not_available'
  | 'cloud_result_envelope_invalid'
  | 'cloud_result_context_mismatch'
  | 'cloud_result_conflict'
  | 'cloud_result_storage_failure';

export interface P256PublicKeyJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

export interface CloudRequestAdmissionRequest {
  readonly operation: CloudRequestOperation;
  readonly byteCount: number;
  readonly pageCount: number;
  readonly devicePublicKeyJwk: P256PublicKeyJwk;
  readonly contractVersion: typeof CONTRACT_VERSION;
}

export interface CloudRequestStatusResponse {
  readonly requestId: string;
  readonly operation: CloudRequestOperation;
  readonly state: CloudRequestState;
  readonly byteCount: number;
  readonly pageCount: number;
  readonly contractVersion: CloudRequestContractVersion;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt: string | null;
  /** Null until the exact artifact has been atomically promoted. */
  readonly uploadedAt?: string | null;
  /** Null until complete-upload inserts the durable handler-v1 job. */
  readonly queuedAt?: string | null;
  /** True only while a valid encrypted envelope is available for the owner to retrieve. */
  readonly resultAvailable?: boolean;
  /** Result-cache expiry; null when no result has been published. */
  readonly resultExpiresAt?: string | null;
  /** Bounded non-sensitive failure category, when a result cache is unusable. */
  readonly failureCategory?: string | null;
  /** Unsealed requests expire no later than this timestamp. */
  readonly expiresAt?: string;
  readonly expiredAt?: string | null;
}

export type CloudRequestAdmissionResponse = CloudRequestStatusResponse;
export type CloudRequestCancellationResponse = CloudRequestStatusResponse;

export interface CloudAllowanceSummary {
  readonly kind: CloudAllowanceKind;
  readonly included: number;
  readonly consumed: number;
  readonly reserved: number;
  readonly remaining: number;
  readonly warning: CloudAllowanceWarning;
  /** Null for non-expiring Starter Pack units. */
  readonly resetAt: string | null;
}

export interface CloudEntitlementSummary {
  readonly planId: CloudPlanId;
  readonly productId: CloudProductId;
  readonly status: CloudEntitlementStatus;
  readonly willRenew: boolean;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
}

export interface CloudAllowanceResponse {
  readonly accountId: string;
  readonly entitlements: readonly CloudEntitlementSummary[];
  readonly allowances: readonly CloudAllowanceSummary[];
  readonly managementUrl: string | null;
  readonly generatedAt: string;
}

export interface CloudReconcileResponse extends CloudAllowanceResponse {
  readonly reconciled: boolean;
}

export interface RevenueCatWebhookResponse {
  readonly accepted: true;
  readonly processed: boolean;
}

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

export * from './cloud-result-envelope.js';
