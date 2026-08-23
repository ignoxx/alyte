export function formatReportPageCount(
  label: string,
  pageCount: number | null,
  unknownLabel: string,
): string {
  return label.replace('{count}', pageCount === null ? unknownLabel : String(pageCount));
}
