import Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 2;

export const SESSION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const OPERATION_IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

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
  readonly account_id: string | null;
  readonly response_status: number;
  readonly response_ciphertext: string;
  readonly created_at: string;
  readonly expires_at: string;
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
                response_ciphertext, created_at, expires_at
         FROM operation_idempotency WHERE operation = ? AND key_hash = ?`,
      )
      .get(operation, keyHash) as OperationRow | undefined;
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
           response_ciphertext, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

  cleanupExpired(now: Date, limit = 100): { sessions: number; operations: number } {
    const nowIso = now.toISOString();
    const sessionCutoff = new Date(now.getTime() - SESSION_RETENTION_MS).toISOString();
    const cleanup = this.transaction(() => {
      const operations = this.sqlite
        .prepare(
          `DELETE FROM operation_idempotency WHERE rowid IN (
             SELECT rowid FROM operation_idempotency WHERE expires_at <= ? LIMIT ?
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
      return { sessions, operations };
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
    this.sqlite.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  }
}
