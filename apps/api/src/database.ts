import Database from 'better-sqlite3';
import type { CloudRequestOperation, CloudRequestState } from '@alyte/contracts';

export const CURRENT_SCHEMA_VERSION = 9;

export const SESSION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const OPERATION_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;
/** The scheduler runs at most every fifteen minutes; reserve that headroom below the 24-hour cap. */
export const CLOUD_UPLOAD_CLEANUP_INTERVAL_MS = 15 * 60 * 1_000;
export const CLOUD_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1_000 - CLOUD_UPLOAD_CLEANUP_INTERVAL_MS;

export type OperationName =
  'auth.apple.exchange' | 'auth.refresh' | 'auth.sign-out' | 'account.delete';

export interface AccountRow {
  readonly id: string;
  readonly created_at: string;
}

export interface SessionRow {
  readonly id: string;
  readonly account_id: string;
  readonly family_id: string;
  readonly access_token_hash: string;
  readonly access_expires_at: string;
  readonly refresh_token_hash: string;
  readonly refresh_expires_at: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

export interface ConsentRow {
  readonly policy_version: string;
  readonly accepted_at: string;
}

export interface AuditEventRow {
  readonly type: 'account.exported' | 'account.deleted';
  readonly occurred_at: string;
}

export interface DeletionTombstoneRow {
  readonly account_id: string;
  readonly idempotency_key_hash: string | null;
  readonly deleted_at: string;
  readonly response_status: number;
  readonly response_json: string;
}

export interface OperationRow {
  readonly operation: OperationName;
  readonly key_hash: string;
  readonly credential_hash: string;
  readonly nonce_digest: string | null;
  readonly account_id: string | null;
  readonly response_status: number;
  readonly response_ciphertext: string;
  readonly created_at: string;
  readonly expires_at: string;
}

/** Unlinkable Apple exchange replay marker retained after account deletion until expiry. */
export interface AppleExchangeReplayTombstoneRow {
  readonly credential_hash: string;
  readonly nonce_digest: string;
  readonly expires_at: string;
}

export type CommercePlanId = 'starter_pack' | 'cloud_plus' | 'cloud_max';
export type CommerceAllowanceKind = 'snap' | 'report';
export type CommerceEntitlementStatus = 'pending' | 'active' | 'exhausted' | 'expired' | 'revoked';
export type CommerceLedgerEntryType = 'grant' | 'reserve' | 'release' | 'consume';

export interface CommerceEntitlementRow {
  readonly account_id: string;
  readonly plan_id: CommercePlanId;
  readonly product_id: string;
  readonly status: CommerceEntitlementStatus;
  readonly will_renew: number;
  readonly period_start: string | null;
  readonly period_end: string | null;
  readonly management_url: string | null;
  readonly updated_at: string;
}

export interface CommercePurchaseRow {
  readonly account_id: string;
  readonly transaction_id: string;
  readonly product_id: string;
  readonly plan_id: CommercePlanId;
  readonly purchase_type: 'starter' | 'subscription';
  readonly purchased_at: string;
  readonly period_start: string | null;
  readonly period_end: string | null;
  readonly created_at: string;
}

export interface CommercePurchaseClaimRow {
  readonly transaction_id: string;
  readonly product_id: string;
  readonly claimed_account_id: string | null;
  readonly claimed_at: string;
  readonly retired_at: string | null;
}

export interface CommerceWebhookEventRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly received_at: string;
  readonly processed_at: string | null;
  readonly outcome: 'processed' | 'ignored' | 'rejected';
}

export interface AllowanceLedgerRow {
  readonly id: string;
  readonly account_id: string;
  readonly kind: CommerceAllowanceKind;
  readonly entry_type: CommerceLedgerEntryType;
  readonly units: number;
  readonly source_id: string;
  readonly grant_source_id: string | null;
  readonly grant_period_start: string | null;
  readonly period_end: string | null;
  readonly created_at: string;
}

export interface CloudRequestRow {
  readonly id: string;
  readonly account_id: string;
  readonly operation: CloudRequestOperation;
  readonly state: CloudRequestState;
  readonly byte_count: number;
  readonly page_count: number;
  /** Canonical P-256 public JWK. This is operational metadata, never request payload. */
  readonly device_public_key_jwk: string;
  /** HMAC digest of the on-device idempotency capability; raw keys are never persisted. */
  readonly idempotency_key_hash: string;
  /** HMAC digest of the canonical bounded admission input. */
  readonly request_fingerprint: string;
  readonly contract_version: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly upload_expires_at: string;
  readonly uploaded_at: string | null;
  readonly queued_at: string | null;
  readonly expired_at: string | null;
  readonly cancelled_at: string | null;
  /** Joined result-cache state; absent when the request has no result metadata. */
  readonly result_state?: CloudResultState | null;
  readonly result_schema_version?: string | null;
  readonly result_handler_version?: number | null;
  readonly result_byte_count?: number | null;
  readonly result_ready_at?: string | null;
  readonly result_expires_at?: string | null;
  readonly result_retrieved_at?: string | null;
  readonly result_expired_at?: string | null;
  readonly result_failure_category?: CloudResultFailureCategory | null;
}

export type CloudResultState = 'ready' | 'retrieved' | 'failed' | 'expired';
export type CloudResultFailureCategory =
  'cloud_result_cache_missing' | 'cloud_result_cache_invalid' | 'cloud_result_cache_conflict';

/** Allowlisted metadata for one ciphertext-only result cache entry. */
export interface CloudResultCacheRow {
  readonly request_id: string;
  readonly state: CloudResultState;
  readonly result_schema_version: string;
  readonly handler_version: number;
  readonly byte_count: number;
  readonly ready_at: string;
  readonly expires_at: string;
  readonly retrieved_at: string | null;
  readonly expired_at: string | null;
  readonly failure_category: CloudResultFailureCategory | null;
}

