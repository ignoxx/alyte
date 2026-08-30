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
  readonly reports: readonly LabReport[];
  readonly records: readonly LabRecord[];
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

  return {
    attention: [...draftAttention, ...reportAttention],
    reports: activeReports,
    records: [...records].sort(recordOrder),
  };
}
