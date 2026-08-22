import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLabRepository, type SqliteDatabase } from '../labs/persistence';
import type { DatabaseProtection, ProtectionOptions } from '../labs/protection';

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
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
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

const protection: DatabaseProtection = {
  async protectDatabaseFiles(databasePath, options: ProtectionOptions = {}) {
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
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createRepository(databasePath: string) {
  const database = new NodeSqliteDatabase(databasePath);
  const repository = createLabRepository(database, {
    protection,
    now: () => '2026-08-22T10:00:00.000Z',
    idGenerator: (prefix) => `${prefix}-generated-${Math.random().toString(36).slice(2)}`,
  });
  return { database, repository };
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-intake-'));
  temporaryPaths.push(directory);
  return join(directory, 'alyte.sqlite');
}

test('local intake journey survives correction, relaunch, undo, exclusion, day navigation, and deletion', async () => {
  const databasePath = temporaryDatabase();
  const first = createRepository(databasePath);
  const created = await first.repository.createIntakeEvent({
    id: 'intake-event-1',
    eventType: 'medication',
    occurredAt: '2026-08-22T09:30:00.000Z',
    localDate: '2026-08-22',
    origin: 'manual',
    components: [
      {
        id: 'intake-component-1',
        name: 'Daily tablet',
        quantity: { kind: 'unknown', reason: 'not-confirmed' },
      },
    ],
    sourceMediaPath: 'protected://intake-media/example.jpg',
  });

  assert.equal(created.analysisInclusion, 'included');
  assert.equal(created.components[0]?.quantity.kind, 'unknown');
  await first.repository.updateIntakeEvent(created.id, {
    eventType: 'medication',
    occurredAt: created.occurredAt,
    localDate: created.localDate,
    components: [
      {
        id: 'intake-component-1',
        name: 'Daily tablet',
        quantity: { kind: 'known', value: 1, unit: 'tablet' },
      },
    ],
  });
  await first.repository.close();

  const reopened = createRepository(databasePath);
  const corrected = await reopened.repository.getIntakeEvent(created.id);
  assert.equal(corrected?.components[0]?.quantity.kind, 'known');
  assert.equal(corrected?.components[0]?.provenance, 'user-corrected');

  const copy = await reopened.repository.logAgainEvent(created.id, '2026-08-22T18:00:00.000Z');
  assert.notEqual(copy.id, created.id);
  assert.equal(copy.copiedFromEventId, created.id);
  assert.equal(copy.components[0]?.quantity.kind, 'known');
  assert.equal((await reopened.repository.listIntakeEventsForDay('2026-08-22')).length, 2);
  await reopened.repository.undoLogAgain(copy.id);
  assert.equal(await reopened.repository.getIntakeEvent(copy.id), null);

  const editedCopy = await reopened.repository.logAgainEvent(
    created.id,
    '2026-08-22T19:00:00.000Z',
  );
  await reopened.repository.updateIntakeEvent(editedCopy.id, {
    notes: 'Edited after logging again',
  });
  await assert.rejects(reopened.repository.undoLogAgain(editedCopy.id), /unedited Log Again/);
  await reopened.repository.deleteIntakeEvent(editedCopy.id);

  await reopened.repository.setAnalysisInclusion(created.id, 'excluded');
  assert.equal(
    (await reopened.repository.getIntakeEvent(created.id))?.analysisInclusion,
    'excluded',
  );
  await reopened.repository.setAnalysisInclusion(created.id, 'included');
  assert.equal(
    (await reopened.repository.getIntakeEvent(created.id))?.analysisInclusion,
    'included',
  );

  const deletion = await reopened.repository.deleteIntakeEvent(created.id);
  assert.equal(deletion.sourceMediaPath, 'protected://intake-media/example.jpg');
  assert.equal(await reopened.repository.getIntakeEvent(created.id), null);
  assert.equal(
    (
      await reopened.database.getAllAsync(
        'SELECT id FROM intake_components WHERE event_id = ?',
        created.id,
      )
    ).length,
    0,
  );
  await reopened.repository.close();
});

test('intake day queries keep prior dates separate and retain unknown dose state', async () => {
  const { repository } = createRepository(temporaryDatabase());
  await repository.createIntakeEvent({
    id: 'intake-event-yesterday',
    eventType: 'supplement',
    occurredAt: '2026-08-21T09:00:00.000Z',
    localDate: '2026-08-21',
    components: [{ name: 'Vitamin D', quantity: { kind: 'unknown', reason: 'not-provided' } }],
  });
  await repository.createIntakeEvent({
    id: 'intake-event-today',
    eventType: 'drink',
    occurredAt: '2026-08-22T09:00:00.000Z',
    localDate: '2026-08-22',
    components: [{ name: 'Water', quantity: { kind: 'known', value: 1, unit: 'glass' } }],
  });
  assert.equal((await repository.listIntakeEventsForDay('2026-08-21')).length, 1);
  assert.equal((await repository.listIntakeEventsForDay('2026-08-22')).length, 1);
  assert.equal(
    (await repository.listIntakeEventsForDay('2026-08-21'))[0]?.components[0]?.quantity.kind,
    'unknown',
  );
  await repository.close();
});

test('intake changes expose invalidation hooks without putting health payloads in the feed', async () => {
  const { repository } = createRepository(temporaryDatabase());
  const changes: { kind: string; eventId: string; invalidatesInsights: boolean }[] = [];
  const unsubscribe = repository.subscribeToIntakeChanges((change) => {
    changes.push({
      kind: change.kind,
      eventId: change.eventId,
      invalidatesInsights: change.invalidatesInsights,
    });
  });
  const event = await repository.createIntakeEvent({
    id: 'intake-event-feed',
    eventType: 'food',
    occurredAt: '2026-08-22T08:00:00.000Z',
    localDate: '2026-08-22',
    components: [{ name: 'Breakfast', quantity: { kind: 'unknown', reason: 'not-provided' } }],
  });
  await repository.setAnalysisInclusion(event.id, 'excluded');
  const deletion = await repository.deleteIntakeEvent(event.id);
  assert.equal(deletion.sourceMediaPath, null);
  unsubscribe();
  assert.deepEqual(
    changes.map((change) => [change.kind, change.invalidatesInsights]),
    [
      ['created', false],
      ['analysis-inclusion-changed', true],
      ['deleted', true],
    ],
  );
  await repository.close();
});
