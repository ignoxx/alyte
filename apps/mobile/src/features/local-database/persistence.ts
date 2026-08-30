import { createSortableOpaqueId } from '@alyte/domain';
import { LOCAL_MIGRATIONS, CURRENT_SCHEMA_VERSION, type Migration } from './migrations';

export type SqliteRunResult = { readonly changes: number; readonly lastInsertRowId: number };

export interface SqliteDatabase {
  readonly databasePath: string;
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: readonly unknown[]): Promise<SqliteRunResult>;
  getAllAsync<T>(source: string, ...params: readonly unknown[]): Promise<readonly T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

export type LocalDatabaseProtection = {
  protectDatabaseFiles(
    databasePath: string,
    options?: { readonly requireSidecars?: boolean },
  ): Promise<unknown>;
};

export type LocalDatabaseOptions = {
  readonly protection: LocalDatabaseProtection;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
  readonly migrations?: readonly Migration[];
};

export type ProtectedDatabaseBoundary = {
  readonly database: SqliteDatabase;
  readonly initialize: () => Promise<void>;
  readonly close: () => Promise<void>;
  /** Re-apply native protection after operations that rebuild the SQLite file. */
  readonly verifyProtection: (requireSidecars?: boolean) => Promise<void>;
  readonly withWrite: <T>(work: () => Promise<T>) => Promise<T>;
  readonly now: () => string;
  readonly makeId: (prefix: string) => string;
};

function isoNow(): string {
  return new Date().toISOString();
}

function idFor(prefix: string): string {
  return createSortableOpaqueId(prefix);
}

export function createProtectedDatabaseBoundary(
  database: SqliteDatabase,
  options: LocalDatabaseOptions,
): ProtectedDatabaseBoundary {
  const migrations = options.migrations ?? LOCAL_MIGRATIONS;
  const now = options.now ?? isoNow;
  const makeId = options.idGenerator ?? idFor;
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();

  async function ensureProtection(requireSidecars: boolean): Promise<void> {
    await options.protection.protectDatabaseFiles(database.databasePath, { requireSidecars });
  }

  async function initializeOnce(): Promise<void> {
    if (initialized) return;
    await database.execAsync(
      'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;',
    );
    await ensureProtection(false);
    await database.execAsync(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL);',
    );
    await ensureProtection(true);
    const currentRows = await database.getAllAsync<{ version: number }>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations;',
    );
    const current = currentRows[0]?.version ?? 0;
    if (!Number.isInteger(current) || current < 0 || current > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Unsupported local schema version: ${String(current)}`);
    }
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      await database.withTransactionAsync(async () => {
        if ('apply' in migration) {
          await migration.apply(database);
        } else {
          await database.execAsync(migration.sql);
        }
        await database.runAsync(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
          migration.version,
          now(),
        );
        await ensureProtection(true);
      });
    }
    await ensureProtection(true);
    initialized = true;
  }

  async function initialize(): Promise<void> {
    if (initialized) return;
    initializationPromise ??= initializeOnce();
    try {
      await initializationPromise;
    } catch (error) {
      initializationPromise = null;
      throw error;
    }
  }

  async function withWrite<T>(work: () => Promise<T>): Promise<T> {
    const previous = writeQueue;
    let release!: () => void;
    writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let result!: T;
      await database.withTransactionAsync(async () => {
        await ensureProtection(true);
        result = await work();
        await ensureProtection(true);
      });
      return result;
    } finally {
      release();
    }
  }

  return {
    database,
    initialize,
    close: () => database.closeAsync(),
    verifyProtection: (requireSidecars = true) => ensureProtection(requireSidecars),
    withWrite,
    now,
    makeId,
  };
}
