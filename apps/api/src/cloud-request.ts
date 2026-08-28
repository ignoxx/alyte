import { createHmac, createPublicKey, randomUUID } from 'node:crypto';
import type { JsonWebKeyInput } from 'node:crypto';
import {
  CLOUD_REQUEST_MAX_BYTES,
  CLOUD_REQUEST_MAX_PAGES,
  CONTRACT_VERSION,
  type CloudAllowanceKind,
  type CloudRequestAdmissionRequest,
  type CloudRequestAdmissionResponse,
  type CloudRequestCancellationResponse,
  type CloudRequestOperation,
  type CloudRequestStatusResponse,
  type P256PublicKeyJwk,
} from '@alyte/contracts';
import {
  CLOUD_UPLOAD_RETENTION_MS,
  type AccountDatabase,
  type AnalysisJobRow,
  type CloudRequestRow,
} from './database.js';
import type { CommerceService } from './commerce.js';
import type { TransientArtifact, TransientUploadStore } from './transient-upload-store.js';

export { CLOUD_UPLOAD_CLEANUP_INTERVAL_MS } from './database.js';

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ACCOUNT_ID_LENGTH = 256;
const MIN_PUBLIC_COORDINATE_LENGTH = 43;
const HASH_SECRET_MINIMUM_LENGTH = 32;
export const CLOUD_UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1_000;

export interface CloudRequestClock {
  now(): Date;
}

export type CloudRequestServiceOptions = {
  readonly database: AccountDatabase;
  readonly commerce: CommerceService;
  readonly hashSecret: string | Uint8Array;
  readonly clock?: CloudRequestClock;
  readonly idFactory?: () => string;
  readonly uploadStore?: TransientUploadStore;
};

export class CloudRequestFailure extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = 'CloudRequestFailure';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const systemClock: CloudRequestClock = { now: () => new Date() };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function validOpaqueId(value: unknown, maxLength = MAX_REQUEST_ID_LENGTH): value is string {
  return validText(value, maxLength) && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function base64urlCoordinate(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length !== MIN_PUBLIC_COORDINATE_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
}

/**
 * Decode and validate the only public-key representation accepted at the admission boundary.
 * Node's key parser checks that the coordinates form an actual P-256 point; the canonical
 * base64url and exact-key checks reject alternate encodings and private-key material.
 */
export function parseP256PublicKeyJwk(value: unknown): P256PublicKeyJwk {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['crv', 'kty', 'x', 'y']) ||
    value.kty !== 'EC' ||
    value.crv !== 'P-256' ||
    !base64urlCoordinate(value.x) ||
    !base64urlCoordinate(value.y)
  ) {
    throw new CloudRequestFailure(400, 'device_public_key_invalid');
  }
  const jwk: P256PublicKeyJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: value.x,
    y: value.y,
  };
  try {
    createPublicKey({ key: jwk as unknown as JsonWebKeyInput['key'], format: 'jwk' });
  } catch {
    throw new CloudRequestFailure(400, 'device_public_key_invalid');
  }
  return jwk;
}

function parseIdempotencyKey(value: unknown): string {
  if (value === undefined || value === null) {
    throw new CloudRequestFailure(400, 'idempotency_key_required');
  }
  if (!validText(value, MAX_IDEMPOTENCY_KEY_LENGTH) || !/^[\x21-\x7E]+$/.test(value)) {
    throw new CloudRequestFailure(400, 'idempotency_key_invalid');
  }
  return value;
}

function parseOperation(value: unknown): CloudRequestOperation {
  if (value === 'intake-image' || value === 'lab-report') return value;
  throw new CloudRequestFailure(400, 'cloud_request_operation_invalid');
}

