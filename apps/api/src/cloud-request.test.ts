import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLOUD_PRODUCT_IDS, CONTRACT_VERSION, type P256PublicKeyJwk } from '@alyte/contracts';
import { AccountDatabase } from './database.js';
import { CommerceService } from './commerce.js';
import {
  CloudRequestFailure,
  CloudRequestService,
  parseP256PublicKeyJwk,
} from './cloud-request.js';
import { createServer } from './server.js';
import type { AppleIdentityVerifier } from './apple-verifier.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const HASH_SECRET = 'a'.repeat(32);
const ACCOUNT = 'account-cloud-request-test';
const PRODUCT = CLOUD_PRODUCT_IDS.starterPack;

class DeterministicAppleVerifier implements AppleIdentityVerifier {
  async verify(identityToken: string): Promise<{ subject: string }> {
    if (identityToken === 'valid-alice') return { subject: 'subject-alice' };
    if (identityToken === 'valid-bob') return { subject: 'subject-bob' };
    throw new Error('invalid_identity');
  }
}

function publicKey(): P256PublicKeyJwk {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return pair.publicKey.export({ format: 'jwk' }) as unknown as P256PublicKeyJwk;
}

function admission(key = publicKey()): Record<string, unknown> {
  return {
    operation: 'intake-image',
    byteCount: 1_024,
    pageCount: 1,
    devicePublicKeyJwk: key,
    contractVersion: CONTRACT_VERSION,
  };
}

function grantStarter(database: AccountDatabase, accountId = ACCOUNT): void {
  const purchasedAt = NOW.toISOString();
  database.upsertCommerceEntitlement({
    account_id: accountId,
    plan_id: 'starter_pack',
    product_id: PRODUCT,
    status: 'active',
    will_renew: 0,
    period_start: null,
    period_end: null,
    management_url: null,
    updated_at: purchasedAt,
  });
  database.recordCommercePurchase({
    account_id: accountId,
    transaction_id: `purchase-${accountId}`,
    product_id: PRODUCT,
    plan_id: 'starter_pack',
    purchase_type: 'starter',
    purchased_at: purchasedAt,
    period_start: null,
    period_end: null,
    created_at: purchasedAt,
  });
  for (const [kind, units] of [
    ['snap', 5],
    ['report', 1],
  ] as const) {
    database.addAllowanceLedgerEntry({
      id: `grant-${kind}-${accountId}`,
      account_id: accountId,
      kind,
      entry_type: 'grant',
      units,
      source_id: `grant:purchase-${accountId}:${kind}`,
      grant_source_id: `grant:purchase-${accountId}:${kind}`,
      grant_period_start: null,
      period_end: null,
      created_at: purchasedAt,
    });
  }
}

function serviceHarness() {
  const database = new AccountDatabase({ filename: ':memory:' });
  database.createAccountForAppleSubject('subject-alice', ACCOUNT, NOW.toISOString());
  grantStarter(database);
  const commerce = new CommerceService({ database, now: () => NOW });
  const service = new CloudRequestService({
    database,
    commerce,
    hashSecret: HASH_SECRET,
    clock: { now: () => NOW },
    idFactory: (() => {
      let next = 0;
      return () => `request-${++next}`;
    })(),
  });
  return { database, service };
}

describe('P-256 admission representation', () => {
  it('accepts a real P-256 public JWK and rejects alternate/private encodings', () => {
    const key = publicKey();
    assert.deepEqual(parseP256PublicKeyJwk({ y: key.y, x: key.x, crv: key.crv, kty: key.kty }), {
      kty: 'EC',
      crv: 'P-256',
      x: key.x,
      y: key.y,
    });
    assert.throws(
      () => parseP256PublicKeyJwk({ ...key, d: key.x }),
      (error: unknown) =>
        error instanceof CloudRequestFailure && error.code === 'device_public_key_invalid',
    );
    assert.throws(
      () => parseP256PublicKeyJwk({ ...key, x: `${key.x}=` }),
      (error: unknown) =>
        error instanceof CloudRequestFailure && error.code === 'device_public_key_invalid',
    );
  });
});

