import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CONTRACT_VERSION,
  decodeCloudResultEnvelope,
  decodeCloudResultEnvelopeJson,
  type P256PublicKeyJwk,
} from '@alyte/contracts';
import vector from '../../../packages/contracts/test-vectors/cloud-result-envelope-v1.json' with { type: 'json' };
import { AccountDatabase } from './database.js';
import { CloudRequestService, toStatus } from './cloud-request.js';
import { CommerceService } from './commerce.js';
import {
  CLOUD_PROCESSING_MAX_ATTEMPTS,
  CloudProcessingFailure,
  CloudProcessingFailureService,
  type CloudProcessingLease,
} from './cloud-processing.js';
import { CloudResultService } from './cloud-result.js';
import { CloudResultStore } from './cloud-result-store.js';
import { TransientUploadStore } from './transient-upload-store.js';
import { createJobRunner } from './worker.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const HASH_SECRET = 'p'.repeat(32);
const ACCOUNT = 'processing-account';
const PRODUCT = 'alyte_starter_pack';

class TestClock {
  private current: Date;

  constructor(value = NOW) {
    this.current = new Date(value);
  }

  now = (): Date => new Date(this.current);

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function publicKey(): P256PublicKeyJwk {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return pair.publicKey.export({ format: 'jwk' }) as unknown as P256PublicKeyJwk;
}

function grantStarter(database: AccountDatabase): void {
  database.upsertCommerceEntitlement({
    account_id: ACCOUNT,
    plan_id: 'starter_pack',
    product_id: PRODUCT,
    status: 'active',
    will_renew: 0,
    period_start: null,
    period_end: null,
    management_url: null,
    updated_at: NOW.toISOString(),
  });
  database.recordCommercePurchase({
    account_id: ACCOUNT,
    transaction_id: 'processing-purchase',
    product_id: PRODUCT,
    plan_id: 'starter_pack',
    purchase_type: 'starter',
    purchased_at: NOW.toISOString(),
    period_start: null,
    period_end: null,
    created_at: NOW.toISOString(),
  });
  for (const [kind, units] of [
    ['snap', 10],
    ['report', 10],
  ] as const) {
    database.addAllowanceLedgerEntry({
      id: `processing-grant-${kind}`,
      account_id: ACCOUNT,
      kind,
      entry_type: 'grant',
      units,
      source_id: `grant:processing-purchase:${kind}`,
      grant_source_id: `grant:processing-purchase:${kind}`,
      grant_period_start: null,
      period_end: null,
      created_at: NOW.toISOString(),
    });
  }
}

function harness(): {
  readonly directory: string;
  readonly database: AccountDatabase;
  readonly clock: TestClock;
  readonly uploads: TransientUploadStore;
  readonly commerce: CommerceService;
  readonly failures: CloudProcessingFailureService;
  readonly requestId: string;
  readonly lease: CloudProcessingLease;
} {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-cloud-processing-'));
  const database = new AccountDatabase({ filename: join(directory, 'cloud.sqlite') });
  database.createAccountForAppleSubject('processing-subject', ACCOUNT, NOW.toISOString());
  grantStarter(database);
  const clock = new TestClock();
  let nextId = 0;
  const uploads = new TransientUploadStore(directory);
  const commerce = new CommerceService({ database, now: clock.now });
  const requests = new CloudRequestService({
    database,
    commerce,
    hashSecret: HASH_SECRET,
    clock,
    idFactory: () => `processing-${++nextId}`,
    uploadStore: uploads,
  });
  const admitted = requests.admit(
    ACCOUNT,
    {
      operation: 'intake-image',
      byteCount: 4,
      pageCount: 1,
      devicePublicKeyJwk: publicKey(),
      contractVersion: CONTRACT_VERSION,
    },
    'processing-admit',
  );
  requests.upload(
    ACCOUNT,
    admitted.requestId,
    Buffer.from([1, 2, 3, 4]),
    'application/octet-stream',
    'processing-upload',
  );
  requests.completeUpload(ACCOUNT, admitted.requestId, 'processing-complete');
  const now = clock.now();
  const claimed = database.claimAnalysisJob({
    now: now.toISOString(),
    leaseOwner: 'processing-owner',
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  assert.ok(claimed);
  const lease: CloudProcessingLease = {
    jobId: claimed.id,
    leaseOwner: claimed.lease_owner as string,
  };
  return {
    directory,
    database,
    clock,
    uploads,
    commerce,
    failures: new CloudProcessingFailureService({
      database,
      uploadStore: uploads,
      commerce,
      clock,
    }),
    requestId: admitted.requestId,
    lease,
  };
}

function close(h: { directory: string; database: AccountDatabase }): void {
  h.database.close();
  rmSync(h.directory, { recursive: true, force: true });
}

function ledgerCounts(h: { readonly database: AccountDatabase }): {
  releases: number;
  consumes: number;
} {
  const ledger = h.database.listAllowanceLedger(ACCOUNT, 'snap');
  return {
    releases: ledger.filter((entry) => entry.entry_type === 'release').length,
    consumes: ledger.filter((entry) => entry.entry_type === 'consume').length,
  };
}

function claim(h: ReturnType<typeof harness>, owner: string): CloudProcessingLease {
  const now = h.clock.now();
  const job = h.database.claimAnalysisJob({
    now: now.toISOString(),
    leaseOwner: owner,
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  assert.ok(job);
  return { jobId: job.id, leaseOwner: owner };
}

describe('cloud processing failure policy', () => {
  it('rejects unsupported categories and suppresses unknown persisted metadata from status', () => {
    const h = harness();
    try {
      assert.throws(
        () => h.failures.handleFailure(h.lease, 'provider response: try again'),
        (error: unknown) =>
          error instanceof CloudProcessingFailure &&
          error.code === 'cloud_processing_category_invalid',
      );
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'processing');
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
      assert.deepEqual(ledgerCounts(h), { releases: 0, consumes: 0 });

      h.database.sqlite
        .prepare('UPDATE analysis_jobs SET state = ?, failure_category = ? WHERE id = ?')
        .run('failed', 'provider response: try again', h.lease.jobId);
      const current = h.database.findCloudRequest(ACCOUNT, h.requestId);
      assert.ok(current);
      assert.equal(toStatus(current).state, 'failed');
      assert.equal(toStatus(current).failureCategory, null);
    } finally {
      close(h);
    }
  });

  for (const category of ['safety_refusal', 'malformed_output', 'unusable_output'] as const) {
    it(`terminalizes ${category} without charging`, () => {
      const h = harness();
      try {
        const transition = h.failures.handleFailure(h.lease, category);
        assert.equal(transition.outcome, 'failed');
        assert.equal(transition.status.state, 'failed');
        assert.equal(transition.status.failureCategory, category);
        assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'failed');
        assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
        assert.deepEqual(ledgerCounts(h), { releases: 1, consumes: 0 });
        assert.deepEqual(h.database.findAnalysisJobOutcome(h.lease.jobId), {
          job_id: h.lease.jobId,
          request_id: h.requestId,
          outcome: 'failed',
          category,
          lease_owner: h.lease.leaseOwner,
          recorded_at: NOW.toISOString(),
          cleanup_pending: 0,
        });
      } finally {
        close(h);
      }
    });
  }

  it('requeues provider failure and timeout with bounded deterministic backoff', () => {
    const h = harness();
    try {
      const first = h.failures.handleFailure(h.lease, 'provider_failure');
      assert.equal(first.outcome, 'retry');
      assert.equal(first.availableAt, '2026-08-28T12:00:01.000Z');
      assert.equal(first.status.state, 'queued');
      assert.equal(first.status.failureCategory, null);
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
      assert.deepEqual(ledgerCounts(h), { releases: 0, consumes: 0 });

      h.clock.advance(1_000);
      const secondLease = claim(h, 'processing-owner-2');
      const second = h.failures.handleFailure(secondLease, 'timeout');
      assert.equal(second.outcome, 'retry');
      assert.equal(second.availableAt, '2026-08-28T12:00:03.000Z');
      assert.equal(second.status.state, 'queued');
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.attempts, 2);
      assert.deepEqual(ledgerCounts(h), { releases: 0, consumes: 0 });
    } finally {
      close(h);
    }
  });

  it('computes retry delay from the clock after the SQLite write lock is acquired', () => {
    const h = harness();
    try {
      const immediate = h.database.immediateTransaction.bind(h.database);
      h.database.immediateTransaction = <T>(callback: () => T): T => {
        // Model a write-lock wait during which the service clock advances. The transaction must
        // derive available_at from this later instant, not from the pre-lock observation.
        h.clock.advance(5_000);
        return immediate(callback);
      };
      const transition = h.failures.handleFailure(h.lease, 'provider_failure');
      assert.equal(transition.availableAt, '2026-08-28T12:00:06.000Z');
      assert.equal(
        h.database.findAnalysisJobByRequest(h.requestId)?.available_at,
        transition.availableAt,
      );
    } finally {
      close(h);
    }
  });

  it('terminalizes retry exhaustion and releases exactly once', () => {
    const h = harness();
    try {
      let lease = h.lease;
      for (let attempt = 1; attempt < CLOUD_PROCESSING_MAX_ATTEMPTS; attempt += 1) {
        const retry = h.failures.handleFailure(lease, 'provider_failure');
        assert.equal(retry.outcome, 'retry');
        h.clock.advance(attempt === 1 ? 1_000 : 2_000);
        lease = claim(h, `processing-owner-${attempt + 1}`);
      }
      const terminal = h.failures.handleFailure(lease, 'timeout');
      assert.equal(terminal.outcome, 'failed');
      assert.equal(terminal.status.state, 'failed');
      assert.equal(terminal.status.failureCategory, 'timeout');
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
      assert.deepEqual(ledgerCounts(h), { releases: 1, consumes: 0 });
    } finally {
      close(h);
    }
  });

  it('terminalizes rather than scheduling at the upload-expiry boundary', () => {
    const h = harness();
    try {
      h.database.sqlite
        .prepare('UPDATE cloud_requests SET upload_expires_at = ? WHERE id = ?')
        .run('2026-08-28T12:00:01.000Z', h.requestId);
      const result = h.failures.handleFailure(h.lease, 'provider_failure');
      assert.equal(result.outcome, 'failed');
      assert.equal(result.status.state, 'failed');
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
      assert.deepEqual(ledgerCounts(h), { releases: 1, consumes: 0 });
    } finally {
      close(h);
    }
  });

  it('keeps wrong, stale, expired, and changed-category transitions fail-closed', () => {
    const h = harness();
    try {
      const before = ledgerCounts(h);
      for (const lease of [
        { jobId: h.lease.jobId, leaseOwner: 'wrong-owner' },
        { jobId: 'wrong-job', leaseOwner: h.lease.leaseOwner },
      ]) {
        assert.throws(
          () => h.failures.handleFailure(lease, 'safety_refusal'),
          (error: unknown) =>
            error instanceof CloudProcessingFailure &&
            (error.code === 'cloud_processing_context_mismatch' ||
              error.code === 'cloud_processing_not_available'),
        );
      }
      h.clock.advance(60_001);
      assert.throws(
        () => h.failures.handleFailure(h.lease, 'safety_refusal'),
        (error: unknown) =>
          error instanceof CloudProcessingFailure &&
          error.code === 'cloud_processing_context_mismatch',
      );
      assert.deepEqual(ledgerCounts(h), before);
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);

      const fresh = harness();
      try {
        const retry = fresh.failures.handleFailure(fresh.lease, 'provider_failure');
        assert.equal(retry.outcome, 'retry');
        assert.deepEqual(fresh.failures.handleFailure(fresh.lease, 'provider_failure'), retry);
        assert.throws(
          () => fresh.failures.handleFailure(fresh.lease, 'timeout'),
          (error: unknown) =>
            error instanceof CloudProcessingFailure &&
            error.code === 'cloud_processing_context_mismatch',
        );
        assert.deepEqual(ledgerCounts(fresh), { releases: 0, consumes: 0 });
        assert.equal(fresh.uploads.hasCompleteArtifact(fresh.requestId), true);
      } finally {
        close(fresh);
      }
    } finally {
      close(h);
    }
  });

  it('allows only the exact terminal replay and never duplicates the release', () => {
    const h = harness();
    try {
      const first = h.failures.handleFailure(h.lease, 'malformed_output');
      const replay = h.failures.handleFailure(h.lease, 'malformed_output');
      assert.deepEqual(replay, first);
      assert.throws(
        () =>
          h.failures.handleFailure({ ...h.lease, leaseOwner: 'other-owner' }, 'malformed_output'),
        (error: unknown) =>
          error instanceof CloudProcessingFailure &&
          error.code === 'cloud_processing_context_mismatch',
      );
      assert.deepEqual(ledgerCounts(h), { releases: 1, consumes: 0 });
    } finally {
      close(h);
    }
  });

  it('leaves state and accounting untouched when upload cleanup fails, then retries after reclaim', () => {
    const h = harness();
    try {
      const originalRemove = h.uploads.remove;
      h.uploads.remove = () => {
        throw new Error('synthetic cleanup failure');
      };
      assert.throws(
        () => h.failures.handleFailure(h.lease, 'safety_refusal'),
        (error: unknown) =>
          error instanceof CloudProcessingFailure &&
          error.code === 'cloud_processing_cleanup_failed',
      );
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'processing');
      assert.equal(h.database.findAnalysisJobOutcome(h.lease.jobId)?.cleanup_pending, 1);
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
      assert.deepEqual(ledgerCounts(h), { releases: 0, consumes: 0 });

      h.uploads.remove = originalRemove;
      h.clock.advance(60_001);
      assert.throws(
        () => h.failures.handleFailure(h.lease, 'malformed_output'),
        (error: unknown) =>
          error instanceof CloudProcessingFailure &&
          error.code === 'cloud_processing_context_mismatch',
      );
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
      assert.deepEqual(ledgerCounts(h), { releases: 0, consumes: 0 });
      const reclaimed = claim(h, 'processing-reclaimer');
      const terminal = h.failures.handleFailure(reclaimed, 'safety_refusal');
      assert.equal(terminal.status.state, 'failed');
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
      assert.deepEqual(ledgerCounts(h), { releases: 1, consumes: 0 });
    } finally {
      close(h);
    }
  });

  it('keeps a post-cleanup transaction crash reclaimable without charging', () => {
    const h = harness();
    try {
      const originalMark = h.database.markAnalysisJobProcessingFailed;
      h.database.markAnalysisJobProcessingFailed = () => {
        throw new Error('synthetic sqlite crash');
      };
      assert.throws(
        () => h.failures.handleFailure(h.lease, 'unusable_output'),
        (error: unknown) =>
          error instanceof CloudProcessingFailure && error.code === 'cloud_processing_conflict',
      );
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'processing');
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
      assert.deepEqual(ledgerCounts(h), { releases: 0, consumes: 0 });

      h.database.markAnalysisJobProcessingFailed = originalMark;
      h.clock.advance(60_001);
      const reclaimed = claim(h, 'processing-crash-reclaimer');
      const terminal = h.failures.handleFailure(reclaimed, 'unusable_output');
      assert.equal(terminal.status.state, 'failed');
      assert.deepEqual(ledgerCounts(h), { releases: 1, consumes: 0 });
    } finally {
      close(h);
    }
  });

