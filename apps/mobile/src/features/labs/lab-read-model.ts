import type { LabDateState, LabRecord, LabReport } from '@alyte/domain';

export type LabReportSummary = {
  readonly collectionDate: LabDateState;
  readonly measurementCount: number;
};

/**
 * Keep source-backed report summaries in one read-model seam. Screens should not need to walk
 * linked records to decide which date and Measurement count to show.
 */
export function summarizeLabReport(
  report: LabReport,
  records: readonly LabRecord[],
): LabReportSummary {
  const linkedRecords = records.filter((record) => report.labRecordIds.includes(record.id));
  const knownDates = linkedRecords
    .flatMap((record) =>
      record.collectionDate.kind === 'known' ? [record.collectionDate.value] : [],
    )
    .sort((left, right) => right.localeCompare(left));

  return {
    collectionDate:
      knownDates[0] === undefined ? { kind: 'missing' } : { kind: 'known', value: knownDates[0] },
    measurementCount: linkedRecords.reduce(
      (count, record) => count + record.measurements.length,
      0,
    ),
  };
}