/** Operational metadata for one queued analysis handler invocation. No payload is stored here. */
export interface AnalysisJobRow {
  readonly id: string;
  readonly request_id: string;
  readonly state: 'queued' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'cancelled';
  readonly available_at: string;
  readonly attempts: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly handler_version: number;
  readonly request_contract_version: string;
  readonly schema_version: string;
  readonly prompt_version: string | null;
  readonly failure_category: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type AnalysisJobLeaseOutcome =
  'renewed' | 'relinquished' | 'not-found' | 'not-owner' | 'not-live';

export interface AnalysisJobClaimOptions {
  readonly now: string;
  readonly leaseOwner: string;
  readonly leaseExpiresAt: string;
  readonly supportedHandlerVersions?: readonly number[];
}

export interface AnalysisJobHeartbeatOptions {
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface AnalysisJobRelinquishOptions {
  readonly jobId: string;
  readonly leaseOwner: string;
  readonly now: string;
  readonly availableAt: string;
}

export interface SessionExportRow {
  readonly id: string;
  readonly family_id: string;
  readonly access_expires_at: string;
  readonly refresh_expires_at: string;
  readonly revoked_at: string | null;
  readonly created_at: string;
}

export interface OperationExportRow {
  readonly operation: OperationName;
  readonly account_id: string | null;
  readonly response_status: number;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface AccountDatabaseOptions {
  readonly filename: string;
}

const migrations: readonly string[] = [
  `
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE apple_subjects (
      subject TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE consents (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      policy_version TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      PRIMARY KEY (account_id, policy_version)
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      family_id TEXT NOT NULL,
      access_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at TEXT NOT NULL,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      refresh_expires_at TEXT NOT NULL,
      revoked_at TEXT,
      replaced_by TEXT
    );

    CREATE INDEX sessions_family_idx ON sessions(family_id);
    CREATE INDEX sessions_account_idx ON sessions(account_id);

    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('account.exported', 'account.deleted')),
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX audit_events_account_idx ON audit_events(account_id, occurred_at);

    CREATE TABLE deletion_tombstones (
      account_id TEXT PRIMARY KEY NOT NULL,
      idempotency_key_hash TEXT,
      deleted_at TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_json TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

    CREATE TABLE operation_idempotency (
      operation TEXT NOT NULL CHECK (operation IN ('auth.apple.exchange', 'auth.refresh', 'auth.sign-out', 'account.delete')),
      key_hash TEXT NOT NULL,
      credential_hash TEXT NOT NULL,
      account_id TEXT,
      response_status INTEGER NOT NULL,
      response_ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (operation, key_hash)
    );
    CREATE INDEX operation_idempotency_account_idx ON operation_idempotency(account_id, created_at);
  `,
  `
    ALTER TABLE operation_idempotency ADD COLUMN nonce_digest TEXT;

    CREATE INDEX operation_idempotency_credential_idx
      ON operation_idempotency(operation, credential_hash);
    CREATE UNIQUE INDEX operation_idempotency_apple_nonce_idx
      ON operation_idempotency(operation, nonce_digest)
      WHERE operation = 'auth.apple.exchange' AND nonce_digest IS NOT NULL;

    -- v1 Apple exchanges predate nonce binding and must never be replayed by the v2 route.
    DELETE FROM operation_idempotency WHERE operation = 'auth.apple.exchange';
  `,
  `
    CREATE TABLE IF NOT EXISTS apple_exchange_replay_tombstones (
      nonce_digest TEXT PRIMARY KEY NOT NULL,
      credential_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS apple_exchange_replay_tombstones_credential_idx
      ON apple_exchange_replay_tombstones(credential_hash);
  `,
  `
    CREATE TABLE commerce_entitlements (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL CHECK (plan_id IN ('starter_pack', 'cloud_plus', 'cloud_max')),
      product_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'exhausted', 'expired', 'revoked')),
      will_renew INTEGER NOT NULL CHECK (will_renew IN (0, 1)),
      period_start TEXT,
      period_end TEXT,
      management_url TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, plan_id)
    );
    CREATE INDEX commerce_entitlements_active_idx
      ON commerce_entitlements(account_id, status, period_end);

    CREATE TABLE commerce_purchase_claims (
      transaction_id TEXT PRIMARY KEY NOT NULL,
      product_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    );

    CREATE TABLE commerce_purchases (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      transaction_id TEXT NOT NULL UNIQUE,
      product_id TEXT NOT NULL,
      plan_id TEXT NOT NULL CHECK (plan_id IN ('starter_pack', 'cloud_plus', 'cloud_max')),
      purchase_type TEXT NOT NULL CHECK (purchase_type IN ('starter', 'subscription')),
      purchased_at TEXT NOT NULL,
      period_start TEXT,
      period_end TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, transaction_id)
    );
    CREATE INDEX commerce_purchases_account_idx ON commerce_purchases(account_id, purchased_at);

    CREATE TABLE commerce_webhook_events (
      event_id TEXT PRIMARY KEY NOT NULL,
      event_type TEXT NOT NULL,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('processed', 'ignored', 'rejected'))
    );

    CREATE TABLE allowance_ledger (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('snap', 'report')),
      entry_type TEXT NOT NULL CHECK (entry_type IN ('grant', 'reserve', 'release', 'consume')),
      units INTEGER NOT NULL CHECK (units > 0),
      source_id TEXT NOT NULL,
      period_end TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX allowance_ledger_source_idx
      ON allowance_ledger(account_id, kind, entry_type, source_id);
    CREATE INDEX allowance_ledger_account_idx
      ON allowance_ledger(account_id, kind, created_at);
  `,
  `
    ALTER TABLE commerce_purchase_claims ADD COLUMN claimed_account_id TEXT;
    ALTER TABLE commerce_purchase_claims ADD COLUMN retired_at TEXT;
    ALTER TABLE allowance_ledger ADD COLUMN grant_source_id TEXT;
    ALTER TABLE allowance_ledger ADD COLUMN grant_period_start TEXT;
    CREATE INDEX allowance_ledger_grant_source_idx
      ON allowance_ledger(account_id, kind, grant_source_id);
  `,
  `
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
    CREATE UNIQUE INDEX cloud_requests_account_key_idx
      ON cloud_requests(account_id, idempotency_key_hash);
    CREATE INDEX cloud_requests_account_idx
      ON cloud_requests(account_id, created_at, id);
  `,
  `
    -- SQLite cannot alter a CHECK constraint in place. Rebuild the v7 request table while
    -- preserving every admitted request, then add only operational upload/queue metadata.
    -- A very early development database may contain only the released session table; keeping
    -- this compatibility guard makes the forward migration safe for that partial fixture too.
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE cloud_requests_v8 (
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
    INSERT INTO cloud_requests_v8
      (id, account_id, operation, state, byte_count, page_count,
       device_public_key_jwk, idempotency_key_hash, request_fingerprint,
       contract_version, created_at, updated_at, upload_expires_at,
       uploaded_at, queued_at, expired_at, cancelled_at)
    SELECT id, account_id, operation, state, byte_count, page_count,
           device_public_key_jwk, idempotency_key_hash, request_fingerprint,
           contract_version, created_at, updated_at,
           strftime(
             '%Y-%m-%dT%H:%M:%fZ',
             datetime(created_at, '+${CLOUD_UPLOAD_RETENTION_MS / 1_000} seconds')
           ),
           NULL, NULL, NULL, cancelled_at
      FROM cloud_requests;
    DROP TABLE cloud_requests;
    ALTER TABLE cloud_requests_v8 RENAME TO cloud_requests;
    CREATE UNIQUE INDEX cloud_requests_account_key_idx
      ON cloud_requests(account_id, idempotency_key_hash);
    CREATE INDEX cloud_requests_account_idx
      ON cloud_requests(account_id, created_at, id);

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
    CREATE INDEX analysis_jobs_ready_idx ON analysis_jobs(state, available_at, id);
  `,
  `
    -- Result rows contain only bounded cache metadata. Ciphertext lives in the protected
    -- cloud-result store; the request foreign key makes account deletion cascade metadata.
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
  `,
];

export class AccountDatabase {
  readonly sqlite: Database.Database;

