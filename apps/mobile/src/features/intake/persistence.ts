import {
  assertIntakeAmount,
  assertIntakeLocalDate,
  amountForInput,
  canonicalId,
  formatIntakeLocalDate,
  type AnalysisInclusion,
  type CreateIntakeComponentInput,
  type CreateIntakeEventInput,
  type IntakeAmount,
  type IntakeChange,
  type IntakeChangeListener,
  type IntakeComponent,
  type IntakeComponentSnapshot,
  type IntakeEvent,
  type UpdateIntakeEventInput,
} from '@alyte/domain';
import {
  createProtectedDatabaseBoundary,
  type SqliteDatabase,
} from '../local-database/persistence';
import { nativeDatabaseProtection, type DatabaseProtection } from '../local-database/protection';

export const INTAKE_DATABASE_NAME = 'alyte-local.sqlite';
export type { SqliteDatabase } from '../local-database/persistence';

type IntakeEventRow = {
  id: unknown;
  event_type: unknown;
  occurred_at: unknown;
  local_date: unknown;
  origin: unknown;
  provenance: unknown;
  review_state: unknown;
  analysis_inclusion: unknown;
  notes: unknown;
  source_media_path: unknown;
  copied_from_event_id: unknown;
  created_at: unknown;
  updated_at: unknown;
};

type IntakeComponentRow = {
  id: unknown;
  event_id: unknown;
  original_amount_json: unknown;
  current_amount_json: unknown;
  provenance: unknown;
  review_state: unknown;
};

const eventTypes = ['food', 'drink', 'supplement', 'medication', 'other'] as const;
const origins = ['manual', 'snap', 'cloud-recognized'] as const;
const provenances = ['user-entered', 'extracted', 'estimated', 'user-corrected'] as const;
const reviewStates = ['confirmed', 'needs-review'] as const;
const inclusions = ['included', 'excluded'] as const;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Invalid ${field} in local database`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Invalid ${field} in local database`);
  return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T))
    throw new Error(`Invalid ${field} in local database`);
  return value as T;
}

