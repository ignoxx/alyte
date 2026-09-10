import {
  extractionReviewRequiresAttention,
  type ExtractionDraftRow,
  type ExtractionRowDecision,
  type LabDateState,
} from '@alyte/domain';
import { findCatalogueBiomarker } from '@alyte/catalogue';
import {
  extractionConfirmationSummary,
  extractionReviewQueueIncludes,
} from './ExtractionConfirmation.shared';
import { extractionFailurePresentation } from './extraction-progress-presentation';
import { t } from '../../localization';

export {
  extractionConfirmationPresentation,
  extractionConfirmationSummary,
  extractionReviewQueueIncludes,
  type ExtractionConfirmationBlockReason,
  type ExtractionConfirmationAction,
  type ExtractionConfirmationActionKind,
  type ExtractionConfirmationPresentation,
  type ExtractionConfirmationState,
  type ExtractionConfirmationSummary,
} from './ExtractionConfirmation.shared';

export type ExtractionReviewFilter = 'all' | 'needs-review';

type ExtractionFailureReason = Parameters<typeof extractionFailurePresentation>[0];

const EXTRACTION_FAILURE_REASONS = [
  'sanitized-source',
  'recognition',
  'no-reviewable-measurements',
  'original-source',
  'persistence',
  'wrong-password',
  'model-unavailable',
  'cancelled',
  'interrupted',
  'improve-deferred',
] as const satisfies readonly ExtractionFailureReason[];

function extractionFailureReason(error: unknown): ExtractionFailureReason | null {
  if (typeof error !== 'object' || error === null || !('reason' in error)) return null;
  const reason = error.reason;
  return typeof reason === 'string' &&
    (EXTRACTION_FAILURE_REASONS as readonly string[]).includes(reason)
    ? (reason as ExtractionFailureReason)
    : null;
}

/** Keep retryable draft actions specific without exposing arbitrary provider/runtime errors. */
export function extractionDraftActionError(error: unknown): string {
  const reason = extractionFailureReason(error);
  return t(
    reason === null
      ? 'labs.extractionRefreshError'
      : extractionFailurePresentation(reason).messageKey,
  );
}

/**
 * Tapping Include on an uncertain automatic row is an explicit review decision. Persist the
 * visible fields through the correction boundary even when the person did not type, so the row
 * can be revalidated and the confirmation is recorded instead of being rejected as still
 * automatic. Skipping never rewrites the extracted source-shaped proposal.
 */
export function extractionDecisionRequiresSubmission(
  row: Pick<ExtractionDraftRow, 'reviewReasons'>,
  decision: ExtractionRowDecision,
  dirty: boolean,
): boolean {
  return decision !== 'skip' && (dirty || extractionReviewRequiresAttention(row));
}

export function pickerValueFromLabDate(date: LabDateState, fallback = new Date()): Date {
  if (date.kind === 'missing') return fallback;
  const [year, month, day] = date.value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return fallback;
  // Noon avoids a date rollover if UIKit or JavaScript crosses a daylight-saving boundary.
  return new Date(year, month - 1, day, 12);
}