function parseAdmission(value: unknown): CloudRequestAdmissionRequest {
  if (!isRecord(value)) throw new CloudRequestFailure(400, 'cloud_request_invalid');
  if (
    !hasExactlyKeys(value, [
      'byteCount',
      'contractVersion',
      'devicePublicKeyJwk',
      'operation',
      'pageCount',
    ])
  ) {
    throw new CloudRequestFailure(400, 'cloud_request_metadata_invalid');
  }
  const operation = parseOperation(value.operation);
  if (value.contractVersion !== CONTRACT_VERSION) {
    throw new CloudRequestFailure(426, 'cloud_request_contract_version_unsupported');
  }
  const byteCount = boundedInteger(value.byteCount, 1, CLOUD_REQUEST_MAX_BYTES);
  const pageCount = boundedInteger(value.pageCount, 1, CLOUD_REQUEST_MAX_PAGES);
  if (byteCount === null || pageCount === null) {
    throw new CloudRequestFailure(400, 'cloud_request_metadata_invalid');
  }
  const devicePublicKeyJwk = parseP256PublicKeyJwk(value.devicePublicKeyJwk);
  return { operation, byteCount, pageCount, devicePublicKeyJwk, contractVersion: CONTRACT_VERSION };
}

function allowanceKind(operation: CloudRequestOperation): CloudAllowanceKind {
  return operation === 'intake-image' ? 'snap' : 'report';
}

function canonicalAdmission(admission: CloudRequestAdmissionRequest): string {
  return JSON.stringify({
    operation: admission.operation,
    byteCount: admission.byteCount,
    pageCount: admission.pageCount,
    devicePublicKeyJwk: admission.devicePublicKeyJwk,
    contractVersion: admission.contractVersion,
  });
}

function toStatus(row: CloudRequestRow): CloudRequestStatusResponse {
  return {
    requestId: row.id,
    operation: row.operation,
    state: row.state,
    byteCount: row.byte_count,
    pageCount: row.page_count,
    contractVersion: row.contract_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at,
    uploadedAt: row.uploaded_at,
    queuedAt: row.queued_at,
    expiresAt: row.upload_expires_at,
    expiredAt: row.expired_at,
  };
}

export class CloudRequestService {
  private readonly database: AccountDatabase;
  private readonly commerce: CommerceService;
  private readonly clock: CloudRequestClock;
  private readonly idFactory: () => string;
  private readonly hashSecret: Uint8Array;
  private readonly uploadStore: TransientUploadStore | undefined;

  constructor(options: CloudRequestServiceOptions) {
    this.database = options.database;
    this.commerce = options.commerce;
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? randomUUID;
    this.uploadStore = options.uploadStore;
    this.hashSecret =
      typeof options.hashSecret === 'string'
        ? new TextEncoder().encode(options.hashSecret)
        : new Uint8Array(options.hashSecret);
    if (this.hashSecret.length < HASH_SECRET_MINIMUM_LENGTH) {
      throw new Error('cloud_request_hash_secret_too_short');
    }
  }

  admit(
    accountId: unknown,
    request: unknown,
    idempotencyKey: unknown,
  ): CloudRequestAdmissionResponse {
    this.requireAccount(accountId);
    const admission = parseAdmission(request);
    const key = parseIdempotencyKey(idempotencyKey);
    const idempotencyKeyHash = this.hash(key);
    const requestFingerprint = this.hash(canonicalAdmission(admission));
    const existing = this.database.findCloudRequestByIdempotencyHash(
      accountId as string,
      idempotencyKeyHash,
    );
    if (existing !== undefined) return this.replay(existing, requestFingerprint);

    return this.database.transaction(() => {
      // Re-check under the write transaction. SQLite serializes writers, while the unique index
      // remains the final guard if another process admitted this key between preflight and write.
      const raced = this.database.findCloudRequestByIdempotencyHash(
        accountId as string,
        idempotencyKeyHash,
      );
      if (raced !== undefined) return this.replay(raced, requestFingerprint);
      const requestId = this.idFactory();
      if (!validOpaqueId(requestId)) throw new Error('cloud_request_id_factory_invalid');
      const now = this.clock.now().toISOString();
      const row: CloudRequestRow = {
        id: requestId,
        account_id: accountId as string,
        operation: admission.operation,
        state: 'awaiting-upload',
        byte_count: admission.byteCount,
        page_count: admission.pageCount,
        device_public_key_jwk: JSON.stringify(admission.devicePublicKeyJwk),
        idempotency_key_hash: idempotencyKeyHash,
        request_fingerprint: requestFingerprint,
        contract_version: admission.contractVersion,
        created_at: now,
        updated_at: now,
        upload_expires_at: new Date(
          this.clock.now().getTime() + CLOUD_UPLOAD_RETENTION_MS,
        ).toISOString(),
        uploaded_at: null,
        queued_at: null,
        expired_at: null,
        cancelled_at: null,
      };
      // Insert before reserving so malformed/insufficient allowance rolls back this row too.
      // Both calls are inside this one SQLite transaction.
      this.database.createCloudRequest(row);
      this.commerce.reserveInTransaction(
        accountId as string,
        allowanceKind(admission.operation),
        requestId,
      );
      return toStatus(row);
    });
  }

