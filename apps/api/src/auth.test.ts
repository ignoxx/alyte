import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from 'jose';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLE_ISSUER,
  AppleTokenVerificationError,
  ProductionAppleIdentityVerifier,
  type AppleIdentityVerifier,
} from './apple-verifier.js';
import { AccountDatabase } from './database.js';
import { createServer } from './server.js';

class TestClock {
  current = new Date('2026-08-22T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1_000);
  }
}

class DeterministicAppleVerifier implements AppleIdentityVerifier {
  async verify(identityToken: string): Promise<{ subject: string }> {
    if (identityToken === 'valid-alice') {
      return { subject: 'apple-subject-alice' };
    }
    if (identityToken === 'valid-alice-second-device') {
      return { subject: 'apple-subject-alice' };
    }
    throw new AppleTokenVerificationError();
  }
}

function makeServer(clock = new TestClock()) {
  const database = new AccountDatabase({ filename: ':memory:' });
  const loggerEvents: Array<{
    event: string;
    attributes: Readonly<Record<string, string | number | boolean>>;
  }> = [];
  const server = createServer({
    database,
    appleVerifier: new DeterministicAppleVerifier(),
    clock,
    hashSecret: 'a'.repeat(32),
    authLogger: {
      info(event, attributes) {
        loggerEvents.push({ event, attributes });
      },
      warn(event, attributes) {
        loggerEvents.push({ event, attributes });
      },
    },
  });
  return { clock, database, loggerEvents, server };
}

async function exchange(
  server: Awaited<ReturnType<typeof createServer>>,
  identityToken = 'valid-alice',
) {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/auth/apple/exchange',
    payload: { identityToken, consentPolicyVersion: '2026-08-01' },
  });
  assert.equal(response.statusCode, 200);
  return response.json() as {
    accountId: string;
    accessToken: string;
    refreshToken: string;
    accessTokenExpiresAt: string;
    refreshTokenExpiresAt: string;
  };
}

