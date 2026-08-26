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
  /** The newest confirmed Lab Record, including records linked to an Original Report. */
  readonly latestRecord: HomeReportRow | null;
  readonly recentReports: readonly HomeReportRow[];
  readonly recentRecords: readonly HomeReportRow[];
  /** Source reports whose local import/review journey has not reached a confirmed Lab Record. */
  readonly unfinishedReports: readonly LabReport[];
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

function compareUnfinishedReports(left: LabReport, right: LabReport): number {
  const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedOrder !== 0) return updatedOrder;
  const createdOrder = right.createdAt.localeCompare(left.createdAt);
  return createdOrder === 0 ? right.id.localeCompare(left.id) : createdOrder;
}

/**
 * A Lab Report remains unfinished until its source/import state and confirmed record link say
 * otherwise. This deliberately returns source state, rather than relabelling it as extracted or
 * measured, so the existing Labs detail flow can choose retry, sanitization, extraction, or review.
 */
export function isUnfinishedLabReport(report: LabReport): boolean {
  return (
    report.importState !== 'deleted' &&
    (report.importState !== 'imported' || report.labRecordIds.length === 0)
  );
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
  const latestRecord = records.map(recordRow).sort(compareHomeRows)[0] ?? null;
  const sourceRecordIds = new Set(
    reports
      .filter((report) => report.importState !== 'deleted')
      .flatMap((report) => report.labRecordIds),
  );
  const recentRecords = records
    // A source record is normally represented by its active Lab Report. If that source is deleted,
    // keep the surviving Lab Record discoverable rather than making Home look empty.
    .filter((record) => record.labReportId === null || !sourceRecordIds.has(record.id))
    .map(recordRow)
    .sort(compareHomeRows)
    .slice(0, 3);
  const recentReports = reportRows.slice(0, 3);
  const latestReport = reportRows[0] ?? null;
  const unfinishedReports = reports.filter(isUnfinishedLabReport).sort(compareUnfinishedReports);
  // Keep the existing pending-import read-model field useful to the Home summary: an imported
  // source without a confirmed record is still pending the local laboratory journey.
  const pendingImports = unfinishedReports;
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
    latestRecord,
    recentReports,
    recentRecords,
    unfinishedReports,
    pendingImports,
    openDraftCount: Math.max(0, openDraftCount),
    reviewCount,
    measuredChanges,
  };
}
