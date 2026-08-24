import {
  buildMeasuredTrend,
  canonicalId,
  type GuidanceContext,
  type LabDateState,
  type LabRecord,
  type MeasuredTrend,
  type MeasuredTrendNonPoint,
  type MeasuredTrendPoint,
  type MeasurementProvenance,
  type MeasurementSourceLocation,
} from '@alyte/domain';
import { comparableBiomarkers, type CatalogueSource } from '@alyte/catalogue';

export type HistoryDirection = MeasuredTrend['direction'];

export type HistoryPoint = {
  readonly kind: 'point';
  readonly point: MeasuredTrendPoint;
  readonly provenance: MeasurementProvenance;
  readonly sourceLocation: MeasurementSourceLocation | null;
};

export type HistoryNonPoint = {
  readonly kind: 'non-point';
  readonly nonPoint: MeasuredTrendNonPoint;
  readonly provenance: MeasurementProvenance | null;
  readonly sourceLocation: MeasurementSourceLocation | null;
};

export type HistoryTimelineItem = HistoryPoint | HistoryNonPoint;

export type BiomarkerHistoryViewModel = {
  readonly biomarkerId: string;
  readonly canonicalLabel: string;
  readonly explanation: string | null;
  readonly explanationReviewPending: boolean;
  readonly catalogueVersion: string | null;
  readonly sources: readonly CatalogueSource[];
  readonly trend: MeasuredTrend;
  /** One ordered sequence is used for both the visible context list and VoiceOver. */
  readonly timeline: readonly HistoryTimelineItem[];
};

export type HistoryEntry = {
  readonly biomarkerId: string;
  readonly canonicalLabel: string;
  readonly measurementCount: number;
};

export type HistoryAccessibilityCopy = {
  readonly chart: string;
  readonly measuredPoint: string;
  readonly nonPoint: Record<MeasuredTrendNonPoint['kind'], string>;
  readonly date: string;
  readonly source: string;
  readonly unit: string;
  readonly laboratoryInterval: string;
  readonly laboratoryFlag: string;
  readonly provenance: Record<MeasurementProvenance, string>;
  readonly noValue: string;
};

function dateOrder(date: LabDateState): string {
  return date.kind === 'known' ? date.value : '9999-99-99';
}

function pointDate(point: MeasuredTrendPoint): LabDateState {
  return { kind: 'known', value: point.collectionDate };
}

function timelineOrder(item: HistoryTimelineItem): LabDateState {
  return item.kind === 'point' ? pointDate(item.point) : item.nonPoint.collectionDate;
}

function measurementMetadata(
  records: readonly LabRecord[],
  measurementId: string | null,
): {
  readonly provenance: MeasurementProvenance | null;
  readonly sourceLocation: MeasurementSourceLocation | null;
} {
  if (measurementId === null) return { provenance: null, sourceLocation: null };
  for (const record of records) {
    const measurement = record.measurements.find((candidate) => candidate.id === measurementId);
    if (measurement !== undefined) {
      return { provenance: measurement.provenance, sourceLocation: measurement.source };
    }
  }
  return { provenance: null, sourceLocation: null };
}

/**
 * Turn confirmed local records into generic Biomarker history entries. The catalogue remains the
 * source of canonical labels; the screen never maintains a lipid-specific list or alias table.
 */
export function listHistoryEntries(
  records: readonly LabRecord[],
  catalogue = comparableBiomarkers,
): readonly HistoryEntry[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const record of records) {
    for (const measurement of record.measurements) {
      if (measurement.biomarkerId === null || measurement.reviewState !== 'confirmed') continue;
      const entry = catalogue.find((candidate) => candidate.id === measurement.biomarkerId);
      counts.set(measurement.biomarkerId, (counts.get(measurement.biomarkerId) ?? 0) + 1);
      labels.set(measurement.biomarkerId, entry?.canonicalLabel ?? measurement.original.label);
    }
  }
  return [...counts]
    .map(([biomarkerId, measurementCount]) => {
      return {
        biomarkerId,
        canonicalLabel: labels.get(biomarkerId) ?? biomarkerId,
        measurementCount,
      };
    })
    .sort((left, right) => left.canonicalLabel.localeCompare(right.canonicalLabel));
}

