import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CONTRACT_VERSION } from '@alyte/contracts';
import { AccountDatabase } from './database.js';
import {
  ANALYSIS_JOB_HANDLER_VERSION,
  createJobRunner,
  type AnalysisJobOutcome,
  type AnalysisJobHandler,
  type JobRunnerLogger,
  type JobRunnerTimer,
} from './worker.js';

const NOW = '2026-08-28T12:00:00.000Z';
const ACCOUNT = 'lease-account';

function seedJob(
  database: AccountDatabase,
  options: {
    readonly id: string;
    readonly availableAt?: string;
    readonly state?: 'queued' | 'processing' | 'succeeded';
    readonly leaseOwner?: string | null;
    readonly leaseExpiresAt?: string | null;
    readonly handlerVersion?: number;
    readonly requestId?: string;
  },
): void {
  const requestId = options.requestId ?? `request-${options.id}`;
  database.sqlite
    .prepare(
      `INSERT INTO cloud_requests
        (id, account_id, operation, state, byte_count, page_count, device_public_key_jwk,
         idempotency_key_hash, request_fingerprint, contract_version, created_at, updated_at,
         upload_expires_at)
       VALUES (?, ?, 'intake-image', 'queued', 1, 1, '{}', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      requestId,
      ACCOUNT,
      `key-${options.id}`,
      `fingerprint-${options.id}`,
      CONTRACT_VERSION,
      NOW,
      NOW,
      '2026-08-29T12:00:00.000Z',
    );
  database.sqlite
    .prepare(
      `INSERT INTO analysis_jobs
        (id, request_id, state, available_at, attempts, lease_owner, lease_expires_at,
         handler_version, request_contract_version, schema_version, prompt_version,
         failure_category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.id,
      requestId,
      options.state ?? 'queued',
      options.availableAt ?? NOW,
      options.state === 'processing' ? 1 : 0,
      options.leaseOwner ?? null,
      options.leaseExpiresAt ?? null,
      options.handlerVersion ?? ANALYSIS_JOB_HANDLER_VERSION,
      'request-contract-v1',
      'schema-v1',
      'prompt-v1',
      null,
      NOW,
      NOW,
    );
}

function createDatabaseAt(filename: string): AccountDatabase {
  const database = new AccountDatabase({ filename });
  database.sqlite.prepare('INSERT INTO accounts (id, created_at) VALUES (?, ?)').run(ACCOUNT, NOW);
  return database;
}

function createDatabase(): AccountDatabase {
  return createDatabaseAt(':memory:');
}

class MutableClock {
  current = new Date(NOW);

  now(): Date {
    return new Date(this.current);
  }
}

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }
}

class TrackingTimer implements JobRunnerTimer {
  readonly pending = new Set<ReturnType<typeof setTimeout>>();

  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> {
    let handle!: ReturnType<typeof setTimeout>;
    handle = setTimeout(() => {
      this.pending.delete(handle);
      callback();
    }, milliseconds);
    this.pending.add(handle);
    return handle;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    clearTimeout(handle);
    this.pending.delete(handle);
  }
}

function logger(
  events: Array<{ event: string; version?: number; outcome?: string; category?: string }>,
): JobRunnerLogger {
  const record = (
    event: string,
    attributes: {
      readonly handlerVersion?: number;
      readonly outcome?: string;
      readonly category?: string;
    },
  ): void => {
    const entry: { event: string; version?: number; outcome?: string; category?: string } = {
      event,
    };
    if (attributes.handlerVersion !== undefined) entry.version = attributes.handlerVersion;
    if (attributes.outcome !== undefined) entry.outcome = attributes.outcome;
    if (attributes.category !== undefined) entry.category = attributes.category;
    events.push(entry);
  };
  return {
    info: record,
    warn: record,
  };
}

