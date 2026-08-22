import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  AccountAuditEvent,
  AccountConsent,
  AccountDeletionResponse,
  AccountExportResponse,
  SessionResponse,
  SignOutResponse,
} from '@alyte/contracts';
import { AppleTokenVerificationError, type AppleIdentityVerifier } from './apple-verifier.js';
import { type AccountDatabase, type SessionRow } from './database.js';

export interface Clock {
  now(): Date;
}

export interface AuthLogger {
  info(event: string, attributes: Readonly<Record<string, string | number | boolean>>): void;
  warn(event: string, attributes: Readonly<Record<string, string | number | boolean>>): void;
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
  readonly hashSecret?: string | Uint8Array | undefined;
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
    const configuredSecret = options.hashSecret ?? process.env.ALYTE_SESSION_HASH_SECRET;
    if (configuredSecret === undefined && process.env.NODE_ENV === 'production') {
      throw new Error('ALYTE_SESSION_HASH_SECRET is required in production');
    }
    this.hashSecret =
      typeof configuredSecret === 'string'
        ? new TextEncoder().encode(configuredSecret)
        : (configuredSecret ?? randomBytes(32));
    if (this.hashSecret.length < 32) {
      throw new Error('session_hash_secret_too_short');
    }
    this.logger = options.logger ?? silentLogger;
  }

  async exchangeApple(
    identityToken: unknown,
    consentPolicyVersion: unknown,
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
    const policyVersion = this.parsePolicyVersion(consentPolicyVersion);
    let identity;
    try {
      identity = await this.appleVerifier.verify(identityToken);
    } catch (error) {
      this.logger.warn('auth.apple_exchange_rejected', {
        outcome:
          error instanceof AppleTokenVerificationError
            ? 'invalid_identity'
            : 'verification_failure',
      });
      throw new AuthFailure(401, 'identity_token_invalid');
    }
    if (!validText(identity.subject, 512)) {
      this.logger.warn('auth.apple_exchange_rejected', { outcome: 'subject_missing' });
      throw new AuthFailure(401, 'identity_token_invalid');
    }

    const now = this.clock.now();
    const { mapped, result } = this.database.transaction(() => {
      const account = this.database.createAccountForAppleSubject(
        identity.subject,
        randomUUID(),
        asIso(now),
      );
      if (policyVersion !== undefined) {
        this.database.recordConsent(account.account.id, policyVersion, asIso(now));
      }
      return { mapped: account, result: this.createSession(account.account.id, now) };
    });
    this.logger.info('auth.apple_exchange_succeeded', {
      outcome: mapped.created ? 'created' : 'existing',
    });
    return result;
  }

  refresh(refreshToken: unknown): SessionResponse {
    if (!validText(refreshToken, 16_384)) {
      throw new AuthFailure(400, 'refresh_token_required');
    }
    const now = this.clock.now();
    const oldSession = this.database.findSessionByRefreshHash(this.hash(refreshToken));
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
    });
    this.logger.info('auth.refresh_succeeded', { outcome: 'rotated' });
    return next.response;
  }

  signOut(accessToken: unknown): SignOutResponse {
    const authenticated = this.authenticateAccess(accessToken);
    this.database.revokeSessionFamily(authenticated.session.family_id, asIso(this.clock.now()));
    this.logger.info('auth.sign_out_succeeded', { outcome: 'revoked_family' });
    return { signedOut: true };
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
      const account = this.database.sqlite
        .prepare('SELECT id, created_at FROM accounts WHERE id = ?')
        .get(authenticated.accountId) as { id: string; created_at: string } | undefined;
      if (account === undefined) {
        throw new AuthFailure(401, 'session_invalid');
      }
      const consents: AccountConsent[] = this.database
        .listConsents(authenticated.accountId)
        .map((consent) => ({
          policyVersion: consent.policy_version,
          acceptedAt: consent.accepted_at,
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
        consents,
        auditEvents,
      } satisfies AccountExportResponse;
    });
    this.logger.info('auth.export_succeeded', { outcome: 'exported' });
    return response;
  }

  deleteAccount(accessToken: unknown, idempotencyKey: unknown): AccountDeletionResponse {
    const key = this.parseIdempotencyKey(idempotencyKey);
    const keyHash = key === undefined ? null : this.hash(key);
    if (keyHash !== null) {
      const tombstone = this.database.findDeletionByKeyHash(keyHash);
      if (tombstone !== undefined) {
        return this.decodeDeletionResponse(tombstone.response_json);
      }
    }
    const authenticated = this.authenticateAccess(accessToken);
    const response: AccountDeletionResponse = { deleted: true };
    const responseJson = JSON.stringify(response);
    const now = asIso(this.clock.now());
    this.database.transaction(() => {
      this.database.saveDeletionTombstone({
        accountId: authenticated.accountId,
        idempotencyKeyHash: keyHash,
        deletedAt: now,
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

  private parsePolicyVersion(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!validText(value, 128) || !/^[A-Za-z0-9._:-]+$/.test(value)) {
      throw new AuthFailure(400, 'consent_policy_version_invalid');
    }
    return value;
  }

  private parseIdempotencyKey(value: unknown): string | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!validText(value, 256) || !/^[\x21-\x7E]+$/.test(value)) {
      throw new AuthFailure(400, 'idempotency_key_invalid');
    }
    return value;
  }

  private decodeDeletionResponse(value: string): AccountDeletionResponse {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'deleted' in parsed &&
        parsed.deleted === true
      ) {
        return { deleted: true };
      }
    } catch {
      // Treat a corrupt tombstone as a safe server failure, without exposing its contents.
    }
    throw new AuthFailure(500, 'deletion_record_invalid');
  }
}