  it('recovers a durable terminal intent after close, reopen, reclaim, and runner dispatch', async () => {
    const h = harness();
    let recovered: AccountDatabase | undefined;
    try {
      const originalMark = h.database.markAnalysisJobProcessingFailed;
      h.database.markAnalysisJobProcessingFailed = () => {
        throw new Error('crash after upload cleanup');
      };
      assert.throws(
        () => h.failures.handleFailure(h.lease, 'unusable_output'),
        (error: unknown) =>
          error instanceof CloudProcessingFailure && error.code === 'cloud_processing_conflict',
      );
      assert.equal(h.database.findAnalysisJobOutcome(h.lease.jobId)?.cleanup_pending, 1);
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
      h.database.markAnalysisJobProcessingFailed = originalMark;
      h.database.close();

      h.clock.advance(60_001);
      recovered = new AccountDatabase({ filename: join(h.directory, 'cloud.sqlite') });
      const uploads = new TransientUploadStore(h.directory);
      const commerce = new CommerceService({ database: recovered, now: h.clock.now });
      const failures = new CloudProcessingFailureService({
        database: recovered,
        uploadStore: uploads,
        commerce,
        clock: h.clock,
      });
      let providerCalls = 0;
      let recoveryCalls = 0;
      let resolveRecovery!: () => void;
      const recovery = new Promise<void>((resolve) => {
        resolveRecovery = resolve;
      });
      const runner = createJobRunner({
        database: recovered,
        clock: h.clock,
        ownerId: 'recovery-runner',
        pollIntervalMs: 1,
        heartbeatIntervalMs: 10,
        leaseDurationMs: 60_000,
        handler: async () => {
          providerCalls += 1;
        },
        failureProcessor: (lease, category) => {
          recoveryCalls += 1;
          failures.handleFailure(lease, category);
          resolveRecovery();
        },
      });
      runner.start();
      await Promise.race([
        recovery,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('recovery_runner_timeout')), 1_000),
        ),
      ]);
      await runner.stop({ gracePeriodMs: 1_000 });
      assert.equal(providerCalls, 0);
      assert.equal(recoveryCalls, 1);
      assert.equal(recovered.findAnalysisJobByRequest(h.requestId)?.state, 'failed');
      assert.equal(recovered.findAnalysisJobOutcome(h.lease.jobId)?.cleanup_pending, 0);
      assert.deepEqual(ledgerCounts({ database: recovered }), {
        releases: 1,
        consumes: 0,
      });
      assert.equal(uploads.hasCompleteArtifact(h.requestId), false);
    } finally {
      if (recovered?.sqlite.open) recovered.close();
      close(h);
    }
  });

  it('converges terminal intent and release across independent SQLite service owners', () => {
    const h = harness();
    const secondDatabase = new AccountDatabase({ filename: join(h.directory, 'cloud.sqlite') });
    try {
      const secondUploads = new TransientUploadStore(h.directory);
      const secondCommerce = new CommerceService({
        database: secondDatabase,
        now: h.clock.now,
      });
      const competing = new CloudProcessingFailureService({
        database: secondDatabase,
        uploadStore: secondUploads,
        commerce: secondCommerce,
        clock: h.clock,
      });
      const remove = h.uploads.remove.bind(h.uploads);
      let nested = false;
      h.uploads.remove = (requestId: string): void => {
        remove(requestId);
        if (!nested) {
          nested = true;
          const winner = competing.handleFailure(h.lease, 'malformed_output');
          assert.equal(winner.outcome, 'failed');
        }
      };

      const result = h.failures.handleFailure(h.lease, 'malformed_output');
      assert.equal(result.outcome, 'failed');
      assert.deepEqual(secondDatabase.findAnalysisJobOutcome(h.lease.jobId), {
        job_id: h.lease.jobId,
        request_id: h.requestId,
        outcome: 'failed',
        category: 'malformed_output',
        lease_owner: h.lease.leaseOwner,
        recorded_at: NOW.toISOString(),
        cleanup_pending: 0,
      });
      assert.equal(secondDatabase.findAnalysisJobByRequest(h.requestId)?.state, 'failed');
      assert.deepEqual(ledgerCounts({ database: secondDatabase }), {
        releases: 1,
        consumes: 0,
      });
    } finally {
      secondDatabase.close();
      close(h);
    }
  });

  it('does not downgrade a staged usable envelope when a late failure arrives', () => {
    const h = harness();
    try {
      const resultStore = new CloudResultStore(h.directory);
      const results = new CloudResultService({
        database: h.database,
        resultStore,
        uploadStore: h.uploads,
        commerce: h.commerce,
        clock: h.clock,
      });
      const envelope = decodeCloudResultEnvelope({
        ...decodeCloudResultEnvelopeJson(vector.serializedEnvelope),
        requestId: h.requestId,
        contractVersion: CONTRACT_VERSION,
        resultSchemaVersion: CONTRACT_VERSION,
        handlerVersion: 1,
      });
      results.stage(h.lease, envelope);
      assert.throws(
        () => h.failures.handleFailure(h.lease, 'unusable_output'),
        (error: unknown) =>
          error instanceof CloudProcessingFailure && error.code === 'cloud_processing_conflict',
      );
      assert.equal(h.database.findCloudResultCache(h.requestId)?.state, 'staged');
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
      assert.deepEqual(ledgerCounts(h), { releases: 0, consumes: 0 });
      assert.equal(results.finalize(h.lease).state, 'ready');
    } finally {
      close(h);
    }
  });

  it('cascades outcome replay metadata during account deletion', () => {
    const h = harness();
    try {
      h.failures.handleFailure(h.lease, 'safety_refusal');
      assert.equal(h.database.findAnalysisJobOutcome(h.lease.jobId)?.request_id, h.requestId);
      h.database.deleteAccountData(ACCOUNT);
      assert.equal(h.database.findAnalysisJobOutcome(h.lease.jobId), undefined);
      assert.equal(h.database.listCloudRequests().length, 0);
      assert.equal(h.database.listAllowanceLedger(ACCOUNT).length, 0);
    } finally {
      close(h);
    }
  });
});