  status(accountId: unknown, requestId: unknown): CloudRequestStatusResponse {
    this.requireAccount(accountId);
    const id = this.parseRequestId(requestId);
    const row = this.database.findCloudRequest(accountId as string, id);
    if (row === undefined) throw new CloudRequestFailure(404, 'cloud_request_not_found');
    return toStatus(this.expireIfDue(row));
  }

  /**
   * Receive one bounded binary artifact. The store promotes only an exact body; a replay compares
   * bytes transiently and never persists a content digest.
   */
  upload(
    accountId: unknown,
    requestId: unknown,
    bytes: unknown,
    contentType: unknown,
    idempotencyKey: unknown,
  ): CloudRequestStatusResponse {
    this.requireAccount(accountId);
    const id = this.parseRequestId(requestId);
    // Upload retries are bound to a caller capability at the transport boundary. The byte
    // comparison below remains the durable artifact idempotency guard; the key itself is never
    // persisted for this per-request mutation.
    parseIdempotencyKey(idempotencyKey);
    const row = this.database.findCloudRequest(accountId as string, id);
    if (row === undefined) throw new CloudRequestFailure(404, 'cloud_request_not_found');
    const current = this.expireIfDue(row);
    if (current.state === 'expired') {
      throw new CloudRequestFailure(409, 'cloud_request_expired');
    }
    if (contentType !== 'application/octet-stream') {
      throw new CloudRequestFailure(415, 'cloud_upload_content_type_invalid');
    }
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new CloudRequestFailure(400, 'cloud_upload_body_invalid');
    }
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (body.byteLength > row.byte_count) {
      throw new CloudRequestFailure(413, 'cloud_upload_too_large');
    }
    if (body.byteLength < row.byte_count) {
      throw new CloudRequestFailure(400, 'cloud_upload_too_small');
    }
    const uploadStore = this.uploadStore;
    if (uploadStore === undefined) {
      throw new CloudRequestFailure(503, 'cloud_upload_filesystem_failure');
    }
    if (row.state === 'cancelled' || row.state === 'expired') {
      throw new CloudRequestFailure(409, 'cloud_request_expired');
    }
    if (row.state === 'queued') {
      if (uploadStore.hasExactBytes(id, body)) return toStatus(row);
      if (!uploadStore.hasExactSize(id, row.byte_count)) {
        throw new CloudRequestFailure(409, 'cloud_upload_artifact_missing');
      }
      throw new CloudRequestFailure(409, 'cloud_upload_conflict');
    }
    if (row.state === 'uploaded') {
      if (uploadStore.hasExactBytes(id, body)) return toStatus(row);
      if (uploadStore.hasExactSize(id, row.byte_count)) {
        throw new CloudRequestFailure(409, 'cloud_upload_conflict');
      }
      // The durable state can win a crash race with filesystem promotion. Once the complete
      // artifact is absent or has the wrong size, remove only that unusable artifact and allow a
      // fresh exact upload; a same-sized different artifact remains a conflict above.
      try {
        uploadStore.remove(id);
        uploadStore.write(id, body, row.byte_count);
        const uploadedAt = this.clock.now().toISOString();
        this.database.transaction(() => {
          this.database.markCloudRequestUploaded(accountId as string, id, uploadedAt);
        });
        const repaired = this.database.findCloudRequest(accountId as string, id);
        if (repaired === undefined) throw new Error('cloud_upload_request_missing_after_repair');
        return toStatus(repaired);
      } catch (error) {
        this.cleanupFailedUpload(uploadStore, id, row.byte_count);
        if (error instanceof CloudRequestFailure) throw error;
        throw new CloudRequestFailure(500, 'cloud_upload_filesystem_failure');
      }
    }
    // A crash can leave a successfully promoted file just before the state update. Recover that
    // exact artifact, but never overwrite a complete artifact from another upload attempt.
    if (uploadStore.hasCompleteArtifact(id)) {
      if (uploadStore.hasExactBytes(id, body)) {
        const uploadedAt = this.clock.now().toISOString();
        this.database.transaction(() => {
          this.database.markCloudRequestUploaded(accountId as string, id, uploadedAt);
        });
        const recovered = this.database.findCloudRequest(accountId as string, id);
        if (recovered === undefined) throw new Error('cloud_upload_request_missing_after_recovery');
        return toStatus(recovered);
      }
      throw new CloudRequestFailure(409, 'cloud_upload_conflict');
    }
    try {
      uploadStore.write(id, body, row.byte_count);
      const uploadedAt = this.clock.now().toISOString();
      this.database.transaction(() => {
        this.database.markCloudRequestUploaded(accountId as string, id, uploadedAt);
      });
      const uploaded = this.database.findCloudRequest(accountId as string, id);
      if (uploaded === undefined) throw new Error('cloud_upload_request_missing_after_write');
      return toStatus(uploaded);
    } catch (error) {
      this.cleanupFailedUpload(uploadStore, id, row.byte_count);
      if (error instanceof CloudRequestFailure) throw error;
      throw new CloudRequestFailure(500, 'cloud_upload_filesystem_failure');
    }
  }

  completeUpload(
    accountId: unknown,
    requestId: unknown,
    idempotencyKey: unknown,
  ): CloudRequestStatusResponse {
    this.requireAccount(accountId);
    const id = this.parseRequestId(requestId);
    parseIdempotencyKey(idempotencyKey);
    const row = this.database.findCloudRequest(accountId as string, id);
    if (row === undefined) throw new CloudRequestFailure(404, 'cloud_request_not_found');
    const current = this.expireIfDue(row);
    if (current.state === 'expired') {
      throw new CloudRequestFailure(409, 'cloud_upload_not_completeable');
    }
    if (current.state === 'queued') {
      if (this.database.findAnalysisJobByRequest(id) === undefined) {
        throw new CloudRequestFailure(500, 'cloud_upload_artifact_missing');
      }
      if (
        this.uploadStore === undefined ||
        !this.uploadStore.hasExactSize(id, current.byte_count)
      ) {
        throw new CloudRequestFailure(409, 'cloud_upload_artifact_missing');
      }
      return toStatus(current);
    }
    if (current.state !== 'uploaded') {
      if (current.state === 'awaiting-upload') {
        throw new CloudRequestFailure(409, 'cloud_upload_required');
      }
      throw new CloudRequestFailure(409, 'cloud_upload_not_completeable');
    }
    if (this.uploadStore === undefined || !this.uploadStore.hasExactSize(id, current.byte_count)) {
      throw new CloudRequestFailure(409, 'cloud_upload_artifact_missing');
    }
    return this.database.transaction(() => {
      const current = this.database.findCloudRequest(accountId as string, id);
      if (current === undefined) throw new CloudRequestFailure(404, 'cloud_request_not_found');
      if (current.state === 'queued') {
        return toStatus(current);
      }
      if (current.state !== 'uploaded') {
        throw new CloudRequestFailure(409, 'cloud_upload_not_completeable');
      }
      const queuedAt = this.clock.now().toISOString();
      const jobId = this.idFactory();
      if (!validOpaqueId(jobId)) throw new Error('cloud_analysis_job_id_factory_invalid');
      const job: AnalysisJobRow = {
        id: jobId,
        request_id: id,
        state: 'queued',
        available_at: queuedAt,
        attempts: 0,
        lease_owner: null,
        lease_expires_at: null,
        handler_version: 1,
        request_contract_version: current.contract_version,
        schema_version: current.contract_version,
        prompt_version: null,
        failure_category: null,
        created_at: queuedAt,
        updated_at: queuedAt,
      };
      this.database.queueCloudRequest(id, queuedAt, job);
      const queued = this.database.findCloudRequest(accountId as string, id);
      if (queued === undefined) throw new Error('cloud_upload_queue_write_failed');
      return toStatus(queued);
    });
  }

  cancel(
    accountId: unknown,
    requestId: unknown,
    idempotencyKey: unknown,
  ): CloudRequestCancellationResponse {
    this.requireAccount(accountId);
    const id = this.parseRequestId(requestId);
    // Cancellation is idempotent by request state. The key is still required at the transport
    // boundary so every mutating endpoint has a retry capability, but is deliberately not stored.
    parseIdempotencyKey(idempotencyKey);
    const row = this.database.findCloudRequest(accountId as string, id);
    if (row === undefined) throw new CloudRequestFailure(404, 'cloud_request_not_found');
    const current = this.expireIfDue(row);
    if (current.state === 'cancelled' || current.state === 'expired') {
      // A retry after cancellation/expiry is still a cleanup opportunity. Do not leave an
      // artifact behind merely because the state transition happened in an earlier process.
      if (this.uploadStore !== undefined) {
        try {
          this.uploadStore.remove(id);
        } catch {
          throw new CloudRequestFailure(500, 'cloud_upload_filesystem_failure');
        }
      }
      return toStatus(current);
    }
    if (current.state === 'queued') {
      throw new CloudRequestFailure(409, 'cloud_request_not_cancellable');
    }
    if (this.uploadStore === undefined && current.state !== 'awaiting-upload') {
      throw new CloudRequestFailure(503, 'cloud_upload_filesystem_failure');
    }
    if (this.uploadStore !== undefined) {
      try {
        this.uploadStore.remove(id);
      } catch {
        throw new CloudRequestFailure(500, 'cloud_upload_filesystem_failure');
      }
    }
    return this.database.transaction(() => {
      const current = this.database.findCloudRequest(accountId as string, id);
      if (current === undefined) throw new CloudRequestFailure(404, 'cloud_request_not_found');
      if (current.state === 'cancelled' || current.state === 'expired') return toStatus(current);
      if (current.state === 'queued') {
        throw new CloudRequestFailure(409, 'cloud_request_not_cancellable');
      }
      const cancelledAt = this.clock.now().toISOString();
      this.database.cancelCloudRequest(accountId as string, id, cancelledAt);
      this.commerce.releaseInTransaction(id);
      const cancelled = this.database.findCloudRequest(accountId as string, id);
      if (cancelled === undefined) throw new Error('cloud_request_cancel_write_failed');
      return toStatus(cancelled);
    });
  }

  /**
   * Reconcile volume artifacts and expire every unsealed request at most 24 hours after admission.
   * Scheduled reconciliation is best effort. Account deletion passes strict=true so it cannot
   * report success while an orphaned health artifact or cleanup failure remains.
   */
  reconcile(options: { readonly strict?: boolean } = {}): void {
    if (this.uploadStore === undefined) {
      if (options.strict) throw new CloudRequestFailure(500, 'cloud_account_cleanup_incomplete');
      return;
    }
    const now = this.clock.now();
    const nowMs = now.getTime();
    const rows = this.database.listCloudRequests();
    const byId = new Map(rows.map((row) => [row.id, row]));
    let artifacts: readonly TransientArtifact[];
    try {
      artifacts = this.uploadStore.list();
    } catch {
      if (options.strict) throw new CloudRequestFailure(500, 'cloud_account_cleanup_incomplete');
      return;
    }
    const remove = new Set<string>();
    let cleanupFailed = false;
    this.database.transaction(() => {
      for (const row of rows) {
        if (row.state === 'awaiting-upload' || row.state === 'uploaded') {
          if (Date.parse(row.upload_expires_at) <= nowMs) {
            this.database.markCloudRequestExpired(row.id, now.toISOString());
            this.commerce.releaseInTransaction(row.id);
            remove.add(row.id);
          } else if (
            row.state === 'awaiting-upload' &&
            artifacts.some(
              (artifact) =>
                artifact.requestId === row.id &&
                artifact.kind === 'complete' &&
                artifact.regular &&
                artifact.size === row.byte_count,
            )
          ) {
            this.database.markCloudRequestUploaded(row.account_id, row.id, now.toISOString());
          }
        } else if (row.state === 'cancelled' || row.state === 'expired') {
          remove.add(row.id);
        }
      }
    });
    for (const artifact of artifacts) {
      const row = byId.get(artifact.requestId);
      if (
        row === undefined ||
        remove.has(artifact.requestId) ||
        artifact.kind === 'partial' ||
        !artifact.regular ||
        (artifact.kind === 'complete' &&
          row.state === 'awaiting-upload' &&
          artifact.size !== row.byte_count) ||
        (artifact.kind === 'complete' &&
          row.state === 'uploaded' &&
          artifact.size !== row.byte_count)
      ) {
        try {
          this.uploadStore.removeEntry(artifact);
        } catch {
          // A later periodic pass retries failed unlink/permission operations.
          cleanupFailed = true;
        }
      }
    }
    try {
      this.uploadStore.removeUnknownEntries(new Set(rows.map((row) => row.id)));
    } catch {
      // A later periodic pass retries failed unlink/permission operations.
      cleanupFailed = true;
    }
    if (options.strict) {
      let remainingNames: readonly string[];
      let remainingArtifacts: readonly (typeof artifacts)[number][];
      try {
        remainingNames = this.uploadStore.listEntryNames();
        remainingArtifacts = this.uploadStore.list();
      } catch {
        throw new CloudRequestFailure(500, 'cloud_account_cleanup_incomplete');
      }
      const remainingRows = new Map(this.database.listCloudRequests().map((row) => [row.id, row]));
      const allowedNames = new Set(
        remainingArtifacts
          .filter((artifact) => {
            const row = remainingRows.get(artifact.requestId);
            return (
              artifact.kind === 'complete' &&
              artifact.regular &&
              row !== undefined &&
              (row.state === 'awaiting-upload' ||
                row.state === 'uploaded' ||
                row.state === 'queued') &&
              artifact.size === row.byte_count
            );
          })
          .map(
            (artifact) =>
              `${artifact.requestId}.${artifact.kind === 'partial' ? 'partial' : 'bin'}`,
          ),
      );
      if (cleanupFailed || remainingNames.some((name) => !allowedNames.has(name))) {
        throw new CloudRequestFailure(500, 'cloud_account_cleanup_incomplete');
      }
    }
  }

  private cleanupFailedUpload(
    uploadStore: TransientUploadStore,
    requestId: string,
    expectedBytes: number,
  ): void {
    try {
      for (const artifact of uploadStore.list()) {
        if (
          artifact.requestId === requestId &&
          (artifact.kind === 'partial' || !artifact.regular || artifact.size !== expectedBytes)
        ) {
          uploadStore.removeEntry(artifact);
        }
      }
    } catch {
      // A later periodic pass retries failed unlink/permission operations.
    }
  }

  private expireIfDue(row: CloudRequestRow): CloudRequestRow {
    if (
      (row.state !== 'awaiting-upload' && row.state !== 'uploaded') ||
      Date.parse(row.upload_expires_at) > this.clock.now().getTime()
    ) {
      return row;
    }
    const expiredAt = this.clock.now().toISOString();
    this.database.transaction(() => {
      this.database.markCloudRequestExpired(row.id, expiredAt);
      this.commerce.releaseInTransaction(row.id);
    });
    if (this.uploadStore !== undefined) {
      try {
        this.uploadStore.remove(row.id);
      } catch {
        // Reconciliation retries failed filesystem cleanup without reopening the request.
      }
    }
    const expired = this.database.findCloudRequest(row.account_id, row.id);
    if (expired === undefined) throw new Error('cloud_request_missing_after_expiry');
    return expired;
  }

  private replay(row: CloudRequestRow, requestFingerprint: string): CloudRequestStatusResponse {
    if (row.request_fingerprint !== requestFingerprint) {
      throw new CloudRequestFailure(409, 'idempotency_key_conflict');
    }
    return toStatus(row);
  }

  private requireAccount(accountId: unknown): void {
    if (!validOpaqueId(accountId, MAX_ACCOUNT_ID_LENGTH)) {
      throw new CloudRequestFailure(404, 'cloud_request_not_found');
    }
    if (this.database.findAccount(accountId) === undefined) {
      throw new CloudRequestFailure(404, 'cloud_request_not_found');
    }
  }

  private parseRequestId(value: unknown): string {
    if (!validOpaqueId(value)) throw new CloudRequestFailure(404, 'cloud_request_not_found');
    return value;
  }

  private hash(value: string): string {
    return createHmac('sha256', this.hashSecret).update(value, 'utf8').digest('hex');
  }
}
