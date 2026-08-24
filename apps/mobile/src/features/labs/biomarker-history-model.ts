import {
  buildMeasuredTrend,
  canonicalId,
  formatLocaleDate,
  formatLocaleDecimal,
  type GuidanceContext,
  type LabDateState,
  type LabRecord,
  type MeasuredTrend,
  type MeasuredTrendNonPoint,
  type MeasuredTrendPoint,
  type MeasurementSnapshot,
  type MeasurementProvenance,
  type MeasurementSourceLocation,
} from '@alyte/domain';
import { comparableBiomarkers, type CatalogueSource, type GeneralGuidance } from '@alyte/catalogue';

export type HistoryDirection = MeasuredTrend['direction'];

export type HistoryPoint = {
  readonly kind: 'point';
  readonly point: MeasuredTrendPoint;
  readonly current: MeasurementSnapshot;
  readonly original: MeasurementSnapshot;
  readonly provenance: MeasurementProvenance | null;
  readonly sourceLocation: MeasurementSourceLocation | null;
  readonly laboratoryReference: {
    readonly interval: string | null;
    readonly flag: string | null;
  };
};

export type HistoryNonPoint = {
  readonly kind: 'non-point';
  readonly nonPoint: MeasuredTrendNonPoint;
  readonly current: MeasurementSnapshot | null;
  readonly original: MeasurementSnapshot | null;
  readonly provenance: MeasurementProvenance | null;
  readonly sourceLocation: MeasurementSourceLocation | null;
  readonly laboratoryReference: {
    readonly interval: string | null;
    readonly flag: string | null;
  };
};

export type HistoryTimelineItem = HistoryPoint | HistoryNonPoint;

export type BiomarkerHistoryViewModel = {
  readonly biomarkerId: string;
  readonly canonicalLabel: string;
  readonly explanation: string | null;
  readonly explanationReviewPending: boolean;
  readonly catalogueVersion: string | null;
  readonly contentVersion: string | null;
  readonly sources: readonly CatalogueSource[];
  readonly trend: MeasuredTrend;
  readonly guidance: HistoryGuidanceState;
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
  readonly current: string;
  readonly nonPoint: Record<MeasuredTrendNonPoint['kind'], string>;
  readonly date: string;
  readonly source: string;
  readonly unit: string;
  readonly laboratoryInterval: string;
  readonly laboratoryFlag: string;
  readonly provenance: Record<MeasurementProvenance, string>;
  readonly noValue: string;
};

export type HistoryGuidanceItem = GeneralGuidance & {
  readonly catalogueVersion: string | null;
  readonly sourceDetails: readonly CatalogueSource[];
};

export type HistoryGuidanceState =
  | {
      readonly kind: 'not-applicable';
      readonly reason: 'context-unavailable' | 'no-match' | 'pending-review';
    }
  | { readonly kind: 'applicable'; readonly items: readonly HistoryGuidanceItem[] };

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
  readonly current: MeasurementSnapshot | null;
  readonly original: MeasurementSnapshot | null;
  readonly provenance: MeasurementProvenance | null;
  readonly sourceLocation: MeasurementSourceLocation | null;
  readonly laboratoryReference: {
    readonly interval: string | null;
    readonly flag: string | null;
  };
} {
  if (measurementId === null) {
    return {
      current: null,
      original: null,
      provenance: null,
      sourceLocation: null,
      laboratoryReference: { interval: null, flag: null },
    };
  }
  for (const record of records) {
    const measurement = record.measurements.find((candidate) => candidate.id === measurementId);
    if (measurement !== undefined) {
      return {
        current: measurement.current,
        original: measurement.original,
        provenance: measurement.provenance,
        sourceLocation: measurement.source,
        laboratoryReference: {
          interval: measurement.current.referenceInterval,
          flag: measurement.current.flag,
        },
      };
    }
  }
  return {
    current: null,
    original: null,
    provenance: null,
    sourceLocation: null,
    laboratoryReference: { interval: null, flag: null },
  };
}

