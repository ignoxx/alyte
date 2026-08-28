import { randomUUID } from 'node:crypto';
import type {
  AccountDatabase,
  AnalysisJobLeaseOutcome,
  AnalysisJobRow,
  CloudProcessingFailureCategory,
} from './database.js';
import { CLOUD_PROCESSING_FAILURE_CATEGORIES } from './database.js';

export const ANALYSIS_JOB_HANDLER_VERSION = 1;
/** A job is recoverable after one minute without a heartbeat. */
export const ANALYSIS_JOB_LEASE_DURATION_MS = 60_000;
export const ANALYSIS_JOB_MAX_LEASE_DURATION_MS = 5 * 60_000;
/** Heartbeats happen well inside the lease window, leaving room for a delayed timer. */
export const ANALYSIS_JOB_HEARTBEAT_INTERVAL_MS = 15_000;
export const ANALYSIS_JOB_POLL_INTERVAL_MS = 1_000;
export const ANALYSIS_JOB_MAX_DRAIN_GRACE_MS = 120_000;
export const ANALYSIS_JOB_DEFAULT_DRAIN_GRACE_MS = 30_000;

export interface JobRunner {
  start(): void;
  stop(options?: { readonly gracePeriodMs?: number }): Promise<void>;
}

export interface JobRunnerClock {
  now(): Date;
}

export interface JobRunnerTimer {
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface JobRunnerLogger {
  info(
    event: string,
    attributes: {
      readonly handlerVersion?: number;
      readonly outcome?: string;
      readonly category?: CloudProcessingFailureCategory;
    },
  ): void;
  warn(
    event: string,
    attributes: {
      readonly handlerVersion?: number;
      readonly outcome?: string;
      readonly category?: CloudProcessingFailureCategory;
    },
  ): void;
}

export type AnalysisJobOutcome =
  | { readonly type: 'completed' }
  | { readonly type: 'failure'; readonly category: CloudProcessingFailureCategory };

export interface AnalysisJobHandlerContext {
  /** Renew the current lease. The operation is owner- and state-bound and is fail-closed. */
  heartbeat(): AnalysisJobLeaseOutcome;
}

export type AnalysisJobHandler = (
  job: AnalysisJobRow,
  context: AnalysisJobHandlerContext,
) => void | AnalysisJobOutcome | Promise<void | AnalysisJobOutcome>;

export type AnalysisJobFailureProcessor = (
  lease: { readonly jobId: string; readonly leaseOwner: string },
  category: CloudProcessingFailureCategory,
) => void | Promise<void>;

export interface JobRunnerOptions {
  readonly database?: AccountDatabase;
  readonly clock?: JobRunnerClock;
  readonly ownerId?: string;
  readonly handler?: AnalysisJobHandler;
  /** Required with handler; omission keeps the runner dormant and prevents blind requeueing. */
  readonly failureProcessor?: AnalysisJobFailureProcessor;
  readonly logger?: JobRunnerLogger;
  readonly timer?: JobRunnerTimer;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly leaseDurationMs?: number;
}

type ConfiguredJobRunnerOptions = JobRunnerOptions & {
  readonly database: AccountDatabase;
  readonly handler: AnalysisJobHandler;
  readonly failureProcessor: AnalysisJobFailureProcessor;
};

const systemClock: JobRunnerClock = { now: () => new Date() };
const systemTimer: JobRunnerTimer = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
};
const quietLogger: JobRunnerLogger = {
  info: () => undefined,
  warn: () => undefined,
};

const processingFailureCategories = new Set<string>(CLOUD_PROCESSING_FAILURE_CATEGORIES);

function isProcessingFailureCategory(value: unknown): value is CloudProcessingFailureCategory {
  return typeof value === 'string' && processingFailureCategories.has(value);
}

interface CancellableWait {
  readonly promise: Promise<void>;
  cancel(): void;
}

function cancellableWait(timer: JobRunnerTimer, milliseconds: number): CancellableWait {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let resolveWait!: () => void;
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    handle = undefined;
    resolveWait();
  };
  const promise = new Promise<void>((resolve) => {
    resolveWait = resolve;
    handle = timer.setTimeout(settle, milliseconds);
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      if (handle !== undefined) timer.clearTimeout(handle);
      settle();
    },
  };
}

function validOwner(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value);
}

