import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { CLOUD_PRODUCT_IDS, CONTRACT_VERSION, type P256PublicKeyJwk } from '@alyte/contracts';
import { AccountDatabase } from './database.js';
import { CommerceService } from './commerce.js';
import { CloudRequestFailure, CloudRequestService } from './cloud-request.js';
import { TransientUploadStore } from './transient-upload-store.js';
import { createServer } from './server.js';
import type { AppleIdentityVerifier } from './apple-verifier.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const ACCOUNT = 'cloud-upload-account';
const SECRET = 'c'.repeat(32);

class DeterministicAppleVerifier implements AppleIdentityVerifier {
  async verify(identityToken: string): Promise<{ subject: string }> {
    if (identityToken === 'valid-upload-account') return { subject: 'upload-subject' };
    throw new Error('invalid_identity');
  }
}

class MutableClock {
  current = new Date(NOW);

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

interface UploadHarness {
  readonly database: AccountDatabase;
  readonly clock: MutableClock;
  readonly runtimePath: string;
  readonly service: CloudRequestService;
  readonly uploads: TransientUploadStore;
}

function publicKey(): P256PublicKeyJwk {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return pair.publicKey.export({ format: 'jwk' }) as unknown as P256PublicKeyJwk;
}

function grantStarter(database: AccountDatabase): void {
  const at = NOW.toISOString();
  database.upsertCommerceEntitlement({
    account_id: ACCOUNT,
    plan_id: 'starter_pack',
    product_id: CLOUD_PRODUCT_IDS.starterPack,
    status: 'active',
    will_renew: 0,
    period_start: null,
    period_end: null,
    management_url: null,
    updated_at: at,
  });
  database.recordCommercePurchase({
    account_id: ACCOUNT,
    transaction_id: 'upload-purchase',
    product_id: CLOUD_PRODUCT_IDS.starterPack,
    plan_id: 'starter_pack',
    purchase_type: 'starter',
    purchased_at: at,
    period_start: null,
    period_end: null,
    created_at: at,
  });
  database.addAllowanceLedgerEntry({
    id: 'upload-grant-snap',
    account_id: ACCOUNT,
    kind: 'snap',
    entry_type: 'grant',
    units: 5,
    source_id: 'grant:upload-purchase:snap',
    grant_source_id: 'grant:upload-purchase:snap',
    grant_period_start: null,
    period_end: null,
    created_at: at,
  });
  database.addAllowanceLedgerEntry({
    id: 'upload-grant-report',
    account_id: ACCOUNT,
    kind: 'report',
    entry_type: 'grant',
    units: 1,
    source_id: 'grant:upload-purchase:report',
    grant_source_id: 'grant:upload-purchase:report',
    grant_period_start: null,
    period_end: null,
    created_at: at,
  });
}

function admission(byteCount = 4): Record<string, unknown> {
  return {
    operation: 'intake-image',
    byteCount,
    pageCount: 1,
    devicePublicKeyJwk: publicKey(),
    contractVersion: CONTRACT_VERSION,
  };
}

function harness(filename = ':memory:'): UploadHarness {
  const database = new AccountDatabase({ filename });
  database.createAccountForAppleSubject('upload-subject', ACCOUNT, NOW.toISOString());
  grantStarter(database);
  const clock = new MutableClock();
  const runtimePath = mkdtempSync(join(tmpdir(), 'alyte-upload-runtime-'));
  const uploads = new TransientUploadStore(runtimePath);
  const service = new CloudRequestService({
    database,
    commerce: new CommerceService({ database, now: () => clock.now() }),
    hashSecret: SECRET,
    clock,
    uploadStore: uploads,
    idFactory: (() => {
      let next = 0;
      return () => `upload-id-${++next}`;
    })(),
  });
  return { database, clock, runtimePath, service, uploads };
}

function closeHarness(harness: UploadHarness): void {
  harness.database.close();
  rmSync(harness.runtimePath, { recursive: true, force: true });
}

describe('transient upload lifecycle', () => {
  it('promotes exact bytes, is idempotent for same bytes, and rejects replacement bytes', () => {
    const h = harness();
    try {
      const admitted = h.service.admit(ACCOUNT, admission(), 'upload-admit');
      const bytes = Buffer.from([1, 2, 3, 4]);
      const uploaded = h.service.upload(
        ACCOUNT,
        admitted.requestId,
        bytes,
        'application/octet-stream',
        'upload-key',
      );
      assert.equal(uploaded.state, 'uploaded');
      assert.deepEqual(h.uploads.read(admitted.requestId), bytes);
      assert.equal(statSync(h.uploads.root).mode & 0o777, 0o700);
      assert.equal(statSync(join(h.uploads.root, `${admitted.requestId}.bin`)).mode & 0o777, 0o600);
      assert.deepEqual(
        h.service.upload(
          ACCOUNT,
          admitted.requestId,
          bytes,
          'application/octet-stream',
          'upload-key',
        ),
        uploaded,
      );
      assert.throws(
        () =>
          h.service.upload(
            ACCOUNT,
            admitted.requestId,
            Buffer.from([4, 3, 2, 1]),
            'application/octet-stream',
            'replay-key',
          ),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_upload_conflict',
      );
      const columns = h.database.sqlite
        .prepare("SELECT name FROM pragma_table_info('cloud_requests')")
        .all() as { name: string }[];
      assert.equal(
        columns.some((column) => column.name.includes('digest')),
        false,
      );
    } finally {
      closeHarness(h);
    }
  });

  it('rejects undersize/oversize bodies without leaving a file and keeps retryable admission', () => {
    const h = harness();
    try {
      const admitted = h.service.admit(ACCOUNT, admission(), 'size-admit');
      assert.throws(
        () =>
          h.service.upload(
            ACCOUNT,
            admitted.requestId,
            Buffer.from([1]),
            'application/octet-stream',
            'small-key',
          ),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_upload_too_small',
      );
      assert.equal(h.uploads.list().length, 0);
      assert.equal(h.service.status(ACCOUNT, admitted.requestId).state, 'awaiting-upload');
      assert.throws(
        () =>
          h.service.upload(
            ACCOUNT,
            admitted.requestId,
            Buffer.from([1, 2, 3, 4, 5]),
            'application/octet-stream',
            'large-key',
          ),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_upload_too_large',
      );
      assert.equal(h.uploads.list().length, 0);
      assert.throws(
        () =>
          h.service.upload(
            ACCOUNT,
            admitted.requestId,
            Buffer.from([1, 2, 3, 4]),
            'image/png',
            'content-key',
          ),
        (error: unknown) =>
          error instanceof CloudRequestFailure &&
          error.code === 'cloud_upload_content_type_invalid',
      );
    } finally {
      closeHarness(h);
    }
  });

  it('rejects a missing or undersize promoted artifact and permits an exact repair', () => {
    const h = harness();
    try {
      const admitted = h.service.admit(ACCOUNT, admission(), 'artifact-admit');
      const bytes = Buffer.from([1, 2, 3, 4]);
      h.service.upload(
        ACCOUNT,
        admitted.requestId,
        bytes,
        'application/octet-stream',
        'artifact-upload-key',
      );
      unlinkSync(join(h.uploads.root, `${admitted.requestId}.bin`));
      assert.throws(
        () => h.service.completeUpload(ACCOUNT, admitted.requestId, 'artifact-complete-key'),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_upload_artifact_missing',
      );
      assert.equal(
        h.service.upload(
          ACCOUNT,
          admitted.requestId,
          bytes,
          'application/octet-stream',
          'artifact-repair-key',
        ).state,
        'uploaded',
      );
      writeFileSync(join(h.uploads.root, `${admitted.requestId}.bin`), Buffer.from([9]));
      assert.throws(
        () => h.service.completeUpload(ACCOUNT, admitted.requestId, 'artifact-complete-key'),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_upload_artifact_missing',
      );
      h.service.reconcile();
      assert.equal(h.uploads.list().length, 0);
    } finally {
      closeHarness(h);
    }
  });

  it('seals one handler-v1 job, survives replay, and leaves queued work non-cancellable', () => {
    const h = harness();
    try {
      const admitted = h.service.admit(ACCOUNT, admission(), 'queue-admit');
      h.service.upload(
        ACCOUNT,
        admitted.requestId,
        Buffer.from([1, 2, 3, 4]),
        'application/octet-stream',
        'queue-upload-key',
      );
      const queued = h.service.completeUpload(ACCOUNT, admitted.requestId, 'complete-key');
      assert.equal(queued.state, 'queued');
      const job = h.database.findAnalysisJobByRequest(admitted.requestId);
      assert.ok(job);
      assert.equal(job.state, 'queued');
      assert.equal(job.handler_version, 1);
      assert.equal(job.request_id, admitted.requestId);
      assert.deepEqual(
        h.service.completeUpload(ACCOUNT, admitted.requestId, 'complete-key'),
        queued,
      );
      assert.deepEqual(
        h.service.completeUpload(ACCOUNT, admitted.requestId, 'different-key'),
        queued,
      );
      assert.equal(
        (
          h.database.sqlite.prepare('SELECT COUNT(*) AS count FROM analysis_jobs').get() as {
            count: number;
          }
        ).count,
        1,
      );
      writeFileSync(join(h.uploads.root, `${admitted.requestId}.partial`), Buffer.from([8]));
      h.service.reconcile();
      assert.equal(h.uploads.list().length, 1);
      assert.equal(h.uploads.list()[0]?.kind, 'complete');
      assert.throws(
        () => h.service.cancel(ACCOUNT, admitted.requestId, 'cancel-key'),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_request_not_cancellable',
      );
      assert.equal(h.uploads.list().length, 1);
    } finally {
      closeHarness(h);
    }
  });

  it('reopens SQLite and the transient volume without creating a second queued job', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-upload-restart-'));
    const filename = join(directory, 'restart.sqlite');
    const h = harness(filename);
    try {
      const admitted = h.service.admit(ACCOUNT, admission(), 'restart-admit');
      h.service.upload(
        ACCOUNT,
        admitted.requestId,
        Buffer.from([1, 2, 3, 4]),
        'application/octet-stream',
        'restart-upload-key',
      );
      const queued = h.service.completeUpload(ACCOUNT, admitted.requestId, 'restart-complete-key');
      h.database.close();
      const restartedDatabase = new AccountDatabase({ filename });
      try {
        const restartedUploads = new TransientUploadStore(h.runtimePath);
        const restartedService = new CloudRequestService({
          database: restartedDatabase,
          commerce: new CommerceService({ database: restartedDatabase, now: () => h.clock.now() }),
          hashSecret: SECRET,
          clock: h.clock,
          uploadStore: restartedUploads,
          idFactory: () => 'restart-unused-id',
        });
        assert.deepEqual(
          restartedService.completeUpload(ACCOUNT, admitted.requestId, 'restart-complete-key'),
          queued,
        );
        assert.equal(
          (
            restartedDatabase.sqlite
              .prepare('SELECT COUNT(*) AS count FROM analysis_jobs WHERE request_id = ?')
              .get(admitted.requestId) as { count: number }
          ).count,
          1,
        );
      } finally {
        restartedDatabase.close();
      }
    } finally {
      rmSync(h.runtimePath, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels uploaded media before sealing and releases once', () => {
    const h = harness();
    try {
      const admitted = h.service.admit(ACCOUNT, admission(), 'cancel-admit');
      h.service.upload(
        ACCOUNT,
        admitted.requestId,
        Buffer.from([1, 2, 3, 4]),
        'application/octet-stream',
        'cancel-upload-key',
      );
      assert.equal(h.service.cancel(ACCOUNT, admitted.requestId, 'cancel-key').state, 'cancelled');
      assert.equal(h.uploads.list().length, 0);
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter(
            (entry) => entry.entry_type === 'release' && entry.source_id === admitted.requestId,
          ).length,
        1,
      );
    } finally {
      closeHarness(h);
    }
  });

  it('expires unsealed uploads, releases the reservation, and removes orphan files', () => {
    const h = harness();
    try {
      const admitted = h.service.admit(ACCOUNT, admission(), 'expiry-admit');
      h.service.upload(
        ACCOUNT,
        admitted.requestId,
        Buffer.from([1, 2, 3, 4]),
        'application/octet-stream',
        'expiry-upload-key',
      );
      h.uploads.write('orphan-request', Buffer.from([9]), 1);
      writeFileSync(join(h.uploads.root, 'unrecognized-orphan'), Buffer.from([8]));
      h.clock.advance(24 * 60 * 60 * 1_000 + 1);
      assert.equal(h.service.status(ACCOUNT, admitted.requestId).state, 'expired');
      h.service.reconcile();
      assert.equal(h.uploads.list().length, 0);
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter(
            (entry) => entry.entry_type === 'release' && entry.source_id === admitted.requestId,
          ).length,
        1,
      );
      h.service.reconcile();
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter(
            (entry) => entry.entry_type === 'release' && entry.source_id === admitted.requestId,
          ).length,
        1,
      );
    } finally {
      closeHarness(h);
    }
  });

