import type { MigrationDatabase } from '../local-database/migrations';

/** The public contract for a portable Alyte export. */
export const EXPORT_MANIFEST_VERSION = 'alyte.export.manifest.v1' as const;
export const EXPORT_TABLE_VERSION = 'alyte.export.table.v1' as const;
export const EXPORT_VERSION = '1.0.0' as const;
export const SANITIZATION_VERSION = 'alyte.sanitization.v1' as const;

export const EXPORT_MEDIA_CATEGORIES = [
  'original-reports',
  'sanitized-reports',
  'intake-images',
] as const;
export type ExportMediaCategory = (typeof EXPORT_MEDIA_CATEGORIES)[number];

export type ExportSelection = {
  readonly originalReportIds?: readonly string[];
  readonly sanitizedReportDerivativeIds?: readonly string[];
  /** Intake Image IDs are the owning Intake Event IDs in the current schema. */
  readonly intakeImageEventIds?: readonly string[];
};

export type ExportTableName =
  | 'lab_reports'
  | 'lab_report_pages'
  | 'sanitized_report_derivatives'
  | 'lab_records'
  | 'measurements'
  | 'measurement_corrections'
  | 'extraction_drafts'
  | 'extraction_draft_rows'
  | 'intake_events'
  | 'intake_components'
  | 'cloud_jobs'
  | 'intake_capture_recovery'
  | 'lab_combined_deletions'
  | 'app_preferences';

export type ExportControlTableName = 'schema_migrations' | 'local_export_jobs';

export type ExportColumnDecision = {
  readonly name: string;
  readonly decision: 'include' | 'exclude';
};

export type ExportTableDecision = {
  readonly name: string;
  readonly decision: 'include' | 'exclude';
  readonly columns: readonly ExportColumnDecision[];
};

const included = (name: string): ExportColumnDecision => ({ name, decision: 'include' });
const includedTable = (name: ExportTableName, columns: readonly string[]): ExportTableDecision => ({
  name,
  decision: 'include',
  columns: columns.map(included),
});
const excludedTable = (name: ExportControlTableName): ExportTableDecision => ({
  name,
  decision: 'exclude',
  columns: [],
});

/**
 * This is deliberately explicit rather than inferred from repositories. Adding a persisted table
 * or column without making an intentional export decision fails the snapshot completeness guard.
 */
export const EXPORT_SCHEMA_DECISIONS: readonly ExportTableDecision[] = [
  includedTable('lab_reports', [
    'id',
    'source_type',
    'original_filename',
    'mime_type',
    'byte_size',
    'source_hash',
    'original_path',
    'import_state',
    'failure_reason',
    'encrypted',
    'page_count',
    'created_at',
    'updated_at',
    'imported_at',
    'deletion_state',
    'deletion_requested_at',
    'deletion_error',
  ]),
  includedTable('lab_report_pages', [
    'id',
    'report_id',
    'page_index',
    'width',
    'height',
    'rotation',
    'crop',
    'derived_path',
  ]),
  includedTable('sanitized_report_derivatives', [
    'id',
    'report_id',
    'recipe_json',
    'recipe_hash',
    'artifact_path',
    'artifact_hash',
    'byte_size',
    'verification_state',
    'verification_json',
    'failure_reason',
    'created_at',
    'updated_at',
    'deleted_at',
  ]),
  includedTable('lab_records', [
    'id',
    'collection_date',
    'date_state',
    'specimen_type',
    'laboratory_name',
    'notes',
    'created_at',
    'updated_at',
    'lab_report_id',
  ]),
  includedTable('measurements', [
    'id',
    'lab_record_id',
    'biomarker_id',
    'specimen_type',
    'original_label',
    'original_value_string',
    'original_value_json',
    'original_unit',
    'original_reference_interval',
    'original_flag',
    'current_label',
    'current_value_string',
    'current_value_json',
    'current_unit',
    'current_reference_interval',
    'current_flag',
    'provenance',
    'review_state',
    'created_at',
    'updated_at',
    'source_page_index',
    'source_bbox_json',
    'source_orientation',
    'panel_label',
    'original_state_json',
  ]),
  includedTable('measurement_corrections', [
    'id',
    'measurement_id',
    'corrected_at',
    'reason',
    'previous_json',
    'next_json',
    'previous_provenance',
  ]),
  includedTable('extraction_drafts', [
    'id',
    'report_id',
    'state',
    'ocr_contract_version',
    'parser_version',
    'collection_date',
    'date_state',
    'created_at',
    'updated_at',
    'confirmed_at',
  ]),
  includedTable('extraction_draft_rows', [
    'id',
    'draft_id',
    'row_order',
    'panel_label',
    'source_text',
    'source_label',
    'source_value_string',
    'source_unit',
    'source_reference_interval',
    'source_flag',
    'source_page_index',
    'source_bbox_json',
    'source_orientation',
    'proposed_label',
    'proposed_value_json',
    'proposed_unit',
    'proposed_reference_interval',
    'proposed_flag',
    'proposed_biomarker_id',
    'proposed_specimen_type',
    'collection_date',
    'date_state',
    'review_reasons_json',
    'review_state',
    'source_value_json',
    'date_context_json',
    'decision',
  ]),
  includedTable('intake_events', [
    'id',
    'event_type',
    'occurred_at',
    'local_date',
    'origin',
    'provenance',
    'review_state',
    'analysis_inclusion',
    'notes',
    'source_media_path',
    'source_media_hash',
    'source_media_size',
    'source_media_protection_json',
    'copied_from_event_id',
    'log_again_undoable',
    'created_at',
    'updated_at',
  ]),
  includedTable('intake_components', [
    'id',
    'event_id',
    'canonical_id',
    'original_name',
    'original_amount_json',
    'current_name',
    'current_amount_json',
    'provenance',
    'review_state',
    'created_at',
    'updated_at',
  ]),
  includedTable('cloud_jobs', [
    'id',
    'event_id',
    'operation',
    'media_path',
    'state',
    'consent_policy_version',
    'failure_category',
    'created_at',
    'updated_at',
    'submitted_at',
    'cancelled_at',
  ]),
  includedTable('intake_capture_recovery', [
    'capture_id',
    'event_id',
    'media_path',
    'media_hash',
    'media_size',
    'media_protection_json',
    'event_json',
    'cloud_mode',
    'consent_policy_version',
    'state',
    'failure_category',
    'created_at',
    'updated_at',
  ]),
  includedTable('lab_combined_deletions', [
    'id',
    'record_id',
    'report_id',
    'state',
    'created_at',
    'updated_at',
  ]),
  // Only explicitly approved interpretation provenance keys are read from this table. The table's
  // other rows (onboarding, cloud consent, and sanitization drafts) are intentionally omitted.
  includedTable('app_preferences', ['key', 'value', 'updated_at']),
  excludedTable('schema_migrations'),
  excludedTable('local_export_jobs'),
] as const;

