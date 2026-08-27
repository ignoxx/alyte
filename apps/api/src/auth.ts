import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type {
  AccountAuditEvent,
  AccountConsent,
  AccountDeletionResponse,
  AccountExportResponse,
  AccountOperation,
  AccountSession,
  SessionResponse,
  SignOutResponse,
} from '@alyte/contracts';
import {
  AppleNonceVerificationError,
  AppleTokenVerificationError,
  isValidAppleRawNonce,
  type AppleIdentityVerifier,
} from './apple-verifier.js';
import {
  OPERATION_IDEMPOTENCY_RETENTION_MS,
  type AccountDatabase,
  type OperationName,
  type SessionRow,
} from './database.js';

export interface Clock {
  now(): Date;
}

export interface AuthLogger {
  info(event: string, attributes: Readonly<{ outcome: string }>): void;
  warn(event: string, attributes: Readonly<{ outcome: string }>): void;
}

const silentLogger: AuthLogger = {
  info() {},
  warn() {},
};

export class AuthFailure extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = 'AuthFailure';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface AuthServiceOptions {
  readonly database: AccountDatabase;
  readonly appleVerifier: AppleIdentityVerifier;
  readonly clock?: Clock | undefined;
  readonly accessLifetimeSeconds?: number | undefined;
  readonly refreshLifetimeSeconds?: number | undefined;
  readonly hashSecret: string | Uint8Array;
  readonly logger?: AuthLogger | undefined;
}

export interface AuthenticatedSession {
  readonly accountId: string;
  readonly session: SessionRow;
}

const systemClock: Clock = { now: () => new Date() };

function asIso(date: Date): string {
  return date.toISOString();
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1_000);
}