describe('cloud identity database migrations', () => {
  it('applies schema zero to current and can reopen the runtime database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-api-test-'));
    const filename = join(directory, 'identity.sqlite');
    try {
      const first = new AccountDatabase({ filename });
      assert.equal(
        (
          first.sqlite.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
            version: number;
          }
        ).version,
        1,
      );
      assert.deepEqual(
        first.sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
          .get(),
        { name: 'accounts' },
      );
      first.close();
      const second = new AccountDatabase({ filename });
      assert.equal(
        (second.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number })
          .count,
        0,
      );
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('production Apple identity verification', () => {
  it('rejects invalid issuer, audience, and expiry while accepting a valid signed subject', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const verifier = new ProductionAppleIdentityVerifier({
      audience: 'com.alyte.app',
      keySet: async () => publicKey,
    });
    const { SignJWT } = await import('jose');
    const sign = (issuer: string, audience: string, expirationTime: string) =>
      new SignJWT({ sub: 'apple-subject-signed' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(expirationTime)
        .sign(privateKey);

    const valid = await verifier.verify(await sign(APPLE_ISSUER, 'com.alyte.app', '1h'));
    assert.deepEqual(valid, { subject: 'apple-subject-signed' });
    await assert.rejects(
      verifier.verify(await sign('https://attacker.invalid', 'com.alyte.app', '1h')),
    );
    await assert.rejects(verifier.verify(await sign(APPLE_ISSUER, 'com.other.app', '1h')));
    await assert.rejects(verifier.verify(await sign(APPLE_ISSUER, 'com.alyte.app', '0s')));
  });
});

describe('optional cloud identity journey', () => {
  it('maps a verified Apple subject to one opaque account and records only consent metadata', async () => {
    const { database, server } = makeServer();
    try {
      const first = await exchange(server);
      const second = await exchange(server, 'valid-alice-second-device');
      assert.equal(first.accountId, second.accountId);
      assert.notEqual(first.accessToken, second.accessToken);
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM apple_subjects').get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.deepEqual(
        database.sqlite.prepare('SELECT subject, account_id FROM apple_subjects').get(),
        {
          subject: 'apple-subject-alice',
          account_id: first.accountId,
        },
      );
      assert.deepEqual(database.sqlite.prepare('SELECT policy_version FROM consents').get(), {
        policy_version: '2026-08-01',
      });
      const sessionRows = database.sqlite
        .prepare('SELECT access_token_hash, refresh_token_hash FROM sessions')
        .all() as Array<Record<string, string>>;
      assert.equal(sessionRows.length, 2);
      for (const row of sessionRows) {
        assert.equal(Object.values(row).includes(first.accessToken), false);
        assert.equal(Object.values(row).includes(first.refreshToken), false);
      }
    } finally {
      await server.close();
      database.close();
    }
  });

  it('rejects cancellation-shaped and invalid identity tokens without logging token material', async () => {
    const { database, loggerEvents, server } = makeServer();
    try {
      const cancelled = await server.inject({
        method: 'POST',
        url: '/v1/auth/apple',
        payload: { identityToken: null },
      });
      assert.equal(cancelled.statusCode, 400);
      assert.equal(cancelled.json().error.code, 'identity_cancelled');

      const invalidToken = 'invalid-token-secret';
      const invalid = await server.inject({
        method: 'POST',
        url: '/v1/auth/apple',
        payload: { identityToken: invalidToken },
      });
      assert.equal(invalid.statusCode, 401);
      assert.equal(JSON.stringify(invalid.json()).includes(invalidToken), false);
      assert.equal(JSON.stringify(loggerEvents).includes(invalidToken), false);
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get() as {
            count: number;
          }
        ).count,
        0,
      );
    } finally {
      await server.close();
      database.close();
    }
  });

  it('rotates refresh secrets transactionally, rejects reuse, and revokes the session family on sign-out', async () => {
    const { database, server } = makeServer();
    try {
      const initial = await exchange(server);
      const rotatedResponse = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: initial.refreshToken },
      });
      assert.equal(rotatedResponse.statusCode, 200);
      const rotated = rotatedResponse.json() as typeof initial;
      assert.equal(rotated.accountId, initial.accountId);
      assert.notEqual(rotated.refreshToken, initial.refreshToken);
      assert.equal(
        (
          database.sqlite
            .prepare('SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NOT NULL')
            .get() as { count: number }
        ).count,
        1,
      );

      const reuse = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: initial.refreshToken },
      });
      assert.equal(reuse.statusCode, 401);
      assert.equal(reuse.json().error.code, 'refresh_token_reused');

      const familyRevoked = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: rotated.refreshToken },
      });
      assert.equal(familyRevoked.statusCode, 401);
      assert.equal(familyRevoked.json().error.code, 'refresh_token_reused');

      const fresh = await exchange(server);
      const signedOut = await server.inject({
        method: 'POST',
        url: '/v1/auth/sign-out',
        headers: { authorization: `Bearer ${fresh.accessToken}` },
      });
      assert.equal(signedOut.statusCode, 200);
      assert.deepEqual(signedOut.json(), { signedOut: true });
      const afterSignOut = await server.inject({
        method: 'GET',
        url: '/v1/account/export',
        headers: { authorization: `Bearer ${fresh.accessToken}` },
      });
      assert.equal(afterSignOut.statusCode, 401);
    } finally {
      await server.close();
      database.close();
    }
  });

  it('rejects expired app sessions and refresh sessions', async () => {
    const { clock, database, server } = makeServer();
    try {
      const session = await exchange(server);
      clock.advance(15 * 60 + 1);
      const expiredAccess = await server.inject({
        method: 'GET',
        url: '/v1/account/export',
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      assert.equal(expiredAccess.statusCode, 401);
      const expiredRefresh = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: session.refreshToken },
      });
      assert.equal(expiredRefresh.statusCode, 200);

      clock.advance(30 * 24 * 60 * 60);
      const afterRefreshExpiry = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: expiredRefresh.json().refreshToken },
      });
      assert.equal(afterRefreshExpiry.statusCode, 401);
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      await server.close();
      database.close();
    }
  });

  it('exports account metadata without secrets and deletes cloud state idempotently', async () => {
    const { database, server } = makeServer();
    try {
      const session = await exchange(server);
      const exported = await server.inject({
        method: 'GET',
        url: '/v1/account/export',
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      assert.equal(exported.statusCode, 200);
      const exportBody = exported.json();
      assert.equal(exportBody.accountId, session.accountId);
      assert.equal(exportBody.consents[0].policyVersion, '2026-08-01');
      assert.equal(JSON.stringify(exportBody).includes(session.accessToken), false);
      assert.equal(JSON.stringify(exportBody).includes(session.refreshToken), false);
      assert.equal(JSON.stringify(exportBody).includes('apple-subject-alice'), false);

      const deletionKey = 'delete-account-test-1';
      const deleted = await server.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: { authorization: `Bearer ${session.accessToken}`, 'idempotency-key': deletionKey },
      });
      assert.equal(deleted.statusCode, 200);
      assert.deepEqual(deleted.json(), { deleted: true });

      const repeated = await server.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: { 'idempotency-key': deletionKey },
      });
      assert.equal(repeated.statusCode, 200);
      assert.deepEqual(repeated.json(), { deleted: true });
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM accounts').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM apple_subjects').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM consents').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
            count: number;
          }
        ).count,
        0,
      );
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM deletion_tombstones').get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      await server.close();
      database.close();
    }
  });
});
