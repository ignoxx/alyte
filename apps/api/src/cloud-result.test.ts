import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES,
  CLOUD_PRODUCT_IDS,
  CONTRACT_VERSION,
  decodeCloudResultEnvelope,
  decodeCloudResultEnvelopeJson,
  serializeCloudResultEnvelope,
  type CloudResultEnvelope,
  type P256PublicKeyJwk,
} from '@alyte/contracts';
import vector from '../../../packages/contracts/test-vectors/cloud-result-envelope-v1.json' with { type: 'json' };
import { AccountDatabase } from './database.js';
import { CommerceService } from './commerce.js';
import { CloudRequestService } from './cloud-request.js';
import {
  CLOUD_RESULT_RETENTION_MS,
  CloudResultFailure,
  CloudResultService,
} from './cloud-result.js';
import { CloudResultStore, CloudResultStoreFailure } from './cloud-result-store.js';
import { TransientUploadStore } from './transient-upload-store.js';
import { createServer } from './server.js';
import type { AppleIdentityVerifier } from './apple-verifier.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const HASH_SECRET = 'r'.repeat(32);
const ACCOUNT = 'cloud-result-account';
const PRODUCT = CLOUD_PRODUCT_IDS.starterPack;

class DeterministicAppleVerifier implements AppleIdentityVerifier {
  async verify(identityToken: string): Promise<{ subject: string }> {
    if (identityToken === 'result-token') return { subject: 'result-subject' };
    throw new Error('invalid_identity');
  }
}

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
    transaction_id: 'result-purchase',
    product_id: PRODUCT,
    plan_id: 'starter_pack',
    purchase_type: 'starter',
    purchased_at: NOW.toISOString(),
    period_start: null,
    period_end: null,
    created_at: NOW.toISOString(),
  });
  for (const [kind, units] of [
    ['snap', 20],
    ['report', 20],
  ] as const) {
    database.addAllowanceLedgerEntry({
      id: `result-grant-${kind}`,
      account_id: ACCOUNT,
      kind,
      entry_type: 'grant',
      units,
      source_id: `grant:result-purchase:${kind}`,
      grant_source_id: `grant:result-purchase:${kind}`,
      grant_period_start: null,
      period_end: null,
      created_at: NOW.toISOString(),
    });
  }
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-cloud-result-'));
  const database = new AccountDatabase({ filename: join(directory, 'cloud.sqlite') });
  database.createAccountForAppleSubject('result-subject', ACCOUNT, NOW.toISOString());
  grantStarter(database);
  const clock = new TestClock();
  const resultStore = new CloudResultStore(directory);
  const uploadStore = new TransientUploadStore(directory);
  const commerce = new CommerceService({ database, now: clock.now });
  const requests = new CloudRequestService({
    database,
    commerce,
    hashSecret: HASH_SECRET,
    clock,
    idFactory: (() => {
      let next = 0;
      return () => `result-request-${++next}`;
    })(),
    uploadStore,
  });
  const results = new CloudResultService({ database, resultStore, uploadStore, commerce, clock });
  return { directory, database, clock, requests, resultStore, uploadStore, commerce, results };
}

function admitAndQueue(h: ReturnType<typeof harness>): string {
  const admitted = h.requests.admit(
    ACCOUNT,
    {
      operation: 'intake-image',
      byteCount: 4,
      pageCount: 1,
      devicePublicKeyJwk: publicKey(),
      contractVersion: CONTRACT_VERSION,
    },
    `admit-${Date.now()}-${Math.random()}`,
  );
  h.requests.upload(
    ACCOUNT,
    admitted.requestId,
    Buffer.from([1, 2, 3, 4]),
    'application/octet-stream',
    'upload',
  );
  h.requests.completeUpload(ACCOUNT, admitted.requestId, 'complete');
  return admitted.requestId;
}

function envelope(requestId: string): CloudResultEnvelope {
  return decodeCloudResultEnvelope({
    ...decodeCloudResultEnvelopeJson(vector.serializedEnvelope),
    requestId,
    contractVersion: CONTRACT_VERSION,
    resultSchemaVersion: CONTRACT_VERSION,
    handlerVersion: 1,
  });
}

function close(h: ReturnType<typeof harness>): void {
  h.database.close();
  rmSync(h.directory, { recursive: true, force: true });
}

function assertNoResultResidue(h: ReturnType<typeof harness>, requestId: string): void {
  assert.equal(h.database.findCloudResultCache(requestId), undefined);
  assert.equal(h.resultStore.list().length, 0);
}

