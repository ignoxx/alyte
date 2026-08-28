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
import type { AccountDatabase, CloudRequestRow } from './database.js';
import type { CommerceService } from './commerce.js';

const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ACCOUNT_ID_LENGTH = 256;
const MIN_PUBLIC_COORDINATE_LENGTH = 43;
const HASH_SECRET_MINIMUM_LENGTH = 32;

export interface CloudRequestClock {
  now(): Date;
}

export type CloudRequestServiceOptions = {
  readonly database: AccountDatabase;
  readonly commerce: CommerceService;
  readonly hashSecret: string | Uint8Array;
  readonly clock?: CloudRequestClock;
  readonly idFactory?: () => string;
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
  };
}

export class CloudRequestService {
  private readonly database: AccountDatabase;
  private readonly commerce: CommerceService;
  private readonly clock: CloudRequestClock;
  private readonly idFactory: () => string;
  private readonly hashSecret: Uint8Array;

  constructor(options: CloudRequestServiceOptions) {
    this.database = options.database;
    this.commerce = options.commerce;
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? randomUUID;
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
    return toStatus(row);
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
    return this.database.transaction(() => {
      const row = this.database.findCloudRequest(accountId as string, id);
      if (row === undefined) throw new CloudRequestFailure(404, 'cloud_request_not_found');
      if (row.state === 'cancelled') return toStatus(row);
      if (row.state !== 'awaiting-upload') {
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
