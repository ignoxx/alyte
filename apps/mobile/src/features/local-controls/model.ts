import type { ExportSelection } from '../export/export-contract';

export const LOCAL_DELETION_SCOPES = [
  'reports',
  'records',
  'events',
  'media',
  'all-health',
  'reset-app',
] as const;
export type LocalDeletionScope = (typeof LOCAL_DELETION_SCOPES)[number];

export type LocalDataCounts = {
  readonly reports: number;
  readonly reportPages: number;
  readonly sanitizedReports: number;
  readonly records: number;
  readonly measurements: number;
  readonly corrections: number;
  readonly extractionDrafts: number;
  readonly extractionRows: number;
  readonly intakeEvents: number;
  readonly intakeComponents: number;
  readonly intakeImages: number;
  readonly cloudJobs: number;
  readonly captureRecoveries: number;
  readonly combinedDeletions: number;
  readonly exportJobs: number;
  readonly sanitizationDrafts: number;
};

export const EMPTY_LOCAL_DATA_COUNTS: LocalDataCounts = {
  reports: 0,
  reportPages: 0,
  sanitizedReports: 0,
  records: 0,
  measurements: 0,
  corrections: 0,
  extractionDrafts: 0,
  extractionRows: 0,
  intakeEvents: 0,
  intakeComponents: 0,
  intakeImages: 0,
  cloudJobs: 0,
  captureRecoveries: 0,
  combinedDeletions: 0,
  exportJobs: 0,
  sanitizationDrafts: 0,
};

export type LocalDataSummary = {
  readonly counts: LocalDataCounts;
  readonly generatedAt: string;
};

export type DeletionPlan = {
  readonly scope: LocalDeletionScope;
  readonly planHash: string;
  readonly counts: LocalDataCounts;
  readonly willRemain: LocalDataCounts;
  readonly targetIds: {
    readonly reportIds: readonly string[];
    readonly recordIds: readonly string[];
    readonly measurementIds: readonly string[];
    readonly eventIds: readonly string[];
  };
  readonly fileReferences: readonly {
    readonly category:
      | 'original-report'
      | 'report-page'
      | 'sanitized-report'
      | 'intake-image'
      | 'cloud-job-media'
      | 'capture-recovery-media'
      | 'export';
    readonly path: string;
    /** Stable owning row identity used only for deletion refcounting. */
    readonly ownerId: string | null;
  }[];
  readonly sanitizationDraftKeys: readonly string[];
};

export type DeletionResult = {
  readonly state: 'completed' | 'failed';
  readonly operationId: string;
  readonly failureCategories: readonly LocalDeletionFailureCategory[];
};

export const LOCAL_DELETION_FAILURE_CATEGORIES = [
  'database-failed',
  'database-hygiene-pending',
  'file-failed',
  'unowned-path',
  'orphan-cleanup-failed',
  'stale-preview',
  'unknown',
] as const;
export type LocalDeletionFailureCategory = (typeof LOCAL_DELETION_FAILURE_CATEGORIES)[number];

export type ExportMediaSummary = {
  readonly selection: ExportSelection;
  readonly counts: {
    readonly originalReports: number;
    readonly sanitizedReports: number;
    readonly intakeImages: number;
  };
};

/** Small stable serializer used for the deletion plan binding, not for cryptographic security. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

/** Deterministic, non-secret fingerprint so a preview cannot be applied to a changed snapshot. */
export function localDeletionPlanHash(value: unknown): string {
  const source = stableJson(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const character = source.charCodeAt(index);
    first = Math.imul(first ^ character, 0x01000193);
    second = Math.imul(second ^ (character + index), 0x85ebca6b);
  }
  return `plan-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`;
}

export function subtractCounts(
  counts: LocalDataCounts,
  deleted: Partial<LocalDataCounts>,
): LocalDataCounts {
  return (Object.keys(EMPTY_LOCAL_DATA_COUNTS) as (keyof LocalDataCounts)[]).reduce(
    (result, key) => ({ ...result, [key]: Math.max(0, counts[key] - (deleted[key] ?? 0)) }),
    {} as LocalDataCounts,
  );
}
