import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CLOUD_PRODUCT_IDS,
  CONTRACT_VERSION,
  decodeCloudResultEnvelope,
  decodeCloudResultEnvelopeJson,
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
import { CloudResultStore } from './cloud-result-store.js';
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
    ['snap', 2],
    ['report', 1],
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
  const requests = new CloudRequestService({
    database,
    commerce: new CommerceService({ database, now: clock.now }),
    hashSecret: HASH_SECRET,
    clock,
    idFactory: (() => {
      let next = 0;
      return () => `result-request-${++next}`;
    })(),
    uploadStore,
  });
  const results = new CloudResultService({ database, resultStore, clock });
  return { directory, database, clock, requests, resultStore, results };
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

describe('cloud result cache', () => {
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

  it('repairs a promoted orphan and removes result files after account deletion', () => {
    const h = harness();
    try {
      const requestId = admitAndQueue(h);
      const result = envelope(requestId);
      const bytes = Buffer.from(JSON.stringify(result), 'utf8');
      h.resultStore.write(requestId, bytes);
      h.results.reconcile();
      assert.equal(h.results.status(ACCOUNT, requestId).state, 'ready');
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