function boundedPositiveMilliseconds(
  value: number | undefined,
  fallback: number,
  maximum = ANALYSIS_JOB_MAX_LEASE_DURATION_MS,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error('analysis_job_timing_invalid');
  }
  return value;
}

function boundedGracePeriod(value: number | undefined): number {
  const grace = value ?? ANALYSIS_JOB_DEFAULT_DRAIN_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 0 || grace > ANALYSIS_JOB_MAX_DRAIN_GRACE_MS) {
    throw new Error('analysis_job_drain_grace_invalid');
  }
  return grace;
}

type ActiveJob = {
  readonly job: AnalysisJobRow;
  heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  relinquished: boolean;
};

class DurableJobRunner implements JobRunner {
  private readonly database: AccountDatabase;
  private readonly clock: JobRunnerClock;
  private readonly ownerId: string;
  private readonly handler: AnalysisJobHandler;
  private readonly failureProcessor: AnalysisJobFailureProcessor;
  private readonly logger: JobRunnerLogger;
  private readonly timer: JobRunnerTimer;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly active = new Map<string, ActiveJob>();
  private readonly pendingWaits = new Set<CancellableWait>();
  private unsupportedVersions = new Set<number>();
  private loopPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private running = false;

  constructor(options: ConfiguredJobRunnerOptions) {
    this.database = options.database;
    this.clock = options.clock ?? systemClock;
    this.ownerId = options.ownerId ?? `runner-${randomUUID()}`;
    if (!validOwner(this.ownerId)) throw new Error('analysis_job_owner_invalid');
    this.handler = options.handler;
    this.failureProcessor = options.failureProcessor;
    this.logger = options.logger ?? quietLogger;
    this.timer = options.timer ?? systemTimer;
    this.pollIntervalMs = boundedPositiveMilliseconds(
      options.pollIntervalMs,
      ANALYSIS_JOB_POLL_INTERVAL_MS,
    );
    this.heartbeatIntervalMs = boundedPositiveMilliseconds(
      options.heartbeatIntervalMs,
      ANALYSIS_JOB_HEARTBEAT_INTERVAL_MS,
    );
    this.leaseDurationMs = boundedPositiveMilliseconds(
      options.leaseDurationMs,
      ANALYSIS_JOB_LEASE_DURATION_MS,
    );
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new Error('analysis_job_heartbeat_interval_invalid');
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopPromise = undefined;
    this.loopPromise = this.runLoop();
  }