  constructor(options: AccountDatabaseOptions) {
    this.sqlite = new Database(options.filename);
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('journal_mode = WAL');
    this.migrate();
  }

  close(): void {
    if (this.sqlite.open) {
      this.sqlite.close();
    }
  }

  migrate(): void {
    this.sqlite.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = this.sqlite
      .prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get() as { version?: number } | undefined;
    const current = applied?.version ?? 0;
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error('database_schema_newer_than_runtime');
    }
    for (let version = current + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
      const migration = migrations[version - 1];
      if (migration === undefined) {
        throw new Error('database_migration_missing');
      }
      const apply = this.sqlite.transaction(() => {
        this.sqlite.exec(migration);
        this.sqlite
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(version, new Date().toISOString());
      });
      apply();
    }
  }

  transaction<T>(callback: () => T): T {
    return this.sqlite.transaction(callback)();
  }

  findAccountByAppleSubject(subject: string): AccountRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT accounts.id, accounts.created_at
         FROM accounts INNER JOIN apple_subjects ON apple_subjects.account_id = accounts.id
         WHERE apple_subjects.subject = ?`,
      )
      .get(subject) as AccountRow | undefined;
  }

  createAccountForAppleSubject(
    subject: string,
    accountId: string,
    createdAt: string,
  ): { account: AccountRow; created: boolean } {
    return this.transaction(() => {
      const existing = this.findAccountByAppleSubject(subject);
      if (existing !== undefined) {
        return { account: existing, created: false };
      }

      this.sqlite
        .prepare('INSERT INTO accounts (id, created_at) VALUES (?, ?)')
        .run(accountId, createdAt);
      this.sqlite
        .prepare(
          'INSERT INTO apple_subjects (subject, account_id) VALUES (?, ?) ON CONFLICT(subject) DO NOTHING',
        )
        .run(subject, accountId);
      const mapped = this.findAccountByAppleSubject(subject);
      if (mapped === undefined) {
        throw new Error('apple_subject_mapping_failed');
      }
      if (mapped.id !== accountId) {
        this.sqlite.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
        return { account: mapped, created: false };
      }
      return { account: mapped, created: true };
    });
  }

  recordConsent(accountId: string, policyVersion: string, acceptedAt: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO consents (account_id, policy_version, accepted_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id, policy_version) DO UPDATE SET accepted_at = excluded.accepted_at`,
      )
      .run(accountId, policyVersion, acceptedAt);
  }

  listConsents(accountId: string): readonly ConsentRow[] {
    return this.sqlite
      .prepare(
        'SELECT policy_version, accepted_at FROM consents WHERE account_id = ? ORDER BY accepted_at ASC, policy_version ASC',
      )
      .all(accountId) as ConsentRow[];
  }

