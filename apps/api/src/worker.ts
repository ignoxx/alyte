import { randomUUID } from 'node:crypto';
import type { AccountDatabase, AnalysisJobLeaseOutcome, AnalysisJobRow } from './database.js';

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
    attributes: { readonly handlerVersion?: number; readonly outcome?: string },
  ): void;
  warn(
    event: string,
    attributes: { readonly handlerVersion?: number; readonly outcome?: string },
  ): void;
}

export interface AnalysisJobHandlerContext {
  /** Renew the current lease. The operation is owner- and state-bound and is fail-closed. */
  heartbeat(): AnalysisJobLeaseOutcome;
}

export type AnalysisJobHandler = (
  job: AnalysisJobRow,
  context: AnalysisJobHandlerContext,
) => void | Promise<void>;

export interface JobRunnerOptions {
  readonly database?: AccountDatabase;
  readonly clock?: JobRunnerClock;
  readonly ownerId?: string;
  readonly handler?: AnalysisJobHandler;
  readonly logger?: JobRunnerLogger;
  readonly timer?: JobRunnerTimer;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly leaseDurationMs?: number;
}

const systemClock: JobRunnerClock = { now: () => new Date() };
const systemTimer: JobRunnerTimer = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle),
};
const quietLogger: JobRunnerLogger = {
  info: () => undefined,
  warn: () => undefined,
};

function wait(timer: JobRunnerTimer, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    timer.setTimeout(resolve, milliseconds);
  });
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
  private readonly logger: JobRunnerLogger;
  private readonly timer: JobRunnerTimer;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly active = new Map<string, ActiveJob>();
  private unsupportedVersions = new Set<number>();
  private loopPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private running = false;

  constructor(options: JobRunnerOptions & { readonly database: AccountDatabase }) {
    this.database = options.database;
    this.clock = options.clock ?? systemClock;
    this.ownerId = options.ownerId ?? `runner-${randomUUID()}`;
    if (!validOwner(this.ownerId)) throw new Error('analysis_job_owner_invalid');
    this.handler = options.handler ?? (async () => undefined);
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
    this.stopPromise = this.drain(gracePeriodMs);
    return this.stopPromise;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const now = this.clock.now();
      this.observeUnsupported(now);
      if (!this.running) break;
      const nowIso = now.toISOString();
      const claimed = this.database.claimAnalysisJob({
        now: nowIso,
        leaseOwner: this.ownerId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
        supportedHandlerVersions: [ANALYSIS_JOB_HANDLER_VERSION],
      });
      if (claimed === undefined) {
        await wait(this.timer, this.pollIntervalMs);
        continue;
      }
      const active: ActiveJob = { job: claimed, heartbeatTimer: undefined, relinquished: false };
      this.active.set(claimed.id, active);
      this.logger.info('analysis_job', {
        handlerVersion: claimed.handler_version,
        outcome: 'claimed',
      });
      this.scheduleHeartbeat(active);
      try {
        await this.handler(claimed, {
          heartbeat: () => this.heartbeat(active),
        });
        this.requeueAfterHandler(active);
      } catch {
        // This slice has no terminal completion/failure policy. Requeueing leaves the job
        // retryable; later provider/result work owns terminal transitions and error categories.
        this.requeueAfterHandler(active);
      } finally {
        this.clearHeartbeat(active);
        if (this.active.get(claimed.id) === active) this.active.delete(claimed.id);
      }
    }
  }

  private observeUnsupported(now: Date): void {
    const versions = new Set(
      this.database.listUnsupportedReadyAnalysisHandlerVersions(now.toISOString(), [
        ANALYSIS_JOB_HANDLER_VERSION,
      ]),
    );
    for (const version of versions) {
      if (this.unsupportedVersions.has(version)) continue;
      this.logger.warn('analysis_job', { handlerVersion: version, outcome: 'unsupported_handler' });
    }
    this.unsupportedVersions = versions;
  }

  private scheduleHeartbeat(active: ActiveJob): void {
    if (active.relinquished) return;
    active.heartbeatTimer = this.timer.setTimeout(() => {
      active.heartbeatTimer = undefined;
      if (active.relinquished || this.active.get(active.job.id) !== active) return;
      const outcome = this.heartbeat(active);
      if (outcome !== 'renewed') {
        this.logger.warn('analysis_job', {
          handlerVersion: active.job.handler_version,
          outcome: `heartbeat_${outcome}`,
        });
        return;
      }
      this.scheduleHeartbeat(active);
    }, this.heartbeatIntervalMs);
  }

  private heartbeat(active: ActiveJob): AnalysisJobLeaseOutcome {
    if (active.relinquished) return 'not-live';
    const now = this.clock.now();
    return this.database.heartbeatAnalysisJob({
      jobId: active.job.id,
      leaseOwner: this.ownerId,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
    });
  }

  private requeueAfterHandler(active: ActiveJob): void {
    if (active.relinquished) return;
    const now = this.clock.now();
    const outcome = this.database.relinquishAnalysisJob({
      jobId: active.job.id,
      leaseOwner: this.ownerId,
      now: now.toISOString(),
      availableAt: new Date(now.getTime() + this.pollIntervalMs).toISOString(),
    });
    if (outcome === 'relinquished') {
      this.logger.info('analysis_job', {
        handlerVersion: active.job.handler_version,
        outcome: 'requeued',
      });
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
    let timedOut = false;
    await Promise.race([
      completed,
      wait(this.timer, gracePeriodMs).then(() => {
        timedOut = true;
      }),
    ]);
    if (!timedOut && this.active.size === 0) return;

    // A handler that outlives the grace window is detached from its lease. The handler remains
    // outside SQLite and cannot heartbeat after this point; a future runner may reclaim safely.
    for (const active of this.active.values()) {
      this.clearHeartbeat(active);
      if (active.relinquished) continue;
      active.relinquished = true;
      const now = this.clock.now();
      const outcome = this.database.relinquishAnalysisJob({
        jobId: active.job.id,
        leaseOwner: this.ownerId,
        now: now.toISOString(),
        availableAt: now.toISOString(),
      });
      if (outcome === 'relinquished') {
        this.logger.info('analysis_job', {
          handlerVersion: active.job.handler_version,
          outcome: 'drain_relinquished',
        });
      }
    }
  }
}

/**
 * The entrypoint keeps running without a queue during the account-free API foundation. Once a
 * database is supplied, it activates the durable lease runner; no health payload crosses this
 * lifecycle seam.
 */
export function createJobRunner(options: JobRunnerOptions = {}): JobRunner {
  if (options.database === undefined) {
    return {
      start: () => undefined,
      stop: async () => undefined,
    };
  }
  return new DurableJobRunner(options as JobRunnerOptions & { readonly database: AccountDatabase });
}
