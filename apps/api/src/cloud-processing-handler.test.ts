import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CONTRACT_VERSION,
  decodeCloudResultEnvelopeJson,
  type P256PublicKeyJwk,
} from '@alyte/contracts';
import { AccountDatabase, type AnalysisJobRow } from './database.js';
import { CloudProcessingFailureService } from './cloud-processing.js';
import {
  CloudProcessingAdapterFailure,
  createCloudProcessingHandler,
  decodeSyntheticResult,
  serializeSyntheticResult,
  SYNTHETIC_RESULT_SCHEMA_VERSION,
  type CloudProcessingAdapter,
  type CloudProcessingAdapterContext,
} from './cloud-processing-handler.js';
import { CloudRequestService } from './cloud-request.js';
import { CommerceService } from './commerce.js';
import { decryptCloudResultForReference, encryptCloudResult } from './cloud-result-crypto.js';
import { CloudResultService } from './cloud-result.js';
import { CloudResultStore } from './cloud-result-store.js';
import { TransientUploadStore } from './transient-upload-store.js';
import { createJobRunner } from './worker.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const ACCOUNT = 'synthetic-account';
const OTHER_ACCOUNT = 'synthetic-other-account';
const HASH_SECRET = 's'.repeat(32);

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

function keyPair(): { readonly publicKey: P256PublicKeyJwk; readonly privateKey: unknown } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: pair.publicKey.export({ format: 'jwk' }) as unknown as P256PublicKeyJwk,
    privateKey: pair.privateKey.export({ format: 'jwk' }),
  };
}

function grant(database: AccountDatabase): void {
  database.upsertCommerceEntitlement({
    account_id: ACCOUNT,
    plan_id: 'starter_pack',
    product_id: 'alyte_starter_pack',
    status: 'active',
    will_renew: 0,
    period_start: null,
    period_end: null,
    management_url: null,
    updated_at: NOW.toISOString(),
  });
  database.recordCommercePurchase({
    account_id: ACCOUNT,
    transaction_id: 'synthetic-purchase',
    product_id: 'alyte_starter_pack',
    plan_id: 'starter_pack',
    purchase_type: 'starter',
    purchased_at: NOW.toISOString(),
    period_start: null,
    period_end: null,
    created_at: NOW.toISOString(),
  });
  for (const kind of ['snap', 'report'] as const) {
    database.addAllowanceLedgerEntry({
      id: `synthetic-grant-${kind}`,
      account_id: ACCOUNT,
      kind,
      entry_type: 'grant',
      units: 1,
      source_id: `grant:synthetic-purchase:${kind}`,
      grant_source_id: `grant:synthetic-purchase:${kind}`,
      grant_period_start: null,
      period_end: null,
      created_at: NOW.toISOString(),
    });
  }
}

type Harness = {
  readonly directory: string;
  readonly database: AccountDatabase;
  readonly clock: TestClock;
  readonly uploads: TransientUploadStore;
  readonly results: CloudResultService;
  readonly failures: CloudProcessingFailureService;
  readonly requestId: string;
  readonly job: AnalysisJobRow;
  readonly privateKey: unknown;
  readonly bytes: Buffer;
};