export const EXPORT_INTERPRETATION_PREFERENCE_KEYS = [
  'catalogue.version',
  'catalogue.artifact-version',
  'catalogue.content-version',
  'ocr.contract-version',
  'parser.version',
  'sanitization.version',
  'semantic-model.version',
] as const;

const CSV_TABLES = new Set<ExportTableName>([
  'lab_records',
  'measurements',
  'intake_events',
  'intake_components',
]);

export type ExportSnapshotTable = {
  readonly name: ExportTableName;
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
};

export type ExportSnapshot = {
  readonly schemaVersion: number;
  readonly tables: readonly ExportSnapshotTable[];
};

export type ExportOutputDescriptor = {
  readonly path: string;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
};

export type ExportMediaFile = {
  readonly category: ExportMediaCategory;
  readonly id: string;
  readonly sourcePath: string | null;
  readonly archivePath: string;
  readonly status: 'present' | 'missing';
  readonly bytes: number | null;
  readonly sha256: string | null;
};

export type ExportManifest = {
  readonly schemaVersion: typeof EXPORT_MANIFEST_VERSION;
  readonly exportVersion: typeof EXPORT_VERSION;
  readonly appVersion: string;
  readonly localSchemaVersion: number;
  readonly catalogueVersion: string | null;
  readonly ocrContractVersion: string | null;
  readonly parserVersion: string | null;
  readonly sanitizationVersion: string;
  readonly createdAt: string;
  readonly locale: string;
  readonly included: {
    readonly categories: readonly string[];
    readonly media: Readonly<Record<ExportMediaCategory, boolean>>;
  };
  readonly tables: readonly { readonly name: ExportTableName; readonly rows: number }[];
  readonly outputs: readonly ExportOutputDescriptor[];
  readonly media: {
    readonly selected: number;
    readonly present: number;
    readonly missing: number;
    readonly files: readonly ExportMediaFile[];
  };
  readonly archive: { readonly sha256: string; readonly bytes: number } | null;
};

export type ExportTextOutput = {
  readonly path: string;
  readonly content: string;
  readonly rows: number;
};

function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, stableValue(record[key])]),
  );
}

/** Canonical JSON is UTF-8, LF terminated, and has deterministic object-key ordering. */
export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(stableValue(value));
  if (encoded === undefined) throw new Error('Export JSON value is not serializable');
  return `${encoded}\n`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? canonicalJson(value).slice(0, -1)
        : String(value);
  // Preserve leading whitespace/BOM while inserting the apostrophe immediately before a formula
  // marker. JSON is deliberately untouched; this rule applies only to human CSV output.
  const leading = raw.match(/^[\s\uFEFF]*/u)?.[0] ?? '';
  const neutralized = /^[=+\-@]/u.test(raw.slice(leading.length))
    ? `${leading}'${raw.slice(leading.length)}`
    : raw;
  return `"${neutralized.replaceAll('"', '""')}"`;
}

export function tableCsv(table: ExportSnapshotTable): string {
  const header = table.columns.map(csvCell).join(',');
  const rows = table.rows.map((row) =>
    table.columns.map((column) => csvCell(row[column])).join(','),
  );
  return `${[header, ...rows].join('\n')}\n`;
}

export function tableJson(table: ExportSnapshotTable): string {
  return canonicalJson({
    schemaVersion: EXPORT_TABLE_VERSION,
    table: table.name,
    columns: table.columns,
    rows: table.rows.map((row) => table.columns.map((column) => row[column] ?? null)),
  });
}

export function exportTextOutputs(snapshot: ExportSnapshot): readonly ExportTextOutput[] {
  const outputs: ExportTextOutput[] = [];
  for (const table of snapshot.tables) {
    const stem = table.name.replaceAll('_', '-');
    outputs.push({ path: `data/${stem}.json`, content: tableJson(table), rows: table.rows.length });
    if (CSV_TABLES.has(table.name)) {
      outputs.push({ path: `csv/${stem}.csv`, content: tableCsv(table), rows: table.rows.length });
    }
  }
  return outputs;
}

export function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function manifestJson(manifest: ExportManifest): string {
  return canonicalJson(manifest);
}

export function tableDecision(name: string): ExportTableDecision | undefined {
  return EXPORT_SCHEMA_DECISIONS.find((decision) => decision.name === name);
}

export function includedTableDecisions(): readonly ExportTableDecision[] {
  return EXPORT_SCHEMA_DECISIONS.filter((decision) => decision.decision === 'include');
}

export type ExportSnapshotDatabase = Pick<MigrationDatabase, 'execAsync' | 'getAllAsync'> & {
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
};