  it('rebuilds a released v7 request table and preserves its admission metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-upload-v7-'));
    const filename = join(directory, 'legacy.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (7, '2026-08-28T00:00:00.000Z');
      CREATE TABLE accounts (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO accounts (id, created_at) VALUES ('legacy-account', '2026-08-28T00:00:00.000Z');
      CREATE TABLE cloud_requests (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('intake-image', 'lab-report')),
        state TEXT NOT NULL CHECK (state IN ('awaiting-upload', 'cancelled')),
        byte_count INTEGER NOT NULL CHECK (byte_count > 0 AND byte_count <= 26214400),
        page_count INTEGER NOT NULL CHECK (page_count > 0 AND page_count <= 20),
        device_public_key_jwk TEXT NOT NULL,
        idempotency_key_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        contract_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cancelled_at TEXT
      );
      INSERT INTO cloud_requests VALUES
        ('legacy-request', 'legacy-account', 'lab-report', 'awaiting-upload', 4, 1,
         '{}', 'key-hash', 'request-hash', '${CONTRACT_VERSION}',
         '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', NULL);
    `);
    legacy.close();
    try {
      const database = new AccountDatabase({ filename });
      const row = database.findCloudRequest('legacy-account', 'legacy-request');
      assert.equal(row?.state, 'awaiting-upload');
      assert.equal(row?.byte_count, 4);
      assert.equal(row?.upload_expires_at, '2026-08-29T00:00:00.000Z');
      assert.deepEqual(
        database.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analysis_jobs'")
          .get(),
        { name: 'analysis_jobs' },
      );
      assert.throws(() =>
        database.sqlite
          .prepare(
            "INSERT INTO cloud_requests (id, account_id, operation, state, byte_count, page_count, device_public_key_jwk, idempotency_key_hash, request_fingerprint, contract_version, created_at, updated_at, upload_expires_at) VALUES ('bad', 'legacy-account', 'lab-report', 'processing', 1, 1, '{}', 'bad', 'bad', '${CONTRACT_VERSION}', 'now', 'now', 'later')",
          )
          .run(),
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a symlink partial without writing outside the allowlisted root', () => {
    const h = harness();
    try {
      const admitted = h.service.admit(ACCOUNT, admission(), 'symlink-admit');
      const outside = join(h.runtimePath, 'outside.bin');
      chmodSync(h.uploads.root, 0o700);
      symlinkSync(outside, join(h.uploads.root, `${admitted.requestId}.partial`));
      assert.throws(
        () =>
          h.service.upload(
            ACCOUNT,
            admitted.requestId,
            Buffer.from([1, 2, 3, 4]),
            'application/octet-stream',
            'symlink-key',
          ),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_upload_filesystem_failure',
      );
      assert.equal(h.service.status(ACCOUNT, admitted.requestId).state, 'awaiting-upload');
      assert.equal(h.uploads.list().length, 0);
    } finally {
      closeHarness(h);
    }
  });
});

describe('binary upload API boundary', () => {
  it('authenticates before writing, enforces content type and idempotency, and seals one job', async () => {
    const h = harness();
    const lines: string[] = [];
    const server = createServer({
      database: h.database,
      runtimePath: h.runtimePath,
      appleVerifier: new DeterministicAppleVerifier(),
      hashSecret: SECRET,
      clock: h.clock,
      loggerStream: { write: (line) => lines.push(line) },
    });
    try {
      const exchange = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'api-exchange-key' },
        payload: {
          identityToken: 'valid-upload-account',
          rawNonce: '0123456789ABCDEFGHIJKLMNOPQRSTUV',
          consentPolicyVersion: '2026-08-01',
        },
      });
      assert.equal(exchange.statusCode, 200);
      const accessToken = exchange.json().accessToken as string;
      const admitted = await server.inject({
        method: 'POST',
        url: '/v1/cloud-requests',
        headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'api-admit-key' },
        payload: admission(),
      });
      assert.equal(admitted.statusCode, 200);
      const requestId = admitted.json().requestId as string;
      const missingKey = await server.inject({
        method: 'PUT',
        url: `/v1/cloud-requests/${requestId}/upload`,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/octet-stream',
        },
        payload: Buffer.from([1, 2, 3, 4]),
      });
      assert.equal(missingKey.statusCode, 400);
      assert.equal(missingKey.json().error.code, 'idempotency_key_required');
      const uploaded = await server.inject({
        method: 'PUT',
        url: `/v1/cloud-requests/${requestId}/upload`,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/octet-stream',
          'idempotency-key': 'api-upload-key',
        },
        payload: Buffer.from([1, 2, 3, 4]),
      });
      assert.equal(uploaded.statusCode, 200);
      assert.equal(uploaded.json().state, 'uploaded');
      const queued = await server.inject({
        method: 'POST',
        url: `/v1/cloud-requests/${requestId}/complete-upload`,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'idempotency-key': 'api-complete-key',
        },
      });
      assert.equal(queued.statusCode, 200);
      assert.equal(queued.json().state, 'queued');
      assert.equal(lines.join('').includes('\u0001\u0002\u0003\u0004'), false);
    } finally {
      await server.close();
      h.database.close();
      rmSync(h.runtimePath, { recursive: true, force: true });
    }
  });
});
