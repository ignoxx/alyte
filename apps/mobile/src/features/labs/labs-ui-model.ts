export function labsShowsManualRecordAction(reportCount: number, recordCount: number): boolean {
  return reportCount > 0 || recordCount > 0;
}
