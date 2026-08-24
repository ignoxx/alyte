import { comparableBiomarkers } from '@alyte/catalogue';
import {
  buildMeasuredTrend,
  classifyMeasuredPointChange,
  canonicalId,
  type IntakeEvent,
  type LabDateState,
  type LabRecord,
  type LabReport,
  type MeasuredTrendPoint,
} from '@alyte/domain';
import { listHistoryEntries } from '../labs/biomarker-history-model';
import { summarizeLabReport } from '../labs/lab-read-model';

/**
 * Home requests one device-local day. Keep ordering pure so the screen remains a small composition
 * of the day query and the timeline row view.
 */
export function sortHomeTimeline(events: readonly IntakeEvent[]): readonly IntakeEvent[] {
  return [...events].sort(
    (left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
  );
}

export function homeHasLocalHistory(
  allIntakeEvents: readonly IntakeEvent[],
  reportCount: number,
): boolean {
  return allIntakeEvents.length > 0 || reportCount > 0;
}

export type HomeReportRow = {
  readonly kind: 'report' | 'record';
  readonly id: string;
  readonly title: string | null;
  readonly date: LabDateState;
  readonly measurementCount: number;
  readonly sourceType: LabReport['sourceType'] | null;
};

export type HomeMeasuredChange = {
  readonly biomarkerId: string;
  readonly label: string;
  readonly previous: MeasuredTrendPoint;
  readonly latest: MeasuredTrendPoint;
  readonly direction: 'increased' | 'decreased' | 'stable';
};

export type HomeLabViewModel = {
  readonly latestReport: HomeReportRow | null;
  readonly recentReports: readonly HomeReportRow[];
  readonly recentRecords: readonly HomeReportRow[];
  readonly pendingImports: readonly LabReport[];
  readonly openDraftCount: number;
  readonly reviewCount: number;
  readonly measuredChanges: readonly HomeMeasuredChange[];
};

function knownDate(row: HomeReportRow): string {
  return row.date.kind === 'known' ? row.date.value : '';
}

function reportRow(report: LabReport, records: readonly LabRecord[]): HomeReportRow {
  const summary = summarizeLabReport(report, records);
  return {
    kind: 'report',
    id: report.id,
    title: report.originalFilename,
    date: summary.collectionDate,
    measurementCount: summary.measurementCount,
    sourceType: report.sourceType,
  };
}

function recordRow(record: LabRecord): HomeReportRow {
  return {
    kind: 'record',
    id: record.id,
    title: record.laboratoryName,
    date: record.collectionDate,
    measurementCount: record.measurements.length,
    sourceType: null,
  };
}

function compareHomeRows(left: HomeReportRow, right: HomeReportRow): number {
  const leftDate = knownDate(left);
  const rightDate = knownDate(right);
  if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
  return right.id.localeCompare(left.id);
}

function latestPoints(
  points: readonly MeasuredTrendPoint[],
): { readonly previous: MeasuredTrendPoint; readonly latest: MeasuredTrendPoint } | null {
  if (points.length < 2) return null;
  const previous = points[points.length - 2];
  const latest = points[points.length - 1];
  return previous === undefined || latest === undefined ? null : { previous, latest };
}

/**
 * Home's Quiet summary is derived only from persisted Lab Reports and confirmed compatible
 * Measurements. No concrete value is inferred for records without a compatible measured point.
 */
export function buildHomeLabViewModel(
  reports: readonly LabReport[],
  records: readonly LabRecord[],
  openDraftCount = 0,
): HomeLabViewModel {
  const reportRows = reports
    .filter((report) => report.importState !== 'deleted')
    .map((report) => reportRow(report, records))
    .sort(compareHomeRows);
  const sourceRecordIds = new Set(
    reports
      .filter((report) => report.importState !== 'deleted')
      .flatMap((report) => report.labRecordIds),
  );
  const recentRecords = records
    .filter((record) => record.labReportId === null && !sourceRecordIds.has(record.id))
    .map(recordRow)
    .sort(compareHomeRows)
    .slice(0, 3);
  const recentReports = reportRows.slice(0, 3);
  const latestReport = reportRows[0] ?? null;
  const pendingImports = reports.filter(
    (report) => report.importState !== 'imported' && report.importState !== 'deleted',
  );
  const reviewCount = records.reduce(
    (count, record) =>
      count +
      record.measurements.filter((measurement) => measurement.reviewState === 'needs-review')
        .length,
    0,
  );

  const measuredChanges = listHistoryEntries(records)
    .flatMap((entry): HomeMeasuredChange[] => {
      const trend = buildMeasuredTrend(
        records,
        canonicalId(entry.biomarkerId),
        comparableBiomarkers,
      );
      const points = latestPoints(trend.points);
      if (points === null) return [];
      const direction = classifyMeasuredPointChange(points.previous, points.latest);
      return [
        { biomarkerId: entry.biomarkerId, label: entry.canonicalLabel, ...points, direction },
      ];
    })
    .sort((left, right) => {
      const dateOrder = right.latest.collectionDate.localeCompare(left.latest.collectionDate);
      return dateOrder === 0 ? left.label.localeCompare(right.label) : dateOrder;
    })
    .slice(0, 3);

  return {
    latestReport,
    recentReports,
    recentRecords,
    pendingImports,
    openDraftCount: Math.max(0, openDraftCount),
    reviewCount,
    measuredChanges,
  };
}
