import {
  EXPORT_INTERPRETATION_PREFERENCE_KEYS,
  EXPORT_SCHEMA_DECISIONS,
  type ExportSnapshot,
  type ExportSnapshotDatabase,
  type ExportSnapshotTable,
  type ExportTableDecision,
} from './export-contract';

type TableRow = { readonly name: unknown };
type ColumnRow = { readonly name: unknown };

export class ExportSchemaIncompleteError extends Error {
  override readonly name = 'ExportSchemaIncompleteError';
  readonly missingTables: readonly string[];
  readonly unexpectedTables: readonly string[];
  readonly columnMismatches: readonly string[];

  constructor(input: {
    readonly missingTables?: readonly string[];
    readonly unexpectedTables?: readonly string[];
    readonly columnMismatches?: readonly string[];
  }) {
    super('The local export schema has no complete export decision');
    this.missingTables = input.missingTables ?? [];
    this.unexpectedTables = input.unexpectedTables ?? [];
    this.columnMismatches = input.columnMismatches ?? [];
  }
}

function requiredName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${field} returned by SQLite`);
  }
  return value;
}

function actualTableNames(rows: readonly TableRow[]): readonly string[] {
  return rows
    .map((row) => requiredName(row.name, 'SQLite table name'))
    .filter((name) => !name.startsWith('sqlite_'))
    .sort();
}

function decisionNames(decisions: readonly ExportTableDecision[]): readonly string[] {
  return decisions.map((decision) => decision.name).sort();
}

function decisionColumns(decision: ExportTableDecision): readonly string[] {
  return decision.columns.map((column) => column.name);
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('Invalid SQLite identifier');
  return `"${value}"`;
}

function orderBy(table: string): string {
  switch (table) {
    case 'lab_report_pages':
      return 'report_id ASC, page_index ASC, id ASC';
    case 'extraction_draft_rows':
      return 'draft_id ASC, row_order ASC, id ASC';
    case 'intake_components':
      return 'event_id ASC, created_at ASC, id ASC';
    default: {
      const key =
        table === 'intake_capture_recovery'
          ? 'capture_id'
          : table === 'app_preferences'
            ? 'key'
            : 'id';
      return `${key} ASC`;
    }
  }
}

function includedDecisions(): readonly ExportTableDecision[] {
  return EXPORT_SCHEMA_DECISIONS.filter((decision) => decision.decision === 'include');
}

/**
 * Compare both sqlite_master and PRAGMA table_info against the explicit export contract. This
 * fails closed for an added table or column, including a future health table not yet known here.
 */
export async function assertExportSchemaComplete(
  database: ExportSnapshotDatabase,
): Promise<{ readonly schemaVersion: number }> {
  const actualTables = actualTableNames(
    await database.getAllAsync<TableRow>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;",
    ),
  );
  const expectedTables = decisionNames(EXPORT_SCHEMA_DECISIONS);
  const missingTables = expectedTables.filter((name) => !actualTables.includes(name));
  const unexpectedTables = actualTables.filter((name) => !expectedTables.includes(name));
  const columnMismatches: string[] = [];

  for (const decision of EXPORT_SCHEMA_DECISIONS) {
    if (decision.decision === 'exclude' || !actualTables.includes(decision.name)) continue;
    const actualColumns = (
      await database.getAllAsync<ColumnRow>(`PRAGMA table_info(${quoteIdentifier(decision.name)});`)
    )
      .map((row) => requiredName(row.name, `${decision.name} column name`))
      .sort();
    const expectedColumns = [...decisionColumns(decision)].sort();
    if (
      actualColumns.length !== expectedColumns.length ||
      actualColumns.some((column, index) => column !== expectedColumns[index])
    ) {
      columnMismatches.push(
        `${decision.name}: expected [${expectedColumns.join(',')}], found [${actualColumns.join(',')}]`,
      );
    }
  }

  if (missingTables.length > 0 || unexpectedTables.length > 0 || columnMismatches.length > 0) {
    throw new ExportSchemaIncompleteError({ missingTables, unexpectedTables, columnMismatches });
  }

  const versionRows = await database.getAllAsync<{ readonly version: unknown }>(
    'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations;',
  );
  const schemaVersion = versionRows[0]?.version;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new ExportSchemaIncompleteError({ columnMismatches: ['schema_migrations.version'] });
  }
  return { schemaVersion };
}

function rowWithExplicitColumns(
  columns: readonly string[],
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const column of columns) result[column] = row[column] ?? null;
  return result;
}

async function readTable(
  database: ExportSnapshotDatabase,
  decision: ExportTableDecision,
): Promise<ExportSnapshotTable> {
  const columns = decision.columns.map((column) => column.name);
  const projection = columns.map(quoteIdentifier).join(', ');
  const rows = await database.getAllAsync<Readonly<Record<string, unknown>>>(
    `SELECT ${projection} FROM ${quoteIdentifier(decision.name)} ORDER BY ${orderBy(decision.name)};`,
  );
  return {
    name: decision.name as ExportSnapshotTable['name'],
    columns,
    rows: rows.map((row) => rowWithExplicitColumns(columns, row)),
  };
}

async function readPreferences(
  database: ExportSnapshotDatabase,
  decision: ExportTableDecision,
): Promise<ExportSnapshotTable> {
  const columns = decision.columns.map((column) => column.name);
  const placeholders = EXPORT_INTERPRETATION_PREFERENCE_KEYS.map(() => '?').join(', ');
  const rows = await database.getAllAsync<Readonly<Record<string, unknown>>>(
    `SELECT ${columns.map(quoteIdentifier).join(', ')} FROM app_preferences
     WHERE key IN (${placeholders}) ORDER BY key ASC;`,
    ...EXPORT_INTERPRETATION_PREFERENCE_KEYS,
  );
  return {
    name: 'app_preferences',
    columns,
    rows: rows.map((row) => rowWithExplicitColumns(columns, row)),
  };
}

/**
 * Read all exportable records from one protected connection and one pinned read transaction.
 * The first SELECT starts SQLite's snapshot before schema or health rows are queried.
 */
export async function readExportSnapshot(
  database: ExportSnapshotDatabase,
): Promise<ExportSnapshot> {
  let snapshot!: ExportSnapshot;
  await database.withTransactionAsync(async () => {
    await database.getAllAsync<{ readonly snapshot_pin: number }>('SELECT 1 AS snapshot_pin;');
    const { schemaVersion } = await assertExportSchemaComplete(database);
    const tables: ExportSnapshotTable[] = [];
    for (const decision of includedDecisions()) {
      tables.push(
        decision.name === 'app_preferences'
          ? await readPreferences(database, decision)
          : await readTable(database, decision),
      );
    }
    snapshot = { schemaVersion, tables };
  });
  return snapshot;
}