export function buildBiomarkerHistoryViewModel(
  records: readonly LabRecord[],
  biomarkerId: string,
  guidanceContext?: GuidanceContext,
  catalogue = comparableBiomarkers,
): BiomarkerHistoryViewModel | null {
  const entry = catalogue.find((candidate) => candidate.id === biomarkerId);
  const fallbackMeasurement = records
    .flatMap((record) => record.measurements)
    .find((measurement) => measurement.biomarkerId === biomarkerId);

  const trend = buildMeasuredTrend(
    records,
    canonicalId(biomarkerId),
    catalogue,
    guidanceContext === undefined ? {} : { guidanceContext },
  );
  const timeline: HistoryTimelineItem[] = [
    ...trend.points.map((point): HistoryPoint => ({
      kind: 'point',
      point,
      provenance: measurementMetadata(records, point.measurementId).provenance ?? 'extracted',
      sourceLocation: measurementMetadata(records, point.measurementId).sourceLocation,
    })),
    ...trend.nonPoints.map((nonPoint): HistoryNonPoint => ({
      kind: 'non-point',
      nonPoint,
      ...measurementMetadata(records, nonPoint.measurementId),
    })),
  ];
  timeline.sort((left, right) =>
    dateOrder(timelineOrder(left)).localeCompare(dateOrder(timelineOrder(right))),
  );

  return {
    biomarkerId,
    canonicalLabel: entry?.canonicalLabel ?? fallbackMeasurement?.original.label ?? biomarkerId,
    explanation: entry?.review?.status === 'approved' ? (entry.explanation ?? null) : null,
    explanationReviewPending:
      entry?.explanation !== undefined && entry.review?.status !== 'approved',
    catalogueVersion: entry?.catalogueVersion ?? null,
    sources: entry?.sources ?? [],
    trend,
    timeline,
  };
}

function sourceValue(point: MeasuredTrendPoint | MeasuredTrendNonPoint): string {
  if (point.source === null) return '';
  return `${point.source.label}: ${point.source.valueString}${point.source.unit ? ` ${point.source.unit}` : ''}`;
}

function dateValue(date: LabDateState, copy: HistoryAccessibilityCopy): string {
  return date.kind === 'known' ? `${copy.date} ${date.value}` : copy.nonPoint['date-missing'];
}

/**
 * The chart's ordered text equivalent includes every point and every non-point state. Keeping this
 * beside the pure view model prevents a renderer from silently dropping inaccessible context.
 */
export function buildHistoryAccessibilityLabel(
  model: BiomarkerHistoryViewModel,
  copy: HistoryAccessibilityCopy,
): string {
  const items = model.timeline.map((item) => {
    if (item.kind === 'point') {
      const point = item.point;
      const source = sourceValue(point);
      const reference = point.laboratoryReference.interval ?? copy.noValue;
      const flag = point.laboratoryReference.flag ?? copy.noValue;
      const provenance = item.provenance === null ? copy.noValue : copy.provenance[item.provenance];
      return [
        copy.measuredPoint,
        dateValue(pointDate(point), copy),
        `${point.normalized.value} ${point.normalized.unit}`,
        `${copy.source} ${source || copy.noValue}`,
        `${copy.laboratoryInterval} ${reference}`,
        `${copy.laboratoryFlag} ${flag}`,
        provenance,
      ].join(', ');
    }
    const nonPoint = item.nonPoint;
    const source = sourceValue(nonPoint);
    return [
      copy.nonPoint[nonPoint.kind],
      dateValue(nonPoint.collectionDate, copy),
      `${copy.source} ${source || copy.noValue}`,
    ].join(', ');
  });
  return [copy.chart, model.canonicalLabel, ...items].join('. ');
}