  createSession(session: {
    id: string;
    accountId: string;
    familyId: string;
    accessTokenHash: string;
    accessExpiresAt: string;
    refreshTokenHash: string;
    refreshExpiresAt: string;
    createdAt: string;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO sessions
          (id, account_id, family_id, access_token_hash, access_expires_at,
           refresh_token_hash, refresh_expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.accountId,
        session.familyId,
        session.accessTokenHash,
        session.accessExpiresAt,
        session.refreshTokenHash,
        session.refreshExpiresAt,
        session.createdAt,
      );
  }

  findSessionByAccessHash(hash: string): SessionRow | undefined {
    return this.sqlite.prepare('SELECT * FROM sessions WHERE access_token_hash = ?').get(hash) as
      SessionRow | undefined;
  }

  findSessionByRefreshHash(hash: string): SessionRow | undefined {
    return this.sqlite.prepare('SELECT * FROM sessions WHERE refresh_token_hash = ?').get(hash) as
      SessionRow | undefined;
  }

  revokeSession(sessionId: string, revokedAt: string, replacedBy?: string): void {
    this.sqlite
      .prepare(
        'UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?), replaced_by = COALESCE(?, replaced_by) WHERE id = ?',
      )
      .run(revokedAt, replacedBy ?? null, sessionId);
  }

  revokeSessionFamily(familyId: string, revokedAt: string): void {
    this.sqlite
      .prepare('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?')
      .run(revokedAt, familyId);
  }

  addAuditEvent(event: {
    id: string;
    accountId: string;
    type: AuditEventRow['type'];
    occurredAt: string;
  }): void {
    this.sqlite
      .prepare('INSERT INTO audit_events (id, account_id, type, occurred_at) VALUES (?, ?, ?, ?)')
      .run(event.id, event.accountId, event.type, event.occurredAt);
  }

  listAuditEvents(accountId: string): readonly AuditEventRow[] {
    return this.sqlite
      .prepare(
        'SELECT type, occurred_at FROM audit_events WHERE account_id = ? ORDER BY occurred_at ASC, id ASC',
      )
      .all(accountId) as AuditEventRow[];
  }

  findAccount(accountId: string): AccountRow | undefined {
    return this.sqlite
      .prepare('SELECT id, created_at FROM accounts WHERE id = ?')
      .get(accountId) as AccountRow | undefined;
  }

  findAppleSubject(accountId: string): string | undefined {
    const row = this.sqlite
      .prepare('SELECT subject FROM apple_subjects WHERE account_id = ?')
      .get(accountId) as { subject: string } | undefined;
    return row?.subject;
  }

  listSessions(accountId: string): readonly SessionExportRow[] {
    return this.sqlite
      .prepare(
        `SELECT id, family_id, access_expires_at, refresh_expires_at, revoked_at, created_at
         FROM sessions WHERE account_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(accountId) as SessionExportRow[];
  }

  findOperation(operation: OperationName, keyHash: string): OperationRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT operation, key_hash, credential_hash, account_id, response_status,
                response_ciphertext, created_at, expires_at, nonce_digest
         FROM operation_idempotency WHERE operation = ? AND key_hash = ?`,
      )
      .get(operation, keyHash) as OperationRow | undefined;
  }

  findOperationByCredentialHash(
    operation: OperationName,
    credentialHash: string,
  ): OperationRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT operation, key_hash, credential_hash, account_id, response_status,
                response_ciphertext, created_at, expires_at, nonce_digest
         FROM operation_idempotency
         WHERE operation = ? AND credential_hash = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(operation, credentialHash) as OperationRow | undefined;
  }

