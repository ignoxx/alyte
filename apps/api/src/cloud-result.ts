import {
  CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES,
  decodeCloudResultEnvelope,
  decodeCloudResultEnvelopeJson,
  serializeCloudResultEnvelope,
  type CloudRequestOperation,
  type CloudRequestStatusResponse,
  type CloudResultEnvelope,
} from '@alyte/contracts';
import {
  CLOUD_UPLOAD_CLEANUP_INTERVAL_MS,
  type AccountDatabase,
  type AnalysisJobRow,
  type CloudRequestRow,
  type CloudResultCacheRow,
} from './database.js';
import { type CloudResultStore, type CloudResultArtifact } from './cloud-result-store.js';
import { CloudRequestFailure, toStatus } from './cloud-request.js';
import type { CommerceService } from './commerce.js';
import type { TransientUploadStore } from './transient-upload-store.js';

/** Keep the serialized envelope bounded without allowing a result to live past one day. */
export const CLOUD_RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000 - CLOUD_UPLOAD_CLEANUP_INTERVAL_MS;
export const CLOUD_RESULT_MAX_SERIALIZED_BYTES = 512 * 1024;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const MAX_ACCOUNT_ID_LENGTH = 256;

export interface CloudResultClock {
  now(): Date;
}

export interface CloudResultServiceOptions {
  readonly database: AccountDatabase;
  readonly resultStore: CloudResultStore;
  /** Transient source media must be removed before a result can become visible. */
  readonly uploadStore: TransientUploadStore;
  /** The reservation is consumed in the same transaction that activates the result. */
  readonly commerce: CommerceService;
  readonly clock?: CloudResultClock;
}

export interface CloudResultLease {
  readonly jobId: string;
  readonly leaseOwner: string;
}

export class CloudResultFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code:
      | 'cloud_result_not_available'
      | 'cloud_result_envelope_invalid'
      | 'cloud_result_context_mismatch'
      | 'cloud_result_conflict'
      | 'cloud_result_storage_failure'
      | 'cloud_account_cleanup_incomplete',
  ) {
    super(code);
    this.name = 'CloudResultFailure';
  }
}

const systemClock: CloudResultClock = { now: () => new Date() };

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && REQUEST_ID_PATTERN.test(value);
}

function validAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ACCOUNT_ID_LENGTH &&
    REQUEST_ID_PATTERN.test(value)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function boundedSerializedEnvelope(value: unknown): {
  readonly envelope: CloudResultEnvelope;
  readonly bytes: Buffer;
} {
  try {
    const envelope = decodeCloudResultEnvelope(value);
    const serialized = serializeCloudResultEnvelope(envelope);
    const bytes = Buffer.from(serialized, 'utf8');
    if (bytes.byteLength > CLOUD_RESULT_MAX_SERIALIZED_BYTES) throw new Error('too_large');
    // Keep the explicit ciphertext bound close to this storage boundary as defense in depth if
    // the shared contract is extended later.
    if (
      Buffer.from(envelope.ciphertext, 'base64url').byteLength >
      CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES
    ) {
      throw new Error('ciphertext_too_large');
    }
    return { envelope, bytes };
  } catch {
    throw new CloudResultFailure(422, 'cloud_result_envelope_invalid');
  }
}

function resultStatus(row: CloudRequestRow): CloudRequestStatusResponse {
  return toStatus(row);
}

function allowanceKind(operation: CloudRequestOperation): 'snap' | 'report' {
  return operation === 'intake-image' ? 'snap' : 'report';
}

/**
 * Owns the ciphertext-only result lifecycle. This service deliberately has no decryption seam and
 * accepts only a strictly decoded CloudResultEnvelope object at its staging boundary.
 */
export class CloudResultService {
  private readonly database: AccountDatabase;
  private readonly resultStore: CloudResultStore;
  private readonly uploadStore: TransientUploadStore;
  private readonly commerce: CommerceService;
  private readonly clock: CloudResultClock;

