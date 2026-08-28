import type { CloudRequestStatusResponse } from '@alyte/contracts';
import {
  CLOUD_PROCESSING_FAILURE_CATEGORIES,
  type AccountDatabase,
  type AnalysisJobRow,
  type CloudProcessingFailureCategory,
} from './database.js';
import { toStatus } from './cloud-request.js';
import type { CommerceService } from './commerce.js';
import type { TransientUploadStore } from './transient-upload-store.js';

/** Keep provider retries small and deterministic; this is intentionally not configurable. */
export const CLOUD_PROCESSING_MAX_ATTEMPTS = 3;
export const CLOUD_PROCESSING_RETRY_BASE_DELAY_MS = 1_000;
export const CLOUD_PROCESSING_RETRY_MAX_DELAY_MS = 30_000;

export const CLOUD_PROCESSING_RETRYABLE_CATEGORIES: readonly CloudProcessingFailureCategory[] = [
  'provider_failure',
  'timeout',
];

export type CloudProcessingLease = {
  readonly jobId: string;
  readonly leaseOwner: string;
};

export type CloudProcessingTransition = {
  readonly outcome: 'retry' | 'failed';
  readonly category: CloudProcessingFailureCategory;
  readonly status: CloudRequestStatusResponse;
  readonly availableAt: string | null;
};

export class CloudProcessingFailure extends Error {
  constructor(
    readonly statusCode: number,
    readonly code:
      | 'cloud_processing_category_invalid'
      | 'cloud_processing_not_available'
      | 'cloud_processing_context_mismatch'
      | 'cloud_processing_cleanup_failed'
      | 'cloud_processing_conflict',
  ) {
    super(code);
    this.name = 'CloudProcessingFailure';
  }
}

const retryable = new Set<CloudProcessingFailureCategory>(CLOUD_PROCESSING_RETRYABLE_CATEGORIES);