  findOperationByNonceDigest(
    operation: OperationName,
    nonceDigest: string,
  ): OperationRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT operation, key_hash, credential_hash, account_id, response_status,
                response_ciphertext, created_at, expires_at, nonce_digest
         FROM operation_idempotency
         WHERE operation = ? AND nonce_digest = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(operation, nonceDigest) as OperationRow | undefined;
  }

  findAppleExchangeReplayTombstoneByCredentialHash(
    credentialHash: string,
  ): AppleExchangeReplayTombstoneRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT credential_hash, nonce_digest, expires_at
         FROM apple_exchange_replay_tombstones WHERE credential_hash = ?`,
      )
      .get(credentialHash) as AppleExchangeReplayTombstoneRow | undefined;
  }

  findAppleExchangeReplayTombstoneByNonceDigest(
    nonceDigest: string,
  ): AppleExchangeReplayTombstoneRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT credential_hash, nonce_digest, expires_at
         FROM apple_exchange_replay_tombstones WHERE nonce_digest = ?`,
      )
      .get(nonceDigest) as AppleExchangeReplayTombstoneRow | undefined;
  }

  deleteAppleExchangeReplayTombstone(nonceDigest: string): void {
    this.sqlite
      .prepare('DELETE FROM apple_exchange_replay_tombstones WHERE nonce_digest = ?')
      .run(nonceDigest);
  }

  deleteOperation(operation: OperationName, keyHash: string): void {
    this.sqlite
      .prepare('DELETE FROM operation_idempotency WHERE operation = ? AND key_hash = ?')
      .run(operation, keyHash);
  }

  createOperation(operation: {
    operation: OperationName;
    keyHash: string;
    credentialHash: string;
    nonceDigest?: string | null;
    accountId: string | null;
    responseStatus: number;
    responseCiphertext: string;
    createdAt: string;
    expiresAt: string;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO operation_idempotency
          (operation, key_hash, credential_hash, account_id, response_status,
           response_ciphertext, created_at, expires_at, nonce_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.operation,
        operation.keyHash,
        operation.credentialHash,
        operation.accountId,
        operation.responseStatus,
        operation.responseCiphertext,
        operation.createdAt,
        operation.expiresAt,
        operation.nonceDigest ?? null,
      );
  }

  listOperations(accountId: string): readonly OperationExportRow[] {
    return this.sqlite
      .prepare(
        `SELECT operation, account_id, response_status, created_at, expires_at
         FROM operation_idempotency WHERE account_id = ? ORDER BY created_at ASC, operation ASC`,
      )
      .all(accountId) as OperationExportRow[];
  }

  preserveAppleExchangeReplayMarkers(accountId: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO apple_exchange_replay_tombstones (nonce_digest, credential_hash, expires_at)
         SELECT nonce_digest, credential_hash, expires_at
         FROM operation_idempotency
         WHERE operation = 'auth.apple.exchange' AND account_id = ? AND nonce_digest IS NOT NULL
         ON CONFLICT(nonce_digest) DO NOTHING`,
      )
      .run(accountId);
  }

  cleanupExpired(now: Date, limit = 100): { sessions: number; operations: number } {
    const nowIso = now.toISOString();
    const sessionCutoff = new Date(now.getTime() - SESSION_RETENTION_MS).toISOString();
    const cleanup = this.transaction(() => {
      const operationCount = this.sqlite
        .prepare(
          `DELETE FROM operation_idempotency WHERE rowid IN (
             SELECT rowid FROM operation_idempotency WHERE expires_at <= ? LIMIT ?
           )`,
        )
        .run(nowIso, limit).changes;
      const tombstones = this.sqlite
        .prepare(
          `DELETE FROM apple_exchange_replay_tombstones WHERE rowid IN (
             SELECT rowid FROM apple_exchange_replay_tombstones WHERE expires_at <= ? LIMIT ?
           )`,
        )
        .run(nowIso, limit).changes;
      const sessions = this.sqlite
        .prepare(
          `DELETE FROM sessions WHERE rowid IN (
             SELECT rowid FROM sessions
             WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
                OR (access_expires_at <= ? AND refresh_expires_at <= ?)
             LIMIT ?
           )`,
        )
        .run(sessionCutoff, nowIso, nowIso, limit).changes;
      return { sessions, operations: operationCount + tombstones };
    });
    return cleanup;
  }

  saveDeletionTombstone(tombstone: {
    accountId: string;
    idempotencyKeyHash: string | null;
    deletedAt: string;
    responseStatus: number;
    responseJson: string;
  }): void {
    this.sqlite
      .prepare(
        `INSERT INTO deletion_tombstones
          (account_id, idempotency_key_hash, deleted_at, response_status, response_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        tombstone.accountId,
        tombstone.idempotencyKeyHash,
        tombstone.deletedAt,
        tombstone.responseStatus,
        tombstone.responseJson,
      );
  }

  findDeletionByKeyHash(keyHash: string): DeletionTombstoneRow | undefined {
    return this.sqlite
      .prepare(
        'SELECT account_id, idempotency_key_hash, deleted_at, response_status, response_json FROM deletion_tombstones WHERE idempotency_key_hash = ?',
      )
      .get(keyHash) as DeletionTombstoneRow | undefined;
  }

  deleteAccountData(accountId: string): void {
    // Account-linked operation responses are removed, but retain unlinkable Apple replay markers
    // until their normal expiry so a captured token cannot recreate a deleted account.
    this.preserveAppleExchangeReplayMarkers(accountId);
    this.retireCommercePurchaseClaims(accountId, new Date().toISOString());
    this.sqlite
      .prepare(
        "DELETE FROM operation_idempotency WHERE account_id = ? AND operation <> 'account.delete'",
      )
      .run(accountId);
    this.sqlite.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  }

  listCommerceEntitlements(accountId: string): readonly CommerceEntitlementRow[] {
    return this.sqlite
      .prepare(
        `SELECT account_id, plan_id, product_id, status, will_renew, period_start, period_end,
                management_url, updated_at
         FROM commerce_entitlements WHERE account_id = ? ORDER BY plan_id ASC`,
      )
      .all(accountId) as CommerceEntitlementRow[];
  }

  upsertCommerceEntitlement(entitlement: CommerceEntitlementRow): void {
    this.sqlite
      .prepare(
        `INSERT INTO commerce_entitlements
          (account_id, plan_id, product_id, status, will_renew, period_start, period_end,
           management_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, plan_id) DO UPDATE SET
           product_id = excluded.product_id,
           status = excluded.status,
           will_renew = excluded.will_renew,
           period_start = excluded.period_start,
           period_end = excluded.period_end,
           management_url = excluded.management_url,
           updated_at = excluded.updated_at`,
      )
      .run(
        entitlement.account_id,
        entitlement.plan_id,
        entitlement.product_id,
        entitlement.status,
        entitlement.will_renew,
        entitlement.period_start,
        entitlement.period_end,
        entitlement.management_url,
        entitlement.updated_at,
      );
  }

  expireCommerceSubscriptions(
    accountId: string,
    keepProductIds: readonly string[],
    now: string,
  ): void {
    const keep =
      keepProductIds.length > 0
        ? ` AND product_id NOT IN (${keepProductIds.map(() => '?').join(', ')})`
        : '';
    this.sqlite
      .prepare(
        `UPDATE commerce_entitlements
         SET status = 'expired', will_renew = 0, updated_at = ?
         WHERE account_id = ? AND plan_id <> 'starter_pack' AND status IN ('active', 'pending')${keep}`,
      )
      .run(now, accountId, ...keepProductIds);
  }

  recordCommercePurchase(purchase: CommercePurchaseRow): void {
    this.sqlite
      .prepare(
        `INSERT INTO commerce_purchases
          (account_id, transaction_id, product_id, plan_id, purchase_type, purchased_at,
           period_start, period_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(transaction_id) DO NOTHING`,
      )
      .run(
        purchase.account_id,
        purchase.transaction_id,
        purchase.product_id,
        purchase.plan_id,
        purchase.purchase_type,
        purchase.purchased_at,
        purchase.period_start,
        purchase.period_end,
        purchase.created_at,
      );
  }

  listCommercePurchases(accountId: string): readonly CommercePurchaseRow[] {
    return this.sqlite
      .prepare(
        'SELECT * FROM commerce_purchases WHERE account_id = ? ORDER BY purchased_at ASC, transaction_id ASC',
      )
      .all(accountId) as CommercePurchaseRow[];
  }

  claimCommercePurchase(
    accountId: string,
    transactionId: string,
    productId: string,
    claimedAt: string,
  ): boolean {
    const existing = this.sqlite
      .prepare('SELECT * FROM commerce_purchase_claims WHERE transaction_id = ?')
      .get(transactionId) as CommercePurchaseClaimRow | undefined;
    if (existing === undefined) {
      return (
        this.sqlite
          .prepare(
            `INSERT INTO commerce_purchase_claims
              (transaction_id, product_id, claimed_account_id, claimed_at, retired_at)
             VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(transactionId, productId, accountId, claimedAt).changes > 0
      );
    }
    if (existing.claimed_account_id === accountId) return false;
    if (
      existing.claimed_account_id !== null &&
      this.sqlite.prepare('SELECT 1 FROM accounts WHERE id = ?').get(existing.claimed_account_id)
    ) {
      return false;
    }
    return (
      this.sqlite
        .prepare(
          `UPDATE commerce_purchase_claims
           SET product_id = ?, claimed_account_id = ?, claimed_at = ?, retired_at = NULL
           WHERE transaction_id = ?`,
        )
        .run(productId, accountId, claimedAt, transactionId).changes > 0
    );
  }

  retireCommercePurchaseClaims(accountId: string, retiredAt: string): void {
    this.sqlite
      .prepare(
        `UPDATE commerce_purchase_claims
         SET claimed_account_id = NULL, retired_at = ?
         WHERE claimed_account_id = ?`,
      )
      .run(retiredAt, accountId);
  }

  findCommerceWebhookEvent(eventId: string): CommerceWebhookEventRow | undefined {
    return this.sqlite
      .prepare('SELECT * FROM commerce_webhook_events WHERE event_id = ?')
      .get(eventId) as CommerceWebhookEventRow | undefined;
  }

  recordCommerceWebhookEvent(event: CommerceWebhookEventRow): void {
    this.sqlite
      .prepare(
        `INSERT INTO commerce_webhook_events
          (event_id, event_type, received_at, processed_at, outcome)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .run(event.event_id, event.event_type, event.received_at, event.processed_at, event.outcome);
  }

  updateCommerceWebhookEvent(
    eventId: string,
    processedAt: string,
    outcome: CommerceWebhookEventRow['outcome'],
  ): void {
    this.sqlite
      .prepare(
        'UPDATE commerce_webhook_events SET processed_at = ?, outcome = ? WHERE event_id = ?',
      )
      .run(processedAt, outcome, eventId);
  }

  listAllowanceLedger(
    accountId: string,
    kind?: CommerceAllowanceKind,
  ): readonly AllowanceLedgerRow[] {
    if (kind === undefined) {
      return this.sqlite
        .prepare(
          'SELECT * FROM allowance_ledger WHERE account_id = ? ORDER BY created_at ASC, id ASC',
        )
        .all(accountId) as AllowanceLedgerRow[];
    }
    return this.sqlite
      .prepare(
        'SELECT * FROM allowance_ledger WHERE account_id = ? AND kind = ? ORDER BY created_at ASC, id ASC',
      )
      .all(accountId, kind) as AllowanceLedgerRow[];
  }

  findAllowanceLedgerEntry(
    accountId: string,
    kind: CommerceAllowanceKind,
    entryType: CommerceLedgerEntryType,
    sourceId: string,
  ): AllowanceLedgerRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT * FROM allowance_ledger
         WHERE account_id = ? AND kind = ? AND entry_type = ? AND source_id = ?`,
      )
      .get(accountId, kind, entryType, sourceId) as AllowanceLedgerRow | undefined;
  }

  findAllowanceReservation(requestId: string): AllowanceLedgerRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT * FROM allowance_ledger
         WHERE entry_type = 'reserve' AND source_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(requestId) as AllowanceLedgerRow | undefined;
  }

  addAllowanceLedgerEntry(entry: AllowanceLedgerRow): boolean {
    return (
      this.sqlite
        .prepare(
          `INSERT INTO allowance_ledger
            (id, account_id, kind, entry_type, units, source_id, grant_source_id, grant_period_start, period_end, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, kind, entry_type, source_id)
           DO NOTHING`,
        )
        .run(
          entry.id,
          entry.account_id,
          entry.kind,
          entry.entry_type,
          entry.units,
          entry.source_id,
          entry.grant_source_id,
          entry.grant_period_start,
          entry.period_end,
          entry.created_at,
        ).changes > 0
    );
  }

  findCloudRequest(accountId: string, requestId: string): CloudRequestRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT cloud_requests.id, cloud_requests.account_id, cloud_requests.operation,
                cloud_requests.state, cloud_requests.byte_count, cloud_requests.page_count,
                cloud_requests.device_public_key_jwk, cloud_requests.idempotency_key_hash,
                cloud_requests.request_fingerprint, cloud_requests.contract_version,
                cloud_requests.created_at, cloud_requests.updated_at, cloud_requests.upload_expires_at,
                cloud_requests.uploaded_at, cloud_requests.queued_at, cloud_requests.expired_at,
                cloud_requests.cancelled_at,
                cloud_result_cache.state AS result_state,
                cloud_result_cache.result_schema_version,
                cloud_result_cache.handler_version AS result_handler_version,
                cloud_result_cache.byte_count AS result_byte_count,
                cloud_result_cache.ready_at AS result_ready_at,
                cloud_result_cache.expires_at AS result_expires_at,
                cloud_result_cache.retrieved_at AS result_retrieved_at,
                cloud_result_cache.expired_at AS result_expired_at,
                cloud_result_cache.failure_category AS result_failure_category
         FROM cloud_requests
         LEFT JOIN cloud_result_cache ON cloud_result_cache.request_id = cloud_requests.id
         WHERE cloud_requests.account_id = ? AND cloud_requests.id = ?`,
      )
      .get(accountId, requestId) as CloudRequestRow | undefined;
  }

  findCloudRequestById(requestId: string): CloudRequestRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT id, account_id, operation, state, byte_count, page_count,
                device_public_key_jwk, idempotency_key_hash, request_fingerprint,
                contract_version, created_at, updated_at, upload_expires_at,
                uploaded_at, queued_at, expired_at, cancelled_at
         FROM cloud_requests WHERE id = ?`,
      )
      .get(requestId) as CloudRequestRow | undefined;
  }

  findCloudRequestByIdempotencyHash(
    accountId: string,
    idempotencyKeyHash: string,
  ): CloudRequestRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT cloud_requests.id, cloud_requests.account_id, cloud_requests.operation,
                cloud_requests.state, cloud_requests.byte_count, cloud_requests.page_count,
                cloud_requests.device_public_key_jwk, cloud_requests.idempotency_key_hash,
                cloud_requests.request_fingerprint, cloud_requests.contract_version,
                cloud_requests.created_at, cloud_requests.updated_at, cloud_requests.upload_expires_at,
                cloud_requests.uploaded_at, cloud_requests.queued_at, cloud_requests.expired_at,
                cloud_requests.cancelled_at,
                cloud_result_cache.state AS result_state,
                cloud_result_cache.result_schema_version,
                cloud_result_cache.handler_version AS result_handler_version,
                cloud_result_cache.byte_count AS result_byte_count,
                cloud_result_cache.ready_at AS result_ready_at,
                cloud_result_cache.expires_at AS result_expires_at,
                cloud_result_cache.retrieved_at AS result_retrieved_at,
                cloud_result_cache.expired_at AS result_expired_at,
                cloud_result_cache.failure_category AS result_failure_category
         FROM cloud_requests
         LEFT JOIN cloud_result_cache ON cloud_result_cache.request_id = cloud_requests.id
         WHERE cloud_requests.account_id = ? AND cloud_requests.idempotency_key_hash = ?`,
      )
      .get(accountId, idempotencyKeyHash) as CloudRequestRow | undefined;
  }

  createCloudRequest(request: CloudRequestRow): void {
    this.sqlite
      .prepare(
        `INSERT INTO cloud_requests
          (id, account_id, operation, state, byte_count, page_count,
           device_public_key_jwk, idempotency_key_hash, request_fingerprint,
           contract_version, created_at, updated_at, upload_expires_at,
           uploaded_at, queued_at, expired_at, cancelled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.account_id,
        request.operation,
        request.state,
        request.byte_count,
        request.page_count,
        request.device_public_key_jwk,
        request.idempotency_key_hash,
        request.request_fingerprint,
        request.contract_version,
        request.created_at,
        request.updated_at,
        request.upload_expires_at,
        request.uploaded_at,
        request.queued_at,
        request.expired_at,
        request.cancelled_at,
      );
  }

  markCloudRequestUploaded(accountId: string, requestId: string, uploadedAt: string): void {
    this.sqlite
      .prepare(
        `UPDATE cloud_requests
         SET state = 'uploaded', uploaded_at = COALESCE(uploaded_at, ?), updated_at = ?
         WHERE account_id = ? AND id = ? AND state = 'awaiting-upload'`,
      )
      .run(uploadedAt, uploadedAt, accountId, requestId);
  }

  cancelCloudRequest(accountId: string, requestId: string, cancelledAt: string): void {
    this.sqlite
      .prepare(
        `UPDATE cloud_requests
         SET state = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?), updated_at = ?
         WHERE account_id = ? AND id = ? AND state IN ('awaiting-upload', 'uploaded')`,
      )
      .run(cancelledAt, cancelledAt, accountId, requestId);
  }

  markCloudRequestExpired(requestId: string, expiredAt: string): void {
    this.sqlite
      .prepare(
        `UPDATE cloud_requests
         SET state = 'expired', expired_at = COALESCE(expired_at, ?), updated_at = ?
         WHERE id = ? AND state IN ('awaiting-upload', 'uploaded')`,
      )
      .run(expiredAt, expiredAt, requestId);
  }

  queueCloudRequest(requestId: string, queuedAt: string, job: AnalysisJobRow): void {
    this.sqlite
      .prepare(
        `UPDATE cloud_requests
         SET state = 'queued',
             queued_at = COALESCE(queued_at, ?), updated_at = ?
         WHERE id = ? AND state = 'uploaded'`,
      )
      .run(queuedAt, queuedAt, requestId);
    this.sqlite
      .prepare(
        `INSERT INTO analysis_jobs
          (id, request_id, state, available_at, attempts, lease_owner, lease_expires_at,
           handler_version, request_contract_version, schema_version, prompt_version,
           failure_category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO NOTHING`,
      )
      .run(
        job.id,
        job.request_id,
        job.state,
        job.available_at,
        job.attempts,
        job.lease_owner,
        job.lease_expires_at,
        job.handler_version,
        job.request_contract_version,
        job.schema_version,
        job.prompt_version,
        job.failure_category,
        job.created_at,
        job.updated_at,
      );
  }

  findCloudResultCache(requestId: string): CloudResultCacheRow | undefined {
    return this.sqlite
      .prepare('SELECT * FROM cloud_result_cache WHERE request_id = ?')
      .get(requestId) as CloudResultCacheRow | undefined;
  }

  listCloudResultCache(): readonly CloudResultCacheRow[] {
    return this.sqlite
      .prepare('SELECT * FROM cloud_result_cache ORDER BY ready_at ASC, request_id ASC')
      .all() as CloudResultCacheRow[];
  }

  createCloudResultCache(result: CloudResultCacheRow): void {
    this.sqlite
      .prepare(
        `INSERT INTO cloud_result_cache
          (request_id, state, result_schema_version, handler_version, byte_count,
           ready_at, expires_at, retrieved_at, expired_at, failure_category)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        result.request_id,
        result.state,
        result.result_schema_version,
        result.handler_version,
        result.byte_count,
        result.ready_at,
        result.expires_at,
        result.retrieved_at,
        result.expired_at,
        result.failure_category,
      );
  }

  markCloudResultRetrieved(requestId: string, retrievedAt: string): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE cloud_result_cache
           SET state = 'retrieved', retrieved_at = COALESCE(retrieved_at, ?), failure_category = NULL
           WHERE request_id = ? AND state = 'ready'`,
        )
        .run(retrievedAt, requestId).changes === 1
    );
  }

  markCloudResultExpired(requestId: string, expiredAt: string): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE cloud_result_cache
           SET state = 'expired', expired_at = COALESCE(expired_at, ?), failure_category = NULL
           WHERE request_id = ? AND state = 'ready'`,
        )
        .run(expiredAt, requestId).changes === 1
    );
  }

  markCloudResultFailed(requestId: string, failureCategory: CloudResultFailureCategory): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE cloud_result_cache
           SET state = 'failed', failure_category = ?
           WHERE request_id = ? AND state = 'ready'`,
        )
        .run(failureCategory, requestId).changes === 1
    );
  }

  findAnalysisJobByRequest(requestId: string): AnalysisJobRow | undefined {
    return this.sqlite
      .prepare('SELECT * FROM analysis_jobs WHERE request_id = ?')
      .get(requestId) as AnalysisJobRow | undefined;
  }

  /**
   * Atomically claim one ready v1 job. The candidate read and guarded update share one short
   * SQLite transaction so a second process cannot receive the same live lease.
   */
  claimAnalysisJob(options: AnalysisJobClaimOptions): AnalysisJobRow | undefined {
    const supported = options.supportedHandlerVersions ?? [1];
    if (supported.length === 0) return undefined;
    const placeholders = supported.map(() => '?').join(', ');
    const claim = this.sqlite.transaction(() => {
      const candidate = this.sqlite
        .prepare(
          `SELECT * FROM analysis_jobs
           WHERE handler_version IN (${placeholders})
             AND (
               (state = 'queued' AND available_at <= ?)
               OR (state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
           ORDER BY available_at ASC, id ASC
           LIMIT 1`,
        )
        .get(...supported, options.now, options.now) as AnalysisJobRow | undefined;
      if (candidate === undefined) return undefined;

      const updated = this.sqlite
        .prepare(
          `UPDATE analysis_jobs
           SET state = 'processing',
               attempts = attempts + 1,
               lease_owner = ?,
               lease_expires_at = ?,
               updated_at = ?
           WHERE id = ?
             AND handler_version IN (${placeholders})
             AND (
               (state = 'queued' AND available_at <= ?)
               OR (state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )`,
        )
        .run(
          options.leaseOwner,
          options.leaseExpiresAt,
          options.now,
          candidate.id,
          ...supported,
          options.now,
          options.now,
        );
      if (updated.changes !== 1) return undefined;
      return this.sqlite
        .prepare('SELECT * FROM analysis_jobs WHERE id = ?')
        .get(candidate.id) as AnalysisJobRow;
    });
    // Acquire the SQLite write lock before reading the candidate. Two runner processes then
    // serialize at the transaction boundary instead of both reading and racing to upgrade a
    // deferred transaction after the read.
    return claim.immediate();
  }

  /**
   * List only unsupported versions that are ready to run. Returning versions rather than rows
   * keeps observability useful without exposing request/job identifiers.
   */
  listUnsupportedReadyAnalysisHandlerVersions(
    now: string,
    supportedHandlerVersions: readonly number[] = [1],
  ): readonly number[] {
    if (supportedHandlerVersions.length === 0) {
      return this.sqlite
        .prepare(
          `SELECT DISTINCT handler_version FROM analysis_jobs
           WHERE (state = 'queued' AND available_at <= ?)
              OR (state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           ORDER BY handler_version ASC`,
        )
        .all(now, now)
        .map((row) => (row as { handler_version: number }).handler_version);
    }
    const placeholders = supportedHandlerVersions.map(() => '?').join(', ');
    return this.sqlite
      .prepare(
        `SELECT DISTINCT handler_version FROM analysis_jobs
         WHERE handler_version NOT IN (${placeholders})
           AND (
             (state = 'queued' AND available_at <= ?)
             OR (state = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           )
         ORDER BY handler_version ASC`,
      )
      .all(...supportedHandlerVersions, now, now)
      .map((row) => (row as { handler_version: number }).handler_version);
  }

  heartbeatAnalysisJob(options: AnalysisJobHeartbeatOptions): AnalysisJobLeaseOutcome {
    const row = this.sqlite
      .prepare('SELECT state, lease_owner, lease_expires_at FROM analysis_jobs WHERE id = ?')
      .get(options.jobId) as
      | {
          state: AnalysisJobRow['state'];
          lease_owner: string | null;
          lease_expires_at: string | null;
        }
      | undefined;
    if (row === undefined) return 'not-found';
    if (row.lease_owner !== options.leaseOwner) return 'not-owner';
    if (
      row.state !== 'processing' ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= options.now
    ) {
      return 'not-live';
    }
    const result = this.sqlite
      .prepare(
        `UPDATE analysis_jobs
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND state = 'processing' AND lease_owner = ?
           AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
      )
      .run(options.leaseExpiresAt, options.now, options.jobId, options.leaseOwner, options.now);
    return result.changes === 1 ? 'renewed' : 'not-live';
  }

  relinquishAnalysisJob(options: AnalysisJobRelinquishOptions): AnalysisJobLeaseOutcome {
    const row = this.sqlite
      .prepare('SELECT state, lease_owner, lease_expires_at FROM analysis_jobs WHERE id = ?')
      .get(options.jobId) as
      | {
          state: AnalysisJobRow['state'];
          lease_owner: string | null;
          lease_expires_at: string | null;
        }
      | undefined;
    if (row === undefined) return 'not-found';
    if (row.lease_owner !== options.leaseOwner) return 'not-owner';
    if (
      row.state !== 'processing' ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= options.now
    ) {
      return 'not-live';
    }
    const result = this.sqlite
      .prepare(
        `UPDATE analysis_jobs
         SET state = 'queued', available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND state = 'processing' AND lease_owner = ?
           AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`,
      )
      .run(options.availableAt, options.now, options.jobId, options.leaseOwner, options.now);
    return result.changes === 1 ? 'relinquished' : 'not-live';
  }

  listProcessingAnalysisJobsByOwner(leaseOwner: string): readonly AnalysisJobRow[] {
    return this.sqlite
      .prepare(
        `SELECT * FROM analysis_jobs
         WHERE state = 'processing' AND lease_owner = ?
         ORDER BY available_at ASC, id ASC`,
      )
      .all(leaseOwner) as AnalysisJobRow[];
  }

  listCloudRequests(): readonly CloudRequestRow[] {
    return this.sqlite
      .prepare(
        `SELECT id, account_id, operation, state, byte_count, page_count,
                device_public_key_jwk, idempotency_key_hash, request_fingerprint,
                contract_version, created_at, updated_at, upload_expires_at,
                uploaded_at, queued_at, expired_at, cancelled_at
         FROM cloud_requests ORDER BY created_at ASC, id ASC`,
      )
      .all() as CloudRequestRow[];
  }
}