function serialized(result: CloudResultEnvelope): Buffer {
  return Buffer.from(serializeCloudResultEnvelope(result), 'utf8');
}

function claim(
  h: ReturnType<typeof harness>,
  owner = 'result-worker',
): NonNullable<ReturnType<AccountDatabase['claimAnalysisJob']>> {
  const now = h.clock.now();
  const job = h.database.claimAnalysisJob({
    now: now.toISOString(),
    leaseOwner: owner,
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
  });
  assert.ok(job);
  return job;
}

describe('cloud result cache', () => {
  it('keeps a staged envelope invisible, removes upload, and atomically consumes once on finalize', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const job = claim(h);
      const result = envelope(requestId);
      const staged = h.results.stage(result, { jobId: job.id, leaseOwner: 'result-worker' });
      assert.equal(staged.state, 'queued');
      assert.equal(staged.resultAvailable, false);
      assert.equal(staged.resultExpiresAt, null);
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'staged');
      assert.equal(h.uploadStore.hasCompleteArtifact(requestId), true);
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'consume').length,
        0,
      );

      const ready = h.results.finalize({ jobId: job.id, leaseOwner: 'result-worker' });
      assert.equal(ready.state, 'ready');
      assert.equal(ready.resultAvailable, true);
      assert.equal(h.uploadStore.hasCompleteArtifact(requestId), false);
      assert.equal(h.database.findAnalysisJobByRequest(requestId)?.state, 'succeeded');
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'consume').length,
        1,
      );
      assert.deepEqual(h.results.finalize({ jobId: job.id, leaseOwner: 'result-worker' }), ready);
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'consume').length,
        1,
      );
      assert.deepEqual(h.results.retrieve(ACCOUNT, requestId), serialized(result));
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'retrieved');
    } finally {
      close(h);
    }
  });

  it('rejects stale, expired, wrong-owner, and wrong-job leases without staging or cleanup', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const job = claim(h);
      const result = envelope(requestId);
      for (const lease of [
        { jobId: job.id, leaseOwner: 'other-worker' },
        { jobId: 'other-job', leaseOwner: 'result-worker' },
      ]) {
        assert.throws(
          () => h.results.stage(result, lease),
          (error: unknown) =>
            error instanceof CloudResultFailure && error.code === 'cloud_result_context_mismatch',
        );
      }
      h.clock.advance(60_001);
      assert.throws(
        () => h.results.stage(result, { jobId: job.id, leaseOwner: 'result-worker' }),
        (error: unknown) =>
          error instanceof CloudResultFailure && error.code === 'cloud_result_context_mismatch',
      );
      assert.equal(h.database.findCloudResultCache(requestId), undefined);
      assert.equal(h.uploadStore.hasCompleteArtifact(requestId), true);
    } finally {
      close(h);
    }
  });

  it('keeps staged ciphertext and reservation when upload cleanup fails, then retries safely', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const job = claim(h);
      const result = envelope(requestId);
      h.results.stage(result, job);
      const originalRemove = h.uploadStore.remove;
      h.uploadStore.remove = () => {
        throw new Error('unlink_failed');
      };
      assert.throws(
        () => h.results.finalize(job),
        (error: unknown) =>
          error instanceof CloudResultFailure && error.code === 'cloud_result_storage_failure',
      );
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'staged');
      assert.equal(h.database.findAnalysisJobByRequest(requestId)?.state, 'processing');
      assert.equal(h.uploadStore.hasCompleteArtifact(requestId), true);
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'consume').length,
        0,
      );
      h.uploadStore.remove = originalRemove;
      assert.equal(h.results.finalize(job).state, 'ready');
      assert.equal(h.uploadStore.hasCompleteArtifact(requestId), false);
    } finally {
      close(h);
    }
  });

  it('rejects finalization after lease expiry without consuming or changing staged state', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const job = claim(h);
      h.results.stage(envelope(requestId), job);
      h.clock.advance(60_001);
      assert.throws(
        () => h.results.finalize(job),
        (error: unknown) =>
          error instanceof CloudResultFailure && error.code === 'cloud_result_context_mismatch',
      );
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'staged');
      assert.equal(h.database.findAnalysisJobByRequest(requestId)?.state, 'processing');
      assert.equal(h.uploadStore.hasCompleteArtifact(requestId), true);
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'consume').length,
        0,
      );
    } finally {
      close(h);
    }
  });

  it('recovers a promoted ciphertext file after a crash before staged metadata', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const job = claim(h);
      const result = envelope(requestId);
      h.resultStore.write(requestId, serialized(result));
      h.results.reconcile();
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'staged');
      assert.equal(h.results.status(ACCOUNT, requestId).state, 'queued');
      assert.equal(h.results.finalize(job).state, 'ready');
      assert.equal(h.uploadStore.hasCompleteArtifact(requestId), false);
    } finally {
      close(h);
    }
  });

  it('reclaims a staged result after lease loss without requiring provider or encryption again', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const firstJob = claim(h, 'first-worker');
      const result = envelope(requestId);
      h.results.stage(result, firstJob);
      h.clock.advance(60_001);
      const reclaimed = claim(h, 'second-worker');
      assert.equal(reclaimed.id, firstJob.id);
      assert.equal(h.results.finalize(reclaimed).state, 'ready');
      assert.equal(h.database.findAnalysisJobByRequest(requestId)?.state, 'succeeded');
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'consume').length,
        1,
      );
    } finally {
      close(h);
    }
  });

  it('expires staged ciphertext during reconciliation and releases its reservation', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const job = claim(h);
      h.results.stage(envelope(requestId), job);
      h.database.sqlite
        .prepare('UPDATE cloud_result_cache SET expires_at = ? WHERE request_id = ?')
        .run(new Date(NOW.getTime() - 1).toISOString(), requestId);
      h.results.reconcile();
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'expired');
      assert.equal(h.uploadStore.hasCompleteArtifact(requestId), false);
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'release').length,
        1,
      );
    } finally {
      close(h);
    }
  });

  it('publishes ciphertext-only metadata, replays the same envelope, and rejects plaintext/conflicts', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const result = envelope(requestId);
      const published = h.results.publish(result);
      assert.equal(published.state, 'ready');
      assert.equal(published.resultAvailable, true);
      assert.equal(published.resultExpiresAt !== null, true);
      const row = h.database.sqlite
        .prepare('SELECT * FROM cloud_result_cache WHERE request_id = ?')
        .get(requestId) as Record<string, unknown>;
      assert.equal(JSON.stringify(row).includes(result.ciphertext), false);
      assert.equal(row.byte_count, Buffer.byteLength(JSON.stringify(result), 'utf8'));
      assert.deepEqual(h.results.publish(result), published);
      assert.throws(
        () => h.results.publish({ requestId, plaintext: 'never accepted' }),
        (error: unknown) =>
          error instanceof CloudResultFailure && error.code === 'cloud_result_envelope_invalid',
      );
      const conflicting = decodeCloudResultEnvelope({
        ...result,
        ciphertext:
          result.ciphertext[0] === 'A'
            ? `B${result.ciphertext.slice(1)}`
            : `A${result.ciphertext.slice(1)}`,
      });
      assert.throws(
        () => h.results.publish(conflicting),
        (error: unknown) =>
          error instanceof CloudResultFailure && error.code === 'cloud_result_conflict',
      );
      assert.equal(
        h.resultStore.hasExactBytes(requestId, Buffer.from(JSON.stringify(result))),
        true,
      );
    } finally {
      close(h);
    }
  });

  it('returns the exact canonical envelope once and hides it across owners and retries', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const result = envelope(requestId);
      h.results.publish(result);
      const canonical = Buffer.from(JSON.stringify(result), 'utf8');
      assert.deepEqual(h.results.retrieve(ACCOUNT, requestId), canonical);
      assert.equal(h.results.status(ACCOUNT, requestId).state, 'retrieved');
      assert.equal(h.resultStore.list().length, 0);
      assert.throws(
        () => h.results.retrieve(ACCOUNT, requestId),
        (error: unknown) =>
          error instanceof CloudResultFailure && error.code === 'cloud_result_not_available',
      );
      assert.throws(
        () => h.results.retrieve('other-account', requestId),
        (error: unknown) =>
          error instanceof CloudResultFailure && error.code === 'cloud_result_not_available',
      );
    } finally {
      close(h);
    }
  });

  it('uses the same bounded not-available response for missing, cross-owner, expired, and retrieved results', () => {
    const h = harness();
    try {
      const retrievedId = admitAndQueue(h);
      h.results.publish(envelope(retrievedId));
      h.results.retrieve(ACCOUNT, retrievedId);

      const expiredId = admitAndQueue(h);
      h.results.publish(envelope(expiredId));
      h.database.sqlite
        .prepare('UPDATE cloud_result_cache SET expires_at = ? WHERE request_id = ?')
        .run(new Date(NOW.getTime() - 1).toISOString(), expiredId);

      const crossOwnerId = admitAndQueue(h);
      h.results.publish(envelope(crossOwnerId));
      const attempts = [
        () => h.results.retrieve(ACCOUNT, 'missing-result'),
        () => h.results.retrieve('other-account', crossOwnerId),
        () => h.results.retrieve(ACCOUNT, expiredId),
        () => h.results.retrieve(ACCOUNT, retrievedId),
      ];
      for (const attempt of attempts) {
        assert.throws(
          attempt,
          (error: unknown) =>
            error instanceof CloudResultFailure &&
            error.statusCode === 404 &&
            error.code === 'cloud_result_not_available',
        );
      }
    } finally {
      close(h);
    }
  });

  it('preserves a ready envelope over restart and expires it within the bounded window', () => {
    const h = harness();
    const requestId = admitAndQueue(h);
    h.results.publish(envelope(requestId));
    h.database.close();
    const restartedDatabase = new AccountDatabase({ filename: join(h.directory, 'cloud.sqlite') });
    const restarted = new CloudResultService({
      database: restartedDatabase,
      resultStore: new CloudResultStore(h.directory),
      clock: h.clock,
    });
    try {
      assert.equal(restarted.status(ACCOUNT, requestId).state, 'ready');
      h.clock.advance(CLOUD_RESULT_RETENTION_MS + 1);
      assert.equal(restarted.status(ACCOUNT, requestId).state, 'expired');
      assert.equal(restartedDatabase.findCloudResultCache(requestId)?.state, 'expired');
      assert.equal(new CloudResultStore(h.directory).list().length, 0);
    } finally {
      restartedDatabase.close();
      rmSync(h.directory, { recursive: true, force: true });
    }
  });

  it('classifies an expired result before cleanup when the file is still present', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      h.results.publish(envelope(requestId));
      const expiresAt = new Date(NOW.getTime() - 1).toISOString();
      assert.equal(h.database.markCloudResultExpired(requestId, expiresAt), true);
      assert.equal(h.resultStore.hasCompleteArtifact(requestId), true);
      h.results.reconcile();
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'expired');
      assert.equal(h.resultStore.hasCompleteArtifact(requestId), false);
    } finally {
      close(h);
    }
  });

  it('classifies an expired result when the file already disappeared', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      h.results.publish(envelope(requestId));
      h.resultStore.remove(requestId);
      h.clock.advance(CLOUD_RESULT_RETENTION_MS + 1);
      h.results.reconcile();
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'expired');
      assert.equal(h.resultStore.list().length, 0);
    } finally {
      close(h);
    }
  });

  it('returns one exact envelope despite unlink failure, then reconciles the terminal artifact', async () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const result = envelope(requestId);
      h.results.publish(result);
      const originalRemove = h.resultStore.remove;
      h.resultStore.remove = () => {
        throw new CloudResultStoreFailure();
      };
      const first = new CloudResultService({
        database: h.database,
        resultStore: h.resultStore,
        clock: h.clock,
      });
      const second = new CloudResultService({
        database: h.database,
        resultStore: h.resultStore,
        clock: h.clock,
      });
      // Both readers may load the bytes before either claims the row. The conditional state
      // transition permits exactly one response; a crash after the claim may still lose delivery,
      // but it can never produce a second ciphertext response.
      const attempts = await Promise.all(
        [first, second].map(async (service) => {
          try {
            return { ok: true, bytes: service.retrieve(ACCOUNT, requestId) };
          } catch (error) {
            return { ok: false, error };
          }
        }),
      );
      const successful = attempts.filter(
        (attempt): attempt is { ok: true; bytes: Buffer } => attempt.ok,
      );
      assert.equal(successful.length, 1);
      assert.deepEqual(successful[0]?.bytes, serialized(result));
      const rejected = attempts.filter((attempt) => !attempt.ok);
      assert.equal(rejected.length, 1);
      assert.equal(
        (rejected[0]?.error as CloudResultFailure | undefined)?.code,
        'cloud_result_not_available',
      );
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'retrieved');
      assert.equal(h.resultStore.hasCompleteArtifact(requestId), true);
      h.resultStore.remove = originalRemove;
      h.results.reconcile();
      assert.equal(h.resultStore.hasCompleteArtifact(requestId), false);
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'retrieved');
    } finally {
      close(h);
    }
  });

  it('rejects request, contract, schema, and handler context mismatches without residue', () => {
    const h = harness();
    try {
      const cases = [
        {
          make: (result: CloudResultEnvelope) => ({ ...result, requestId: 'different-request' }),
          code: 'cloud_result_not_available',
        },
        {
          make: (result: CloudResultEnvelope) => ({
            ...result,
            contractVersion: 'different-contract',
          }),
          code: 'cloud_result_context_mismatch',
        },
        {
          make: (result: CloudResultEnvelope) => ({
            ...result,
            resultSchemaVersion: 'different-schema',
          }),
          code: 'cloud_result_context_mismatch',
        },
        {
          make: (result: CloudResultEnvelope) => ({ ...result, handlerVersion: 2 }),
          code: 'cloud_result_context_mismatch',
        },
      ] as const;
      for (const { make, code } of cases) {
        const requestId = admitAndQueue(h);
        assert.throws(
          () => h.results.publish(make(envelope(requestId))),
          (error: unknown) => error instanceof CloudResultFailure && error.code === code,
        );
        assertNoResultResidue(h, requestId);
      }
    } finally {
      close(h);
    }
  });

  it('rejects malformed, plaintext-shaped, off-curve, and oversize input before persistence', () => {
    const h = harness();
    try {
      const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]).toString('base64url');
      const invalids: readonly unknown[] = [
        'not-json',
        { requestId: 'plaintext-request', plaintext: 'never accepted' },
        { ...envelope('malformed-request'), extra: 'unknown-field' },
        { ...envelope('off-curve-request'), ephemeralPublicKey: offCurve },
        {
          ...envelope('oversize-request'),
          ciphertext: Buffer.alloc(CLOUD_RESULT_ENVELOPE_MAX_CIPHERTEXT_BYTES + 1).toString(
            'base64url',
          ),
        },
      ];
      for (const value of invalids) {
        const requestId = admitAndQueue(h);
        assert.throws(
          () => h.results.publish(value),
          (error: unknown) =>
            error instanceof CloudResultFailure && error.code === 'cloud_result_envelope_invalid',
        );
        assertNoResultResidue(h, requestId);
      }
    } finally {
      close(h);
    }
  });

  it('keeps the result root and ciphertext file restrictive', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      h.results.publish(envelope(requestId));
      assert.equal(lstatSync(h.resultStore.root).mode & 0o777, 0o700);
      assert.equal(statSync(join(h.resultStore.root, `${requestId}.json`)).mode & 0o777, 0o600);
    } finally {
      close(h);
    }
  });

  it('rejects traversal and partial/complete symlinks without touching their targets', () => {
    const h = harness();
    try {
      assert.throws(
        () => h.resultStore.write('../traversal', Buffer.from('not-written')),
        (error: unknown) => error instanceof CloudResultStoreFailure,
      );

      const outside = join(h.directory, 'outside-result-target');
      writeFileSync(outside, 'preserve');
      const partialId = 'partial-symlink';
      symlinkSync(outside, join(h.resultStore.root, `${partialId}.partial`));
      h.results.reconcile();
      assert.equal(existsSync(outside), true);
      assert.equal(existsSync(join(h.resultStore.root, `${partialId}.partial`)), false);

      const requestId = admitAndQueue(h);
      h.results.publish(envelope(requestId));
      unlinkSync(join(h.resultStore.root, `${requestId}.json`));
      symlinkSync(outside, join(h.resultStore.root, `${requestId}.json`));
      h.results.reconcile();
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'failed');
      assert.equal(existsSync(join(h.resultStore.root, `${requestId}.json`)), false);
      assert.equal(existsSync(outside), true);
    } finally {
      close(h);
    }
  });

  it('marks corrupt, noncanonical, and wrong-size caches failed and removes them', () => {
    const h = harness();
    try {
      const mutations = [
        Buffer.from('{"schemaVersion":"invalid"}', 'utf8'),
        (result: CloudResultEnvelope) =>
          Buffer.from(
            JSON.stringify({
              schemaVersion: result.schemaVersion,
              keyAgreement: result.keyAgreement,
              kdf: result.kdf,
              cipher: result.cipher,
              requestId: result.requestId,
              contractVersion: result.contractVersion,
              resultSchemaVersion: result.resultSchemaVersion,
              handlerVersion: result.handlerVersion,
              ephemeralPublicKey: result.ephemeralPublicKey,
              salt: result.salt,
              nonce: result.nonce,
              authenticationTag: result.authenticationTag,
              ciphertext: result.ciphertext,
            }),
            'utf8',
          ),
        (result: CloudResultEnvelope) => Buffer.concat([serialized(result), Buffer.from('x')]),
      ] as const;
      for (const mutate of mutations) {
        const requestId = admitAndQueue(h);
        const result = envelope(requestId);
        h.results.publish(result);
        writeFileSync(
          join(h.resultStore.root, `${requestId}.json`),
          typeof mutate === 'function' ? mutate(result) : mutate,
        );
        assert.throws(
          () => h.results.retrieve(ACCOUNT, requestId),
          (error: unknown) =>
            error instanceof CloudResultFailure && error.code === 'cloud_result_not_available',
        );
        assert.equal(h.database.findCloudResultCache(requestId)?.state, 'failed');
        assert.equal(
          h.database.findCloudResultCache(requestId)?.failure_category,
          'cloud_result_cache_invalid',
        );
        assert.equal(h.resultStore.list().length, 0);
      }
    } finally {
      close(h);
    }
  });

  it('fails safely when ready metadata loses its file during reconciliation', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      h.results.publish(envelope(requestId));
      h.resultStore.remove(requestId);
      h.results.reconcile();
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'failed');
      assert.equal(h.resultStore.list().length, 0);
    } finally {
      close(h);
    }
  });

  it('keeps account deletion incomplete on result unlink failure and finishes on same-key retry', async () => {
    const h = harness();
    const server = createServer({
      database: h.database,
      runtimePath: h.directory,
      hashSecret: HASH_SECRET,
      clock: h.clock,
      appleVerifier: new DeterministicAppleVerifier(),
      cloudResultService: h.results,
    });
    try {
      const requestId = admitAndQueue(h);
      h.results.publish(envelope(requestId));
      const exchange = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'delete-result-auth' },
        payload: {
          identityToken: 'result-token',
          rawNonce: '0123456789ABCDEFGHIJKLMNOPQRSTUV',
          consentPolicyVersion: '2026-08-01',
        },
      });
      const token = exchange.json().accessToken as string;
      const originalRemoveEntry = h.resultStore.removeEntry;
      const originalRemoveUnknownEntries = h.resultStore.removeUnknownEntries;
      h.resultStore.removeEntry = () => {
        throw new CloudResultStoreFailure();
      };
      h.resultStore.removeUnknownEntries = () => {
        throw new CloudResultStoreFailure();
      };
      const firstDelete = await server.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': 'delete-result-key',
        },
      });
      assert.equal(firstDelete.statusCode, 500);
      assert.equal(firstDelete.json().error.code, 'cloud_account_cleanup_incomplete');
      assert.equal(h.database.findAccountByAppleSubject('result-subject'), undefined);
      assert.equal(h.resultStore.hasCompleteArtifact(requestId), true);

      h.resultStore.removeEntry = originalRemoveEntry;
      h.resultStore.removeUnknownEntries = originalRemoveUnknownEntries;
      const retry = await server.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: {
          authorization: `Bearer ${token}`,
          'idempotency-key': 'delete-result-key',
        },
      });
      assert.equal(retry.statusCode, 200);
      assert.equal(h.database.findAccountByAppleSubject('result-subject'), undefined);
      assert.equal(h.resultStore.list().length, 0);
    } finally {
      await server.close();
      close(h);
    }
  });

  it('migrates a populated v8 queue to v9 without changing request or job metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-cloud-result-v8-'));
    const filename = join(directory, 'legacy.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (8, '2026-08-28T00:00:00.000Z');
      CREATE TABLE accounts (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO accounts (id, created_at) VALUES ('legacy-result-account', '2026-08-28T00:00:00.000Z');
      CREATE TABLE cloud_requests (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('intake-image', 'lab-report')),
        state TEXT NOT NULL CHECK (state IN ('awaiting-upload', 'uploaded', 'queued', 'cancelled', 'expired')),
        byte_count INTEGER NOT NULL CHECK (byte_count > 0 AND byte_count <= 26214400),
        page_count INTEGER NOT NULL CHECK (page_count > 0 AND page_count <= 20),
        device_public_key_jwk TEXT NOT NULL,
        idempotency_key_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        contract_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        upload_expires_at TEXT NOT NULL,
        uploaded_at TEXT,
        queued_at TEXT,
        expired_at TEXT,
        cancelled_at TEXT
      );
      INSERT INTO cloud_requests VALUES
        ('legacy-result-request', 'legacy-result-account', 'intake-image', 'queued', 4, 1,
         '{}', 'legacy-key-hash', 'legacy-request-hash', '${CONTRACT_VERSION}',
         '2026-08-28T00:00:00.000Z', '2026-08-28T00:00:00.000Z', '2026-08-28T23:45:00.000Z',
         '2026-08-28T00:01:00.000Z', '2026-08-28T00:02:00.000Z', NULL, NULL);
      CREATE TABLE analysis_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES cloud_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'succeeded', 'failed', 'expired', 'cancelled')),
        available_at TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        handler_version INTEGER NOT NULL CHECK (handler_version > 0),
        request_contract_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        prompt_version TEXT,
        failure_category TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO analysis_jobs VALUES
        ('legacy-result-job', 'legacy-result-request', 'queued', '2026-08-28T00:02:00.000Z', 0,
         NULL, NULL, 1, '${CONTRACT_VERSION}', 'legacy-schema-v1', 'legacy-prompt-v1', NULL,
         '2026-08-28T00:02:00.000Z', '2026-08-28T00:02:00.000Z');
    `);
    legacy.close();
    try {
      const database = new AccountDatabase({ filename });
      const request = database.findCloudRequest('legacy-result-account', 'legacy-result-request');
      const job = database.findAnalysisJobByRequest('legacy-result-request');
      assert.equal(request?.state, 'queued');
      assert.equal(request?.byte_count, 4);
      assert.equal(request?.queued_at, '2026-08-28T00:02:00.000Z');
      assert.equal(job?.id, 'legacy-result-job');
      assert.equal(job?.schema_version, 'legacy-schema-v1');
      assert.equal(job?.prompt_version, 'legacy-prompt-v1');
      assert.deepEqual(
        database.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cloud_result_cache'",
          )
          .get(),
        { name: 'cloud_result_cache' },
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('migrates every populated v9 result state without changing result history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-cloud-result-v9-'));
    const filename = join(directory, 'legacy.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (9, '2026-08-28T00:00:00.000Z');
      CREATE TABLE accounts (id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO accounts (id, created_at) VALUES ('legacy-v9-account', '2026-08-28T00:00:00.000Z');
      CREATE TABLE cloud_requests (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('intake-image', 'lab-report')),
        state TEXT NOT NULL CHECK (state IN ('awaiting-upload', 'uploaded', 'queued', 'cancelled', 'expired')),
        byte_count INTEGER NOT NULL CHECK (byte_count > 0 AND byte_count <= 26214400),
        page_count INTEGER NOT NULL CHECK (page_count > 0 AND page_count <= 20),
        device_public_key_jwk TEXT NOT NULL,
        idempotency_key_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        contract_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        upload_expires_at TEXT NOT NULL,
        uploaded_at TEXT,
        queued_at TEXT,
        expired_at TEXT,
        cancelled_at TEXT
      );
      CREATE TABLE analysis_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES cloud_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'succeeded', 'failed', 'expired', 'cancelled')),
        available_at TEXT NOT NULL,
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        handler_version INTEGER NOT NULL CHECK (handler_version > 0),
        request_contract_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        prompt_version TEXT,
        failure_category TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE cloud_result_cache (
        request_id TEXT PRIMARY KEY NOT NULL REFERENCES cloud_requests(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('ready', 'retrieved', 'failed', 'expired')),
        result_schema_version TEXT NOT NULL,
        handler_version INTEGER NOT NULL CHECK (handler_version > 0),
        byte_count INTEGER NOT NULL CHECK (byte_count > 0 AND byte_count <= 524288),
        ready_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        retrieved_at TEXT,
        expired_at TEXT,
        failure_category TEXT CHECK (
          failure_category IS NULL OR
          failure_category IN ('cloud_result_cache_missing', 'cloud_result_cache_invalid', 'cloud_result_cache_conflict')
        )
      );
      CREATE INDEX cloud_result_cache_expiry_idx ON cloud_result_cache(state, expires_at, request_id);
    `);
    const states = ['ready', 'retrieved', 'failed', 'expired'] as const;
    for (const state of states) {
      const requestId = `legacy-v9-request-${state}`;
      legacy
        .prepare(
          `INSERT INTO cloud_requests
          (id, account_id, operation, state, byte_count, page_count, device_public_key_jwk,
           idempotency_key_hash, request_fingerprint, contract_version, created_at, updated_at,
           upload_expires_at, uploaded_at, queued_at, expired_at, cancelled_at)
         VALUES (?, ?, 'intake-image', 'queued', 4, 1, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          'legacy-v9-account',
          `${requestId}-key`,
          `${requestId}-fingerprint`,
          CONTRACT_VERSION,
          NOW.toISOString(),
          NOW.toISOString(),
          NOW.toISOString(),
          NOW.toISOString(),
          NOW.toISOString(),
          null,
          null,
        );
      legacy
        .prepare(
          `INSERT INTO cloud_result_cache
            (request_id, state, result_schema_version, handler_version, byte_count, ready_at,
             expires_at, retrieved_at, expired_at, failure_category)
           VALUES (?, ?, 'result-v9', 1, 4, ?, ?, ?, ?, ?)`,
        )
        .run(
          requestId,
          state,
          NOW.toISOString(),
          new Date(NOW.getTime() + 60_000).toISOString(),
          state === 'retrieved' ? NOW.toISOString() : null,
          state === 'expired' ? NOW.toISOString() : null,
          state === 'failed' ? 'cloud_result_cache_invalid' : null,
        );
    }
    const before = legacy
      .prepare('SELECT * FROM cloud_result_cache ORDER BY request_id')
      .all() as readonly Record<string, unknown>[];
    legacy.close();
    try {
      const database = new AccountDatabase({ filename });
      const after = database.sqlite
        .prepare(
          'SELECT request_id, state, result_schema_version, handler_version, byte_count, ready_at, expires_at, retrieved_at, expired_at, failure_category FROM cloud_result_cache ORDER BY request_id',
        )
        .all() as readonly Record<string, unknown>[];
      assert.deepEqual(after, before);
      assert.deepEqual(
        database.sqlite
          .prepare(
            "SELECT name FROM pragma_table_info('cloud_result_cache') WHERE name IN ('ready_at', 'staged_at') ORDER BY name",
          )
          .all(),
        [{ name: 'ready_at' }, { name: 'staged_at' }],
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('repairs a promoted orphan into invisible staged state and removes result files after account deletion', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const result = envelope(requestId);
      const bytes = Buffer.from(JSON.stringify(result), 'utf8');
      h.resultStore.write(requestId, bytes);
      h.results.reconcile();
      assert.equal(h.results.status(ACCOUNT, requestId).state, 'queued');
      assert.equal(h.database.findCloudResultCache(requestId)?.state, 'staged');
      h.database.deleteAccountData(ACCOUNT);
      h.results.reconcile({ strict: true });
      assert.equal(h.resultStore.list().length, 0);
      assert.equal(h.database.listCloudResultCache().length, 0);
    } finally {
      close(h);
    }
  });

  it('serves the exact envelope only to the owner and keeps result IDs/bodies out of logs', async () => {
    const h = harness();
    const lines: string[] = [];
    const requestId = admitAndQueue(h);
    const result = envelope(requestId);
    h.results.publish(result);
    const server = createServer({
      database: h.database,
      runtimePath: h.directory,
      hashSecret: HASH_SECRET,
      clock: h.clock,
      appleVerifier: new DeterministicAppleVerifier(),
      cloudResultService: h.results,
      loggerStream: { write: (message) => lines.push(message) },
    });
    try {
      const exchange = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'result-auth' },
        payload: {
          identityToken: 'result-token',
          rawNonce: '0123456789ABCDEFGHIJKLMNOPQRSTUV',
          consentPolicyVersion: '2026-08-01',
        },
      });
      const token = exchange.json().accessToken as string;
      const status = await server.inject({
        method: 'GET',
        url: `/v1/cloud-requests/${requestId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().resultAvailable, true);
      assert.equal(status.body.includes(result.ciphertext), false);
      assert.equal(status.body.includes('ephemeralPublicKey'), false);
      const response = await server.inject({
        method: 'GET',
        url: `/v1/cloud-requests/${requestId}/result`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, JSON.stringify(result));
      const repeated = await server.inject({
        method: 'GET',
        url: `/v1/cloud-requests/${requestId}/result`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(repeated.statusCode, 404);
      assert.equal(repeated.json().error.code, 'cloud_result_not_available');
      const unknown = await server.inject({
        method: 'GET',
        url: `/v1/cloud-requests/${requestId}/result/unknown`,
      });
      assert.equal(unknown.statusCode, 404);
      const output = lines.join('');
      assert.equal(output.includes(requestId), false);
      assert.equal(output.includes(result.ciphertext), false);
    } finally {
      await server.close();
      close(h);
    }
  });
});