export function isCloudProcessingFailureCategory(
  value: unknown,
): value is CloudProcessingFailureCategory {
  return (
    typeof value === 'string' &&
    (CLOUD_PROCESSING_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

function boundedCategory(value: unknown): CloudProcessingFailureCategory {
  if (!isCloudProcessingFailureCategory(value)) {
    throw new CloudProcessingFailure(400, 'cloud_processing_category_invalid');
  }
  return value;
}

function isLive(job: AnalysisJobRow, lease: CloudProcessingLease, nowMs: number): boolean {
  return (
    job.state === 'processing' &&
    job.id === lease.jobId &&
    job.lease_owner === lease.leaseOwner &&
    job.lease_expires_at !== null &&
    Date.parse(job.lease_expires_at) > nowMs
  );
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  const delay = CLOUD_PROCESSING_RETRY_BASE_DELAY_MS * 2 ** Math.min(exponent, 30);
  return Math.min(CLOUD_PROCESSING_RETRY_MAX_DELAY_MS, delay);
}

export interface CloudProcessingFailureServiceOptions {
  readonly database: AccountDatabase;
  readonly uploadStore: TransientUploadStore;
  readonly commerce: CommerceService;
  readonly clock?: { now(): Date };
}

const systemClock = { now: () => new Date() };

/**
 * Owns the non-usable processing path. Provider code supplies only a typed category; this class
 * decides whether the live attempt can be retried or must be cleaned up and released. It never
 * accepts or persists provider messages, payloads, prompts, IDs beyond existing operational keys,
 * or readable result data.
 */
export class CloudProcessingFailureService {
  private readonly database: AccountDatabase;
  private readonly uploadStore: TransientUploadStore;
  private readonly commerce: CommerceService;
  private readonly clock: { now(): Date };

  constructor(options: CloudProcessingFailureServiceOptions) {
    this.database = options.database;
    this.uploadStore = options.uploadStore;
    this.commerce = options.commerce;
    this.clock = options.clock ?? systemClock;
  }

  handleFailure(lease: CloudProcessingLease, categoryValue: unknown): CloudProcessingTransition {
    const category = boundedCategory(categoryValue);
    const job = this.database.findAnalysisJobById(lease.jobId);
    if (job === undefined) {
      throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
    }
    const request = this.database.findCloudRequestById(job.request_id);
    if (request === undefined) {
      throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
    }
    if (request.state !== 'queued') {
      throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
    }

    // A usable staged/ready envelope wins over any late provider failure. This check is before
    // cleanup, and the same guard is repeated inside the transaction for a cleanup race.
    const existingResult = this.database.findCloudResultCache(request.id);
    if (existingResult !== undefined) {
      throw new CloudProcessingFailure(409, 'cloud_processing_conflict');
    }

    const previous = this.database.findAnalysisJobOutcome(job.id);
    if (
      previous !== undefined &&
      previous.request_id === request.id &&
      previous.category !== category &&
      (job.state === 'queued' || job.state === 'failed')
    ) {
      throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
    }
    if (
      previous !== undefined &&
      previous.request_id === request.id &&
      previous.category === category &&
      previous.lease_owner === lease.leaseOwner &&
      ((previous.outcome === 'retry' && job.state === 'queued') ||
        (previous.outcome === 'failed' && job.state === 'failed'))
    ) {
      const status = this.status(request.account_id, request.id);
      return {
        outcome: previous.outcome,
        category,
        status,
        availableAt: previous.outcome === 'retry' ? job.available_at : null,
      };
    }

    const now = this.clock.now();
    if (!isLive(job, lease, now.getTime())) {
      throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
    }

    const uploadExpiryMs = Date.parse(request.upload_expires_at);
    const nextAvailableMs = now.getTime() + retryDelayMs(job.attempts);
    const canRetry =
      retryable.has(category) &&
      job.attempts < CLOUD_PROCESSING_MAX_ATTEMPTS &&
      Number.isFinite(uploadExpiryMs) &&
      nextAvailableMs < uploadExpiryMs;
    if (canRetry) {
      try {
        // A retry is useful only while the exact submitted artifact is still available. A
        // missing/wrong-sized artifact converges through the same cleanup-before-failure path.
        if (!this.uploadStore.hasExactSize(request.id, request.byte_count)) {
          return this.failAfterCleanup(lease, request.id, category);
        }
      } catch {
        throw new CloudProcessingFailure(503, 'cloud_processing_cleanup_failed');
      }
      return this.retry(lease, request.id, category, new Date(nextAvailableMs).toISOString());
    }
    return this.failAfterCleanup(lease, request.id, category);
  }

  /** Alias kept explicit for the provider child that will call this typed outcome seam. */
  processFailure(lease: CloudProcessingLease, categoryValue: unknown): CloudProcessingTransition {
    return this.handleFailure(lease, categoryValue);
  }

  private retry(
    lease: CloudProcessingLease,
    requestId: string,
    category: CloudProcessingFailureCategory,
    availableAt: string,
  ): CloudProcessingTransition {
    try {
      return this.database.transaction(() => {
        // Read the lease clock inside the guarded transaction. A write-lock wait must not turn
        // a lease that expired during the wait into an authorized mutation.
        const now = this.clock.now().toISOString();
        const request = this.database.findCloudRequestById(requestId);
        const job = this.database.findAnalysisJobById(lease.jobId);
        if (request === undefined || job === undefined || job.request_id !== requestId) {
          throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
        }
        if (request.state !== 'queued') {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        if (this.database.findCloudResultCache(requestId) !== undefined) {
          throw new CloudProcessingFailure(409, 'cloud_processing_conflict');
        }
        if (!isLive(job, lease, Date.parse(now))) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        if (Date.parse(availableAt) >= Date.parse(request.upload_expires_at)) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        if (Date.parse(now) >= Date.parse(request.upload_expires_at)) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        if (
          !this.database.markAnalysisJobRetried(
            job.id,
            requestId,
            lease.leaseOwner,
            category,
            now,
            availableAt,
          )
        ) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        this.database.recordAnalysisJobOutcome({
          job_id: job.id,
          request_id: requestId,
          outcome: 'retry',
          category,
          lease_owner: lease.leaseOwner,
          recorded_at: now,
        });
        const current = this.database.findCloudRequest(request.account_id, requestId);
        if (current === undefined) {
          throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
        }
        return {
          outcome: 'retry' as const,
          category,
          status: toStatus(current),
          availableAt,
        };
      });
    } catch (error) {
      if (error instanceof CloudProcessingFailure) throw error;
      throw new CloudProcessingFailure(503, 'cloud_processing_conflict');
    }
  }

  private failAfterCleanup(
    lease: CloudProcessingLease,
    requestId: string,
    category: CloudProcessingFailureCategory,
  ): CloudProcessingTransition {
    // Removal is deliberately outside SQLite. If it fails, no public state or ledger row moves;
    // the processing lease expires and a later owner can retry this category without a response.
    this.removeTransientUpload(requestId);
    try {
      return this.database.transaction(() => {
        // Revalidate against the clock inside the transaction after cleanup and any write-lock
        // wait, so an expired owner can never commit a terminal transition.
        const now = this.clock.now().toISOString();
        const request = this.database.findCloudRequestById(requestId);
        const job = this.database.findAnalysisJobById(lease.jobId);
        if (request === undefined || job === undefined || job.request_id !== requestId) {
          throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
        }
        if (request.state !== 'queued') {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        const result = this.database.findCloudResultCache(requestId);
        if (result !== undefined) {
          throw new CloudProcessingFailure(409, 'cloud_processing_conflict');
        }

        const previous = this.database.findAnalysisJobOutcome(job.id);
        if (
          previous !== undefined &&
          previous.request_id === requestId &&
          previous.category === category &&
          previous.lease_owner === lease.leaseOwner &&
          previous.outcome === 'failed' &&
          job.state === 'failed'
        ) {
          const current = this.database.findCloudRequest(request.account_id, requestId);
          if (current === undefined) {
            throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
          }
          return {
            outcome: 'failed' as const,
            category,
            status: toStatus(current),
            availableAt: null,
          };
        }
        if (!isLive(job, lease, Date.parse(now))) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        if (
          !this.database.markAnalysisJobProcessingFailed(
            job.id,
            requestId,
            lease.leaseOwner,
            category,
            now,
          )
        ) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        this.database.recordAnalysisJobOutcome({
          job_id: job.id,
          request_id: requestId,
          outcome: 'failed',
          category,
          lease_owner: lease.leaseOwner,
          recorded_at: now,
        });
        this.commerce.releaseInTransaction(requestId);
        const current = this.database.findCloudRequest(request.account_id, requestId);
        if (current === undefined) {
          throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
        }
        return {
          outcome: 'failed' as const,
          category,
          status: toStatus(current),
          availableAt: null,
        };
      });
    } catch (error) {
      if (error instanceof CloudProcessingFailure) throw error;
      // The upload was already removed, but the reservation and processing row remain intact;
      // retrying after lease reclaim is safe and cannot consume the allowance.
      throw new CloudProcessingFailure(503, 'cloud_processing_conflict');
    }
  }

  private removeTransientUpload(requestId: string): void {
    try {
      this.uploadStore.remove(requestId);
      if (this.uploadStore.list().some((artifact) => artifact.requestId === requestId)) {
        throw new Error('cloud_processing_cleanup_incomplete');
      }
    } catch {
      throw new CloudProcessingFailure(503, 'cloud_processing_cleanup_failed');
    }
  }

  private status(accountId: string, requestId: string): CloudRequestStatusResponse {
    const row = this.database.findCloudRequest(accountId, requestId);
    if (row === undefined) {
      throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
    }
    return toStatus(row);
  }
}

/** Short name for callers that do not need to distinguish the failure policy from its seam. */
export { CloudProcessingFailureService as CloudFailureService };
