import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalId } from '@alyte/domain';
import { CURRENT_SCHEMA_VERSION, createLabRepository, type SqliteDatabase } from './persistence';
import { ProtectionError, type DatabaseProtection } from './protection';

class NodeSqliteDatabase implements SqliteDatabase {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.database = new DatabaseSync(databasePath);
  }

  async execAsync(source: string): Promise<void> {
    this.database.exec(source);
  }

  async runAsync(source: string, ...params: any[]) {
    const result = this.database.prepare(source).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  async getAllAsync<T>(source: string, ...params: any[]): Promise<readonly T[]> {
    return this.database.prepare(source).all(...params) as T[];
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.database.exec('BEGIN');
    try {
      await task();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async closeAsync(): Promise<void> {
    this.database.close();
  }
}

const protectedPaths: string[] = [];
const protection: DatabaseProtection = {
  async protectDatabaseFiles(databasePath) {
    protectedPaths.push(databasePath);
    return {
      protectedPaths: [databasePath],
      missingSidecarPaths: [`${databasePath}-wal`, `${databasePath}-shm`],
    };
  },
};

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  protectedPaths.length = 0;
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-labs-'));
  temporaryPaths.push(directory);
  return join(directory, 'alyte.sqlite');
}

function createRepository(databasePath = temporaryDatabase(), databaseProtection = protection) {
  const database = new NodeSqliteDatabase(databasePath);
  const repository = createLabRepository(database, {
    protection: databaseProtection,
    now: () => '2026-08-22T10:00:00.000Z',
    idGenerator: (prefix) => `${prefix}-fixed-${Math.random().toString(36).slice(2)}`,
  });
  return { database, repository, databasePath };
}

describe('protected manual Lab Record persistence', () => {
  test('migration and typed repository preserve every manual value kind', async () => {
    const { repository, database } = createRepository();
    const record = await repository.createRecord({
      id: 'lab-record-1',
      collectionDate: { kind: 'missing' },
      specimenType: 'blood',
      measurements: [
        {
          id: 'measurement-number',
          label: 'LDL-C',
          value: { kind: 'numeric', value: 3.2 },
          unit: 'mmol/L',
        },
        {
          id: 'measurement-bound',
          label: 'Vitamin D',
          value: { kind: 'bounded', comparator: '<', value: 20 },
          valueString: '<20',
          unit: 'ng/mL',
        },
        {
          id: 'measurement-category',
          label: 'Blood group',
          value: { kind: 'categorical', value: 'O+' },
        },
        {
          id: 'measurement-text',
          label: 'Comment',
          value: { kind: 'free_text', value: 'fasting sample' },
        },
      ],
    });

    assert.equal(record.collectionDate.kind, 'missing');
    assert.deepEqual(
      record.measurements.map((measurement) => measurement.current.value.kind),
      ['numeric', 'bounded', 'categorical', 'free_text'],
    );
    assert.equal(record.measurements[1]?.current.valueString, '<20');
    assert.equal(protectedPaths.length > 0, true);

    const migrationRows = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations',
    );
    assert.equal(migrationRows[0]?.version, CURRENT_SCHEMA_VERSION);
    await repository.close();
  });

  test('reopening the same database preserves records offline without an account', async () => {
    const databasePath = temporaryDatabase();
    const first = createRepository(databasePath);
    await first.repository.createRecord({
      id: 'lab-record-restart',
      collectionDate: { kind: 'known', value: '2026-08-20' },
      measurements: [
        {
          id: 'measurement-restart',
          biomarkerId: canonicalId('biomarker.ldl_c'),
          label: 'LDL cholesterol',
          value: { kind: 'numeric', value: 3.1 },
          unit: 'mmol/L',
        },
      ],
    });
    await first.repository.close();

    const second = createRepository(databasePath);
    const reopened = await second.repository.getRecord('lab-record-restart');
    assert.equal(reopened?.measurements[0]?.current.valueString, '3.1');
    assert.equal(reopened?.measurements[0]?.original.label, 'LDL cholesterol');
    await second.repository.close();
  });

  test('correction stores prior user-entered provenance and a readable audit trail', async () => {
    const { repository } = createRepository();
    await repository.createRecord({
      id: 'lab-record-correction',
      collectionDate: { kind: 'known', value: '2026-08-20' },
      measurements: [
        {
          id: 'measurement-correction',
          label: 'LDL-C',
          value: { kind: 'numeric', value: 3.2 },
          unit: 'mmol/L',
          provenance: 'user-entered',
        },
      ],
    });

    const corrected = await repository.correctMeasurement('measurement-correction', {
      value: { kind: 'numeric', value: 3.8 },
      valueString: '3.8',
      reason: 'Transcription correction',
    });
    assert.equal(corrected.provenance, 'user-corrected');
    assert.equal(corrected.original.valueString, '3.2');
    assert.equal(corrected.current.valueString, '3.8');
    assert.equal(corrected.corrections.length, 1);
    assert.equal(corrected.corrections[0]?.previousProvenance, 'user-entered');
    assert.equal(corrected.corrections[0]?.previous.valueString, '3.2');
    assert.equal(corrected.corrections[0]?.reason, 'Transcription correction');
    await repository.close();
  });

  test('record deletion removes measurements and correction rows transactionally', async () => {
    const { repository, database } = createRepository();
    await repository.createRecord({
      id: 'lab-record-delete',
      collectionDate: { kind: 'missing' },
      measurements: [
        {
          id: 'measurement-delete',
          label: 'Result',
          value: { kind: 'numeric', value: 1 },
        },
      ],
    });
    await repository.correctMeasurement('measurement-delete', {
      value: { kind: 'numeric', value: 2 },
    });
    await repository.deleteRecord('lab-record-delete');
    assert.deepEqual(await repository.getRecord('lab-record-delete'), null);
    assert.equal((await database.getAllAsync('SELECT id FROM measurements')).length, 0);
    assert.equal((await database.getAllAsync('SELECT id FROM measurement_corrections')).length, 0);
    await repository.close();
  });

  test('deleting a date-only Lab Record succeeds when it has no Measurements', async () => {
    const { repository } = createRepository();
    await repository.createRecord({
      id: 'lab-record-empty-delete',
      collectionDate: { kind: 'missing' },
      measurements: [],
    });
    await repository.deleteRecord('lab-record-empty-delete');
    assert.equal(await repository.getRecord('lab-record-empty-delete'), null);
    await repository.close();
  });

  test('protection failure blocks initialization before schema or health records are persisted', async () => {
    const { repository, database } = createRepository(undefined, {
      async protectDatabaseFiles() {
        throw new ProtectionError('test protection failure');
      },
    });
    await assert.rejects(repository.initialize(), /test protection failure/);
    assert.deepEqual(
      await database.getAllAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lab_records'",
      ),
      [],
    );
    await repository.close();
  });
});