describe('cloud processing migration', () => {
  it('preserves populated request, job, result, and ledger rows while adding replay storage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-cloud-processing-migration-'));
    const filename = join(directory, 'legacy.sqlite');
    const legacy = new AccountDatabase({ filename });
    try {
      legacy.createAccountForAppleSubject(
        'migration-subject',
        'migration-account',
        NOW.toISOString(),
      );
      legacy.sqlite
        .prepare(
          `INSERT INTO cloud_requests
            (id, account_id, operation, state, byte_count, page_count, device_public_key_jwk,
             idempotency_key_hash, request_fingerprint, contract_version, created_at, updated_at,
             upload_expires_at)
           VALUES ('migration-request', 'migration-account', 'intake-image', 'queued', 1, 1, '{}',
                   'migration-key', 'migration-fingerprint', ?, ?, ?, ?)`,
        )
        .run(CONTRACT_VERSION, NOW.toISOString(), NOW.toISOString(), '2026-08-29T12:00:00.000Z');
      legacy.sqlite
        .prepare(
          `INSERT INTO analysis_jobs
            (id, request_id, state, available_at, attempts, handler_version,
             request_contract_version, schema_version, created_at, updated_at)
           VALUES ('migration-job', 'migration-request', 'queued', ?, 0, 1, ?, ?, ?, ?)`,
        )
        .run(
          NOW.toISOString(),
          CONTRACT_VERSION,
          CONTRACT_VERSION,
          NOW.toISOString(),
          NOW.toISOString(),
        );
      legacy.sqlite
        .prepare(
          `INSERT INTO cloud_result_cache
            (request_id, state, result_schema_version, handler_version, byte_count, expires_at)
           VALUES ('migration-request', 'failed', ?, 1, 1, ?)`,
        )
        .run(CONTRACT_VERSION, '2026-08-29T12:00:00.000Z');
      legacy.sqlite
        .prepare(
          `INSERT INTO allowance_ledger
            (id, account_id, kind, entry_type, units, source_id, grant_source_id,
             grant_period_start, period_end, created_at)
           VALUES ('migration-ledger', 'migration-account', 'snap', 'grant', 1,
                   'migration-grant', 'migration-grant', NULL, NULL, ?)`,
        )
        .run(NOW.toISOString());
      legacy.sqlite
        .prepare(
          `INSERT INTO analysis_job_outcomes
            (job_id, request_id, outcome, category, lease_owner, recorded_at, cleanup_pending)
           VALUES ('migration-job', 'migration-request', 'failed', 'safety_refusal',
                   'migration-owner', ?, 0)`,
        )
        .run(NOW.toISOString());
      const before = {
        requests: legacy.sqlite.prepare('SELECT * FROM cloud_requests').all(),
        jobs: legacy.sqlite.prepare('SELECT * FROM analysis_jobs').all(),
        results: legacy.sqlite.prepare('SELECT * FROM cloud_result_cache').all(),
        ledger: legacy.sqlite.prepare('SELECT * FROM allowance_ledger').all(),
        outcomes: legacy.sqlite.prepare('SELECT * FROM analysis_job_outcomes').all(),
      };
      // Reopen this populated pre-v13 shape so the test exercises the additive forward migration
      // rather than merely checking a freshly created database.
      legacy.sqlite.exec(`
        ALTER TABLE analysis_job_outcomes RENAME TO analysis_job_outcomes_v12;
        CREATE TABLE analysis_job_outcomes (
          job_id TEXT PRIMARY KEY NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL UNIQUE REFERENCES cloud_requests(id) ON DELETE CASCADE,
          outcome TEXT NOT NULL CHECK (outcome IN ('retry', 'failed')),
          category TEXT NOT NULL CHECK (
            category IN ('provider_failure', 'timeout', 'safety_refusal', 'malformed_output', 'unusable_output')
          ),
          lease_owner TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        INSERT INTO analysis_job_outcomes
          (job_id, request_id, outcome, category, lease_owner, recorded_at)
          SELECT job_id, request_id, outcome, category, lease_owner, recorded_at
            FROM analysis_job_outcomes_v12;
        DROP TABLE analysis_job_outcomes_v12;
      `);
      legacy.sqlite.prepare('DELETE FROM schema_migrations WHERE version = 13').run();
      legacy.close();

      const migrated = new AccountDatabase({ filename });
      assert.deepEqual(
        migrated.sqlite.prepare('SELECT * FROM cloud_requests').all(),
        before.requests,
      );
      assert.deepEqual(migrated.sqlite.prepare('SELECT * FROM analysis_jobs').all(), before.jobs);
      assert.deepEqual(
        migrated.sqlite.prepare('SELECT * FROM cloud_result_cache').all(),
        before.results,
      );
      assert.deepEqual(
        migrated.sqlite.prepare('SELECT * FROM allowance_ledger').all(),
        before.ledger,
      );
      assert.deepEqual(
        migrated.sqlite.prepare('SELECT * FROM analysis_job_outcomes').all(),
        before.outcomes.map((row) => ({ ...(row as object), cleanup_pending: 0 })),
      );
      assert.deepEqual(
        migrated.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analysis_job_outcomes'",
          )
          .get(),
        { name: 'analysis_job_outcomes' },
      );
      migrated.close();
    } finally {
      if (legacy.sqlite.open) legacy.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