function guidanceState(
  entry: (typeof comparableBiomarkers)[number] | undefined,
  trend: MeasuredTrend,
  context: GuidanceContext | undefined,
): HistoryGuidanceState {
  if (context === undefined || context.sex === 'unknown' || context.fasting === 'unknown') {
    return { kind: 'not-applicable', reason: 'context-unavailable' };
  }
  if (entry === undefined) return { kind: 'not-applicable', reason: 'no-match' };

  const selected = trend.generalGuidance
    .map((candidate) =>
      entry.generalGuidance?.find((guidance) => guidance.id === candidate.guidanceId),
    )
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined);
  if (selected.length === 0) return { kind: 'not-applicable', reason: 'no-match' };
  if (
    entry.review?.status !== 'approved' ||
    selected.some((guidance) => guidance.review.status !== 'approved')
  ) {
    return { kind: 'not-applicable', reason: 'pending-review' };
  }
  return {
    kind: 'applicable',
    items: selected.map((guidance) => ({
      ...guidance,
      catalogueVersion: entry.catalogueVersion ?? null,
      sourceDetails: (entry.sources ?? []).filter((source) => guidance.sources.includes(source.id)),
    })),
  };
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
    ...trend.points.map((point): HistoryPoint => {
      const metadata = measurementMetadata(records, point.measurementId);
      return {
        kind: 'point',
        point,
        current: metadata.current ?? point.current,
        original: metadata.original ?? point.source,
        provenance: metadata.provenance,
        sourceLocation: metadata.sourceLocation,
        laboratoryReference: point.laboratoryReference,
      };
    }),
    ...trend.nonPoints.map((nonPoint): HistoryNonPoint => {
      const metadata = measurementMetadata(records, nonPoint.measurementId);
      return {
        kind: 'non-point',
        nonPoint,
        ...metadata,
        original: metadata.original ?? nonPoint.source,
      };
    }),
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
    contentVersion: entry?.review?.contentVersion ?? entry?.catalogueVersion ?? null,
    sources: entry?.sources ?? [],
    trend,
    guidance: guidanceState(entry, trend, guidanceContext),
    timeline,
  };
}

function snapshotValue(snapshot: MeasurementSnapshot, locale: string): string {
  const value =
    snapshot.value.kind === 'numeric'
      ? formatLocaleDecimal(snapshot.value.value, locale)
      : snapshot.value.kind === 'bounded'
        ? `${snapshot.value.comparator}${formatLocaleDecimal(snapshot.value.value, locale)}`
        : snapshot.value.value;
  return `${snapshot.label}: ${value}${snapshot.unit ? ` ${snapshot.unit}` : ''}`;
}

function originalSourceValue(snapshot: MeasurementSnapshot | null): string {
  if (snapshot === null) return '';
  return `${snapshot.label}: ${snapshot.valueString}${snapshot.unit ? ` ${snapshot.unit}` : ''}`;
}

function dateValue(date: LabDateState, copy: HistoryAccessibilityCopy, locale: string): string {
  return date.kind === 'known'
    ? `${copy.date} ${formatLocaleDate(date.value, locale)}`
    : copy.nonPoint['date-missing'];
}

/**
 * The chart's ordered text equivalent includes every point and every non-point state. Keeping this
 * beside the pure view model prevents a renderer from silently dropping inaccessible context.
 */
export function buildHistoryAccessibilityLabel(
  model: BiomarkerHistoryViewModel,
  copy: HistoryAccessibilityCopy,
  locale = Intl.DateTimeFormat().resolvedOptions().locale,
): string {
  const items = model.timeline.map((item) => {
    if (item.kind === 'point') {
      const point = item.point;
      const source = originalSourceValue(item.original);
      const reference = point.laboratoryReference.interval ?? copy.noValue;
      const flag = point.laboratoryReference.flag ?? copy.noValue;
      const provenance = item.provenance === null ? copy.noValue : copy.provenance[item.provenance];
      return [
        copy.measuredPoint,
        dateValue(pointDate(point), copy, locale),
        `${copy.current} ${formatLocaleDecimal(point.normalized.value, locale)} ${point.normalized.unit}; ${snapshotValue(item.current, locale)}`,
        `${copy.source} ${source || copy.noValue}`,
        `${copy.laboratoryInterval} ${reference}`,
        `${copy.laboratoryFlag} ${flag}`,
        provenance,
      ].join(', ');
    }
    const nonPoint = item.nonPoint;
    const source = originalSourceValue(item.original);
    const current = item.current === null ? copy.noValue : snapshotValue(item.current, locale);
    const reference = item.laboratoryReference.interval ?? copy.noValue;
    const flag = item.laboratoryReference.flag ?? copy.noValue;
    const provenance = item.provenance === null ? copy.noValue : copy.provenance[item.provenance];
    return [
      copy.nonPoint[nonPoint.kind],
      dateValue(nonPoint.collectionDate, copy, locale),
      `${copy.current} ${current}`,
      `${copy.source} ${source || copy.noValue}`,
      `${copy.laboratoryInterval} ${reference}`,
      `${copy.laboratoryFlag} ${flag}`,
      provenance,
    ].join(', ');
  });
  return [copy.chart, model.canonicalLabel, ...items].join('. ');
}
