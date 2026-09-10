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

export type HistoryTimelineLayout = 'inline' | 'stacked';

export type HistoryChartLayout = {
  readonly chartHeight: number;
  readonly plotPadding: number;
  readonly axisLabelInset: number;
};

export type HistoryChartConnection = readonly [MeasuredTrendPoint, MeasuredTrendPoint];

const HISTORY_ACCESSIBILITY_FONT_SCALE = 1.3;

function normalizedFontScale(fontScale: number): number {
  return Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
}

/**
 * Keep timeline facts compact by default, then give the value/unit and status separate full-width
 * rows once iOS enters its accessibility Dynamic Type ramp. The threshold matches the other lab
 * detail surfaces so a person gets the same reflow behavior across the laboratory journey.
 */
export function getHistoryTimelineLayout(fontScale: number): HistoryTimelineLayout {
  return normalizedFontScale(fontScale) >= HISTORY_ACCESSIBILITY_FONT_SCALE ? 'stacked' : 'inline';
}

/**
 * Scale the chart canvas only when text needs it. The ordinary-size values intentionally retain
 * the existing compact chart geometry; larger categories gain both vertical room and plot inset
 * so the fixed axis annotations and point markers remain inside the rounded surface.
 */
export function getHistoryChartLayout(fontScale: number): HistoryChartLayout {
  const scale = normalizedFontScale(fontScale);
  return {
    chartHeight: Math.max(220, Math.round(180 * scale)),
    plotPadding: Math.max(28, Math.ceil(28 + (scale - 1) * 20)),
    axisLabelInset: Math.max(8, Math.ceil(8 * scale)),
  };
}

/**
 * The chart follows the domain's measured segments. A missing, bounded, incompatible, or
 * unsupported result ends a line; the renderer never bridges that gap just because compatible
 * points exist on both sides of it.
 */
export function getHistoryChartConnections(
  segments: readonly (readonly MeasuredTrendPoint[])[],
): readonly HistoryChartConnection[] {
  return segments.flatMap((points) =>
    points.slice(1).flatMap((point, index) => {
      const previous = points[index];
      return previous === undefined ? [] : [[previous, point] as const];
    }),
  );
}

/**
 * Converted trend values are derived presentation data. Limit them to four significant digits so
 * floating-point conversion noise never looks like precision reported by the laboratory. The
 * untouched source value string remains available beside every point.
 */
export function formatNormalizedTrendValue(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 }).format(value);
}

export type HistoryPointValuePresentation = {
  /** The current saved result, in the unit the person reviewed. */
  readonly result: string;
  /** A derived value used only when the chart has to compare a different compatible unit. */
  readonly chartValue: string | null;
};

function comparableUnitKey(unit: string | null): string {
  return (unit ?? '').replace(/\s+/g, '').toLocaleLowerCase();
}

/**
 * Lead with the saved result and disclose conversion only when comparison uses another unit.
 * This keeps deterministic chart normalization from looking like a value printed by the lab.
 */
export function historyPointValuePresentation(
  point: MeasuredTrendPoint,
  current: MeasurementSnapshot,
  locale?: string,
): HistoryPointValuePresentation {
  const value = current.valueString.trim() || snapshotResultValue(current, locale ?? 'en');
  const result = `${value}${current.unit ? ` ${current.unit}` : ''}`;
  const normalized = `${formatNormalizedTrendValue(point.normalized.value, locale)} ${point.normalized.unit}`;
  return {
    result,
    chartValue:
      comparableUnitKey(current.unit) === comparableUnitKey(point.normalized.unit)
        ? null
        : normalized,
  };
}

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
  readonly chartValue: string;
  readonly nonPoint: Record<MeasuredTrendNonPoint['kind'], string>;
  readonly date: string;
  readonly source: string;
  readonly sourceEntry: string;
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

  // A stale Home action must not open a screen that exposes only an opaque ID and empty history.
  // Keep a real source measurement visible even when the catalogue has not caught up yet.
  if (entry === undefined && fallbackMeasurement === undefined) return null;

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

function snapshotResultValue(snapshot: MeasurementSnapshot, locale: string): string {
  const value =
    snapshot.value.kind === 'numeric'
      ? formatLocaleDecimal(snapshot.value.value, locale)
      : snapshot.value.kind === 'bounded'
        ? `${snapshot.value.comparator}${formatLocaleDecimal(snapshot.value.value, locale)}`
        : snapshot.value.value;
  return value;
}

function snapshotValue(snapshot: MeasurementSnapshot, locale: string): string {
  return `${snapshot.label}: ${snapshotResultValue(snapshot, locale)}${snapshot.unit ? ` ${snapshot.unit}` : ''}`;
}

function originalSourceValue(snapshot: MeasurementSnapshot | null): string {
  if (snapshot === null) return '';
  return `${snapshot.label}: ${snapshot.valueString}${snapshot.unit ? ` ${snapshot.unit}` : ''}`;
}

function sourceAccessibilityValue(
  item: HistoryTimelineItem,
  copy: HistoryAccessibilityCopy,
): string | null {
  const source = originalSourceValue(item.original);
  if (source.length === 0 || item.provenance === null || item.provenance === 'user-entered') {
    return null;
  }
  const label =
    item.provenance === 'extracted' || item.sourceLocation !== null
      ? copy.source
      : copy.sourceEntry;
  return `${label} ${source}`;
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
      const source = sourceAccessibilityValue(item, copy);
      const reference = point.laboratoryReference.interval ?? copy.noValue;
      const flag = point.laboratoryReference.flag ?? copy.noValue;
      const provenance = item.provenance === null ? copy.noValue : copy.provenance[item.provenance];
      const values = historyPointValuePresentation(point, item.current, locale);
      return [
        copy.measuredPoint,
        dateValue(pointDate(point), copy, locale),
        `${copy.current} ${values.result}${
          values.chartValue === null ? '' : `; ${copy.chartValue} ${values.chartValue}`
        }`,
        source,
        `${copy.laboratoryInterval} ${reference}`,
        `${copy.laboratoryFlag} ${flag}`,
        provenance,
      ]
        .filter((part): part is string => part !== null)
        .join(', ');
    }
    const nonPoint = item.nonPoint;
    const source = sourceAccessibilityValue(item, copy);
    const current = item.current === null ? copy.noValue : snapshotValue(item.current, locale);
    const reference = item.laboratoryReference.interval ?? copy.noValue;
    const flag = item.laboratoryReference.flag ?? copy.noValue;
    const provenance = item.provenance === null ? copy.noValue : copy.provenance[item.provenance];
    return [
      copy.nonPoint[nonPoint.kind],
      dateValue(nonPoint.collectionDate, copy, locale),
      `${copy.current} ${current}`,
      source,
      `${copy.laboratoryInterval} ${reference}`,
      `${copy.laboratoryFlag} ${flag}`,
      provenance,
    ]
      .filter((part): part is string => part !== null)
      .join(', ');
  });
  return [copy.chart, model.canonicalLabel, ...items].join('. ');
}