  constructor(options: CloudResultServiceOptions) {
    this.database = options.database;
    this.resultStore = options.resultStore;
    this.uploadStore = options.uploadStore;
    this.commerce = options.commerce;
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Stage a strictly decoded encrypted envelope for the caller's live job lease. Staging writes
   * only ciphertext and bounded metadata; it deliberately does not consume an allowance or make
   * the result visible. The typed lease is the only completion authority; the envelope is always
   * validated before any ciphertext or metadata is persisted.
   */
  stage(lease: CloudResultLease, value: CloudResultEnvelope): CloudRequestStatusResponse {
    const { envelope, bytes } = boundedSerializedEnvelope(value);
    const requestId = envelope.requestId;
    const request = this.database.findCloudRequestById(requestId);
    if (request === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
    const existing = this.database.findCloudResultCache(requestId);
    if (existing !== undefined && existing.state !== 'staged' && existing.state !== 'ready') {
      throw new CloudResultFailure(409, 'cloud_result_conflict');
    }
    if (existing?.state === 'staged' && this.isExpired(existing.expires_at)) {
      if (!this.expireStagedAndCleanup(requestId)) {
        const current = this.database.findCloudRequest(request.account_id, requestId);
        if (current?.result_state === 'ready') return resultStatus(current);
      }
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    }
    const job = this.database.findAnalysisJobByRequest(requestId);
    this.requireLiveLease(request, job, envelope, lease);
    if (existing?.state === 'ready') {
      if (!this.resultStore.hasExactBytes(requestId, bytes)) {
        throw new CloudResultFailure(409, 'cloud_result_conflict');
      }
      const visible = this.database.findCloudRequest(request.account_id, requestId);
      if (visible === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
      return resultStatus(visible);
    }

    try {
      if (this.resultStore.hasCompleteArtifact(requestId)) {
        if (!this.resultStore.hasExactBytes(requestId, bytes)) {
          throw new CloudResultFailure(409, 'cloud_result_conflict');
        }
      } else {
        this.resultStore.write(requestId, bytes);
      }
    } catch (error) {
      if (error instanceof CloudResultFailure) throw error;
      throw new CloudResultFailure(503, 'cloud_result_storage_failure');
    }

    const stagedAt = this.clock.now();
    const stagedAtIso = stagedAt.toISOString();
    const expiresAt = new Date(stagedAt.getTime() + CLOUD_RESULT_RETENTION_MS).toISOString();
    try {
      this.database.transaction(() => {
        const currentRequest = this.database.findCloudRequestById(requestId);
        const currentJob = this.database.findAnalysisJobByRequest(requestId);
        if (currentRequest === undefined) {
          throw new CloudResultFailure(404, 'cloud_result_not_available');
        }
        this.requireLiveLease(currentRequest, currentJob, envelope, lease);
        const currentResult = this.database.findCloudResultCache(requestId);
        if (currentResult !== undefined) {
          if (
            currentResult.state !== 'staged' ||
            !this.resultStore.hasExactBytes(requestId, bytes)
          ) {
            throw new CloudResultFailure(409, 'cloud_result_conflict');
          }
          return;
        }
        this.database.createCloudResultCache({
          request_id: requestId,
          state: 'staged',
          result_schema_version: envelope.resultSchemaVersion,
          handler_version: envelope.handlerVersion,
          byte_count: bytes.byteLength,
          ready_at: null,
          staged_at: stagedAtIso,
          completion_job_id: null,
          completion_lease_owner: null,
          expires_at: expiresAt,
          retrieved_at: null,
          expired_at: null,
          failure_category: null,
        });
      });
    } catch (error) {
      // A promoted ciphertext file is intentionally retained for reconciliation. It can be
      // repaired into a staged row after a crash without rerunning the provider or re-encrypting.
      if (error instanceof CloudResultFailure) throw error;
      throw new CloudResultFailure(503, 'cloud_result_storage_failure');
    }
    const visible = this.database.findCloudRequest(request.account_id, requestId);
    if (visible === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
    return resultStatus(visible);
  }

  /**
   * Remove transient media, then atomically complete one staged result. The transaction is the
   * only place that can make a result ready, succeed its job, and consume its matching allowance.
   */
  finalize(lease: CloudResultLease): CloudRequestStatusResponse {
    const jobForRequest = this.database.findAnalysisJobById(lease.jobId);
    if (jobForRequest === undefined)
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    const requestId = jobForRequest.request_id;
    const request = this.database.findCloudRequestById(requestId);
    if (request === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
    const existing = this.database.findCloudResultCache(requestId);
    if (existing?.state === 'ready') {
      const completionJob = this.database.findAnalysisJobByRequest(requestId);
      if (
        existing.completion_job_id !== lease.jobId ||
        existing.completion_lease_owner !== lease.leaseOwner ||
        completionJob?.id !== lease.jobId ||
        completionJob.state !== 'succeeded'
      ) {
        throw new CloudResultFailure(409, 'cloud_result_context_mismatch');
      }
      const visible = this.database.findCloudRequest(request.account_id, requestId);
      if (visible === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
      return resultStatus(visible);
    }
    if (existing === undefined || existing.state !== 'staged') {
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    }
    if (this.isExpired(existing.expires_at)) {
      if (!this.expireStagedAndCleanup(requestId)) {
        const current = this.database.findCloudRequest(request.account_id, requestId);
        if (current?.result_state === 'ready') return resultStatus(current);
      }
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    }

    const envelope = this.readAndDecode(requestId);
    const job = this.database.findAnalysisJobByRequest(requestId);
    if (envelope === null || !this.cacheMatchesEnvelope(existing, envelope)) {
      this.invalidateStaged(requestId);
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    }
    this.requireLiveLease(request, job, envelope, lease);
    this.removeTransientUpload(requestId);

    const now = this.clock.now();
    const readyAt = now.toISOString();
    const stagedExpiry = Date.parse(existing.expires_at);
    const expiresAt = new Date(
      Math.min(
        Number.isFinite(stagedExpiry) ? stagedExpiry : now.getTime() + CLOUD_RESULT_RETENTION_MS,
        now.getTime() + CLOUD_RESULT_RETENTION_MS,
      ),
    ).toISOString();
    try {
      this.database.transaction(() => {
        const currentRequest = this.database.findCloudRequestById(requestId);
        const currentJob = this.database.findAnalysisJobByRequest(requestId);
        const currentResult = this.database.findCloudResultCache(requestId);
        if (currentRequest === undefined) {
          throw new CloudResultFailure(404, 'cloud_result_not_available');
        }
        if (currentResult?.state === 'ready') return;
        if (currentResult === undefined || currentResult.state !== 'staged') {
          throw new CloudResultFailure(409, 'cloud_result_conflict');
        }
        if (!this.cacheMatchesEnvelope(currentResult, envelope)) {
          throw new CloudResultFailure(409, 'cloud_result_conflict');
        }
        this.requireLiveLease(currentRequest, currentJob, envelope, lease);
        const reservation = this.database.findAllowanceReservation(requestId);
        if (
          reservation === undefined ||
          reservation.account_id !== currentRequest.account_id ||
          reservation.kind !== allowanceKind(currentRequest.operation)
        ) {
          throw new CloudResultFailure(409, 'cloud_result_context_mismatch');
        }
        this.commerce.consumeInTransaction(requestId);
        if (
          currentJob === undefined ||
          !this.database.markAnalysisJobSucceeded(
            currentJob.id,
            requestId,
            lease.leaseOwner,
            readyAt,
          )
        ) {
          throw new CloudResultFailure(409, 'cloud_result_context_mismatch');
        }
        if (
          !this.database.activateCloudResult(
            requestId,
            readyAt,
            expiresAt,
            currentJob.id,
            lease.leaseOwner,
          )
        ) {
          throw new CloudResultFailure(409, 'cloud_result_conflict');
        }
      });
    } catch (error) {
      // Cleanup has already happened, but a failed transaction leaves the staged ciphertext and
      // reservation intact. A reclaimed lease can retry this exact bytes-only operation safely.
      if (error instanceof CloudResultFailure) throw error;
      throw new CloudResultFailure(503, 'cloud_result_storage_failure');
    }
    const visible = this.database.findCloudRequest(request.account_id, requestId);
    if (visible === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
    return resultStatus(visible);
  }

  /** Return status while applying the result expiry boundary on demand. */
  status(accountId: unknown, requestId: unknown): CloudRequestStatusResponse {
    let row: CloudRequestRow;
    try {
      row = this.ownerRequest(accountId, requestId);
    } catch (error) {
      // Preserve the existing status endpoint's bounded not-found contract. Result retrieval has
      // its own indistinguishable result-specific 404 below.
      if (error instanceof CloudResultFailure && error.code === 'cloud_result_not_available') {
        throw new CloudRequestFailure(404, 'cloud_request_not_found');
      }
      throw error;
    }
    if (row.result_state === 'ready' && this.isExpired(row.result_expires_at)) {
      this.expireReady(row.id);
      const expired = this.database.findCloudRequest(row.account_id, row.id);
      if (expired === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
      return resultStatus(expired);
    }
    if (row.result_state === 'staged' && this.isExpired(row.result_expires_at)) {
      this.expireStagedAndCleanup(row.id);
      const expired = this.database.findCloudRequest(row.account_id, row.id);
      if (expired === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
      return resultStatus(expired);
    }
    return resultStatus(row);
  }

  /** Retrieve the exact canonical serialized envelope once for its owning account. */
  retrieve(accountId: unknown, requestId: unknown): Buffer {
    const row = this.ownerRequest(accountId, requestId);
    if (row.result_state !== 'ready') {
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    }
    if (this.isExpired(row.result_expires_at)) {
      this.expireReady(row.id);
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    }

    let bytes: Buffer;
    let envelope: CloudResultEnvelope;
    try {
      bytes = this.resultStore.read(row.id);
      if (
        bytes.byteLength !== row.result_byte_count ||
        bytes.byteLength > CLOUD_RESULT_MAX_SERIALIZED_BYTES
      ) {
        throw new Error('wrong_size');
      }
      envelope = decodeCloudResultEnvelopeJson(bytes.toString('utf8'));
      const canonical = Buffer.from(serializeCloudResultEnvelope(envelope), 'utf8');
      if (!sameBytes(canonical, bytes)) throw new Error('non_canonical');
      const job = this.database.findAnalysisJobByRequest(row.id);
      this.requireContext(row, job, envelope);
    } catch {
      this.invalidateReady(row.id);
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    }

    // Claim retrieval before unlinking. This is the one-time cross-process guard; a crash leaves
    // retrieved metadata for reconciliation to remove without ever returning the envelope again.
    const claimed = this.database.transaction(() =>
      this.database.markCloudResultRetrieved(row.id, this.clock.now().toISOString()),
    );
    if (!claimed) throw new CloudResultFailure(404, 'cloud_result_not_available');
    try {
      this.resultStore.remove(row.id);
    } catch {
      // The exact bytes were already read and retrieval was claimed atomically. Return them even
      // when unlinking fails so a valid result is not lost; terminal metadata prevents a second
      // response, while reconciliation and strict deletion retry the encrypted-file cleanup.
    }
    return bytes;
  }

  /** Reconcile result metadata and files after restart or a filesystem/SQLite crash window. */
  reconcile(options: { readonly strict?: boolean } = {}): void {
    let artifacts: readonly CloudResultArtifact[];
    try {
      artifacts = this.resultStore.list();
    } catch {
      if (options.strict) throw new CloudResultFailure(500, 'cloud_account_cleanup_incomplete');
      return;
    }
    const now = this.clock.now();
    const nowMs = now.getTime();
    const requests = this.database.listCloudRequests();
    const requestsById = new Map(requests.map((request) => [request.id, request]));
    const results = this.database.listCloudResultCache();
    const resultsById = new Map(results.map((result) => [result.request_id, result]));
    const byId = new Map<string, CloudResultArtifact>();
    for (const artifact of artifacts) {
      if (artifact.kind === 'complete') byId.set(artifact.requestId, artifact);
    }
    let cleanupFailed = false;

    for (const result of results) {
      const request = requestsById.get(result.request_id);
      const artifact = byId.get(result.request_id);
      if (result.state === 'staged') {
        // A staged cache remains intentionally invisible. Keep it (and its reservation) while
        // its ciphertext is valid; a later reclaimed live lease can finish finalization.
        if (this.isExpired(result.expires_at, nowMs)) {
          if (this.expireStaged(result.request_id, now.toISOString())) {
            cleanupFailed = this.tryRemove(result.request_id, artifacts, cleanupFailed);
            cleanupFailed = this.tryRemoveTransientUpload(result.request_id, cleanupFailed);
          }
          continue;
        }
        if (
          request === undefined ||
          artifact === undefined ||
          !artifact.regular ||
          artifact.size !== result.byte_count ||
          !this.artifactMatchesContext(request, artifact, result)
        ) {
          this.markStagedFailed(result.request_id);
          cleanupFailed = this.tryRemove(result.request_id, artifacts, cleanupFailed);
          cleanupFailed = this.tryRemoveTransientUpload(result.request_id, cleanupFailed);
        }
        continue;
      }
      if (result.state !== 'ready') {
        cleanupFailed = this.tryRemove(result.request_id, artifacts, cleanupFailed);
        cleanupFailed = this.tryRemoveTransientUpload(result.request_id, cleanupFailed);
        continue;
      }
      if (this.isExpired(result.expires_at, nowMs)) {
        // Persist the terminal classification before best-effort unlinking. A crash after this
        // update must converge to expired even when the file was already absent or unlink fails.
        this.database.markCloudResultExpired(result.request_id, now.toISOString());
        const removed = this.removeRequestArtifacts(result.request_id, artifacts);
        if (!removed) cleanupFailed = true;
        cleanupFailed = this.tryRemoveTransientUpload(result.request_id, cleanupFailed);
        continue;
      }
      if (request === undefined || artifact === undefined || !artifact.regular) {
        this.database.markCloudResultFailed(result.request_id, 'cloud_result_cache_missing');
        cleanupFailed = this.tryRemove(result.request_id, artifacts, cleanupFailed);
        cleanupFailed = this.tryRemoveTransientUpload(result.request_id, cleanupFailed);
        continue;
      }
      if (
        artifact.size !== result.byte_count ||
        !this.artifactMatchesContext(request, artifact, result)
      ) {
        this.database.markCloudResultFailed(result.request_id, 'cloud_result_cache_invalid');
        cleanupFailed = this.tryRemove(result.request_id, artifacts, cleanupFailed);
        cleanupFailed = this.tryRemoveTransientUpload(result.request_id, cleanupFailed);
      }
    }

    for (const artifact of artifacts) {
      if (artifact.kind === 'partial') {
        cleanupFailed = this.tryRemoveEntry(artifact, cleanupFailed);
        continue;
      }
      if (!artifact.regular) {
        cleanupFailed = this.tryRemoveEntry(artifact, cleanupFailed);
        continue;
      }
      const result = resultsById.get(artifact.requestId);
      if (result !== undefined) continue;
      const request = requestsById.get(artifact.requestId);
      const job =
        request === undefined ? undefined : this.database.findAnalysisJobByRequest(request.id);
      if (
        request === undefined ||
        request.state !== 'queued' ||
        job === undefined ||
        (job.state !== 'queued' && job.state !== 'processing') ||
        artifact.modifiedAtMs + CLOUD_RESULT_RETENTION_MS <= nowMs
      ) {
        cleanupFailed = this.tryRemoveEntry(artifact, cleanupFailed);
        continue;
      }
      const envelope = this.readAndDecode(artifact.requestId);
      if (envelope === null || !this.contextMatches(request, job, envelope)) {
        cleanupFailed = this.tryRemoveEntry(artifact, cleanupFailed);
        continue;
      }
      const bytes = Buffer.from(serializeCloudResultEnvelope(envelope), 'utf8');
      const readyAt = new Date(artifact.modifiedAtMs).toISOString();
      const expiresAt = new Date(
        Math.min(
          artifact.modifiedAtMs + CLOUD_RESULT_RETENTION_MS,
          nowMs + CLOUD_RESULT_RETENTION_MS,
        ),
      ).toISOString();
      if (Date.parse(expiresAt) <= nowMs) {
        cleanupFailed = this.tryRemoveEntry(artifact, cleanupFailed);
        continue;
      }
      try {
        this.database.transaction(() => {
          if (this.database.findCloudResultCache(request.id) === undefined) {
            this.database.createCloudResultCache({
              request_id: request.id,
              state: 'staged',
              result_schema_version: envelope.resultSchemaVersion,
              handler_version: envelope.handlerVersion,
              byte_count: bytes.byteLength,
              ready_at: null,
              staged_at: readyAt,
              completion_job_id: null,
              completion_lease_owner: null,
              expires_at: expiresAt,
              retrieved_at: null,
              expired_at: null,
              failure_category: null,
            });
          }
        });
      } catch {
        cleanupFailed = true;
      }
    }

    try {
      this.resultStore.removeUnknownEntries(
        new Set(
          requests.filter((request) => request.state === 'queued').map((request) => request.id),
        ),
      );
    } catch {
      cleanupFailed = true;
    }

    if (options.strict) {
      let names: readonly string[];
      let remaining: readonly CloudResultArtifact[];
      try {
        names = this.resultStore.listEntryNames();
        remaining = this.resultStore.list();
      } catch {
        throw new CloudResultFailure(500, 'cloud_account_cleanup_incomplete');
      }
      const currentResults = new Map(
        this.database.listCloudResultCache().map((result) => [result.request_id, result]),
      );
      const allowedNames = new Set(
        remaining
          .filter((artifact) => {
            const result = currentResults.get(artifact.requestId);
            return (
              artifact.kind === 'complete' &&
              artifact.regular &&
              (result?.state === 'ready' || result?.state === 'staged') &&
              artifact.size === result.byte_count
            );
          })
          .map((artifact) => `${artifact.requestId}.json`),
      );
      if (cleanupFailed || names.some((name) => !allowedNames.has(name))) {
        throw new CloudResultFailure(500, 'cloud_account_cleanup_incomplete');
      }
    }
  }

  private ownerRequest(accountId: unknown, requestId: unknown): CloudRequestRow {
    if (!validAccountId(accountId) || !validRequestId(requestId)) {
      throw new CloudResultFailure(404, 'cloud_result_not_available');
    }
    const row = this.database.findCloudRequest(accountId, requestId);
    if (row === undefined) throw new CloudResultFailure(404, 'cloud_result_not_available');
    return row;
  }

  private requireContext(
    request: CloudRequestRow,
    job: AnalysisJobRow | undefined,
    envelope: CloudResultEnvelope,
  ): void {
    if (!this.contextMatches(request, job, envelope)) {
      throw new CloudResultFailure(409, 'cloud_result_context_mismatch');
    }
  }

  private requireLiveLease(
    request: CloudRequestRow,
    job: AnalysisJobRow | undefined,
    envelope: CloudResultEnvelope,
    lease: CloudResultLease,
  ): void {
    if (
      !this.contextMatches(request, job, envelope) ||
      job === undefined ||
      job.id !== lease.jobId ||
      job.state !== 'processing' ||
      job.lease_owner !== lease.leaseOwner ||
      job.lease_expires_at === null ||
      Date.parse(job.lease_expires_at) <= this.clock.now().getTime()
    ) {
      throw new CloudResultFailure(409, 'cloud_result_context_mismatch');
    }
  }

  private cacheMatchesEnvelope(cache: CloudResultCacheRow, envelope: CloudResultEnvelope): boolean {
    return (
      cache.result_schema_version === envelope.resultSchemaVersion &&
      cache.handler_version === envelope.handlerVersion &&
      cache.byte_count === Buffer.byteLength(serializeCloudResultEnvelope(envelope), 'utf8')
    );
  }

  private contextMatches(
    request: CloudRequestRow,
    job: AnalysisJobRow | undefined,
    envelope: CloudResultEnvelope,
  ): boolean {
    return (
      request.state === 'queued' &&
      job !== undefined &&
      (job.state === 'queued' || job.state === 'processing' || job.state === 'succeeded') &&
      job.request_id === request.id &&
      job.request_contract_version === request.contract_version &&
      envelope.requestId === request.id &&
      envelope.contractVersion === request.contract_version &&
      envelope.resultSchemaVersion === job.schema_version &&
      envelope.handlerVersion === job.handler_version
    );
  }

  private artifactMatchesContext(
    request: CloudRequestRow,
    artifact: CloudResultArtifact,
    result: CloudResultCacheRow,
  ): boolean {
    const envelope = this.readAndDecode(artifact.requestId);
    const job = this.database.findAnalysisJobByRequest(request.id);
    return (
      envelope !== null &&
      Buffer.byteLength(serializeCloudResultEnvelope(envelope), 'utf8') === result.byte_count &&
      envelope.resultSchemaVersion === result.result_schema_version &&
      envelope.handlerVersion === result.handler_version &&
      this.contextMatches(request, job, envelope)
    );
  }

  private readAndDecode(requestId: string): CloudResultEnvelope | null {
    try {
      const bytes = this.resultStore.read(requestId);
      if (bytes.byteLength > CLOUD_RESULT_MAX_SERIALIZED_BYTES) return null;
      const envelope = decodeCloudResultEnvelopeJson(bytes.toString('utf8'));
      const canonical = Buffer.from(serializeCloudResultEnvelope(envelope), 'utf8');
      return sameBytes(canonical, bytes) ? envelope : null;
    } catch {
      return null;
    }
  }

  private expireReady(requestId: string): void {
    this.database.transaction(() => {
      this.database.markCloudResultExpired(requestId, this.clock.now().toISOString());
    });
    try {
      this.resultStore.remove(requestId);
    } catch {
      // Expired metadata is durable even when physical cleanup needs reconciliation.
      throw new CloudResultFailure(503, 'cloud_result_storage_failure');
    }
  }

  private invalidateReady(requestId: string): void {
    try {
      this.resultStore.remove(requestId);
    } catch {
      // The state is made unusable even if an unlink needs a later reconciliation pass.
    }
    this.database.transaction(() => {
      this.database.markCloudResultFailed(requestId, 'cloud_result_cache_invalid');
    });
  }

  private invalidateStaged(requestId: string): void {
    try {
      this.resultStore.remove(requestId);
    } catch {
      // The row is made unavailable even if physical cleanup needs a later reconciliation pass.
    }
    this.markStagedFailed(requestId);
    // Invalid staged output cannot be finalized; remove its source media as part of the same
    // best-effort cleanup path used by reconciliation. The cache is already unavailable even if
    // a filesystem retry remains necessary.
    this.tryRemoveTransientUpload(requestId, false);
  }

  private markStagedFailed(requestId: string): boolean {
    return this.database.transaction(() => {
      const result = this.database.findCloudResultCache(requestId);
      if (result?.state !== 'staged') return false;
      const failed = this.database.markCloudResultFailed(requestId, 'cloud_result_cache_invalid');
      if (!failed) return false;
      const job = this.database.findAnalysisJobByRequest(requestId);
      if (job !== undefined) {
        this.database.markAnalysisJobFailed(
          job.id,
          requestId,
          'cloud_result_cache_invalid',
          this.clock.now().toISOString(),
        );
      }
      this.commerce.releaseInTransaction(requestId);
      return true;
    });
  }

  private expireStaged(requestId: string, expiredAt = this.clock.now().toISOString()): boolean {
    return this.database.transaction(() => {
      const result = this.database.findCloudResultCache(requestId);
      if (result?.state !== 'staged') return false;
      const expired = this.database.markCloudResultExpired(requestId, expiredAt);
      if (!expired) return false;
      const job = this.database.findAnalysisJobByRequest(requestId);
      if (job !== undefined) this.database.markAnalysisJobExpired(job.id, requestId, expiredAt);
      this.commerce.releaseInTransaction(requestId);
      return true;
    });
  }

  private expireStagedAndCleanup(requestId: string): boolean {
    if (!this.expireStaged(requestId)) return false;
    try {
      this.resultStore.remove(requestId);
    } catch {
      throw new CloudResultFailure(503, 'cloud_result_storage_failure');
    }
    this.removeTransientUpload(requestId);
    return true;
  }

  private removeTransientUpload(requestId: string): void {
    try {
      this.uploadStore.remove(requestId);
      if (this.uploadStore.list().some((artifact) => artifact.requestId === requestId)) {
        throw new Error('cloud_upload_cleanup_incomplete');
      }
    } catch (error) {
      if (error instanceof CloudResultFailure) throw error;
      throw new CloudResultFailure(503, 'cloud_result_storage_failure');
    }
  }

  private tryRemoveTransientUpload(requestId: string, failed: boolean): boolean {
    try {
      this.uploadStore.remove(requestId);
      if (this.uploadStore.list().some((artifact) => artifact.requestId === requestId)) return true;
      return failed;
    } catch {
      return true;
    }
  }

  private isExpired(value: string | null | undefined, nowMs = this.clock.now().getTime()): boolean {
    return value !== null && value !== undefined && Date.parse(value) <= nowMs;
  }

  private tryRemove(
    requestId: string,
    artifacts: readonly CloudResultArtifact[],
    failed: boolean,
  ): boolean {
    return this.tryRemoveEntryResult(requestId, artifacts, failed);
  }

  private removeRequestArtifacts(
    requestId: string,
    artifacts: readonly CloudResultArtifact[],
  ): boolean {
    const entries = artifacts.filter((artifact) => artifact.requestId === requestId);
    let removed = true;
    for (const entry of entries) {
      try {
        this.resultStore.removeEntry(entry);
      } catch {
        removed = false;
      }
    }
    return removed;
  }

  private tryRemoveEntryResult(
    requestId: string,
    artifacts: readonly CloudResultArtifact[],
    failed: boolean,
  ): boolean {
    return this.removeRequestArtifacts(requestId, artifacts) ? failed : true;
  }

  private tryRemoveEntry(artifact: CloudResultArtifact, failed: boolean): boolean {
    try {
      this.resultStore.removeEntry(artifact);
      return failed;
    } catch {
      return true;
    }
  }
}