describe('analysis job lease repository', () => {
  it('serializes two database owners so only one receives a live lease', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-job-lease-'));
    const filename = join(directory, 'queue.sqlite');
    const firstDatabase = createDatabaseAt(filename);
    const secondDatabase = new AccountDatabase({ filename });
    try {
      seedJob(firstDatabase, { id: 'concurrent' });
      const first = firstDatabase.claimAnalysisJob({
        now: NOW,
        leaseOwner: 'owner-a',
        leaseExpiresAt: '2026-08-28T12:01:00.000Z',
      });
      const second = secondDatabase.claimAnalysisJob({
        now: NOW,
        leaseOwner: 'owner-b',
        leaseExpiresAt: '2026-08-28T12:01:00.000Z',
      });
      assert.equal(first?.id, 'concurrent');
      assert.equal(second, undefined);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('orders ready jobs, excludes live leases, and increments attempts once on reclaim', () => {
    const database = createDatabase();
    try {
      seedJob(database, { id: 'later', availableAt: '2026-08-28T12:00:00.001Z' });
      seedJob(database, { id: 'first', availableAt: NOW });
      seedJob(database, {
        id: 'live',
        state: 'processing',
        leaseOwner: 'other-owner',
        leaseExpiresAt: '2026-08-28T12:01:30.000Z',
      });
      const first = database.claimAnalysisJob({
        now: NOW,
        leaseOwner: 'owner-a',
        leaseExpiresAt: '2026-08-28T12:00:30.000Z',
      });
      assert.equal(first?.id, 'first');
      assert.equal(first?.attempts, 1);
      assert.equal(first?.state, 'processing');
      assert.equal(
        database.claimAnalysisJob({
          now: '2026-08-28T12:00:00.001Z',
          leaseOwner: 'owner-b',
          leaseExpiresAt: '2026-08-28T12:00:30.000Z',
        })?.id,
        'later',
      );
      assert.equal(
        database.claimAnalysisJob({
          now: '2026-08-28T12:00:00.001Z',
          leaseOwner: 'owner-c',
          leaseExpiresAt: '2026-08-28T12:00:30.000Z',
        })?.id,
        undefined,
      );

      const reclaimed = database.claimAnalysisJob({
        now: '2026-08-28T12:00:31.000Z',
        leaseOwner: 'owner-c',
        leaseExpiresAt: '2026-08-28T12:01:01.000Z',
      });
      assert.equal(reclaimed?.id, 'first');
      assert.equal(reclaimed?.attempts, 2);
      assert.equal(reclaimed?.request_contract_version, 'request-contract-v1');
      assert.equal(reclaimed?.schema_version, 'schema-v1');
      assert.equal(reclaimed?.prompt_version, 'prompt-v1');
    } finally {
      database.close();
    }
  });

  it('reclaims a persisted live lease once after restart and preserves operational metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-job-restart-'));
    const filename = join(directory, 'queue.sqlite');
    const firstDatabase = createDatabaseAt(filename);
    seedJob(firstDatabase, { id: 'restartable', requestId: 'restart-request' });
    const firstLease = firstDatabase.claimAnalysisJob({
      now: NOW,
      leaseOwner: 'first-runner',
      leaseExpiresAt: '2026-08-28T12:01:00.000Z',
    });
    assert.equal(firstLease?.state, 'processing');
    assert.equal(firstLease?.attempts, 1);
    firstDatabase.close();

    const restartedDatabase = new AccountDatabase({ filename });
    try {
      assert.equal(
        restartedDatabase.claimAnalysisJob({
          now: '2026-08-28T12:00:59.999Z',
          leaseOwner: 'second-runner',
          leaseExpiresAt: '2026-08-28T12:02:00.000Z',
        }),
        undefined,
      );
      const reclaimed = restartedDatabase.claimAnalysisJob({
        now: '2026-08-28T12:01:00.000Z',
        leaseOwner: 'second-runner',
        leaseExpiresAt: '2026-08-28T12:02:00.000Z',
      });
      assert.equal(reclaimed?.id, 'restartable');
      assert.equal(reclaimed?.attempts, 2);
      assert.equal(reclaimed?.request_id, 'restart-request');
      assert.equal(reclaimed?.request_contract_version, 'request-contract-v1');
      assert.equal(reclaimed?.schema_version, 'schema-v1');
      assert.equal(reclaimed?.prompt_version, 'prompt-v1');
      assert.equal(reclaimed?.handler_version, ANALYSIS_JOB_HANDLER_VERSION);
      assert.equal(
        restartedDatabase.claimAnalysisJob({
          now: '2026-08-28T12:01:00.000Z',
          leaseOwner: 'third-runner',
          leaseExpiresAt: '2026-08-28T12:03:00.000Z',
        }),
        undefined,
      );
    } finally {
      restartedDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps heartbeat and relinquish owner-bound and refuses terminal or expired rows', () => {
    const database = createDatabase();
    try {
      seedJob(database, {
        id: 'owned',
        state: 'processing',
        leaseOwner: 'owner-a',
        leaseExpiresAt: '2026-08-28T12:01:00.000Z',
      });
      assert.equal(
        database.heartbeatAnalysisJob({
          jobId: 'owned',
          leaseOwner: 'wrong-owner',
          now: NOW,
          leaseExpiresAt: '2026-08-28T12:02:00.000Z',
        }),
        'not-owner',
      );
      assert.equal(
        database.heartbeatAnalysisJob({
          jobId: 'owned',
          leaseOwner: 'owner-a',
          now: NOW,
          leaseExpiresAt: '2026-08-28T12:02:00.000Z',
        }),
        'renewed',
      );
      assert.equal(
        database.relinquishAnalysisJob({
          jobId: 'owned',
          leaseOwner: 'wrong-owner',
          now: NOW,
          availableAt: NOW,
        }),
        'not-owner',
      );
      assert.equal(
        database.relinquishAnalysisJob({
          jobId: 'owned',
          leaseOwner: 'owner-a',
          now: NOW,
          availableAt: '2026-08-28T12:00:01.000Z',
        }),
        'relinquished',
      );
      seedJob(database, {
        id: 'expired',
        state: 'processing',
        leaseOwner: 'owner-a',
        leaseExpiresAt: '2026-08-28T11:59:00.000Z',
      });
      assert.equal(
        database.heartbeatAnalysisJob({
          jobId: 'expired',
          leaseOwner: 'owner-a',
          now: NOW,
          leaseExpiresAt: '2026-08-28T12:02:00.000Z',
        }),
        'not-live',
      );
      seedJob(database, { id: 'terminal', state: 'succeeded' });
      assert.equal(
        database.relinquishAnalysisJob({
          jobId: 'terminal',
          leaseOwner: 'owner-a',
          now: NOW,
          availableAt: NOW,
        }),
        'not-owner',
      );
    } finally {
      database.close();
    }
  });

  it('observes unsupported handlers without mutating them', () => {
    const database = createDatabase();
    try {
      seedJob(database, { id: 'unsupported', handlerVersion: 2 });
      assert.deepEqual(database.listUnsupportedReadyAnalysisHandlerVersions(NOW), [2]);
      const before = database.findAnalysisJobByRequest('request-unsupported');
      assert.equal(
        database.claimAnalysisJob({
          now: NOW,
          leaseOwner: 'owner-a',
          leaseExpiresAt: '2026-08-28T12:01:00.000Z',
        }),
        undefined,
      );
      assert.deepEqual(database.findAnalysisJobByRequest('request-unsupported'), before);
    } finally {
      database.close();
    }
  });
});

