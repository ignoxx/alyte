import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntakeRepository, type SqliteDatabase } from './persistence';
import { createIntakeService, type IntakeMediaStore } from './service';
import type { DatabaseProtection, ProtectionOptions } from '../local-database/protection';

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
  const repository = createIntakeRepository(database, {
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
  const created = await first.repository.createEvent({
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
  await first.repository.updateEvent(created.id, {
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
  const corrected = await reopened.repository.getEvent(created.id);
  assert.equal(corrected?.components[0]?.quantity.kind, 'known');
  assert.equal(corrected?.components[0]?.provenance, 'user-corrected');

  const copy = await reopened.repository.logAgain(created.id, '2026-08-22T18:00:00.000Z');
  assert.notEqual(copy.id, created.id);
  assert.equal(copy.copiedFromEventId, created.id);
  assert.equal(copy.components[0]?.quantity.kind, 'known');
  assert.equal((await reopened.repository.listEventsForDay('2026-08-22')).length, 2);
  await reopened.repository.undoLogAgain(copy.id);
  assert.equal(await reopened.repository.getEvent(copy.id), null);

  const editedCopy = await reopened.repository.logAgain(created.id, '2026-08-22T19:00:00.000Z');
  await reopened.repository.updateEvent(editedCopy.id, {
    notes: 'Edited after logging again',
  });
  await assert.rejects(reopened.repository.undoLogAgain(editedCopy.id), /unedited Log Again/);
  await reopened.repository.deleteEvent(editedCopy.id);

  await reopened.repository.setAnalysisInclusion(created.id, 'excluded');
  assert.equal((await reopened.repository.getEvent(created.id))?.analysisInclusion, 'excluded');
  await reopened.repository.setAnalysisInclusion(created.id, 'included');
  assert.equal((await reopened.repository.getEvent(created.id))?.analysisInclusion, 'included');

  const deletion = await reopened.repository.deleteEvent(created.id);
  assert.equal(deletion.sourceMediaPath, 'protected://intake-media/example.jpg');
  assert.equal(await reopened.repository.getEvent(created.id), null);
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
  const yesterday = await repository.createEvent({
    id: 'intake-event-yesterday',
    eventType: 'supplement',
    occurredAt: '2026-08-21T09:00:00.000Z',
    localDate: '2026-08-21',
    components: [{ name: 'Vitamin D', quantity: { kind: 'unknown', reason: 'not-provided' } }],
  });
  await repository.createEvent({
    id: 'intake-event-today',
    eventType: 'drink',
    occurredAt: '2026-08-22T09:00:00.000Z',
    localDate: '2026-08-22',
    components: [{ name: 'Water', quantity: { kind: 'known', value: 1, unit: 'glass' } }],
  });
  assert.equal((await repository.listEventsForDay('2026-08-21')).length, 1);
  assert.equal((await repository.listEventsForDay('2026-08-22')).length, 1);
  assert.equal(
    (await repository.listEventsForDay('2026-08-21'))[0]?.components[0]?.quantity.kind,
    'unknown',
  );
  const copy = await repository.logAgain(yesterday.id, '2026-08-22T10:00:00.000Z');
  assert.equal(copy.localDate, '2026-08-22');
  assert.equal((await repository.listEventsForDay('2026-08-21')).length, 1);
  assert.equal((await repository.listEventsForDay('2026-08-22')).length, 2);
  await repository.close();
});

test('intake persistence rejects a timestamp and local date from different local days', async () => {
  const { repository } = createRepository(temporaryDatabase());
  await assert.rejects(
    repository.createEvent({
      id: 'intake-event-mismatched-day',
      eventType: 'food',
      occurredAt: '2026-08-22T09:00:00.000Z',
      localDate: '2026-08-21',
      components: [{ name: 'Breakfast', quantity: { kind: 'unknown', reason: 'not-provided' } }],
    }),
    /local date must match/,
  );
  await repository.close();
});

test('known numeric intake amounts require an explicit unit', async () => {
  const { repository } = createRepository(temporaryDatabase());
  await assert.rejects(
    repository.createEvent({
      id: 'intake-event-missing-unit',
      eventType: 'supplement',
      occurredAt: '2026-08-22T09:00:00.000Z',
      components: [{ name: 'Vitamin D', amount: { kind: 'known', value: 1, unit: '' } }],
    }),
    /must include a unit/,
  );
  await assert.rejects(
    repository.createEvent({
      id: 'intake-event-missing-dose-unit',
      eventType: 'medication',
      occurredAt: '2026-08-22T09:00:00.000Z',
      components: [{ name: 'Daily tablet', amount: { kind: 'known', value: 1, unit: ' ' } }],
    }),
    /must include a unit/,
  );
  await repository.close();
});

test('intake changes expose invalidation hooks without putting health payloads in the feed', async () => {
  const { repository } = createRepository(temporaryDatabase());
  const changes: { kind: string; eventId: string; invalidatesInsights: boolean }[] = [];
  const unsubscribe = repository.subscribe((change) => {
    changes.push({
      kind: change.kind,
      eventId: change.eventId,
      invalidatesInsights: change.invalidatesInsights,
    });
  });
  const event = await repository.createEvent({
    id: 'intake-event-feed',
    eventType: 'food',
    occurredAt: '2026-08-22T08:00:00.000Z',
    localDate: '2026-08-22',
    components: [{ name: 'Breakfast', quantity: { kind: 'unknown', reason: 'not-provided' } }],
  });
  await repository.setAnalysisInclusion(event.id, 'excluded');
  const deletion = await repository.deleteEvent(event.id);
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

test('service removes Intake media before deletion and leaves retryable events on failure', async () => {
  const { repository } = createRepository(temporaryDatabase());
  const mediaPath = 'protected://intake-media/retry.jpg';
  const event = await repository.createEvent({
    id: 'intake-event-media-retry',
    eventType: 'food',
    occurredAt: '2026-08-22T12:00:00.000Z',
    components: [{ name: 'Lunch', quantity: { kind: 'unknown', reason: 'not-provided' } }],
    sourceMediaPath: mediaPath,
  });
  let failRemove = true;
  let verifyResult = true;
  const mediaStore: IntakeMediaStore = {
    async remove() {
      if (failRemove) throw new Error('media unavailable');
      // The production adapter is idempotent after a crash removed the file.
    },
    async verifyRemoved() {
      return verifyResult;
    },
  };
  const service = createIntakeService({
    repositoryFactory: async () => repository,
    mediaStore,
  });

  await assert.rejects(service.deleteEvent(event.id), /media unavailable/);
  assert.equal((await repository.getEvent(event.id))?.sourceMediaPath, mediaPath);

  failRemove = false;
  verifyResult = false;
  await assert.rejects(service.deleteEvent(event.id), /could not be verified/);
  assert.equal((await repository.getEvent(event.id)) !== null, true);

  verifyResult = true;
  await service.deleteEvent(event.id);
  assert.equal(await repository.getEvent(event.id), null);

  const crashEvent = await repository.createEvent({
    id: 'intake-event-media-crash',
    eventType: 'drink',
    occurredAt: '2026-08-22T12:30:00.000Z',
    components: [{ name: 'Water', quantity: { kind: 'unknown', reason: 'not-provided' } }],
    sourceMediaPath: mediaPath,
  });
  let failDatabaseDelete = true;
  const deleteEvent = repository.deleteEvent.bind(repository);
  const flakyRepository = {
    ...repository,
    async deleteEvent(id: string) {
      if (failDatabaseDelete) {
        failDatabaseDelete = false;
        throw new Error('database interrupted after media removal');
      }
      return deleteEvent(id);
    },
  };
  const crashRetryService = createIntakeService({
    repositoryFactory: async () => flakyRepository,
    mediaStore,
  });
  await assert.rejects(crashRetryService.deleteEvent(crashEvent.id), /database interrupted/);
  assert.equal((await repository.getEvent(crashEvent.id)) !== null, true);
  await crashRetryService.deleteEvent(crashEvent.id);
  assert.equal(await repository.getEvent(crashEvent.id), null);
  await repository.close();
});

test('remove Intake Image clears only the reference after verified media cleanup', async () => {
  const { repository } = createRepository(temporaryDatabase());
  const mediaPath = 'protected://intake-media/retain-event.jpg';
  const event = await repository.createEvent({
    id: 'intake-event-remove-image',
    eventType: 'medication',
    occurredAt: '2026-08-22T13:00:00.000Z',
    components: [{ name: 'Medication', quantity: { kind: 'unknown', reason: 'not-confirmed' } }],
    sourceMediaPath: mediaPath,
  });
  let removed = false;
  let verifyImage = false;
  const mediaStore: IntakeMediaStore = {
    async remove() {
      removed = true;
    },
    async verifyRemoved() {
      return removed && verifyImage;
    },
  };
  const service = createIntakeService({ repositoryFactory: async () => repository, mediaStore });
  await assert.rejects(service.removeIntakeImage(event.id), /could not be verified/);
  assert.equal((await repository.getEvent(event.id))?.sourceMediaPath, mediaPath);
  verifyImage = true;
  const cleared = await service.removeIntakeImage(event.id);
  assert.equal(cleared.sourceMediaPath, null);
  assert.equal((await repository.getEvent(event.id))?.sourceMediaPath, null);
  assert.equal((await repository.getEvent(event.id))?.eventType, 'medication');
  await repository.close();
});
