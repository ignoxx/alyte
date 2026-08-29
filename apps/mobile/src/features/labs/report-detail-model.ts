import type { LabReport } from '@alyte/domain';

export type LabReportDetailState = 'loading' | 'error' | 'unavailable' | 'ready';

export type LabReportDetailRowLayout = 'inline' | 'stacked';

export type LabReportFailureRecovery = {
  readonly action: 'retry' | 'delete';
  readonly message: 'retained-source' | 'missing-source';
};

/**
 * Keep the metadata card compact at ordinary text sizes, while avoiding a two-column squeeze once
 * iOS enters its accessibility Dynamic Type ramp. The inline row still has bounded flex columns so
 * larger non-accessibility categories can wrap without relying on intrinsic text widths.
 */
export function getLabReportDetailRowLayout(fontScale: number): LabReportDetailRowLayout {
  return Number.isFinite(fontScale) && fontScale >= 1.3 ? 'stacked' : 'inline';
}

export function formatLabReportDetailRowAccessibilityLabel(label: string, value: string): string {
  return value.length > 0 ? `${label}: ${value}` : label;
}

/**
 * Keep an absent report distinct from a failed read. A report can disappear after Home has
 * queued navigation (for example, because it was deleted), and that state needs a way back.
 */
export function getLabReportDetailState(
  report: LabReport | null,
  loading: boolean,
  error: boolean,
): LabReportDetailState {
  if (loading) return 'loading';
  if (error) return 'error';
  return report === null ? 'unavailable' : 'ready';
}

/**
 * A failed import can offer local inspection retry only while both protected source facts remain.
 * Pathless rows are deletion-only so the UI never promises a retry against a source that cannot be
 * opened, nor claims that a source remains available.
 */
export function getLabReportFailureRecovery(
  report: Pick<LabReport, 'originalPath' | 'sourceHash'>,
): LabReportFailureRecovery {
  const canRetry = report.originalPath !== null && report.sourceHash !== null;
  return canRetry
    ? { action: 'retry', message: 'retained-source' }
    : { action: 'delete', message: 'missing-source' };
}

export function formatReportPageCount(
  label: string,
  pageCount: number | null,
  unknownLabel: string,
): string {
  return label.replace('{count}', pageCount === null ? unknownLabel : String(pageCount));
}

export type ReportFileSizeFormatOptions = {
  /** Localized fallback for a report whose source size was not recorded. */
  readonly unknownLabel?: string;
  /** Locale used for decimal separators and grouping. The runtime locale is used by default. */
  readonly locale?: string;
};

/**
 * Keep source-size units honest at the byte boundaries. Small reports are never rounded into an
 * unhelpful `0.0 MB`; formatting is delegated to Intl so decimal separators follow the locale.
 */
export function formatReportFileSize(
  byteSize: number | null,
  options: ReportFileSizeFormatOptions = {},
): string {
  const unknownLabel = options.unknownLabel ?? 'Unknown';
  if (byteSize === null || !Number.isFinite(byteSize) || byteSize < 0) return unknownLabel;

  const formatter = (value: number, maximumFractionDigits: number) =>
    new Intl.NumberFormat(options.locale, {
      maximumFractionDigits,
      minimumFractionDigits: maximumFractionDigits,
    }).format(value);

  if (byteSize < 1024) return `${formatter(byteSize, 0)} B`;
  if (byteSize < 1024 * 1024) return `${formatter(byteSize / 1024, 1)} KB`;
  return `${formatter(byteSize / (1024 * 1024), 1)} MB`;
}