describe('cloud request admission service', () => {
  it('reserves the operation-specific allowance and replays after reopening SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-cloud-request-'));
    const filename = join(directory, 'cloud.sqlite');
    try {
      const firstDatabase = new AccountDatabase({ filename });
      firstDatabase.createAccountForAppleSubject('subject-alice', ACCOUNT, NOW.toISOString());
      grantStarter(firstDatabase);
      const firstService = new CloudRequestService({
        database: firstDatabase,
        commerce: new CommerceService({ database: firstDatabase, now: () => NOW }),
        hashSecret: HASH_SECRET,
        clock: { now: () => NOW },
        idFactory: () => 'request-restart',
      });
      const request = admission();
      const first = firstService.admit(ACCOUNT, request, 'same-key');
      assert.equal(first.requestId, 'request-restart');
      assert.equal(
        firstDatabase
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'reserve').length,
        1,
      );
      firstDatabase.close();

      const secondDatabase = new AccountDatabase({ filename });
      const replay = new CloudRequestService({
        database: secondDatabase,
        commerce: new CommerceService({ database: secondDatabase, now: () => NOW }),
        hashSecret: HASH_SECRET,
        clock: { now: () => NOW },
        idFactory: () => 'different-id',
      }).admit(ACCOUNT, request, 'same-key');
      assert.deepEqual(replay, first);
      assert.equal(
        secondDatabase
          .listAllowanceLedger(ACCOUNT, 'snap')
          .filter((row) => row.entry_type === 'reserve').length,
        1,
      );
      secondDatabase.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('conflicts on changed input and rolls back request plus reservation when allowance is unavailable', () => {
    const { database, service } = serviceHarness();
    try {
      const original = service.admit(ACCOUNT, admission(), 'conflict-key');
      assert.throws(
        () => service.admit(ACCOUNT, { ...admission(), byteCount: 2_048 }, 'conflict-key'),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'idempotency_key_conflict',
      );
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM cloud_requests').get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.equal(original.state, 'awaiting-upload');

      const noAllowanceDatabase = new AccountDatabase({ filename: ':memory:' });
      noAllowanceDatabase.createAccountForAppleSubject(
        'subject-empty',
        'empty-account',
        NOW.toISOString(),
      );
      const noAllowance = new CloudRequestService({
        database: noAllowanceDatabase,
        commerce: new CommerceService({ database: noAllowanceDatabase, now: () => NOW }),
        hashSecret: HASH_SECRET,
        clock: { now: () => NOW },
        idFactory: () => 'rolled-back-request',
      });
      assert.throws(() => noAllowance.admit('empty-account', admission(), 'no-allowance'));
      assert.equal(
        (
          noAllowanceDatabase.sqlite
            .prepare('SELECT COUNT(*) AS count FROM cloud_requests')
            .get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          noAllowanceDatabase.sqlite
            .prepare('SELECT COUNT(*) AS count FROM allowance_ledger')
            .get() as {
            count: number;
          }
        ).count,
        0,
      );
      noAllowanceDatabase.close();
    } finally {
      database.close();
    }
  });

  it('cancels only awaiting-upload and releases exactly one reservation', () => {
    const { database, service } = serviceHarness();
    try {
      const admitted = service.admit(ACCOUNT, admission(), 'cancel-key');
      const cancelled = service.cancel(ACCOUNT, admitted.requestId, 'cancel-call-1');
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(cancelled.cancelledAt, NOW.toISOString());
      assert.deepEqual(service.cancel(ACCOUNT, admitted.requestId, 'cancel-call-2'), cancelled);
      const releases = database
        .listAllowanceLedger(ACCOUNT, 'snap')
        .filter((row) => row.entry_type === 'release' && row.source_id === admitted.requestId);
      assert.equal(releases.length, 1);
      assert.equal(service.status(ACCOUNT, admitted.requestId).state, 'cancelled');
    } finally {
      database.close();
    }
  });

  it('persists only allowlisted opaque metadata and never the raw idempotency capability', () => {
    const { database, service } = serviceHarness();
    try {
      const rawKey = 'raw-idempotency-capability-never-stored';
      const admitted = service.admit(ACCOUNT, admission(), rawKey);
      const row = database.sqlite
        .prepare('SELECT * FROM cloud_requests WHERE id = ?')
        .get(admitted.requestId) as Record<string, unknown> | undefined;
      assert.ok(row);
      assert.equal(JSON.stringify(row).includes(rawKey), false);
      assert.equal('device_public_key_jwk' in row, true);
      assert.equal('filename' in row, false);
      assert.equal('ocr_text' in row, false);
      assert.equal('measurement' in row, false);
      assert.equal('intake_content' in row, false);
    } finally {
      database.close();
    }
  });

  it('uses owner-scoped lookup so another account cannot discover a request', () => {
    const { database, service } = serviceHarness();
    try {
      database.createAccountForAppleSubject('subject-bob', 'account-bob', NOW.toISOString());
      grantStarter(database, 'account-bob');
      const admitted = service.admit(ACCOUNT, admission(), 'owner-key');
      assert.throws(
        () => service.status('account-bob', admitted.requestId),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_request_not_found',
      );
      assert.throws(
        () => service.cancel('account-bob', admitted.requestId, 'bob-cancel'),
        (error: unknown) =>
          error instanceof CloudRequestFailure && error.code === 'cloud_request_not_found',
      );
    } finally {
      database.close();
    }
  });

  it('removes request metadata and its reservation through account deletion cascade', () => {
    const { database, service } = serviceHarness();
    try {
      const admitted = service.admit(ACCOUNT, admission(), 'delete-key');
      database.deleteAccountData(ACCOUNT);
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM cloud_requests').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM allowance_ledger').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(admitted.operation, 'intake-image');
    } finally {
      database.close();
    }
  });
});

describe('cloud request API', () => {
  it('authenticates admission/status/cancellation and rejects body health payloads', async () => {
    const { database } = serviceHarness();
    const server = createServer({
      database,
      appleVerifier: new DeterministicAppleVerifier(),
      hashSecret: HASH_SECRET,
      clock: { now: () => NOW },
    });
    try {
      const exchange = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'auth-key' },
        payload: {
          identityToken: 'valid-alice',
          rawNonce: '0123456789ABCDEFGHIJKLMNOPQRSTUV',
          consentPolicyVersion: '2026-08-01',
        },
      });
      assert.equal(exchange.statusCode, 200);
      const token = exchange.json().accessToken as string;
      const created = await server.inject({
        method: 'POST',
        url: '/v1/cloud-requests',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'request-key' },
        payload: admission(),
      });
      assert.equal(created.statusCode, 200);
      const requestId = created.json().requestId as string;
      assert.equal(created.json().state, 'awaiting-upload');
      assert.equal(created.json().devicePublicKeyJwk, undefined);

      const status = await server.inject({
        method: 'GET',
        url: `/v1/cloud-requests/${requestId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(status.statusCode, 200);
      const cancelled = await server.inject({
        method: 'POST',
        url: `/v1/cloud-requests/${requestId}/cancel`,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'cancel-key' },
      });
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.json().state, 'cancelled');
    } finally {
      await server.close();
    }
  });
});
