import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { generateKeyPair } from 'jose';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLE_ISSUER,
  AppleNonceVerificationError,
  AppleTokenVerificationError,
  ProductionAppleIdentityVerifier,
  hashAppleNonce,
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
  async verify(identityToken: string, _rawNonce: string): Promise<{ subject: string }> {
    if (identityToken === 'valid-alice') {
      return { subject: 'apple-subject-alice' };
    }
    if (identityToken === 'valid-alice-second-device') {
      return { subject: 'apple-subject-alice' };
    }
    if (identityToken === 'valid-bob') {
      return { subject: 'apple-subject-bob' };
    }
    throw new AppleTokenVerificationError();
  }
}

function makeServer(
  clock = new TestClock(),
  appleVerifier: AppleIdentityVerifier = new DeterministicAppleVerifier(),
) {
  const database = new AccountDatabase({ filename: ':memory:' });
  const loggerEvents: Array<{
    event: string;
    attributes: Readonly<{ outcome: string }>;
  }> = [];
  const server = createServer({
    database,
    appleVerifier,
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

let exchangeCounter = 0;
const DEFAULT_RAW_NONCE = '0123456789ABCDEFGHIJKLMNOPQRSTUV';

async function exchange(
  server: Awaited<ReturnType<typeof createServer>>,
  identityToken = 'valid-alice',
  key = `exchange-${++exchangeCounter}`,
  rawNonce = DEFAULT_RAW_NONCE,
) {
  const response = await server.inject({
    method: 'POST',
    url: '/v2/auth/apple/exchange',
    headers: { 'idempotency-key': key },
    payload: { identityToken, rawNonce, consentPolicyVersion: '2026-08-01' },
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
        11,
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

  it('upgrades the released schema with session timestamps and replay storage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-api-migration-'));
    const filename = join(directory, 'identity.sqlite');
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-01T00:00:00.000Z');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        access_token_hash TEXT NOT NULL UNIQUE,
        access_expires_at TEXT NOT NULL,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        refresh_expires_at TEXT NOT NULL,
        revoked_at TEXT,
        replaced_by TEXT
      );
    `);
    legacy.close();
    try {
      const database = new AccountDatabase({ filename });
      assert.deepEqual(
        database.sqlite
          .prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'created_at'")
          .get(),
        { name: 'created_at' },
      );
      assert.deepEqual(
        database.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_idempotency'",
          )
          .get(),
        { name: 'operation_idempotency' },
      );
      assert.deepEqual(
        database.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'apple_exchange_replay_tombstones'",
          )
          .get(),
        { name: 'apple_exchange_replay_tombstones' },
      );
      assert.deepEqual(
        database.sqlite
          .prepare(
            "SELECT name FROM pragma_table_info('operation_idempotency') WHERE name = 'nonce_digest'",
          )
          .get(),
        { name: 'nonce_digest' },
      );
      database.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('runtime persistence and bounded cleanup', () => {
  it('persists the local session hash secret across ordinary server restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-api-restart-'));
    const filename = join(directory, 'identity.sqlite');
    const clock = new TestClock();
    try {
      const firstServer = createServer({
        databasePath: filename,
        runtimePath: directory,
        appleVerifier: new DeterministicAppleVerifier(),
        clock,
      });
      const session = await exchange(firstServer, 'valid-alice', 'restart-exchange');
      await firstServer.close();

      const secondServer = createServer({
        databasePath: filename,
        runtimePath: directory,
        appleVerifier: new DeterministicAppleVerifier(),
        clock,
      });
      const refreshed = await secondServer.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { 'idempotency-key': 'restart-refresh' },
        payload: { refreshToken: session.refreshToken },
      });
      assert.equal(refreshed.statusCode, 200);
      await secondServer.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('bounds cleanup of expired sessions and replay records', async () => {
    const { clock, database, server } = makeServer();
    try {
      const session = await exchange(server, 'valid-alice', 'cleanup-exchange');
      const signedOut = await server.inject({
        method: 'POST',
        url: '/v1/auth/sign-out',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'idempotency-key': 'cleanup-sign-out',
        },
      });
      assert.equal(signedOut.statusCode, 200);
      clock.advance(2 * 24 * 60 * 60);
      const removed = database.cleanupExpired(clock.now(), 100);
      assert.equal(removed.sessions >= 1, true);
      assert.equal(removed.operations >= 1, true);
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
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM operation_idempotency').get() as {
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

  it('rejects a consumed Apple nonce under a new key after a server restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-api-nonce-restart-'));
    const filename = join(directory, 'identity.sqlite');
    const clock = new TestClock();
    try {
      const firstServer = createServer({
        databasePath: filename,
        runtimePath: directory,
        appleVerifier: new DeterministicAppleVerifier(),
        clock,
      });
      await exchange(firstServer, 'valid-alice', 'nonce-restart-first');
      const sameProcessReplay = await firstServer.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'nonce-restart-second' },
        payload: {
          identityToken: 'valid-alice',
          rawNonce: DEFAULT_RAW_NONCE,
          consentPolicyVersion: '2026-08-01',
        },
      });
      assert.equal(sameProcessReplay.statusCode, 409);
      assert.equal(sameProcessReplay.json().error.code, 'nonce_replayed');
      await firstServer.close();

      const secondServer = createServer({
        databasePath: filename,
        runtimePath: directory,
        appleVerifier: new DeterministicAppleVerifier(),
        clock,
      });
      const afterRestart = await secondServer.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'nonce-restart-third' },
        payload: {
          identityToken: 'valid-alice',
          rawNonce: DEFAULT_RAW_NONCE,
          consentPolicyVersion: '2026-08-01',
        },
      });
      assert.equal(afterRestart.statusCode, 409);
      assert.equal(afterRestart.json().error.code, 'nonce_replayed');
      await secondServer.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('production runtime configuration', () => {
  it('requires an explicit runtime path before production startup', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRuntimePath = process.env.ALYTE_RUNTIME_PATH;
    const previousSecret = process.env.ALYTE_SESSION_HASH_SECRET;
    const previousAudience = process.env.APPLE_AUDIENCE;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.ALYTE_RUNTIME_PATH;
      delete process.env.ALYTE_SESSION_HASH_SECRET;
      process.env.APPLE_AUDIENCE = 'com.alyte.app';
      assert.throws(() => createServer({ hashSecret: 'a'.repeat(32) }), /ALYTE_RUNTIME_PATH/);
      const runtimePath = mkdtempSync(join(tmpdir(), 'alyte-api-production-'));
      try {
        process.env.ALYTE_RUNTIME_PATH = runtimePath;
        assert.throws(() => createServer(), /ALYTE_SESSION_HASH_SECRET/);
      } finally {
        rmSync(runtimePath, { recursive: true, force: true });
      }
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousRuntimePath === undefined) delete process.env.ALYTE_RUNTIME_PATH;
      else process.env.ALYTE_RUNTIME_PATH = previousRuntimePath;
      if (previousSecret === undefined) delete process.env.ALYTE_SESSION_HASH_SECRET;
      else process.env.ALYTE_SESSION_HASH_SECRET = previousSecret;
      if (previousAudience === undefined) delete process.env.APPLE_AUDIENCE;
      else process.env.APPLE_AUDIENCE = previousAudience;
    }
  });
});

describe('production Apple identity verification', () => {
  it('hashes the raw nonce as UTF-8 SHA-256 lowercase hex for Apple', () => {
    assert.equal(
      hashAppleNonce(DEFAULT_RAW_NONCE),
      '41ba696bc2822924f7cba0ce211bfddfe653ceb3c981255a1775bebf110bf42d',
    );
  });

  it('rejects invalid issuer, audience, and expiry while accepting a valid signed subject', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const secondKey = await generateKeyPair('RS256');
    const verifier = new ProductionAppleIdentityVerifier({
      audience: 'com.alyte.app',
      keySet: async () => publicKey,
    });
    const { SignJWT } = await import('jose');
    const sign = (
      issuer: string,
      audience: string,
      expirationTime: string,
      kid = 'test-key',
      rawNonce = DEFAULT_RAW_NONCE,
    ) =>
      new SignJWT({ sub: 'apple-subject-signed', nonce: hashAppleNonce(rawNonce) })
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(expirationTime)
        .sign(privateKey);

    const valid = await verifier.verify(
      await sign(APPLE_ISSUER, 'com.alyte.app', '1h'),
      DEFAULT_RAW_NONCE,
    );
    assert.deepEqual(valid, { subject: 'apple-subject-signed' });
    await assert.rejects(
      verifier.verify(
        await sign('https://attacker.invalid', 'com.alyte.app', '1h'),
        DEFAULT_RAW_NONCE,
      ),
    );
    await assert.rejects(
      verifier.verify(await sign(APPLE_ISSUER, 'com.other.app', '1h'), DEFAULT_RAW_NONCE),
    );
    await assert.rejects(
      verifier.verify(await sign(APPLE_ISSUER, 'com.alyte.app', '0s'), DEFAULT_RAW_NONCE),
    );
    await assert.rejects(
      new ProductionAppleIdentityVerifier({
        audience: 'com.alyte.app',
        keySet: async (header) => {
          if (header.kid !== 'test-key') {
            throw new Error('unknown_apple_key');
          }
          return publicKey;
        },
      }).verify(await sign(APPLE_ISSUER, 'com.alyte.app', '1h', 'unknown-key'), DEFAULT_RAW_NONCE),
    );
    await assert.rejects(
      new ProductionAppleIdentityVerifier({
        audience: 'com.alyte.app',
        keySet: async () => {
          throw new Error('malformed_jwks');
        },
      }).verify(await sign(APPLE_ISSUER, 'com.alyte.app', '1h'), DEFAULT_RAW_NONCE),
    );
    await assert.rejects(
      verifier.verify(
        await new (await import('jose')).SignJWT({
          sub: 'apple-subject-signed',
          nonce: hashAppleNonce(DEFAULT_RAW_NONCE),
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(APPLE_ISSUER)
          .setAudience('com.alyte.app')
          .setExpirationTime('1h')
          .sign(secondKey.privateKey),
        DEFAULT_RAW_NONCE,
      ),
    );
    await assert.rejects(
      verifier.verify(
        await new (await import('jose')).SignJWT({ nonce: hashAppleNonce(DEFAULT_RAW_NONCE) })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(APPLE_ISSUER)
          .setAudience('com.alyte.app')
          .setExpirationTime('1h')
          .sign(privateKey),
        DEFAULT_RAW_NONCE,
      ),
    );
    await assert.rejects(
      verifier.verify(
        await sign(
          APPLE_ISSUER,
          'com.alyte.app',
          '1h',
          'test-key',
          'fedcba9876543210ZYXWVUTSRQPONMLK',
        ),
        DEFAULT_RAW_NONCE,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppleNonceVerificationError);
        return true;
      },
    );
    await assert.rejects(
      verifier.verify(
        await new (await import('jose')).SignJWT({ sub: 'apple-subject-signed' })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(APPLE_ISSUER)
          .setAudience('com.alyte.app')
          .setExpirationTime('1h')
          .sign(privateKey),
        DEFAULT_RAW_NONCE,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppleNonceVerificationError);
        return true;
      },
    );
  });
});

describe('optional cloud identity journey', () => {
  it('requires the v2 nonce contract and rejects the legacy exchange routes', async () => {
    const { database, server } = makeServer();
    try {
      const legacy = await server.inject({
        method: 'POST',
        url: '/v1/auth/apple/exchange',
        headers: { 'idempotency-key': 'legacy-exchange' },
        payload: { identityToken: 'valid-alice', consentPolicyVersion: '2026-08-01' },
      });
      assert.equal(legacy.statusCode, 426);
      assert.equal(legacy.json().error.code, 'auth_contract_version_unsupported');

      const missing = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'missing-nonce' },
        payload: { identityToken: 'valid-alice', consentPolicyVersion: '2026-08-01' },
      });
      assert.equal(missing.statusCode, 400);
      assert.equal(missing.json().error.code, 'nonce_required');

      const malformed = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'malformed-nonce' },
        payload: {
          identityToken: 'valid-alice',
          rawNonce: `${DEFAULT_RAW_NONCE.slice(0, -1)}!`,
          consentPolicyVersion: '2026-08-01',
        },
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().error.code, 'nonce_invalid');
    } finally {
      await server.close();
      database.close();
    }
  });

  it('replays an Apple exchange without re-verifying the already accepted token', async () => {
    let verificationAttempts = 0;
    const verifier: AppleIdentityVerifier = {
      async verify(_identityToken, _rawNonce): Promise<{ subject: string }> {
        verificationAttempts += 1;
        if (verificationAttempts > 1) {
          throw new AppleTokenVerificationError();
        }
        return { subject: 'apple-subject-alice' };
      },
    };
    const { database, server } = makeServer(new TestClock(), verifier);
    try {
      const first = await exchange(server, 'valid-alice', 'exchange-replay-without-provider');
      const replayed = await exchange(server, 'valid-alice', 'exchange-replay-without-provider');
      assert.deepEqual(replayed, first);
      assert.equal(verificationAttempts, 1);
      const changedCredential = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'exchange-replay-without-provider' },
        payload: {
          identityToken: 'valid-bob',
          rawNonce: DEFAULT_RAW_NONCE,
          consentPolicyVersion: '2026-08-01',
        },
      });
      assert.equal(changedCredential.statusCode, 409);
      assert.equal(changedCredential.json().error.code, 'idempotency_key_conflict');
    } finally {
      await server.close();
      database.close();
    }
  });

  it('allows one concurrent exchange per nonce and rejects the other key', async () => {
    const { database, server } = makeServer();
    try {
      const responses = await Promise.all(
        ['concurrent-exchange-a', 'concurrent-exchange-b'].map((key) =>
          server.inject({
            method: 'POST',
            url: '/v2/auth/apple/exchange',
            headers: { 'idempotency-key': key },
            payload: {
              identityToken: 'valid-alice',
              rawNonce: DEFAULT_RAW_NONCE,
              consentPolicyVersion: '2026-08-01',
            },
          }),
        ),
      );
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal(
        (
          database.sqlite
            .prepare(
              "SELECT COUNT(*) AS count FROM operation_idempotency WHERE operation = 'auth.apple.exchange'",
            )
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      await server.close();
      database.close();
    }
  });

  it('maps a verified Apple subject to one opaque account and records only consent metadata', async () => {
    const { database, server } = makeServer();
    try {
      const first = await exchange(server, 'valid-alice', 'exchange-first');
      const second = await exchange(
        server,
        'valid-alice-second-device',
        'exchange-second',
        'fedcba9876543210ZYXWVUTSRQPONMLK',
      );
      const replayed = await exchange(server, 'valid-alice', 'exchange-first');
      assert.equal(first.accountId, second.accountId);
      assert.notEqual(first.accessToken, second.accessToken);
      assert.deepEqual(replayed, first);
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
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'exchange-cancelled' },
        payload: { identityToken: null },
      });
      assert.equal(cancelled.statusCode, 400);
      assert.equal(cancelled.json().error.code, 'identity_cancelled');

      const missingConsent = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'exchange-missing-consent' },
        payload: { identityToken: 'valid-alice', rawNonce: DEFAULT_RAW_NONCE },
      });
      assert.equal(missingConsent.statusCode, 400);
      assert.equal(missingConsent.json().error.code, 'consent_policy_version_required');

      const invalidToken = 'invalid-token-secret';
      const invalid = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'exchange-invalid' },
        payload: {
          identityToken: invalidToken,
          rawNonce: DEFAULT_RAW_NONCE,
          consentPolicyVersion: '2026-08-01',
        },
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
        headers: { 'idempotency-key': 'refresh-first' },
        payload: { refreshToken: initial.refreshToken },
      });
      assert.equal(rotatedResponse.statusCode, 200);
      const rotated = rotatedResponse.json() as typeof initial;
      assert.equal(rotated.accountId, initial.accountId);
      assert.notEqual(rotated.refreshToken, initial.refreshToken);
      const rotatedReplay = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { 'idempotency-key': 'refresh-first' },
        payload: { refreshToken: initial.refreshToken },
      });
      assert.equal(rotatedReplay.statusCode, 200);
      assert.deepEqual(rotatedReplay.json(), rotated);
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
        headers: { 'idempotency-key': 'refresh-reuse' },
        payload: { refreshToken: initial.refreshToken },
      });
      assert.equal(reuse.statusCode, 401);
      assert.equal(reuse.json().error.code, 'refresh_token_reused');

      const familyRevoked = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { 'idempotency-key': 'refresh-family-revoked' },
        payload: { refreshToken: rotated.refreshToken },
      });
      assert.equal(familyRevoked.statusCode, 401);
      assert.equal(familyRevoked.json().error.code, 'refresh_token_reused');

      const fresh = await exchange(
        server,
        'valid-alice',
        'exchange-fresh',
        'fedcba9876543210ZYXWVUTSRQPONMLK',
      );
      const signedOut = await server.inject({
        method: 'POST',
        url: '/v1/auth/sign-out',
        headers: {
          authorization: `Bearer ${fresh.accessToken}`,
          'idempotency-key': 'sign-out-first',
        },
      });
      assert.equal(signedOut.statusCode, 200);
      assert.deepEqual(signedOut.json(), { signedOut: true });
      const signOutReplay = await server.inject({
        method: 'POST',
        url: '/v1/auth/sign-out',
        headers: {
          authorization: `Bearer ${fresh.accessToken}`,
          'idempotency-key': 'sign-out-first',
        },
      });
      assert.equal(signOutReplay.statusCode, 200);
      assert.deepEqual(signOutReplay.json(), { signedOut: true });
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
        headers: { 'idempotency-key': 'refresh-expired-access' },
        payload: { refreshToken: session.refreshToken },
      });
      assert.equal(expiredRefresh.statusCode, 200);

      clock.advance(30 * 24 * 60 * 60);
      const afterRefreshExpiry = await server.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { 'idempotency-key': 'refresh-after-expiry' },
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
      assert.equal(exportBody.appleSubject, 'apple-subject-alice');
      assert.equal(exportBody.consents[0].policyVersion, '2026-08-01');
      assert.equal(exportBody.sessions.length, 1);
      assert.equal(exportBody.operations.length >= 1, true);
      assert.equal(JSON.stringify(exportBody).includes(session.accessToken), false);
      assert.equal(JSON.stringify(exportBody).includes(session.refreshToken), false);
      assert.equal(JSON.stringify(exportBody).includes('access_token_hash'), false);

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
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'idempotency-key': deletionKey,
        },
      });
      assert.equal(repeated.statusCode, 200);
      assert.deepEqual(repeated.json(), { deleted: true });
      const anotherAccount = await exchange(
        server,
        'valid-bob',
        'exchange-bob-for-delete',
        'fedcba9876543210ZYXWVUTSRQPONMLK',
      );
      const crossAccountReplay = await server.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: {
          authorization: `Bearer ${anotherAccount.accessToken}`,
          'idempotency-key': deletionKey,
        },
      });
      assert.equal(crossAccountReplay.statusCode, 409);
      assert.equal(database.findAccount(session.accountId), undefined);
      assert.equal(database.findAppleSubject(session.accountId), undefined);
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
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM consents').get() as {
            count: number;
          }
        ).count,
        1,
      );
      assert.equal(
        (
          database.sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
            count: number;
          }
        ).count,
        1,
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

  it('retains only an unlinkable Apple replay marker after account deletion', async () => {
    const { clock, database, server } = makeServer();
    try {
      const session = await exchange(server, 'valid-alice', 'delete-nonce-source');
      const deleted = await server.inject({
        method: 'DELETE',
        url: '/v1/account',
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          'idempotency-key': 'delete-nonce-account',
        },
      });
      assert.equal(deleted.statusCode, 200);
      assert.equal(
        (
          database.sqlite
            .prepare(
              "SELECT COUNT(*) AS count FROM operation_idempotency WHERE operation = 'auth.apple.exchange'",
            )
            .get() as { count: number }
        ).count,
        0,
      );
      const marker = database.sqlite
        .prepare('SELECT * FROM apple_exchange_replay_tombstones')
        .get() as Record<string, unknown>;
      assert.equal(typeof marker.nonce_digest, 'string');
      assert.equal(typeof marker.credential_hash, 'string');
      assert.equal(typeof marker.expires_at, 'string');
      assert.equal('account_id' in marker, false);
      assert.equal('response_json' in marker, false);

      const replay = await server.inject({
        method: 'POST',
        url: '/v2/auth/apple/exchange',
        headers: { 'idempotency-key': 'delete-nonce-replay' },
        payload: {
          identityToken: 'valid-alice',
          rawNonce: DEFAULT_RAW_NONCE,
          consentPolicyVersion: '2026-08-01',
        },
      });
      assert.equal(replay.statusCode, 409);
      assert.equal(replay.json().error.code, 'nonce_replayed');
      assert.equal(database.findAccount(session.accountId), undefined);
      clock.advance(2 * 24 * 60 * 60);
      assert.equal(database.cleanupExpired(clock.now()).operations >= 1, true);
      assert.equal(
        (
          database.sqlite
            .prepare('SELECT COUNT(*) AS count FROM apple_exchange_replay_tombstones')
            .get() as { count: number }
        ).count,
        0,
      );
    } finally {
      await server.close();
      database.close();
    }
  });
});
