import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalId, groupObservationsIntoRows, type ExtractionAliasEntry } from '@alyte/domain';
import { CURRENT_SCHEMA_VERSION, createLabRepository, type SqliteDatabase } from './persistence';
import { ProtectionError, type DatabaseProtection, type ProtectionOptions } from './protection';

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
  async protectDatabaseFiles(databasePath, options: ProtectionOptions = {}) {
    protectedPaths.push(databasePath);
    return {
      protectedPaths:
        options.requireSidecars === true
          ? [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
          : [databasePath],
      missingSidecarPaths:
        options.requireSidecars === true ? [] : [`${databasePath}-wal`, `${databasePath}-shm`],
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
  test('Extraction Draft preserves source locations and confirms atomically/idempotently', async () => {
    const { repository, database } = createRepository();
    await repository.createReport({
      id: 'report-extraction',
      sourceType: 'image',
      originalFilename: 'synthetic-en.png',
      mimeType: 'image/png',
      importState: 'imported',
      originalPath: 'protected://original/synthetic-en.png',
      sourceHash: 'synthetic-hash',
      pageCount: 1,
    });
    const aliases: readonly ExtractionAliasEntry[] = [
      {
        id: 'biomarker.ldl_c',
        aliases: ['LDL-C'],
        specimens: ['blood', 'unknown'],
        units: ['mmol/L'],
      },
    ];
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'source-row-1',
          text: 'LDL-C 3,8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'missing' }, specimenType: 'blood' },
    );
    const draft = await repository.createExtractionDraft({
      id: 'draft-extraction',
      reportId: 'report-extraction',
      collectionDate: { kind: 'missing' },
      rows,
    });
    assert.equal(draft.rows[0]?.source.pageIndex, 0);
    const records = await repository.confirmExtractionDraft(draft.id);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.collectionDate.kind, 'missing');
    assert.equal(records[0]?.measurements[0]?.source?.boundingBox.x, 0.1);
    assert.equal(records[0]?.measurements[0]?.original.valueString, '3,8');
    assert.equal(records[0]?.measurements[0]?.current.valueString, '3.8');
    const repeated = await repository.confirmExtractionDraft(draft.id);
    assert.deepEqual(
      repeated.map((record) => record.id),
      records.map((record) => record.id),
    );
    assert.equal(
      (
        await database.getAllAsync(
          'SELECT id FROM lab_records WHERE lab_report_id = ?',
          'report-extraction',
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await database.getAllAsync(
          'SELECT id FROM measurements WHERE lab_record_id = ?',
          records[0]?.id,
        )
      ).length,
      1,
    );
    const preservedDraft = await repository.getExtractionDraft(draft.id);
    assert.equal(preservedDraft?.rows[0]?.sourceText, 'LDL-C 3,8 mmol/L');
    await repository.close();
  });

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
          valueString: '>999',
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
    const databasePath = temporaryDatabase();
    const { repository } = createRepository(databasePath);
    await repository.createRecord({
      id: 'lab-record-correction',
      collectionDate: { kind: 'known', value: '2026-08-20' },
      measurements: [
        {
          id: 'measurement-correction',
          biomarkerId: canonicalId('biomarker.ldl_c'),
          label: 'LDL-C',
          value: { kind: 'numeric', value: 3.2 },
          unit: 'mmol/L',
          referenceInterval: '<3.0',
          provenance: 'user-entered',
        },
      ],
    });

    const corrected = await repository.correctMeasurement('measurement-correction', {
      biomarkerId: canonicalId('biomarker.total_cholesterol'),
      label: 'Total cholesterol',
      value: { kind: 'numeric', value: 3.8 },
      unit: 'mg/dL',
      referenceInterval: '100-200',
      flag: 'H',
      specimenType: 'serum',
      reviewState: 'needs-review',
      reason: 'Transcription correction',
    });
    assert.equal(corrected.provenance, 'user-corrected');
    assert.equal(corrected.original.valueString, '3.2');
    assert.equal(corrected.original.unit, 'mmol/L');
    assert.equal(corrected.biomarkerId, canonicalId('biomarker.total_cholesterol'));
    assert.equal(corrected.current.label, 'Total cholesterol');
    assert.equal(corrected.current.valueString, '3.8');
    assert.equal(corrected.current.unit, 'mg/dL');
    assert.equal(corrected.current.referenceInterval, '100-200');
    assert.equal(corrected.current.flag, 'H');
    assert.equal(corrected.specimenType, 'serum');
    assert.equal(corrected.reviewState, 'needs-review');
    assert.equal(corrected.corrections.length, 1);
    assert.equal(corrected.corrections[0]?.previousProvenance, 'user-entered');
    assert.equal(corrected.corrections[0]?.previous.snapshot.valueString, '3.2');
    assert.equal(corrected.corrections[0]?.next.snapshot.valueString, '3.8');
    assert.equal(corrected.corrections[0]?.previous.reviewState, 'confirmed');
    assert.equal(corrected.corrections[0]?.next.reviewState, 'needs-review');
    assert.equal(corrected.corrections[0]?.previous.biomarkerId, canonicalId('biomarker.ldl_c'));
    assert.equal(
      corrected.corrections[0]?.next.biomarkerId,
      canonicalId('biomarker.total_cholesterol'),
    );
    assert.equal(corrected.corrections[0]?.next.specimenType, 'serum');
    assert.equal(corrected.corrections[0]?.reason, 'Transcription correction');
    await repository.close();

    const reopenedRepository = createRepository(databasePath);
    const reopened = await reopenedRepository.repository.getRecord('lab-record-correction');
    assert.equal(reopened?.measurements[0]?.current.label, 'Total cholesterol');
    assert.equal(reopened?.measurements[0]?.current.valueString, '3.8');
    assert.equal(reopened?.measurements[0]?.current.unit, 'mg/dL');
    assert.equal(reopened?.measurements[0]?.specimenType, 'serum');
    assert.equal(reopened?.measurements[0]?.reviewState, 'needs-review');
    assert.equal(reopened?.measurements[0]?.corrections[0]?.next.snapshot.valueString, '3.8');
    await reopenedRepository.repository.close();
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

  test('legacy correction snapshots remain readable after the provenance contract expands', async () => {
    const { repository, database } = createRepository();
    await repository.createRecord({
      id: 'lab-record-legacy-correction',
      collectionDate: { kind: 'missing' },
      measurements: [
        {
          id: 'measurement-legacy-correction',
          label: 'Result',
          value: { kind: 'numeric', value: 1 },
        },
      ],
    });
    const oldSnapshot = JSON.stringify({
      label: 'Result',
      value: { kind: 'numeric', value: 1 },
      valueString: '1',
      unit: null,
      referenceInterval: null,
      flag: null,
    });
    await database.runAsync(
      `INSERT INTO measurement_corrections (
        id, measurement_id, corrected_at, reason, previous_json, next_json, previous_provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      'measurement-correction-legacy',
      'measurement-legacy-correction',
      '2026-08-22T10:00:00.000Z',
      'Legacy correction',
      oldSnapshot,
      oldSnapshot,
      'user-entered',
    );
    const record = await repository.getRecord('lab-record-legacy-correction');
    const correction = record?.measurements[0]?.corrections[0];
    assert.equal(correction?.previous.snapshot.valueString, '1');
    assert.equal(correction?.previous.specimenType, 'unknown');
    assert.equal(correction?.previous.reviewState, 'confirmed');
    assert.equal(correction?.previous.provenance, 'user-entered');
    assert.equal(correction?.next.provenance, 'user-corrected');
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

  test('post-write protection failure rolls back a newly requested create', async () => {
    let strictCalls = 0;
    let failPostWrite = false;
    const failingProtection: DatabaseProtection = {
      async protectDatabaseFiles(databasePath, options = {}) {
        if (options.requireSidecars === true) {
          strictCalls += 1;
          if (failPostWrite && strictCalls === 2) {
            throw new ProtectionError('post-write protection failure');
          }
        }
        return {
          protectedPaths: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
          missingSidecarPaths: [],
        };
      },
    };
    const { repository, database } = createRepository(undefined, failingProtection);
    await repository.initialize();
    strictCalls = 0;
    failPostWrite = true;
    await assert.rejects(
      repository.createRecord({
        id: 'lab-record-rollback-create',
        collectionDate: { kind: 'missing' },
        measurements: [{ label: 'Result', value: { kind: 'numeric', value: 1 } }],
      }),
      /post-write protection failure/,
    );
    assert.deepEqual(await repository.getRecord('lab-record-rollback-create'), null);
    assert.equal((await database.getAllAsync('SELECT id FROM measurements')).length, 0);
    await repository.close();
  });

  test('protection failure blocks update, correction, and delete without committing', async () => {
    let fail = false;
    const guardedProtection: DatabaseProtection = {
      async protectDatabaseFiles(databasePath, options = {}) {
        if (fail && options.requireSidecars === true) {
          throw new ProtectionError('mutation protection failure');
        }
        return {
          protectedPaths: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
          missingSidecarPaths: [],
        };
      },
    };
    const { repository } = createRepository(undefined, guardedProtection);
    await repository.createRecord({
      id: 'lab-record-rollback-mutations',
      collectionDate: { kind: 'known', value: '2026-08-22' },
      specimenType: 'blood',
      laboratoryName: 'Original lab',
      measurements: [
        { id: 'measurement-rollback', label: 'Result', value: { kind: 'numeric', value: 1 } },
      ],
    });
    fail = true;
    await assert.rejects(
      repository.updateRecord('lab-record-rollback-mutations', {
        collectionDate: { kind: 'known', value: '2026-08-23' },
        specimenType: 'urine',
        laboratoryName: 'Changed lab',
        notes: 'changed',
      }),
      /mutation protection failure/,
    );
    await assert.rejects(
      repository.correctMeasurement('measurement-rollback', {
        value: { kind: 'numeric', value: 2 },
      }),
      /mutation protection failure/,
    );
    await assert.rejects(
      repository.deleteRecord('lab-record-rollback-mutations'),
      /mutation protection failure/,
    );
    const record = await repository.getRecord('lab-record-rollback-mutations');
    assert.equal(record?.laboratoryName, 'Original lab');
    assert.equal(record?.measurements[0]?.current.valueString, '1');
    await repository.close();
  });
});