function isExpired(iso: string, now: Date): boolean {
  const timestamp = Date.parse(iso);
  return !Number.isFinite(timestamp) || timestamp <= now.getTime();
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export class AuthService {
  private readonly database: AccountDatabase;
  private readonly appleVerifier: AppleIdentityVerifier;
  private readonly clock: Clock;
  private readonly accessLifetimeSeconds: number;
  private readonly refreshLifetimeSeconds: number;
  private readonly hashSecret: Uint8Array;
  private readonly logger: AuthLogger;

  constructor(options: AuthServiceOptions) {
    this.database = options.database;
    this.appleVerifier = options.appleVerifier;
    this.clock = options.clock ?? systemClock;
    this.accessLifetimeSeconds = options.accessLifetimeSeconds ?? 15 * 60;
    this.refreshLifetimeSeconds = options.refreshLifetimeSeconds ?? 30 * 24 * 60 * 60;
    if (this.accessLifetimeSeconds <= 0 || this.refreshLifetimeSeconds <= 0) {
      throw new Error('session_lifetime_must_be_positive');
    }
    const configuredSecret = options.hashSecret;
    this.hashSecret =
      typeof configuredSecret === 'string'
        ? new TextEncoder().encode(configuredSecret)
        : configuredSecret;
    if (this.hashSecret.length < 32) {
      throw new Error('session_hash_secret_too_short');
    }
    this.logger = options.logger ?? silentLogger;
  }

  async exchangeApple(
    identityToken: unknown,
    rawNonce: unknown,
    consentPolicyVersion: unknown,
    idempotencyKey: unknown,
  ): Promise<SessionResponse> {
    if (identityToken === undefined || identityToken === null || identityToken === '') {
      throw new AuthFailure(
        400,
        identityToken === null ? 'identity_cancelled' : 'identity_token_required',
      );
    }
    if (!validText(identityToken, 16_384)) {
      throw new AuthFailure(400, 'identity_token_invalid');
    }
    if (rawNonce === undefined || rawNonce === null || rawNonce === '') {
      throw new AuthFailure(400, 'nonce_required');
    }
    if (!isValidAppleRawNonce(rawNonce)) {
      throw new AuthFailure(400, 'nonce_invalid');
    }
    const key = this.parseIdempotencyKey(idempotencyKey);
    const now = this.clock.now();
    const keyHash = this.hash(key);
    const nonceDigest = this.hash(rawNonce);
    const credentialHash = this.hash(`${identityToken}\u0000${rawNonce}`);
    const replay = this.replayOperation<SessionResponse>(
      'auth.apple.exchange',
      keyHash,
      credentialHash,
      now,
      nonceDigest,
    );
    if (replay !== undefined) {
      this.logger.info('auth.apple_exchange_replayed', { outcome: 'replayed' });
      return replay;
    }
    this.assertAppleExchangeNotReplayed(credentialHash, nonceDigest, keyHash, now);
    const policyVersion = this.parsePolicyVersion(consentPolicyVersion);
    let identity;
    try {
      identity = await this.appleVerifier.verify(identityToken, rawNonce);
    } catch (error) {
      this.logger.warn('auth.apple_exchange_rejected', {
        outcome:
          error instanceof AppleNonceVerificationError
            ? 'invalid_nonce'
            : error instanceof AppleTokenVerificationError
              ? 'invalid_identity'
              : 'verification_failure',
      });
      if (error instanceof AppleNonceVerificationError) {
        throw new AuthFailure(401, 'nonce_invalid');
      }
      throw new AuthFailure(401, 'identity_token_invalid');
    }
    if (!validText(identity.subject, 512)) {
      this.logger.warn('auth.apple_exchange_rejected', { outcome: 'subject_missing' });
      throw new AuthFailure(401, 'identity_token_invalid');
    }

    let transactionResult: {
      mapped: ReturnType<AccountDatabase['createAccountForAppleSubject']>;
      result: SessionResponse;
    };
    try {
      transactionResult = this.database.transaction(() => {
        // Re-check inside the write transaction so a second process cannot race the preflight
        // replay check. The partial unique nonce index is the final guard for concurrent writers.
        this.assertAppleExchangeNotReplayed(credentialHash, nonceDigest, keyHash, now);
        const existing = this.database.findOperation('auth.apple.exchange', keyHash);
        if (existing !== undefined) {
          const replayed = this.replayOperation<SessionResponse>(
            'auth.apple.exchange',
            keyHash,
            credentialHash,
            now,
            nonceDigest,
          );
          const existingAccount =
            existing.account_id === null
              ? undefined
              : this.database.findAccount(existing.account_id);
          if (replayed === undefined || existingAccount === undefined) {
            throw new Error('apple_exchange_replay_record_invalid');
          }
          return {
            mapped: { account: existingAccount, created: false },
            result: replayed,
          };
        }
        const account = this.database.createAccountForAppleSubject(
          identity.subject,
          randomUUID(),
          asIso(now),
        );
        if (policyVersion !== undefined) {
          this.database.recordConsent(account.account.id, policyVersion, asIso(now));
        }
        const session = this.createSession(account.account.id, now);
        this.database.createOperation({
          operation: 'auth.apple.exchange',
          keyHash,
          credentialHash,
          nonceDigest,
          accountId: account.account.id,
          responseStatus: 200,
          responseCiphertext: this.encryptResponse(session),
          createdAt: asIso(now),
          expiresAt: asIso(addSeconds(now, OPERATION_IDEMPOTENCY_RETENTION_MS / 1_000)),
        });
        return { mapped: account, result: session };
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          'operation_idempotency.operation, operation_idempotency.nonce_digest',
        )
      ) {
        throw new AuthFailure(409, 'nonce_replayed');
      }
      throw error;
    }
    const { mapped, result } = transactionResult;
    this.logger.info('auth.apple_exchange_succeeded', {
      outcome: mapped.created ? 'created' : 'existing',
    });
    return result;
  }

  refresh(refreshToken: unknown, idempotencyKey: unknown): SessionResponse {
    if (!validText(refreshToken, 16_384)) {
      throw new AuthFailure(400, 'refresh_token_required');
    }
    const key = this.parseIdempotencyKey(idempotencyKey);
    const now = this.clock.now();
    const credentialHash = this.hash(refreshToken);
    const keyHash = this.hash(key);
    const replay = this.replayOperation<SessionResponse>(
      'auth.refresh',
      keyHash,
      credentialHash,
      now,
    );
    if (replay !== undefined) {
      this.logger.info('auth.refresh_replayed', { outcome: 'replayed' });
      return replay;
    }
    const oldSession = this.database.findSessionByRefreshHash(credentialHash);
    if (oldSession === undefined) {
      this.logger.warn('auth.refresh_rejected', { outcome: 'unknown_token' });
      throw new AuthFailure(401, 'refresh_token_invalid');
    }
    if (oldSession.revoked_at !== null) {
      this.database.transaction(() => {
        this.database.revokeSessionFamily(oldSession.family_id, asIso(now));
      });
      this.logger.warn('auth.refresh_rejected', { outcome: 'reuse' });
      throw new AuthFailure(401, 'refresh_token_reused');
    }
    if (isExpired(oldSession.refresh_expires_at, now)) {
      this.database.revokeSession(oldSession.id, asIso(now));
      this.logger.warn('auth.refresh_rejected', { outcome: 'expired' });
      throw new AuthFailure(401, 'refresh_token_expired');
    }

    const next = this.buildSession(oldSession.account_id, now, oldSession.family_id);
    this.database.transaction(() => {
      this.database.createSession(next.record);
      this.database.revokeSession(oldSession.id, asIso(now), next.record.id);
      this.database.createOperation({
        operation: 'auth.refresh',
        keyHash,
        credentialHash,
        nonceDigest: null,
        accountId: oldSession.account_id,
        responseStatus: 200,
        responseCiphertext: this.encryptResponse(next.response),
        createdAt: asIso(now),
        expiresAt: asIso(addSeconds(now, OPERATION_IDEMPOTENCY_RETENTION_MS / 1_000)),
      });
    });
    this.logger.info('auth.refresh_succeeded', { outcome: 'rotated' });
    return next.response;
  }

  signOut(accessToken: unknown, idempotencyKey: unknown): SignOutResponse {
    if (!validText(accessToken, 16_384)) {
      throw new AuthFailure(401, 'session_invalid');
    }
    const key = this.parseIdempotencyKey(idempotencyKey);
    const now = this.clock.now();
    const credentialHash = this.hash(accessToken);
    const keyHash = this.hash(key);
    const replay = this.replayOperation<SignOutResponse>(
      'auth.sign-out',
      keyHash,
      credentialHash,
      now,
    );
    if (replay !== undefined) {
      this.logger.info('auth.sign_out_replayed', { outcome: 'replayed' });
      return replay;
    }
    const authenticated = this.authenticateAccess(accessToken);
    const response: SignOutResponse = { signedOut: true };
    this.database.transaction(() => {
      this.database.revokeSessionFamily(authenticated.session.family_id, asIso(now));
      this.database.createOperation({
        operation: 'auth.sign-out',
        keyHash,
        credentialHash,
        nonceDigest: null,
        accountId: authenticated.accountId,
        responseStatus: 200,
        responseCiphertext: this.encryptResponse(response),
        createdAt: asIso(now),
        expiresAt: asIso(addSeconds(now, OPERATION_IDEMPOTENCY_RETENTION_MS / 1_000)),
      });
    });
    this.logger.info('auth.sign_out_succeeded', { outcome: 'revoked_family' });
    return response;
  }

  exportAccount(accessToken: unknown): AccountExportResponse {
    const authenticated = this.authenticateAccess(accessToken);
    const now = this.clock.now();
    const response = this.database.transaction(() => {
      this.database.addAuditEvent({
        id: randomUUID(),
        accountId: authenticated.accountId,
        type: 'account.exported',
        occurredAt: asIso(now),
      });
      const account = this.database.findAccount(authenticated.accountId);
      const appleSubject = this.database.findAppleSubject(authenticated.accountId);
      if (account === undefined || appleSubject === undefined) {
        throw new AuthFailure(401, 'session_invalid');
      }
      const consents: AccountConsent[] = this.database
        .listConsents(authenticated.accountId)
        .map((consent) => ({
          policyVersion: consent.policy_version,
          acceptedAt: consent.accepted_at,
        }));
      const sessions: AccountSession[] = this.database
        .listSessions(authenticated.accountId)
        .map((session) => ({
          id: session.id,
          familyId: session.family_id,
          status:
            session.revoked_at !== null
              ? 'revoked'
              : isExpired(session.access_expires_at, now) &&
                  isExpired(session.refresh_expires_at, now)
                ? 'expired'
                : 'active',
          createdAt: session.created_at,
          accessExpiresAt: session.access_expires_at,
          refreshExpiresAt: session.refresh_expires_at,
          revokedAt: session.revoked_at,
        }));
      const operations: AccountOperation[] = this.database
        .listOperations(authenticated.accountId)
        .map((operation) => ({
          operation: operation.operation,
          responseStatus: operation.response_status,
          createdAt: operation.created_at,
          expiresAt: operation.expires_at,
        }));
      const auditEvents: AccountAuditEvent[] = this.database
        .listAuditEvents(authenticated.accountId)
        .map((event) => ({
          type: event.type,
          occurredAt: event.occurred_at,
        }));
      return {
        accountId: account.id,
        createdAt: account.created_at,
        appleSubject,
        consents,
        sessions,
        operations,
        auditEvents,
      } satisfies AccountExportResponse;
    });
    this.logger.info('auth.export_succeeded', { outcome: 'exported' });
    return response;
  }

  deleteAccount(accessToken: unknown, idempotencyKey: unknown): AccountDeletionResponse {
    if (!validText(accessToken, 16_384)) {
      throw new AuthFailure(401, 'session_invalid');
    }
    const key = this.parseIdempotencyKey(idempotencyKey);
    const keyHash = this.hash(key);
    const credentialHash = this.hash(accessToken);
    const now = this.clock.now();
    const replay = this.replayOperation<AccountDeletionResponse>(
      'account.delete',
      keyHash,
      credentialHash,
      now,
    );
    if (replay !== undefined) {
      this.logger.info('auth.account_delete_replayed', { outcome: 'replayed' });
      return replay;
    }
    const authenticated = this.authenticateAccess(accessToken);
    const response: AccountDeletionResponse = { deleted: true };
    const responseJson = JSON.stringify(response);
    this.database.transaction(() => {
      this.database.createOperation({
        operation: 'account.delete',
        keyHash,
        credentialHash,
        nonceDigest: null,
        accountId: authenticated.accountId,
        responseStatus: 200,
        responseCiphertext: this.encryptResponse(response),
        createdAt: asIso(now),
        expiresAt: asIso(addSeconds(now, OPERATION_IDEMPOTENCY_RETENTION_MS / 1_000)),
      });
      this.database.saveDeletionTombstone({
        accountId: authenticated.accountId,
        idempotencyKeyHash: null,
        deletedAt: asIso(now),
        responseStatus: 200,
        responseJson,
      });
      this.database.deleteAccountData(authenticated.accountId);
    });
    this.logger.info('auth.account_deleted', { outcome: 'deleted' });
    return response;
  }

  authenticateAccess(accessToken: unknown): AuthenticatedSession {
    if (!validText(accessToken, 16_384)) {
      throw new AuthFailure(401, 'session_invalid');
    }
    const session = this.database.findSessionByAccessHash(this.hash(accessToken));
    const now = this.clock.now();
    if (
      session === undefined ||
      session.revoked_at !== null ||
      isExpired(session.access_expires_at, now)
    ) {
      throw new AuthFailure(401, 'session_invalid');
    }
    return { accountId: session.account_id, session };
  }

  private createSession(
    accountId: string,
    now: Date,
    familyId: string = randomUUID(),
  ): SessionResponse {
    const session = this.buildSession(accountId, now, familyId);
    this.database.createSession(session.record);
    return session.response;
  }

  private buildSession(
    accountId: string,
    now: Date,
    familyId: string = randomUUID(),
  ): { record: Parameters<AccountDatabase['createSession']>[0]; response: SessionResponse } {
    const sessionId = randomUUID();
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const accessExpiresAt = asIso(addSeconds(now, this.accessLifetimeSeconds));
    const refreshExpiresAt = asIso(addSeconds(now, this.refreshLifetimeSeconds));
    const record = {
      id: sessionId,
      accountId,
      familyId,
      accessTokenHash: this.hash(accessToken),
      accessExpiresAt,
      refreshTokenHash: this.hash(refreshToken),
      refreshExpiresAt,
      createdAt: asIso(now),
    };
    return {
      record,
      response: {
        accountId,
        accessToken,
        refreshToken,
        tokenType: 'Bearer',
        accessTokenExpiresAt: accessExpiresAt,
        refreshTokenExpiresAt: refreshExpiresAt,
      },
    };
  }

  private hash(value: string): string {
    return createHmac('sha256', this.hashSecret).update(value, 'utf8').digest('hex');
  }

  private parsePolicyVersion(value: unknown): string {
    if (value === undefined || value === null) {
      throw new AuthFailure(400, 'consent_policy_version_required');
    }
    if (!validText(value, 128) || !/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw new AuthFailure(400, 'consent_policy_version_invalid');
    }
    return value;
  }

  private parseIdempotencyKey(value: unknown): string {
    if (value === undefined || value === null) {
      throw new AuthFailure(400, 'idempotency_key_required');
    }
    if (!validText(value, 256) || !/^[\x21-\x7E]+$/.test(value)) {
      throw new AuthFailure(400, 'idempotency_key_invalid');
    }
    return value;
  }

  private assertAppleExchangeNotReplayed(
    credentialHash: string,
    nonceDigest: string,
    keyHash: string,
    now: Date,
  ): void {
    const credentialRecord = this.database.findOperationByCredentialHash(
      'auth.apple.exchange',
      credentialHash,
    );
    const nonceRecord = this.database.findOperationByNonceDigest(
      'auth.apple.exchange',
      nonceDigest,
    );
    for (const record of [credentialRecord, nonceRecord]) {
      if (record === undefined) continue;
      if (isExpired(record.expires_at, now)) {
        this.database.deleteOperation(record.operation, record.key_hash);
        continue;
      }
      if (record.key_hash !== keyHash) {
        // This intentionally covers both a captured token replay and a fresh token reusing a
        // consumed nonce. The caller receives only a bounded code, never the digest or token.
        throw new AuthFailure(409, 'nonce_replayed');
      }
    }
    const credentialTombstone =
      this.database.findAppleExchangeReplayTombstoneByCredentialHash(credentialHash);
    const nonceTombstone = this.database.findAppleExchangeReplayTombstoneByNonceDigest(nonceDigest);
    for (const tombstone of [credentialTombstone, nonceTombstone]) {
      if (tombstone === undefined) continue;
      if (isExpired(tombstone.expires_at, now)) {
        this.database.deleteAppleExchangeReplayTombstone(tombstone.nonce_digest);
        continue;
      }
      throw new AuthFailure(409, 'nonce_replayed');
    }
  }

  private replayOperation<T>(
    operation: OperationName,
    keyHash: string,
    credentialHash: string,
    now: Date,
    nonceDigest: string | null = null,
  ): T | undefined {
    const record = this.database.findOperation(operation, keyHash);
    if (record === undefined) {
      return undefined;
    }
    if (record.credential_hash !== credentialHash) {
      throw new AuthFailure(409, 'idempotency_key_conflict');
    }
    if (operation === 'auth.apple.exchange' && record.nonce_digest !== nonceDigest) {
      throw new AuthFailure(409, 'idempotency_key_conflict');
    }
    if (
      record.account_id !== null &&
      this.database.findAccount(record.account_id) === undefined &&
      operation !== 'account.delete'
    ) {
      this.database.deleteOperation(operation, keyHash);
      return undefined;
    }
    if (isExpired(record.expires_at, now)) {
      this.database.deleteOperation(operation, keyHash);
      return undefined;
    }
    try {
      return this.decryptResponse<T>(record.response_ciphertext);
    } catch {
      // Treat a corrupt replay record as a safe server failure, without exposing its contents.
      throw new AuthFailure(500, 'idempotency_record_invalid');
    }
  }

  private encryptResponse(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.operationCipherKey(), iv);
    cipher.setAAD(Buffer.from('alyte-operation-v1', 'utf8'));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
  }

  private decryptResponse<T>(value: string): T {
    const [ivEncoded, tagEncoded, ciphertextEncoded] = value.split('.');
    if (ivEncoded === undefined || tagEncoded === undefined || ciphertextEncoded === undefined) {
      throw new Error('idempotency_ciphertext_invalid');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.operationCipherKey(),
      Buffer.from(ivEncoded, 'base64url'),
    );
    decipher.setAAD(Buffer.from('alyte-operation-v1', 'utf8'));
    decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext) as T;
  }

  private operationCipherKey(): Buffer {
    return createHash('sha256').update(this.hashSecret).digest();
  }
}