export function labDateFromPickerValue(date: Date): LabDateState {
  return {
    kind: 'known',
    value: `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
  };
}

const COMMON_LAB_UNITS = [
  '%',
  'mg/dL',
  'mmol/L',
  'g/dL',
  'g/L',
  'mg/L',
  'µg/L',
  'ng/mL',
  'pg/mL',
  'nmol/L',
  'pmol/L',
  'µmol/L',
  'U/L',
  'IU/L',
  'mIU/L',
  'µIU/mL',
  'ng/dL',
  'pg/dL',
  'fL',
  'pg',
  '10^3/µL',
  '10^6/µL',
  '10^9/L',
  'cells/µL',
  'mm/h',
  'mL/min/1.73 m²',
  'ratio',
] as const;

export type ExtractionUnitOptions = {
  readonly suggested: readonly string[];
  readonly common: readonly string[];
};

function uniqueUnits(units: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  return units.flatMap((unit) => {
    const value = unit?.trim() ?? '';
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) return [];
    seen.add(key);
    return [value];
  });
}

/**
 * Unit choices only edit the source-shaped proposal. They never convert the observed value.
 * Resolved catalogue units lead, while the exact extracted/current unit remains available even
 * when it is unsupported so provenance is not hidden by the convenience control.
 */
export function extractionUnitOptions(
  row: Pick<ExtractionDraftRow, 'proposedBiomarkerId' | 'proposedUnit' | 'sourceUnit'>,
): ExtractionUnitOptions {
  const catalogue =
    row.proposedBiomarkerId === null ? null : findCatalogueBiomarker(row.proposedBiomarkerId);
  const suggested = uniqueUnits([row.proposedUnit, row.sourceUnit, ...(catalogue?.units ?? [])]);
  const suggestedKeys = new Set(suggested.map((unit) => unit.toLocaleLowerCase()));
  return {
    suggested,
    common: uniqueUnits(COMMON_LAB_UNITS).filter(
      (unit) => !suggestedKeys.has(unit.toLocaleLowerCase()),
    ),
  };
}

export function extractionBlockingRowIds(
  rows: readonly Pick<ExtractionDraftRow, 'id' | 'decision' | 'reviewReasons'>[],
): readonly string[] {
  return rows.filter(extractionReviewQueueIncludes).map((row) => row.id);
}

export function nextExtractionBlockingRowId(
  rows: readonly Pick<ExtractionDraftRow, 'id' | 'decision' | 'reviewReasons'>[],
  queue: readonly string[],
  currentId: string,
): string | null {
  const stillBlocking = new Set(extractionBlockingRowIds(rows));
  const currentIndex = queue.indexOf(currentId);
  const ordered =
    currentIndex < 0 ? queue : [...queue.slice(currentIndex + 1), ...queue.slice(0, currentIndex)];
  return ordered.find((id) => stillBlocking.has(id)) ?? null;
}

export type ExtractionConfirmationDestination =
  | {
      readonly kind: 'record';
      readonly route: 'LabRecordDetail';
      readonly recordId: string;
    }
  | {
      readonly kind: 'labs';
    };

/**
 * A single confirmed Lab Record can be opened directly. When one draft creates more than one
 * record, return to the existing Labs root so every newly created record is visible together.
 */
export function extractionConfirmationDestination(
  records: readonly { readonly id: string }[],
): ExtractionConfirmationDestination {
  if (records.length === 1) {
    return { kind: 'record', route: 'LabRecordDetail', recordId: records[0]!.id };
  }
  if (records.length > 1) return { kind: 'labs' };
  throw new Error('No Lab Records were created');
}

export type ExtractionSourcePresentation = {
  readonly artifactKind: 'original' | 'sanitized' | 'unavailable';
  readonly labelKey:
    | 'labs.extractionOriginalReport'
    | 'labs.extractionSanitizedReport'
    | 'labs.extractionSourceUnavailable';
  readonly regionKey:
    | 'labs.extractionOriginalRegion'
    | 'labs.extractionSanitizedPageRegion'
    | 'labs.extractionSourceUnavailable';
};

/**
 * Source copy follows the persisted artifact on the row. A missing artifact stays explicit rather
 * than being treated as Sanitized Report because the current workflow happens to be local.
 */
export function extractionSourcePresentation(
  row: Pick<ExtractionDraftRow, 'source'>,
): ExtractionSourcePresentation {
  switch (row.source.artifact?.kind) {
    case 'original':
      return {
        artifactKind: 'original',
        labelKey: 'labs.extractionOriginalReport',
        regionKey: 'labs.extractionOriginalRegion',
      };
    case 'sanitized':
      return {
        artifactKind: 'sanitized',
        labelKey: 'labs.extractionSanitizedReport',
        regionKey: 'labs.extractionSanitizedPageRegion',
      };
    default:
      return {
        artifactKind: 'unavailable',
        labelKey: 'labs.extractionSourceUnavailable',
        regionKey: 'labs.extractionSourceUnavailable',
      };
  }
}

export function extractionSourcePreviewRequestAllowed(input: {
  readonly pending: boolean;
  readonly busy: boolean;
  readonly artifactKind: ExtractionSourcePresentation['artifactKind'];
}): boolean {
  return !input.pending && !input.busy && input.artifactKind !== 'unavailable';
}

export type ExtractionReviewSection = {
  readonly key: string;
  readonly collectionDateLabel: string | null;
  readonly collectionDate: ExtractionDraftRow['collectionDate'];
  readonly dateDefaulted: boolean;
  readonly specimenType: ExtractionDraftRow['proposedSpecimenType'];
  readonly panels: readonly {
    readonly label: string | null;
    readonly rows: readonly ExtractionDraftRow[];
  }[];
};

export function extractionNeedsResolution(row: Pick<ExtractionDraftRow, 'reviewReasons'>): boolean {
  return extractionReviewRequiresAttention(row);
}

export type ExtractionDecisionPresentation = {
  readonly label: 'kept' | 'skipped' | 'resolved' | 'needs-decision';
  /** Review decisions stay visually neutral; they are not provenance or inclusion states. */
  readonly tone: 'neutral';
};

export function extractionDecisionPresentation(
  decision: ExtractionRowDecision,
): ExtractionDecisionPresentation {
  switch (decision) {
    case 'preserve':
      return { label: 'kept', tone: 'neutral' };
    case 'skip':
      return { label: 'skipped', tone: 'neutral' };
    case 'resolve':
      return { label: 'resolved', tone: 'neutral' };
    case 'unresolved':
      return { label: 'needs-decision', tone: 'neutral' };
  }
}

export function canConfirmExtraction(
  rows: readonly Pick<ExtractionDraftRow, 'decision' | 'reviewReasons'>[],
): boolean {
  return extractionConfirmationSummary(rows).canConfirm;
}

export function canConfirmCurrentExtraction(
  rows: readonly Pick<ExtractionDraftRow, 'decision' | 'reviewReasons'>[],
  pipelineStatus: 'current' | 'older' | 'newer' | 'unknown',
): boolean {
  return pipelineStatus === 'current' && canConfirmExtraction(rows);
}

export function extractionReviewCounts(
  rows: readonly Pick<ExtractionDraftRow, 'decision' | 'reviewReasons'>[],
): { readonly included: number; readonly needsReview: number } {
  const summary = extractionConfirmationSummary(rows);
  return { included: summary.included, needsReview: summary.needsReview };
}

export function filterExtractionRows(
  rows: readonly ExtractionDraftRow[],
  search: string,
  filter: ExtractionReviewFilter,
): readonly ExtractionDraftRow[] {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (filter === 'needs-review' && !extractionReviewQueueIncludes(row)) return false;
    if (!query) return true;
    const value = row.proposedValue;
    const proposedValue =
      value.kind === 'numeric'
        ? String(value.value)
        : value.kind === 'bounded'
          ? `${value.comparator}${value.value}`
          : value.value;
    return [
      row.proposedLabel,
      row.sourceLabel,
      row.sourceText,
      proposedValue,
      row.sourceValueString,
      row.proposedUnit,
      row.proposedReferenceInterval,
      row.proposedFlag,
      row.panelLabel,
    ]
      .filter((value): value is string => value !== null)
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
}

export function buildExtractionReviewSections(
  rows: readonly ExtractionDraftRow[],
): readonly ExtractionReviewSection[] {
  // Build the short review hierarchy in one pass. Copying every record/panel/row array for every
  // input row made switching All/Check increasingly expensive on large reports and needlessly
  // competed with the native SectionList for the same JS frame.
  type MutablePanel = { label: string | null; rows: ExtractionDraftRow[] };
  type MutableRecord = {
    key: string;
    collectionDateLabel: string | null;
    collectionDate: LabDateState;
    dateDefaulted: boolean;
    specimenType: ExtractionDraftRow['proposedSpecimenType'];
    panels: MutablePanel[];
  };
  const records = new Map<string, MutableRecord>();
  for (const row of rows) {
    const collectionDateLabel =
      row.collectionDate.kind === 'known' ? row.collectionDate.value : null;
    const key = `${collectionDateLabel ?? 'missing'}|${row.proposedSpecimenType}`;
    let record = records.get(key);
    if (record === undefined) {
      record = {
        key,
        collectionDateLabel,
        collectionDate: row.collectionDate,
        dateDefaulted: row.reviewReasons.includes('defaulted-collection-date'),
        specimenType: row.proposedSpecimenType,
        panels: [],
      };
      records.set(key, record);
    }
    let panel = record.panels.find((candidate) => candidate.label === row.panelLabel);
    if (panel === undefined) {
      panel = { label: row.panelLabel, rows: [] };
      record.panels.push(panel);
    }
    panel.rows.push(row);
    record.dateDefaulted =
      record.dateDefaulted || row.reviewReasons.includes('defaulted-collection-date');
  }
  return [...records.values()];
}

export function sourceRegionPresentation(row: Pick<ExtractionDraftRow, 'source'>) {
  return {
    pageIndex: row.source.pageIndex,
    boundingBox: row.source.boundingBox,
  } as const;
}