describe('analysis job runner lifecycle', () => {
  it('cancels an idle poll timer before stop resolves', async () => {
    const database = createDatabase();
    const timer = new TrackingTimer();
    const runner = createJobRunner({
      database,
      ownerId: 'idle-runner',
      timer,
      pollIntervalMs: 50,
    });
    runner.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await runner.stop({ gracePeriodMs: 0 });
      assert.equal(timer.pending.size, 0);
    } finally {
      await runner.stop({ gracePeriodMs: 0 });
      database.close();
    }
  });

  it('clears fast-handler timers and prevents a later claim after stop', async () => {
    const database = createDatabase();
    const timer = new TrackingTimer();
    let handled = 0;
    const handledOnce = new Deferred();
    seedJob(database, { id: 'fast-job' });
    const runner = createJobRunner({
      database,
      ownerId: 'fast-runner',
      clock: new MutableClock(),
      timer,
      handler: async () => {
        handled += 1;
        handledOnce.resolve();
      },
      pollIntervalMs: 50,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 40,
    });
    runner.start();
    try {
      await handledOnce.promise;
      assert.equal(handled, 1);
      await runner.stop({ gracePeriodMs: 0 });
      assert.equal(timer.pending.size, 0);
      await new Promise((resolve) => setTimeout(resolve, 70));
      assert.equal(handled, 1);
    } finally {
      await runner.stop({ gracePeriodMs: 0 });
      database.close();
    }
  });

  it('contains claim repository failures and keeps the loop stoppable', async () => {
    const database = createDatabase();
    const events: Array<{ event: string; version?: number; outcome?: string }> = [];
    const timer = new TrackingTimer();
    database.claimAnalysisJob = () => {
      throw new Error('synthetic sqlite failure');
    };
    const runner = createJobRunner({
      database,
      ownerId: 'failing-runner',
      logger: logger(events),
      timer,
      pollIntervalMs: 10,
    });
    runner.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await assert.doesNotReject(runner.stop({ gracePeriodMs: 0 }));
      assert.equal(timer.pending.size, 0);
      assert.equal(
        events.some((entry) => entry.outcome === 'claim_failed'),
        true,
      );
    } finally {
      await runner.stop({ gracePeriodMs: 0 });
      database.close();
    }
  });

  it('claims v1 work, renews outside handler/database transaction, and relinquishes on bounded drain', async () => {
    const database = createDatabase();
    const events: Array<{ event: string; version?: number; outcome?: string }> = [];
    const started = new Deferred();
    const finish = new Deferred();
    seedJob(database, { id: 'runner-job' });
    const clock = new MutableClock();
    let heartbeatOutcome: string | undefined;
    const handler: AnalysisJobHandler = async (_job, context) => {
      heartbeatOutcome = context.heartbeat();
      started.resolve();
      await finish.promise;
    };
    const runner = createJobRunner({
      database,
      clock,
      ownerId: 'runner-owner',
      handler,
      logger: logger(events),
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 40,
    });
    runner.start();
    try {
      await started.promise;
      assert.equal(heartbeatOutcome, 'renewed');
      assert.equal(database.findAnalysisJobByRequest('request-runner-job')?.state, 'processing');
      const stopping = runner.stop({ gracePeriodMs: 0 });
      await stopping;
      assert.equal(database.findAnalysisJobByRequest('request-runner-job')?.state, 'queued');
      assert.equal(database.findAnalysisJobByRequest('request-runner-job')?.lease_owner, null);
      assert.equal(
        events.some((entry) => entry.outcome === 'drain_relinquished'),
        true,
      );
    } finally {
      finish.resolve();
      await runner.stop({ gracePeriodMs: 0 });
      database.close();
    }
  });

  it('logs only handler version for unsupported ready work', async () => {
    const database = createDatabase();
    const events: Array<{ event: string; version?: number; outcome?: string }> = [];
    seedJob(database, { id: 'runner-unsupported', handlerVersion: 2 });
    const runner = createJobRunner({
      database,
      clock: new MutableClock(),
      ownerId: 'runner-owner',
      logger: logger(events),
      pollIntervalMs: 5,
    });
    runner.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.deepEqual(
        events.filter((entry) => entry.outcome === 'unsupported_handler'),
        [{ event: 'analysis_job', version: 2, outcome: 'unsupported_handler' }],
      );
      const row = database.findAnalysisJobByRequest('request-runner-unsupported');
      assert.equal(row?.state, 'queued');
      assert.equal(row?.attempts, 0);
    } finally {
      await runner.stop({ gracePeriodMs: 0 });
      database.close();
    }
  });

  it('dispatches typed provider outcomes without requeueing before the failure policy acts', async () => {
    const database = createDatabase();
    const events: Array<{ event: string; version?: number; outcome?: string; category?: string }> =
      [];
    const timer = new TrackingTimer();
    const handled = new Deferred();
    const categories: string[] = [];
    seedJob(database, { id: 'typed-failure' });
    const runner = createJobRunner({
      database,
      ownerId: 'typed-runner',
      clock: new MutableClock(),
      timer,
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 40,
      handler: async () => ({ type: 'failure' as const, category: 'safety_refusal' as const }),
      failureProcessor: async (_lease, category) => {
        categories.push(category);
        handled.resolve();
      },
      logger: logger(events),
    });
    runner.start();
    try {
      await handled.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(categories, ['safety_refusal']);
      assert.deepEqual(
        events.filter((entry) => entry.outcome === 'failure_processed'),
        [
          {
            event: 'analysis_job',
            version: 1,
            outcome: 'failure_processed',
            category: 'safety_refusal',
          },
        ],
      );
      assert.equal(JSON.stringify(events).includes('typed-failure'), false);
      assert.equal(database.findAnalysisJobByRequest('request-typed-failure')?.state, 'processing');
    } finally {
      await runner.stop({ gracePeriodMs: 0 });
      database.close();
    }
  });

  it('does not log or dispatch an untrusted provider category value', async () => {
    const database = createDatabase();
    const events: Array<{ event: string; version?: number; outcome?: string; category?: string }> =
      [];
    seedJob(database, { id: 'invalid-category' });
    const providerMessage = 'provider response secret';
    const runner = createJobRunner({
      database,
      ownerId: 'invalid-category-runner',
      clock: new MutableClock(),
      timer: new TrackingTimer(),
      logger: logger(events),
      pollIntervalMs: 5,
      heartbeatIntervalMs: 10,
      leaseDurationMs: 40,
      handler: async () =>
        ({ type: 'failure', category: providerMessage }) as unknown as AnalysisJobOutcome,
    });
    runner.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(JSON.stringify(events).includes(providerMessage), false);
      assert.equal(
        events.some((entry) => entry.outcome === 'failure_category_invalid'),
        true,
      );
      assert.equal(database.findAnalysisJobByRequest('request-invalid-category')?.state, 'queued');
    } finally {
      await runner.stop({ gracePeriodMs: 0 });
      database.close();
    }
  });
});