function harness(options: { readonly bytes?: Buffer } = {}): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-cloud-handler-'));
  const database = new AccountDatabase({ filename: join(directory, 'cloud.sqlite') });
  database.createAccountForAppleSubject('synthetic-subject', ACCOUNT, NOW.toISOString());
  database.createAccountForAppleSubject(
    'synthetic-other-subject',
    OTHER_ACCOUNT,
    NOW.toISOString(),
  );
  grant(database);
  const clock = new TestClock();
  const uploads = new TransientUploadStore(directory);
  const results = new CloudResultService({
    database,
    resultStore: new CloudResultStore(directory),
    uploadStore: uploads,
    commerce: new CommerceService({ database, now: clock.now }),
    clock,
  });
  const commerce = new CommerceService({ database, now: clock.now });
  const requests = new CloudRequestService({
    database,
    commerce,
    hashSecret: HASH_SECRET,
    clock,
    idFactory: (() => {
      let id = 0;
      return () => `synthetic-${++id}`;
    })(),
    uploadStore: uploads,
  });
  const keys = keyPair();
  const bytes = options.bytes ?? Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const admitted = requests.admit(
    ACCOUNT,
    {
      operation: 'intake-image',
      byteCount: bytes.byteLength,
      pageCount: 1,
      devicePublicKeyJwk: keys.publicKey,
      contractVersion: CONTRACT_VERSION,
    },
    'synthetic-admit',
  );
  requests.upload(
    ACCOUNT,
    admitted.requestId,
    bytes,
    'application/octet-stream',
    'synthetic-upload',
  );
  requests.completeUpload(ACCOUNT, admitted.requestId, 'synthetic-complete');
  const job = database.claimAnalysisJob({
    now: NOW.toISOString(),
    leaseOwner: 'synthetic-owner',
    leaseExpiresAt: '2026-08-28T12:01:00.000Z',
  });
  assert.ok(job);
  return {
    directory,
    database,
    clock,
    uploads,
    results,
    failures: new CloudProcessingFailureService({
      database,
      uploadStore: uploads,
      commerce,
      clock,
    }),
    requestId: admitted.requestId,
    job,
    privateKey: keys.privateKey,
    bytes,
  };
}

function close(h: { readonly directory: string; readonly database: AccountDatabase }): void {
  if (h.database.sqlite.open) h.database.close();
  rmSync(h.directory, { recursive: true, force: true });
}

function heartbeat(h: Harness, expected = 'synthetic-owner') {
  return (): 'renewed' | 'not-live' | 'not-owner' | 'not-found' | 'relinquished' =>
    h.database.heartbeatAnalysisJob({
      jobId: h.job.id,
      leaseOwner: expected,
      now: h.clock.now().toISOString(),
      leaseExpiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString(),
    });
}

function successfulAdapter(): CloudProcessingAdapter {
  return {
    process(bytes, context) {
      return {
        type: 'usable',
        output: {
          schemaVersion: SYNTHETIC_RESULT_SCHEMA_VERSION,
          operation: context.operation,
          inputByteCount: bytes.byteLength,
          accepted: true,
        },
      };
    },
  };
}