function parseJson(value: unknown, field: string): unknown {
  const json = requiredString(value, field);
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${field} JSON in local database`, { cause: error });
  }
}

function amountFromUnknown(value: unknown): IntakeAmount {
  if (typeof value !== 'object' || value === null)
    throw new Error('Invalid intake amount in local database');
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'unknown') {
    const reason = enumValue(
      candidate.reason,
      ['not-provided', 'not-confirmed', 'not-applicable'] as const,
      'intake amount reason',
    );
    return { kind: 'unknown', reason };
  }
  if (
    candidate.kind !== 'known' ||
    typeof candidate.value !== 'number' ||
    !Number.isFinite(candidate.value) ||
    candidate.value < 0 ||
    typeof candidate.unit !== 'string' ||
    candidate.unit.trim().length === 0
  ) {
    throw new Error('Invalid known intake amount in local database');
  }
  const amount = { kind: 'known' as const, value: candidate.value, unit: candidate.unit };
  assertIntakeAmount(amount);
  return amount;
}

function snapshotFromUnknown(value: unknown): IntakeComponentSnapshot {
  if (typeof value !== 'object' || value === null)
    throw new Error('Invalid intake component snapshot in local database');
  const candidate = value as Record<string, unknown>;
  const canonical =
    candidate.canonicalId === null || candidate.canonicalId === undefined
      ? null
      : canonicalId(requiredString(candidate.canonicalId, 'intake component canonical id'));
  return {
    name: requiredString(candidate.name, 'intake component name'),
    amount: amountFromUnknown(candidate.amount),
    canonicalId: canonical,
  };
}

function snapshotJson(snapshot: IntakeComponentSnapshot): string {
  return JSON.stringify(snapshot);
}

function decodeEvent(row: IntakeEventRow): Omit<IntakeEvent, 'components'> {
  const occurredAt = requiredString(row.occurred_at, 'intake event timestamp');
  if (Number.isNaN(new Date(occurredAt).getTime()))
    throw new Error('Invalid intake event timestamp in local database');
  const localDate = requiredString(row.local_date, 'intake event local date');
  assertIntakeLocalDate(localDate);
  return {
    id: requiredString(row.id, 'intake event id'),
    eventType: enumValue(row.event_type, eventTypes, 'intake event type'),
    occurredAt,
    localDate,
    origin: enumValue(row.origin, origins, 'intake event origin'),
    provenance: enumValue(row.provenance, provenances, 'intake event provenance'),
    reviewState: enumValue(row.review_state, reviewStates, 'intake event review state'),
    analysisInclusion: enumValue(row.analysis_inclusion, inclusions, 'intake analysis inclusion'),
    notes: nullableString(row.notes, 'intake event notes'),
    sourceMediaPath: nullableString(row.source_media_path, 'intake source media path'),
    copiedFromEventId: nullableString(row.copied_from_event_id, 'intake copied event id'),
    createdAt: requiredString(row.created_at, 'intake event created timestamp'),
    updatedAt: requiredString(row.updated_at, 'intake event updated timestamp'),
  };
}

function decodeComponent(row: IntakeComponentRow): IntakeComponent {
  const original = snapshotFromUnknown(
    parseJson(row.original_amount_json, 'original intake component'),
  );
  const current = snapshotFromUnknown(
    parseJson(row.current_amount_json, 'current intake component'),
  );
  return {
    ...current,
    id: requiredString(row.id, 'intake component id'),
    eventId: requiredString(row.event_id, 'intake component event id'),
    original,
    provenance: enumValue(row.provenance, provenances, 'intake component provenance'),
    reviewState: enumValue(row.review_state, reviewStates, 'intake component review state'),
    quantity: current.amount,
  };
}

function normalizeTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('Intake event timestamp must be valid');
  return parsed.toISOString();
}

function localDateForTimestamp(localDate: string | undefined, occurredAt: string): string {
  const derived = formatIntakeLocalDate(new Date(occurredAt));
  if (localDate !== undefined && localDate !== derived) {
    throw new Error('Intake local date must match the event timestamp in local time');
  }
  return localDate ?? derived;
}

function normalizeSnapshot(
  input: CreateIntakeComponentInput,
  fallback?: IntakeComponentSnapshot,
): IntakeComponentSnapshot {
  const name = input.name.trim();
  if (name.length === 0) throw new Error('Intake component name is required');
  const amount =
    input.amount === undefined && input.quantity === undefined && fallback !== undefined
      ? fallback.amount
      : amountForInput(input);
  const canonicalId =
    input.canonicalId === undefined ? (fallback?.canonicalId ?? null) : (input.canonicalId ?? null);
  return { name, amount, canonicalId };
}

function sameSnapshot(left: IntakeComponentSnapshot, right: IntakeComponentSnapshot): boolean {
  return (
    left.name === right.name &&
    JSON.stringify(left.amount) === JSON.stringify(right.amount) &&
    left.canonicalId === right.canonicalId
  );
}

export type IntakeRepository = {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listEvents(): Promise<readonly IntakeEvent[]>;
  listEventsForDay(localDate: string): Promise<readonly IntakeEvent[]>;
  getEvent(id: string): Promise<IntakeEvent | null>;
  createEvent(input: CreateIntakeEventInput): Promise<IntakeEvent>;
  updateEvent(id: string, input: UpdateIntakeEventInput): Promise<IntakeEvent>;
  logAgain(id: string, occurredAt?: string): Promise<IntakeEvent>;
  undoLogAgain(id: string): Promise<void>;
  setAnalysisInclusion(id: string, inclusion: AnalysisInclusion): Promise<IntakeEvent>;
  clearIntakeImage(id: string): Promise<IntakeEvent>;
  deleteEvent(
    id: string,
  ): Promise<{ readonly deleted: boolean; readonly sourceMediaPath: string | null }>;
  subscribe(listener: IntakeChangeListener): () => void;
};

export type IntakeRepositoryOptions = {
  readonly protection?: DatabaseProtection;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
};

export function createIntakeRepository(
  database: SqliteDatabase,
  options: IntakeRepositoryOptions = {},
): IntakeRepository {
  const boundary = createProtectedDatabaseBoundary(database, {
    protection: options.protection ?? nativeDatabaseProtection,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.idGenerator === undefined ? {} : { idGenerator: options.idGenerator }),
  });
  const { initialize, close, withWrite, now, makeId } = boundary;
  const listeners = new Set<IntakeChangeListener>();

  function emit(change: IntakeChange): void {
    for (const listener of listeners) {
      try {
        listener(change);
      } catch {
        /* A stale view must not roll back a durable write. */
      }
    }
  }

  async function componentsFor(eventId: string): Promise<readonly IntakeComponent[]> {
    const rows = await database.getAllAsync<IntakeComponentRow>(
      `SELECT id, event_id, original_amount_json, current_amount_json, provenance, review_state
       FROM intake_components WHERE event_id = ? ORDER BY created_at ASC, id ASC;`,
      eventId,
    );
    return rows.map(decodeComponent);
  }

  async function readEvent(id: string): Promise<IntakeEvent | null> {
    const rows = await database.getAllAsync<IntakeEventRow>(
      `SELECT id, event_type, occurred_at, local_date, origin, provenance, review_state,
        analysis_inclusion, notes, source_media_path, copied_from_event_id, created_at, updated_at
       FROM intake_events WHERE id = ?;`,
      id,
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { ...decodeEvent(row), components: await componentsFor(id) };
  }

  async function persist(
    input: CreateIntakeEventInput,
    kind: 'created' | 'logged-again',
    undoable: boolean,
  ): Promise<IntakeEvent> {
    if (input.components.length === 0)
      throw new Error('An Intake Event needs at least one Intake Component');
    const id = input.id ?? makeId('intake-event');
    const occurredAt = normalizeTimestamp(input.occurredAt ?? now());
    const localDate = localDateForTimestamp(input.localDate, occurredAt);
    assertIntakeLocalDate(localDate);
    const createdAt = now();
    const provenance = input.provenance ?? 'user-entered';
    const reviewState = input.reviewState ?? 'confirmed';
    const components = input.components.map((component) => ({
      id: component.id ?? makeId('intake-component'),
      snapshot: normalizeSnapshot(component),
      provenance: component.provenance ?? provenance,
      reviewState: component.reviewState ?? reviewState,
    }));
    await withWrite(async () => {
      await database.runAsync(
        `INSERT INTO intake_events (id, event_type, occurred_at, local_date, origin, provenance,
          review_state, analysis_inclusion, notes, source_media_path, copied_from_event_id,
          log_again_undoable, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        id,
        input.eventType,
        occurredAt,
        localDate,
        input.origin ?? 'manual',
        provenance,
        reviewState,
        input.analysisInclusion ?? 'included',
        input.notes ?? null,
        input.sourceMediaPath ?? null,
        input.copiedFromEventId ?? null,
        undoable ? 1 : 0,
        createdAt,
        createdAt,
      );
      for (const component of components) {
        await database.runAsync(
          `INSERT INTO intake_components (id, event_id, canonical_id, original_name, original_amount_json,
            current_name, current_amount_json, provenance, review_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          component.id,
          id,
          component.snapshot.canonicalId,
          component.snapshot.name,
          snapshotJson(component.snapshot),
          component.snapshot.name,
          snapshotJson(component.snapshot),
          component.provenance,
          component.reviewState,
          createdAt,
          createdAt,
        );
      }
    });
    const event = await readEvent(id);
    if (event === null) throw new Error('Created Intake Event could not be read back');
    emit({ kind, eventId: id, occurredAt: event.occurredAt, invalidatesInsights: false });
    return event;
  }

  async function listEvents(): Promise<readonly IntakeEvent[]> {
    await initialize();
    const rows = await database.getAllAsync<IntakeEventRow>(
      `SELECT id, event_type, occurred_at, local_date, origin, provenance, review_state,
        analysis_inclusion, notes, source_media_path, copied_from_event_id, created_at, updated_at
       FROM intake_events ORDER BY local_date DESC, occurred_at DESC, created_at DESC;`,
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...decodeEvent(row),
        components: await componentsFor(requiredString(row.id, 'intake event id')),
      })),
    );
  }

  async function listEventsForDay(localDate: string): Promise<readonly IntakeEvent[]> {
    await initialize();
    assertIntakeLocalDate(localDate);
    const rows = await database.getAllAsync<IntakeEventRow>(
      `SELECT id, event_type, occurred_at, local_date, origin, provenance, review_state,
        analysis_inclusion, notes, source_media_path, copied_from_event_id, created_at, updated_at
       FROM intake_events WHERE local_date = ? ORDER BY occurred_at DESC, created_at DESC;`,
      localDate,
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...decodeEvent(row),
        components: await componentsFor(requiredString(row.id, 'intake event id')),
      })),
    );
  }

  async function getEvent(id: string): Promise<IntakeEvent | null> {
    await initialize();
    return readEvent(id);
  }

  async function createEvent(input: CreateIntakeEventInput): Promise<IntakeEvent> {
    await initialize();
    return persist(input, 'created', false);
  }

  async function updateEvent(id: string, input: UpdateIntakeEventInput): Promise<IntakeEvent> {
    await initialize();
    let inclusionChanged = false;
    await withWrite(async () => {
      const existing = await readEvent(id);
      if (existing === null) throw new Error('Intake Event was not found');
      const occurredAt =
        input.occurredAt === undefined ? existing.occurredAt : normalizeTimestamp(input.occurredAt);
      const localDate = localDateForTimestamp(
        input.localDate ?? (input.occurredAt === undefined ? existing.localDate : undefined),
        occurredAt,
      );
      assertIntakeLocalDate(localDate);
      const nextInputs =
        input.components ??
        existing.components.map((component) => ({
          id: component.id,
          name: component.name,
          amount: component.amount,
          canonicalId: component.canonicalId,
          provenance: component.provenance,
          reviewState: component.reviewState,
        }));
      if (nextInputs.length === 0)
        throw new Error('An Intake Event needs at least one Intake Component');
      const existingById = new Map(
        existing.components.map((component) => [component.id, component]),
      );
      const usedIds = new Set<string>();
      let changed = input.eventType !== undefined && input.eventType !== existing.eventType;
      changed ||= input.occurredAt !== undefined && occurredAt !== existing.occurredAt;
      changed ||= input.localDate !== undefined && localDate !== existing.localDate;
      changed ||= input.origin !== undefined && input.origin !== existing.origin;
      changed ||= input.notes !== undefined && input.notes !== existing.notes;
      const prepared = nextInputs.map((componentInput, index) => {
        const previous =
          (componentInput.id === undefined
            ? existing.components[index]
            : existingById.get(componentInput.id)) ?? undefined;
        const snapshot = normalizeSnapshot(componentInput, previous);
        const componentChanged = previous === undefined || !sameSnapshot(snapshot, previous);
        changed ||= componentChanged;
        const componentId = previous?.id ?? componentInput.id ?? makeId('intake-component');
        usedIds.add(componentId);
        return {
          id: componentId,
          previous,
          snapshot,
          original: previous?.original ?? snapshot,
          provenance: componentChanged
            ? ('user-corrected' as const)
            : (previous?.provenance ?? 'user-entered'),
          reviewState: componentInput.reviewState ?? previous?.reviewState ?? 'confirmed',
        };
      });
      const inclusion = input.analysisInclusion ?? existing.analysisInclusion;
      inclusionChanged = inclusion !== existing.analysisInclusion;
      const updatedAt = now();
      const result = await database.runAsync(
        `UPDATE intake_events SET event_type = ?, occurred_at = ?, local_date = ?, origin = ?,
          provenance = ?, review_state = ?, analysis_inclusion = ?, notes = ?, source_media_path = ?,
          log_again_undoable = 0, updated_at = ? WHERE id = ?;`,
        input.eventType ?? existing.eventType,
        occurredAt,
        localDate,
        input.origin ?? existing.origin,
        changed ? 'user-corrected' : existing.provenance,
        input.reviewState ?? existing.reviewState,
        inclusion,
        input.notes === undefined ? existing.notes : input.notes,
        input.sourceMediaPath === undefined ? existing.sourceMediaPath : input.sourceMediaPath,
        updatedAt,
        id,
      );
      if (result.changes !== 1) throw new Error('Intake Event could not be updated');
      for (const component of prepared) {
        if (component.previous === undefined) {
          await database.runAsync(
            `INSERT INTO intake_components (id, event_id, canonical_id, original_name, original_amount_json,
              current_name, current_amount_json, provenance, review_state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            component.id,
            id,
            component.snapshot.canonicalId,
            component.original.name,
            snapshotJson(component.original),
            component.snapshot.name,
            snapshotJson(component.snapshot),
            component.provenance,
            component.reviewState,
            updatedAt,
            updatedAt,
          );
        } else {
          await database.runAsync(
            `UPDATE intake_components SET canonical_id = ?, current_name = ?, current_amount_json = ?,
              provenance = ?, review_state = ?, updated_at = ? WHERE id = ? AND event_id = ?;`,
            component.snapshot.canonicalId,
            component.snapshot.name,
            snapshotJson(component.snapshot),
            component.provenance,
            component.reviewState,
            updatedAt,
            component.id,
            id,
          );
        }
      }
      for (const component of existing.components) {
        if (!usedIds.has(component.id))
          await database.runAsync(
            'DELETE FROM intake_components WHERE id = ? AND event_id = ?;',
            component.id,
            id,
          );
      }
    });
    const event = await readEvent(id);
    if (event === null) throw new Error('Updated Intake Event could not be read back');
    emit({
      kind: inclusionChanged ? 'analysis-inclusion-changed' : 'updated',
      eventId: id,
      occurredAt: event.occurredAt,
      invalidatesInsights: inclusionChanged || event.provenance === 'user-corrected',
    });
    return event;
  }

  async function logAgain(id: string, occurredAt?: string): Promise<IntakeEvent> {
    await initialize();
    const source = await readEvent(id);
    if (source === null) throw new Error('Intake Event was not found');
    const timestamp = normalizeTimestamp(occurredAt ?? now());
    return persist(
      {
        eventType: source.eventType,
        occurredAt: timestamp,
        localDate: formatIntakeLocalDate(new Date(timestamp)),
        origin: 'manual',
        provenance: 'user-entered',
        reviewState: source.reviewState,
        analysisInclusion: source.analysisInclusion,
        notes: source.notes,
        copiedFromEventId: source.id,
        components: source.components.map((component) => ({
          name: component.name,
          amount: component.amount,
          canonicalId: component.canonicalId,
          provenance: component.provenance,
          reviewState: component.reviewState,
        })),
      },
      'logged-again',
      true,
    );
  }

  async function undoLogAgain(id: string): Promise<void> {
    await initialize();
    let deleted = false;
    await withWrite(async () => {
      const rows = await database.getAllAsync<{ log_again_undoable: number }>(
        'SELECT log_again_undoable FROM intake_events WHERE id = ? AND copied_from_event_id IS NOT NULL;',
        id,
      );
      if (rows[0]?.log_again_undoable !== 1)
        throw new Error('Only an unedited Log Again copy can be undone');
      deleted =
        (
          await database.runAsync(
            'DELETE FROM intake_events WHERE id = ? AND copied_from_event_id IS NOT NULL;',
            id,
          )
        ).changes === 1;
    });
    if (deleted)
      emit({ kind: 'deleted', eventId: id, occurredAt: null, invalidatesInsights: true });
  }

  async function setAnalysisInclusion(
    id: string,
    inclusion: AnalysisInclusion,
  ): Promise<IntakeEvent> {
    return updateEvent(id, { analysisInclusion: inclusion });
  }

  async function clearIntakeImage(id: string): Promise<IntakeEvent> {
    await initialize();
    await withWrite(async () => {
      const result = await database.runAsync(
        'UPDATE intake_events SET source_media_path = NULL, updated_at = ? WHERE id = ?;',
        now(),
        id,
      );
      if (result.changes !== 1) throw new Error('Intake Event was not found');
    });
    const event = await readEvent(id);
    if (event === null) throw new Error('Intake Event could not be read back after image removal');
    emit({
      kind: 'image-removed',
      eventId: id,
      occurredAt: event.occurredAt,
      invalidatesInsights: false,
    });
    return event;
  }

  async function deleteEvent(
    id: string,
  ): Promise<{ readonly deleted: boolean; readonly sourceMediaPath: string | null }> {
    await initialize();
    let deleted = false;
    let sourceMediaPath: string | null = null;
    await withWrite(async () => {
      const event = await readEvent(id);
      if (event === null) return;
      sourceMediaPath = event.sourceMediaPath;
      await database.runAsync('DELETE FROM intake_components WHERE event_id = ?;', id);
      deleted =
        (await database.runAsync('DELETE FROM intake_events WHERE id = ?;', id)).changes === 1;
      const orphans = await database.getAllAsync<{ id: string }>(
        'SELECT id FROM intake_components WHERE event_id = ?;',
        id,
      );
      if (orphans.length > 0) throw new Error('Intake Event deletion left orphaned components');
    });
    if (deleted)
      emit({ kind: 'deleted', eventId: id, occurredAt: null, invalidatesInsights: true });
    return { deleted, sourceMediaPath };
  }

  function subscribe(listener: IntakeChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    initialize,
    close,
    listEvents,
    listEventsForDay,
    getEvent,
    createEvent,
    updateEvent,
    logAgain,
    undoLogAgain,
    setAnalysisInclusion,
    clearIntakeImage,
    deleteEvent,
    subscribe,
  };
}

export async function openProtectedIntakeDatabase(
  options: { readonly databaseName?: string; readonly protection?: DatabaseProtection } = {},
): Promise<IntakeRepository> {
  const { openDatabaseAsync } = await import('expo-sqlite');
  const database = await openDatabaseAsync(options.databaseName ?? INTAKE_DATABASE_NAME, {
    useNewConnection: true,
  });
  const repository = createIntakeRepository(
    database,
    options.protection === undefined ? {} : { protection: options.protection },
  );
  try {
    await repository.initialize();
    return repository;
  } catch (error) {
    await database.closeAsync();
    throw error;
  }
}
