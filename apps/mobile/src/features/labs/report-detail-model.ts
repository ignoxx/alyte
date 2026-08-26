import type { LabReport } from '@alyte/domain';

export type LabReportDetailState = 'loading' | 'error' | 'unavailable' | 'ready';

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