describe('synthetic cloud processing composition', () => {
  it('completes, encrypts, survives restart, and retrieves exactly once', async () => {
    const h = harness();
    let restarted: AccountDatabase | undefined;
    try {
      const calls: Array<{ bytes: number[]; context: CloudProcessingAdapterContext }> = [];
      const handler = createCloudProcessingHandler({
        database: h.database,
        uploadStore: h.uploads,
        results: h.results,
        adapter: {
          process(bytes, context) {
            calls.push({ bytes: [...bytes], context });
            return successfulAdapter().process(bytes, context);
          },
        },
      });
      const outcome = await handler(h.job, { heartbeat: heartbeat(h) });
      assert.deepEqual(outcome, { type: 'completed' });
      assert.deepEqual(calls, [
        {
          bytes: [...h.bytes],
          context: {
            operation: 'intake-image',
            contractVersion: CONTRACT_VERSION,
            resultSchemaVersion: CONTRACT_VERSION,
            handlerVersion: 1,
          },
        },
      ]);
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'succeeded');
      assert.equal(h.database.findCloudResultCache(h.requestId)?.state, 'ready');
      assert.equal(
        h.database
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'consume').length,
        1,
      );

      const resultFile = readFileSync(join(h.directory, 'cloud-results', `${h.requestId}.json`));
      assert.equal(resultFile.toString('utf8').includes(SYNTHETIC_RESULT_SCHEMA_VERSION), false);
      restarted = new AccountDatabase({ filename: join(h.directory, 'cloud.sqlite') });
      const restartedResults = new CloudResultService({
        database: restarted,
        resultStore: new CloudResultStore(h.directory),
        uploadStore: new TransientUploadStore(h.directory),
        commerce: new CommerceService({ database: restarted, now: h.clock.now }),
        clock: h.clock,
      });
      const envelopeBytes = restartedResults.retrieve(ACCOUNT, h.requestId);
      const envelope = decodeCloudResultEnvelopeJson(envelopeBytes.toString('utf8'));
      const plaintext = decryptCloudResultForReference({
        envelope,
        devicePrivateKeyJwk: h.privateKey,
        context: {
          requestId: h.requestId,
          contractVersion: CONTRACT_VERSION,
          resultSchemaVersion: CONTRACT_VERSION,
          handlerVersion: 1,
        },
      });
      const decoded = decodeSyntheticResult(JSON.parse(Buffer.from(plaintext).toString('utf8')), {
        operation: 'intake-image',
        inputByteCount: h.bytes.byteLength,
      });
      assert.equal(decoded.schemaVersion, SYNTHETIC_RESULT_SCHEMA_VERSION);
      assert.throws(
        () => restartedResults.retrieve(ACCOUNT, h.requestId),
        /cloud_result_not_available/,
      );
    } finally {
      if (restarted?.sqlite.open) restarted.close();
      close(h);
    }
  });

  it('keeps retrieval owner-bound and ciphertext-only', async () => {
    const h = harness();
    try {
      const handler = createCloudProcessingHandler({
        database: h.database,
        uploadStore: h.uploads,
        results: h.results,
        adapter: successfulAdapter(),
      });
      assert.deepEqual(await handler(h.job, { heartbeat: heartbeat(h) }), { type: 'completed' });
      assert.throws(
        () => h.results.retrieve(OTHER_ACCOUNT, h.requestId),
        /cloud_result_not_available/,
      );
      assert.equal(h.results.retrieve(ACCOUNT, h.requestId).byteLength > 0, true);
      assert.throws(() => h.results.retrieve(ACCOUNT, h.requestId), /cloud_result_not_available/);
    } finally {
      close(h);
    }
  });

  it('zeros the canonical plaintext buffer after encryption', async () => {
    const h = harness();
    try {
      let plaintext: Uint8Array | undefined;
      const handler = createCloudProcessingHandler({
        database: h.database,
        uploadStore: h.uploads,
        results: h.results,
        adapter: successfulAdapter(),
        encrypt: (input) => {
          plaintext = input.plaintext;
          return encryptCloudResult(input);
        },
      });
      assert.deepEqual(await handler(h.job, { heartbeat: heartbeat(h) }), { type: 'completed' });
      assert.ok(plaintext);
      assert.deepEqual([...plaintext], new Array(plaintext.byteLength).fill(0));
    } finally {
      close(h);
    }
  });

  it('rejects malformed and unusable output before encryption and releases without charging', async () => {
    for (const output of [
      {},
      {
        schemaVersion: SYNTHETIC_RESULT_SCHEMA_VERSION,
        operation: 'intake-image',
        inputByteCount: 99,
        accepted: true,
      },
    ]) {
      const h = harness();
      try {
        const handler = createCloudProcessingHandler({
          database: h.database,
          uploadStore: h.uploads,
          results: h.results,
          adapter: { process: async () => ({ type: 'usable' as const, output }) },
        });
        const result = await handler(h.job, { heartbeat: heartbeat(h) });
        assert.deepEqual(result, { type: 'failure', category: 'malformed_output' });
        h.failures.handleFailure(
          { jobId: h.job.id, leaseOwner: h.job.lease_owner as string },
          'malformed_output',
        );
        assert.equal(h.database.findCloudResultCache(h.requestId), undefined);
        assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'failed');
        assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
        const ledger = h.database.listAllowanceLedger(ACCOUNT, 'snap');
        assert.equal(
          ledger.some((row) => row.entry_type === 'consume'),
          false,
        );
        assert.equal(ledger.filter((row) => row.entry_type === 'release').length, 1);
      } finally {
        close(h);
      }
    }
  });

  it('does not propagate provider messages or unknown outcome categories', async () => {
    const h = harness();
    try {
      const providerMessage = 'private provider response';
      const handler = createCloudProcessingHandler({
        database: h.database,
        uploadStore: h.uploads,
        results: h.results,
        adapter: {
          process: async () =>
            ({
              type: 'failure',
              category: providerMessage,
              message: providerMessage,
            }) as never,
        },
      });
      const result = await handler(h.job, { heartbeat: heartbeat(h) });
      assert.deepEqual(result, { type: 'failure', category: 'malformed_output' });
      assert.equal(JSON.stringify(result).includes(providerMessage), false);
    } finally {
      close(h);
    }
  });

  it('maps every provider outcome to only the closed #122 category', async () => {
    for (const category of [
      'provider_failure',
      'timeout',
      'safety_refusal',
      'malformed_output',
      'unusable_output',
    ] as const) {
      const h = harness();
      try {
        const handler = createCloudProcessingHandler({
          database: h.database,
          uploadStore: h.uploads,
          results: h.results,
          adapter: {
            process: async () => {
              if (category === 'timeout') throw new CloudProcessingAdapterFailure(category);
              return { type: 'failure' as const, category };
            },
          },
        });
        const result = await handler(h.job, { heartbeat: heartbeat(h) });
        assert.deepEqual(result, { type: 'failure', category });
        if (category === 'provider_failure' || category === 'timeout') {
          const transition = h.failures.handleFailure(
            { jobId: h.job.id, leaseOwner: h.job.lease_owner as string },
            category,
          );
          assert.equal(transition.outcome, 'retry');
          assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
        } else {
          const transition = h.failures.handleFailure(
            { jobId: h.job.id, leaseOwner: h.job.lease_owner as string },
            category,
          );
          assert.equal(transition.outcome, 'failed');
          assert.equal(h.uploads.hasCompleteArtifact(h.requestId), false);
        }
      } finally {
        close(h);
      }
    }
  });

  it('does no read/provider work when the lease is lost before invocation', async () => {
    const h = harness();
    try {
      let calls = 0;
      const handler = createCloudProcessingHandler({
        database: h.database,
        uploadStore: h.uploads,
        results: h.results,
        adapter: {
          process: async () => {
            calls += 1;
            return successfulAdapter().process(h.bytes, {
              operation: 'intake-image',
              contractVersion: CONTRACT_VERSION,
              resultSchemaVersion: CONTRACT_VERSION,
              handlerVersion: 1,
            });
          },
        },
      });
      const result = await handler(h.job, { heartbeat: () => 'not-live' });
      assert.equal(result, undefined);
      assert.equal(calls, 0);
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'processing');
    } finally {
      close(h);
    }
  });

  it('does not stage or charge when the lease is lost after provider return', async () => {
    const h = harness();
    try {
      let heartbeatCalls = 0;
      let calls = 0;
      const handler = createCloudProcessingHandler({
        database: h.database,
        uploadStore: h.uploads,
        results: h.results,
        adapter: {
          process: async () => {
            calls += 1;
            return successfulAdapter().process(h.bytes, {
              operation: 'intake-image',
              contractVersion: CONTRACT_VERSION,
              resultSchemaVersion: CONTRACT_VERSION,
              handlerVersion: 1,
            });
          },
        },
      });
      const result = await handler(h.job, {
        heartbeat: () => {
          heartbeatCalls += 1;
          return heartbeatCalls === 1 ? 'renewed' : 'not-live';
        },
      });
      assert.equal(result, undefined);
      assert.equal(calls, 1);
      assert.equal(h.database.findCloudResultCache(h.requestId), undefined);
      assert.equal(h.uploads.hasCompleteArtifact(h.requestId), true);
      assert.deepEqual(
        h.database.listAllowanceLedger(ACCOUNT, 'snap').filter((row) => row.entry_type !== 'grant'),
        [
          {
            id: h.database
              .listAllowanceLedger(ACCOUNT, 'snap')
              .find((row) => row.entry_type === 'reserve')?.id,
            account_id: ACCOUNT,
            kind: 'snap',
            entry_type: 'reserve',
            units: 1,
            source_id: h.requestId,
            grant_source_id: 'grant:synthetic-purchase:snap',
            grant_period_start: null,
            period_end: null,
            created_at: NOW.toISOString(),
          },
        ],
      );
    } finally {
      close(h);
    }
  });

  it('finalizes a staged result after restart without invoking the adapter again', async () => {
    const h = harness();
    let restarted: AccountDatabase | undefined;
    try {
      const adapterCalls: number[] = [];
      const context = {
        operation: 'intake-image' as const,
        contractVersion: CONTRACT_VERSION,
        resultSchemaVersion: CONTRACT_VERSION,
        handlerVersion: 1,
      };
      const plaintext = serializeSyntheticResult(
        {
          schemaVersion: SYNTHETIC_RESULT_SCHEMA_VERSION,
          operation: 'intake-image',
          inputByteCount: h.bytes.byteLength,
          accepted: true,
        },
        { operation: 'intake-image', inputByteCount: h.bytes.byteLength },
      );
      const envelope = encryptCloudResult({
        ...context,
        requestId: h.requestId,
        devicePublicKeyJwk: JSON.parse(
          h.database.findCloudRequestById(h.requestId)?.device_public_key_jwk ?? '{}',
        ),
        plaintext,
      });
      plaintext.fill(0);
      h.results.stage({ jobId: h.job.id, leaseOwner: h.job.lease_owner as string }, envelope);
      h.database.close();
      h.clock.advance(60_001);
      const reopened = new AccountDatabase({ filename: join(h.directory, 'cloud.sqlite') });
      restarted = reopened;
      const restartedUploads = new TransientUploadStore(h.directory);
      const restartedResults = new CloudResultService({
        database: reopened,
        resultStore: new CloudResultStore(h.directory),
        uploadStore: restartedUploads,
        commerce: new CommerceService({ database: restarted, now: h.clock.now }),
        clock: h.clock,
      });
      const reclaimed = reopened.claimAnalysisJob({
        now: h.clock.now().toISOString(),
        leaseOwner: 'restarted-owner',
        leaseExpiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString(),
      });
      assert.ok(reclaimed);
      const handler = createCloudProcessingHandler({
        database: restarted,
        uploadStore: restartedUploads,
        results: restartedResults,
        adapter: {
          process: async () => {
            adapterCalls.push(1);
            return successfulAdapter().process(h.bytes, context);
          },
        },
      });
      const outcome = await handler(reclaimed, {
        heartbeat: () =>
          reopened.heartbeatAnalysisJob({
            jobId: reclaimed.id,
            leaseOwner: 'restarted-owner',
            now: h.clock.now().toISOString(),
            leaseExpiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString(),
          }),
      });
      assert.deepEqual(outcome, { type: 'completed' });
      assert.deepEqual(adapterCalls, []);
      assert.equal(reopened.findAnalysisJobByRequest(h.requestId)?.state, 'succeeded');
      assert.equal(
        reopened.listAllowanceLedger(ACCOUNT, 'snap').filter((row) => row.entry_type === 'consume')
          .length,
        1,
      );
    } finally {
      if (restarted?.sqlite.open) restarted.close();
      close(h);
    }
  });

  it('maps an admitted-key crypto failure to malformed output without ready state', async () => {
    const h = harness();
    try {
      h.database.sqlite
        .prepare('UPDATE cloud_requests SET device_public_key_jwk = ? WHERE id = ?')
        .run('{"not":"a-key"}', h.requestId);
      const handler = createCloudProcessingHandler({
        database: h.database,
        uploadStore: h.uploads,
        results: h.results,
        adapter: successfulAdapter(),
      });
      const result = await handler(h.job, { heartbeat: heartbeat(h) });
      assert.deepEqual(result, { type: 'failure', category: 'malformed_output' });
      h.failures.handleFailure(
        { jobId: h.job.id, leaseOwner: h.job.lease_owner as string },
        'malformed_output',
      );
      assert.equal(h.database.findCloudResultCache(h.requestId), undefined);
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'failed');
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

  it('keeps the default runner dormant instead of claiming without an explicit handler', async () => {
    const h = harness();
    try {
      h.database.sqlite
        .prepare(
          "UPDATE analysis_jobs SET state = 'queued', attempts = 0, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?",
        )
        .run(h.job.id);
      const runner = createJobRunner({
        database: h.database,
        ownerId: 'dormant-runner',
        pollIntervalMs: 1,
      });
      runner.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await runner.stop({ gracePeriodMs: 0 });
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.state, 'queued');
      assert.equal(h.database.findAnalysisJobByRequest(h.requestId)?.attempts, 0);
    } finally {
      close(h);
    }
  });
});