  stop(options: { readonly gracePeriodMs?: number } = {}): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    const gracePeriodMs = boundedGracePeriod(options.gracePeriodMs);
    this.running = false;
    this.cancelPendingWaits();
    this.stopPromise = this.drain(gracePeriodMs);
    return this.stopPromise;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const now = this.clock.now();
        this.observeUnsupported(now);
        if (!this.running) break;
        const claimed = this.claim(now);
        if (claimed === undefined) {
          await this.wait(this.pollIntervalMs);
          continue;
        }
        await this.runHandler(claimed);
      } catch {
        // Keep repository and timer failures from terminating the retryable polling loop. The
        // next bounded poll is a safe retry point; no exception details enter operational logs.
        this.logWarn(undefined, 'runner_iteration_failed');
        if (this.running) await this.wait(this.pollIntervalMs);
      }
    }
  }

  private async runHandler(claimed: AnalysisJobRow): Promise<void> {
    const active: ActiveJob = { job: claimed, heartbeatTimer: undefined, relinquished: false };
    this.active.set(claimed.id, active);
    try {
      this.logInfo(claimed.handler_version, 'claimed');
      this.scheduleHeartbeat(active);
      if (claimed.failure_cleanup_pending === 1) {
        // A terminal intent is durable before media cleanup. Reclaimed jobs go straight to the
        // typed cleanup/finalization seam; the ordinary provider handler is never replayed.
        const category = claimed.failure_cleanup_category;
        if (!isProcessingFailureCategory(category)) {
          this.logWarn(claimed.handler_version, 'failure_recovery_category_invalid');
          return;
        }
        try {
          await this.failureProcessor({ jobId: claimed.id, leaseOwner: this.ownerId }, category);
          this.logInfo(claimed.handler_version, 'failure_recovered', { category });
        } catch {
          // Keep the recovery lease until expiry. The durable intent is the only source of the
          // category, so a later owner can retry cleanup without provider replay.
          this.logWarn(claimed.handler_version, 'failure_recovery_failed', { category });
        }
        return;
      }
      const handlerOutcome = await this.handler(claimed, {
        heartbeat: () => this.heartbeat(active),
      });
      if (handlerOutcome?.type === 'completed') {
        this.logInfo(claimed.handler_version, 'completed');
        return;
      }
      if (handlerOutcome?.type === 'failure') {
        // Provider adapters are an untrusted boundary at runtime even though the seam is typed.
        // Reject unknown values before they reach the failure service or operational logs.
        if (!isProcessingFailureCategory(handlerOutcome.category)) {
          this.logWarn(claimed.handler_version, 'failure_category_invalid');
          try {
            await this.failureProcessor(
              { jobId: claimed.id, leaseOwner: this.ownerId },
              'malformed_output',
            );
            this.logInfo(claimed.handler_version, 'failure_processed', {
              category: 'malformed_output',
            });
          } catch {
            this.logWarn(claimed.handler_version, 'failure_processing_failed', {
              category: 'malformed_output',
            });
          }
          return;
        }
        try {
          await this.failureProcessor(
            { jobId: claimed.id, leaseOwner: this.ownerId },
            handlerOutcome.category,
          );
          this.logInfo(claimed.handler_version, 'failure_processed', {
            category: handlerOutcome.category,
          });
        } catch {
          // Cleanup failure or a stale lease must remain retryable. Do not relinquish here: the
          // current lease can expire and a later owner can retry without losing the upload.
          this.logWarn(claimed.handler_version, 'failure_processing_failed', {
            category: handlerOutcome.category,
          });
        }
        return;
      }
      this.requeueAfterHandler(active);
    } catch {
      try {
        await this.failureProcessor(
          { jobId: claimed.id, leaseOwner: this.ownerId },
          'provider_failure',
        );
        this.logInfo(claimed.handler_version, 'failure_processed', {
          category: 'provider_failure',
        });
      } catch {
        this.logWarn(claimed.handler_version, 'failure_processing_failed', {
          category: 'provider_failure',
        });
      }
    } finally {
      this.clearHeartbeat(active);
      if (this.active.get(claimed.id) === active) this.active.delete(claimed.id);
    }
  }

  private observeUnsupported(now: Date): void {
    try {
      const versions = new Set(
        this.database.listUnsupportedReadyAnalysisHandlerVersions(now.toISOString(), [
          ANALYSIS_JOB_HANDLER_VERSION,
        ]),
      );
      for (const version of versions) {
        if (this.unsupportedVersions.has(version)) continue;
        this.logWarn(version, 'unsupported_handler');
      }
      this.unsupportedVersions = versions;
    } catch {
      this.logWarn(undefined, 'unsupported_observation_failed');
    }
  }

  private claim(now: Date): AnalysisJobRow | undefined {
    try {
      const nowIso = now.toISOString();
      return this.database.claimAnalysisJob({
        now: nowIso,
        leaseOwner: this.ownerId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
        supportedHandlerVersions: [ANALYSIS_JOB_HANDLER_VERSION],
      });
    } catch {
      this.logWarn(undefined, 'claim_failed');
      return undefined;
    }
  }

  private scheduleHeartbeat(active: ActiveJob): void {
    if (active.relinquished) return;
    active.heartbeatTimer = this.timer.setTimeout(() => {
      active.heartbeatTimer = undefined;
      if (active.relinquished || this.active.get(active.job.id) !== active) return;
      const result = this.heartbeatResult(active);
      const outcome = result.outcome;
      if (outcome !== 'renewed') {
        this.logWarn(active.job.handler_version, `heartbeat_${outcome}`);
      }
      if (result.retry || outcome === 'renewed') this.scheduleHeartbeat(active);
    }, this.heartbeatIntervalMs);
  }

  private heartbeat(active: ActiveJob): AnalysisJobLeaseOutcome {
    return this.heartbeatResult(active).outcome;
  }

  private heartbeatResult(active: ActiveJob): {
    readonly outcome: AnalysisJobLeaseOutcome;
    readonly retry: boolean;
  } {
    if (active.relinquished) return { outcome: 'not-live', retry: false };
    const now = this.clock.now();
    try {
      return {
        outcome: this.database.heartbeatAnalysisJob({
          jobId: active.job.id,
          leaseOwner: this.ownerId,
          now: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
        }),
        retry: false,
      };
    } catch {
      this.logWarn(active.job.handler_version, 'heartbeat_failed');
      return { outcome: 'not-live', retry: true };
    }
  }

  private requeueAfterHandler(active: ActiveJob): void {
    if (active.relinquished) return;
    try {
      const now = this.clock.now();
      const outcome = this.database.relinquishAnalysisJob({
        jobId: active.job.id,
        leaseOwner: this.ownerId,
        now: now.toISOString(),
        availableAt: new Date(now.getTime() + this.pollIntervalMs).toISOString(),
      });
      if (outcome === 'relinquished') this.logInfo(active.job.handler_version, 'requeued');
    } catch {
      this.logWarn(active.job.handler_version, 'requeue_failed');
    }
  }

  private clearHeartbeat(active: ActiveJob): void {
    if (active.heartbeatTimer !== undefined) {
      this.timer.clearTimeout(active.heartbeatTimer);
      active.heartbeatTimer = undefined;
    }
  }

  private async drain(gracePeriodMs: number): Promise<void> {
    const loop = this.loopPromise;
    if (loop === undefined && this.active.size === 0) return;
    const completed = loop === undefined ? Promise.resolve() : loop;
    const graceWait = cancellableWait(this.timer, gracePeriodMs);
    const timedOut = await Promise.race([
      completed.then(() => false),
      graceWait.promise.then(() => true),
    ]);
    graceWait.cancel();
    if (!timedOut && this.active.size === 0) return;

    // A handler that outlives the grace window is detached from its lease. The handler remains
    // outside SQLite and cannot heartbeat after this point; a future runner may reclaim safely.
    for (const active of this.active.values()) {
      this.clearHeartbeat(active);
      if (active.relinquished) continue;
      active.relinquished = true;
      try {
        const now = this.clock.now();
        const outcome = this.database.relinquishAnalysisJob({
          jobId: active.job.id,
          leaseOwner: this.ownerId,
          now: now.toISOString(),
          availableAt: now.toISOString(),
        });
        if (outcome === 'relinquished') {
          this.logInfo(active.job.handler_version, 'drain_relinquished');
        }
      } catch {
        this.logWarn(active.job.handler_version, 'drain_relinquish_failed');
      }
    }
  }

  private wait(milliseconds: number): Promise<void> {
    const pending = cancellableWait(this.timer, milliseconds);
    this.pendingWaits.add(pending);
    return pending.promise.finally(() => this.pendingWaits.delete(pending));
  }

  private cancelPendingWaits(): void {
    for (const pending of this.pendingWaits) pending.cancel();
  }

  private logInfo(
    handlerVersion: number | undefined,
    outcome: string,
    extra: { readonly category?: CloudProcessingFailureCategory } = {},
  ): void {
    try {
      const attributes = {
        outcome,
        ...(extra.category === undefined ? {} : { category: extra.category }),
      } as {
        handlerVersion?: number;
        outcome: string;
        category?: CloudProcessingFailureCategory;
      };
      if (handlerVersion !== undefined) attributes.handlerVersion = handlerVersion;
      this.logger.info('analysis_job', attributes);
    } catch {
      // Operational logging must never interrupt lease safety or stop/drain completion.
    }
  }

  private logWarn(
    handlerVersion: number | undefined,
    outcome: string,
    extra: { readonly category?: CloudProcessingFailureCategory } = {},
  ): void {
    try {
      const attributes = {
        outcome,
        ...(extra.category === undefined ? {} : { category: extra.category }),
      } as {
        handlerVersion?: number;
        outcome: string;
        category?: CloudProcessingFailureCategory;
      };
      if (handlerVersion !== undefined) attributes.handlerVersion = handlerVersion;
      this.logger.warn('analysis_job', attributes);
    } catch {
      // Operational logging must never interrupt lease safety or stop/drain completion.
    }
  }
}

/**
 * The entrypoint keeps running without a queue during the account-free API foundation. It activates
 * the durable lease runner only when both a database and an explicit handler are supplied; no
 * health payload crosses this lifecycle seam.
 */
export function createJobRunner(options: JobRunnerOptions = {}): JobRunner {
  // A database alone is not enough to activate processing. Keeping the runner inert until both an
  // explicit handler and its closed-taxonomy failure processor are supplied prevents a production
  // process from claiming and churning work while provider configuration is absent.
  if (
    options.database === undefined ||
    options.handler === undefined ||
    options.failureProcessor === undefined
  ) {
    return {
      start: () => undefined,
      stop: async () => undefined,
    };
  }
  return new DurableJobRunner(options as ConfiguredJobRunnerOptions);
}
