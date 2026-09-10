import type { LabRecord, LabReport } from '@alyte/domain';

export type OpenDraftReference = {
  readonly reportId: string;
  readonly draftId: string;
};

export type LabsAttentionItem = {
  readonly report: LabReport;
  readonly draftId?: string;
  readonly kind: 'review-draft' | 'continue-report';
};

export type LabsWorkspaceModel = {
  readonly attention: readonly LabsAttentionItem[];
  /** Completed reports that are not already represented by the attention queue. */
  readonly reports: readonly LabReport[];
  /** All records remain available to report detail and trend builders. */
  readonly records: readonly LabRecord[];
  /** Manual records and records whose source report was deleted. */
  readonly standaloneRecords: readonly LabRecord[];
  readonly reportCount: number;
  readonly reviewedResultCount: number;
};

function reportOrder(left: LabReport, right: LabReport): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated === 0 ? right.id.localeCompare(left.id) : updated;
}

function recordDate(record: LabRecord): string {
  return record.collectionDate.kind === 'known' ? record.collectionDate.value : '';
}

function recordOrder(left: LabRecord, right: LabRecord): number {
  const dates = recordDate(right).localeCompare(recordDate(left));
  return dates === 0 ? right.id.localeCompare(left.id) : dates;
}

function reportNeedsAttention(report: LabReport): boolean {
  return (
    report.importState !== 'deleted' &&
    (report.importState !== 'imported' || report.labRecordIds.length === 0)
  );
}

/**
 * Keep Labs chronology and its work queue deterministic. Open extraction drafts outrank source
 * recovery because they are already closest to confirmed Measurements. This changes presentation
 * only; report and extraction lifecycle state remains owned by the existing services.
 */
export function buildLabsWorkspaceModel(
  reports: readonly LabReport[],
  records: readonly LabRecord[],
  drafts: readonly OpenDraftReference[],
): LabsWorkspaceModel {
  const activeReports = reports
    .filter((report) => report.importState !== 'deleted')
    .sort(reportOrder);
  const reportById = new Map(activeReports.map((report) => [report.id, report]));
  const draftReportIds = new Set(drafts.map((draft) => draft.reportId));
  const draftAttention = drafts
    .flatMap((draft): LabsAttentionItem[] => {
      const report = reportById.get(draft.reportId);
      return report === undefined ? [] : [{ report, draftId: draft.draftId, kind: 'review-draft' }];
    })
    .sort((left, right) => reportOrder(left.report, right.report));
  const reportAttention = activeReports
    .filter((report) => !draftReportIds.has(report.id) && reportNeedsAttention(report))
    .map((report): LabsAttentionItem => ({ report, kind: 'continue-report' }))
    .sort((left, right) => reportOrder(left.report, right.report));
  const attentionReportIds = new Set(
    [...draftAttention, ...reportAttention].map((item) => item.report.id),
  );
  const activeReportIds = new Set(activeReports.map((report) => report.id));
  const orderedRecords = [...records].sort(recordOrder);

  return {
    attention: [...draftAttention, ...reportAttention],
    reports: activeReports.filter((report) => !attentionReportIds.has(report.id)),
    records: orderedRecords,
    standaloneRecords: orderedRecords.filter(
      (record) => record.labReportId === null || !activeReportIds.has(record.labReportId),
    ),
    reportCount: activeReports.length,
    reviewedResultCount: records.reduce(
      (count, record) =>
        count +
        record.measurements.filter((measurement) => measurement.reviewState === 'confirmed').length,
      0,
    ),
  };
}
