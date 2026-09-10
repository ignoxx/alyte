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

export type HomeLatestMeasurement = {
  readonly id: string;
  readonly recordId: string;
  readonly reportId: string | null;
  readonly biomarkerId: string | null;
  readonly label: string;
  readonly valueString: string;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
  readonly reviewState: 'confirmed' | 'needs-review';
  readonly collectionDate: LabDateState;
  readonly sourcePage: number | null;
};

export type HomeOpenExtractionDraft = {
  readonly reportId: string;
  readonly draftId: string;
};

export type HomeLabViewModel = {
  readonly latestReport: HomeReportRow | null;
  /** The newest Lab Record, including records linked to an Original Report. */
  readonly latestRecord: HomeReportRow | null;
  readonly recentReports: readonly HomeReportRow[];
  readonly recentRecords: readonly HomeReportRow[];
  /** Source reports whose local import/review journey still has an actionable next step. */
  readonly unfinishedReports: readonly LabReport[];
  readonly pendingImports: readonly LabReport[];
  readonly openDrafts: readonly HomeOpenExtractionDraft[];
  readonly openDraftCount: number;
  readonly reviewCount: number;
  readonly measuredChanges: readonly HomeMeasuredChange[];
  /** Results from the newest report or manual record that contains Measurements. */
  readonly latestMeasurements: readonly HomeLatestMeasurement[];
  readonly latestMeasurementReportId: string | null;
  readonly latestReviewRecordId: string | null;
  /** Reviewed local history coverage. These are counts, never health scores. */
  readonly reportCount: number;
  readonly recordCount: number;
  readonly measurementCount: number;
  readonly totalMeasurementCount: number;
  readonly biomarkerCount: number;
};

export type HomeMeasuredChangeColumnCount = 1 | 2;

const HOME_CHANGE_GRID_MINIMUM_WIDTH = 390;
const HOME_CHANGE_GRID_MAXIMUM_FONT_SCALE = 1.3;
const HOME_MEASURED_CHANGE_LIMIT = 4;

/**
 * Keep the biomarker overview visual at ordinary iPhone sizes, then return to a single reading
 * column when the viewport or Dynamic Type would make two cards compete for space.
 */
export function getHomeMeasuredChangeColumnCount(
  width: number,
  fontScale: number,
): HomeMeasuredChangeColumnCount {
  const normalizedWidth = Number.isFinite(width) && width > 0 ? width : 0;
  const normalizedFontScale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return normalizedWidth >= HOME_CHANGE_GRID_MINIMUM_WIDTH &&
    normalizedFontScale < HOME_CHANGE_GRID_MAXIMUM_FONT_SCALE
    ? 2
    : 1;
}

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

function reviewedMeasurements(record: LabRecord) {
  return record.measurements.filter((measurement) => measurement.reviewState === 'confirmed');
}

/**
 * Home's Quiet summary is derived only from persisted Lab Reports and confirmed compatible
 * Measurements. No concrete value is inferred for records without a compatible measured point.
 */
export function buildHomeLabViewModel(
  reports: readonly LabReport[],
  records: readonly LabRecord[],
  openDraftCount = 0,
  openDrafts: readonly HomeOpenExtractionDraft[] = [],
): HomeLabViewModel {
  const reportRows = reports
    .filter((report) => report.importState !== 'deleted')
    .map((report) => reportRow(report, records))
    .sort(compareHomeRows);
  const orderedRecords = [...records].sort((left, right) =>
    compareHomeRows(recordRow(left), recordRow(right)),
  );
  const latestRecordEntity = orderedRecords[0] ?? null;
  const latestRecord = latestRecordEntity === null ? null : recordRow(latestRecordEntity);
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
  const openDraftReportIds = new Set(openDrafts.map((draft) => draft.reportId));
  const unfinishedReports = reports
    .filter((report) => openDraftReportIds.has(report.id) || isUnfinishedLabReport(report))
    .sort((left, right) => {
      const leftHasOpenDraft = openDraftReportIds.has(left.id);
      const rightHasOpenDraft = openDraftReportIds.has(right.id);
      if (leftHasOpenDraft !== rightHasOpenDraft) return leftHasOpenDraft ? -1 : 1;
      return compareUnfinishedReports(left, right);
    });
  // An open draft is the actionable next step for its source report. Keep it out of the broader
  // pending-import count so Home does not repeat the same work in two summary lines.
  const pendingImports = reports
    .filter((report) => isUnfinishedLabReport(report) && !openDraftReportIds.has(report.id))
    .sort(compareUnfinishedReports);
  const reviewCount = records.reduce(
    (count, record) =>
      count +
      record.measurements.filter((measurement) => measurement.reviewState === 'needs-review')
        .length,
    0,
  );

  const historyEntries = listHistoryEntries(records);
  const measuredChanges = historyEntries
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
    .slice(0, HOME_MEASURED_CHANGE_LIMIT);
  const activeReports = reports.filter((report) => report.importState !== 'deleted');
  const latestMeasurementRecord =
    orderedRecords.find((record) => record.measurements.length > 0) ?? null;
  const latestMeasurementReportEntity =
    latestMeasurementRecord === null
      ? null
      : (activeReports.find(
          (report) =>
            report.id === latestMeasurementRecord.labReportId ||
            report.labRecordIds.includes(latestMeasurementRecord.id),
        ) ?? null);
  const latestReportRecordIds = latestMeasurementReportEntity?.labRecordIds ?? [];
  const latestMeasurementRecords =
    latestMeasurementReportEntity !== null && latestReportRecordIds.length > 0
      ? orderedRecords.filter(
          (record) =>
            record.labReportId === latestMeasurementReportEntity.id ||
            latestReportRecordIds.includes(record.id),
        )
      : latestMeasurementRecord === null
        ? []
        : [latestMeasurementRecord];
  const latestMeasurements = latestMeasurementRecords.flatMap((record) =>
    record.measurements.map((measurement): HomeLatestMeasurement => {
      const catalogue =
        measurement.biomarkerId === null
          ? null
          : (comparableBiomarkers.find((entry) => entry.id === measurement.biomarkerId) ?? null);
      return {
        id: measurement.id,
        recordId: record.id,
        reportId: record.labReportId,
        biomarkerId: measurement.biomarkerId,
        label: catalogue?.canonicalLabel ?? measurement.current.label,
        valueString: measurement.current.valueString,
        unit: measurement.current.unit,
        referenceInterval: measurement.current.referenceInterval,
        flag: measurement.current.flag,
        reviewState: measurement.reviewState,
        collectionDate: record.collectionDate,
        sourcePage: measurement.source === null ? null : measurement.source.pageIndex + 1,
      };
    }),
  );
  const measurementCount = records.reduce(
    (count, record) => count + reviewedMeasurements(record).length,
    0,
  );
  const totalMeasurementCount = records.reduce(
    (count, record) => count + record.measurements.length,
    0,
  );
  const latestReviewRecordId =
    orderedRecords.find((record) =>
      record.measurements.some((measurement) => measurement.reviewState === 'needs-review'),
    )?.id ?? null;

  return {
    latestReport,
    latestRecord,
    recentReports,
    recentRecords,
    unfinishedReports,
    pendingImports,
    openDrafts,
    openDraftCount: Math.max(0, openDraftCount),
    reviewCount,
    measuredChanges,
    latestMeasurements,
    latestMeasurementReportId: latestMeasurementReportEntity?.id ?? null,
    latestReviewRecordId,
    reportCount: activeReports.length,
    recordCount: records.length,
    measurementCount,
    totalMeasurementCount,
    biomarkerCount: historyEntries.length,
  };
}
