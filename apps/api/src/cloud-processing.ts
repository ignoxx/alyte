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

type RetryDecision =
  | { readonly kind: 'retry'; readonly transition: CloudProcessingTransition }
  | { readonly kind: 'terminal' };

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
    // cleanup, and the same guard is repeated inside the finalization transaction.
    if (this.database.findCloudResultCache(request.id) !== undefined) {
      throw new CloudProcessingFailure(409, 'cloud_processing_conflict');
    }

    const previous = this.database.findAnalysisJobOutcome(job.id);
    if (previous !== undefined && previous.request_id === request.id) {
      if (
        previous.category !== category &&
        previous.outcome === 'failed' &&
        (previous.cleanup_pending === 1 || job.state === 'failed')
      ) {
        throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
      }
      if (previous.outcome === 'failed' && previous.cleanup_pending === 1) {
        // The intent is authoritative. A reclaimed owner must finish this path and must never
        // invoke the ordinary provider handler or require a provider response again.
        const now = this.clock.now();
        if (!isLive(job, lease, now.getTime())) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        return this.finishPendingFailure(lease, request.id, category);
      }
      if (
        previous.category === category &&
        previous.lease_owner === lease.leaseOwner &&
        ((previous.outcome === 'retry' && job.state === 'queued') ||
          (previous.outcome === 'failed' && job.state === 'failed'))
      ) {
        return {
          outcome: previous.outcome,
          category,
          status: this.status(request.account_id, request.id),
          availableAt: previous.outcome === 'retry' ? job.available_at : null,
        };
      }
      throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
    }

    const now = this.clock.now();
    if (!isLive(job, lease, now.getTime())) {
      throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
    }

    if (retryable.has(category)) {
      try {
        // A retry is useful only while the exact submitted artifact is still available. A
        // missing/wrong-sized artifact converges through the durable terminal-intent path.
        if (!this.uploadStore.hasExactSize(request.id, request.byte_count)) {
          return this.terminalFailure(lease, request.id, category);
        }
      } catch {
        throw new CloudProcessingFailure(503, 'cloud_processing_cleanup_failed');
      }
      const decision = this.retryOrTerminal(lease, request.id, category);
      if (decision.kind === 'retry') return decision.transition;
    }
    return this.terminalFailure(lease, request.id, category);
  }

  private retryOrTerminal(
    lease: CloudProcessingLease,
    requestId: string,
    category: CloudProcessingFailureCategory,
  ): RetryDecision {
    try {
      return this.database.immediateTransaction(() => {
        // All retry eligibility, expiry comparison, and timestamp arithmetic happen after the
        // SQLite write lock is acquired. A lock wait or clock advance cannot erase the delay.
        const now = this.clock.now();
        const nowIso = now.toISOString();
        const nowMs = now.getTime();
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
        if (!isLive(job, lease, nowMs)) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        const uploadExpiryMs = Date.parse(request.upload_expires_at);
        const availableAtMs = nowMs + retryDelayMs(job.attempts);
        if (
          !Number.isFinite(uploadExpiryMs) ||
          nowMs >= uploadExpiryMs ||
          job.attempts >= CLOUD_PROCESSING_MAX_ATTEMPTS ||
          availableAtMs >= uploadExpiryMs
        ) {
          return { kind: 'terminal' as const };
        }
        const availableAt = new Date(availableAtMs).toISOString();
        if (
          !this.database.markAnalysisJobRetried(
            job.id,
            requestId,
            lease.leaseOwner,
            category,
            nowIso,
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
          recorded_at: nowIso,
          cleanup_pending: 0,
        });
        const current = this.database.findCloudRequest(request.account_id, requestId);
        if (current === undefined) {
          throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
        }
        return {
          kind: 'retry' as const,
          transition: {
            outcome: 'retry' as const,
            category,
            status: toStatus(current),
            availableAt,
          },
        };
      });
    } catch (error) {
      if (error instanceof CloudProcessingFailure) throw error;
      throw new CloudProcessingFailure(503, 'cloud_processing_conflict');
    }
  }

  private terminalFailure(
    lease: CloudProcessingLease,
    requestId: string,
    category: CloudProcessingFailureCategory,
  ): CloudProcessingTransition {
    const intent = this.acceptTerminalIntent(lease, requestId, category);
    if (intent === 'replayed') {
      return {
        outcome: 'failed',
        category,
        status: this.statusForRequest(requestId),
        availableAt: null,
      };
    }
    return this.finishPendingFailure(lease, requestId, category);
  }

  private acceptTerminalIntent(
    lease: CloudProcessingLease,
    requestId: string,
    category: CloudProcessingFailureCategory,
  ): 'accepted' | 'replayed' {
    try {
      return this.database.immediateTransaction(() => {
        const now = this.clock.now();
        const nowIso = now.toISOString();
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
        const previous = this.database.findAnalysisJobOutcome(job.id);
        if (previous !== undefined) {
          if (previous.request_id !== requestId || previous.category !== category) {
            throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
          }
          if (previous.outcome === 'failed' && previous.cleanup_pending === 1) {
            if (!isLive(job, lease, now.getTime())) {
              throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
            }
            return 'accepted';
          }
          if (
            previous.outcome === 'failed' &&
            previous.lease_owner === lease.leaseOwner &&
            job.state === 'failed'
          ) {
            return 'replayed';
          }
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        if (!isLive(job, lease, now.getTime())) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        // This is the durable authority for terminal category and outcome. It is committed
        // separately from filesystem I/O so a crash after this point is recoverable by reclaim.
        this.database.recordAnalysisJobOutcome({
          job_id: job.id,
          request_id: requestId,
          outcome: 'failed',
          category,
          lease_owner: lease.leaseOwner,
          recorded_at: nowIso,
          cleanup_pending: 1,
        });
        return 'accepted';
      });
    } catch (error) {
      if (error instanceof CloudProcessingFailure) throw error;
      throw new CloudProcessingFailure(503, 'cloud_processing_conflict');
    }
  }

  private finishPendingFailure(
    lease: CloudProcessingLease,
    requestId: string,
    category: CloudProcessingFailureCategory,
  ): CloudProcessingTransition {
    // Cleanup remains outside SQLite. The durable pending intent means a cleanup failure or
    // process crash leaves a bounded recovery state without charging or losing the category.
    this.removeTransientUpload(requestId);
    try {
      return this.database.immediateTransaction(() => {
        const now = this.clock.now();
        const nowIso = now.toISOString();
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

        const previous = this.database.findAnalysisJobOutcome(job.id);
        if (
          previous !== undefined &&
          previous.request_id === requestId &&
          previous.category === category &&
          previous.outcome === 'failed' &&
          previous.cleanup_pending === 0 &&
          previous.lease_owner === lease.leaseOwner &&
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
        if (
          previous === undefined ||
          previous.request_id !== requestId ||
          previous.category !== category ||
          previous.outcome !== 'failed' ||
          previous.cleanup_pending !== 1
        ) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        if (!isLive(job, lease, now.getTime())) {
          // Intent stays pending for the owner that successfully reclaims the job.
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        if (
          !this.database.markAnalysisJobProcessingFailed(
            job.id,
            requestId,
            lease.leaseOwner,
            category,
            nowIso,
          )
        ) {
          throw new CloudProcessingFailure(409, 'cloud_processing_context_mismatch');
        }
        this.database.recordAnalysisJobOutcome({
          job_id: job.id,
          request_id: requestId,
          outcome: 'failed',
          category,
          // The finalizing owner is the only one allowed to replay the completed transition.
          lease_owner: lease.leaseOwner,
          recorded_at: nowIso,
          cleanup_pending: 0,
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
      // The upload may already be removed, but the pending intent and reservation remain intact;
      // reclaiming the lease safely retries cleanup/finalization without provider replay.
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

  private statusForRequest(requestId: string): CloudRequestStatusResponse {
    const request = this.database.findCloudRequestById(requestId);
    if (request === undefined) {
      throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
    }
    return this.status(request.account_id, requestId);
  }

  private status(accountId: string, requestId: string): CloudRequestStatusResponse {
    const row = this.database.findCloudRequest(accountId, requestId);
    if (row === undefined) {
      throw new CloudProcessingFailure(404, 'cloud_processing_not_available');
    }
    return toStatus(row);
  }
}
