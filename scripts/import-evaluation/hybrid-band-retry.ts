import type { EvaluationMeasurement } from './contract';

export const HYBRID_BAND_RETRY_VERSION = 'alyte.import-eval.overlapping-band-retry.v2' as const;

export type NormalizedBand = {
  readonly x: 0;
  readonly y: number;
  readonly width: 1;
  readonly height: number;
};

export type HybridFallbackPage = {
  /** Zero-based page index used by native readers and the adapter request. */
  readonly pageIndex: number;
  /** One-based page number used by the import-evaluation measurement contract. */
  readonly pageNumber: number;
  readonly routeReason: string;
  readonly observationCount: number;
  readonly dense: boolean;
  readonly bands: readonly NormalizedBand[];
};

export type HybridRetryPlan = {
  readonly schemaVersion: typeof HYBRID_BAND_RETRY_VERSION;
  readonly reason: 'initial' | 'repetition-detected';
  readonly overlap: number;
  readonly bandHeight: number;
  readonly denseObservationThreshold: number;
  readonly pages: readonly HybridFallbackPage[];
};

export type ExactRowDeduplication = {
  readonly measurements: readonly EvaluationMeasurement[];
  readonly duplicateCount: number;
  readonly duplicatePageIndexes: readonly number[];
};

// Four bounded attempts at the default settings. The adapter can translate these normalized
// rectangles to its native pixel size (for example, a 600px band with 200px overlap).
const DEFAULT_BAND_HEIGHT = 1 / 3;
const DEFAULT_OVERLAP = 1 / 9;
const DEFAULT_DENSE_OBSERVATION_THRESHOLD = 36;

function boundedFraction(value: number, name: string, allowZero = false): number {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0) || value > 1) {
    throw new Error(`hybrid-${name}-invalid`);
  }
  return value;
}

/**
 * Make deterministic full-width vertical bands. The first band starts at the page top and the
 * final band ends at the page bottom; adjacent bands overlap so a row crossing a crop boundary
 * is visible in both attempts. A small page is represented by one band.
 */
export function createOverlappingVerticalBands(
  bandHeight = DEFAULT_BAND_HEIGHT,
  overlap = DEFAULT_OVERLAP,
): readonly NormalizedBand[] {
  boundedFraction(bandHeight, 'band-height');
  boundedFraction(overlap, 'overlap', true);
  if (overlap >= bandHeight) throw new Error('hybrid-overlap-must-be-smaller-than-band-height');
  const step = bandHeight - overlap;
  const bands: NormalizedBand[] = [];
  let y = 0;
  while (true) {
    const height = Math.min(bandHeight, 1 - y);
    bands.push({ x: 0, y: Number(y.toFixed(6)), width: 1, height: Number(height.toFixed(6)) });
    if (y + bandHeight >= 1 - 1e-9) break;
    y = Math.min(1 - bandHeight, y + step);
  }
  return bands;
}

function pageIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('hybrid-page-index-invalid');
}

/**
 * Build the private request sent to the Paddle seam. The model receives page numbers and crop
 * rectangles only; no ground truth and no Poppler source text are included.
 */
export function buildHybridRetryPlan(options: {
  readonly deferredPageIndexes: readonly number[];
  readonly routeReasons?: Readonly<Record<number, string>>;
  readonly observationCounts?: Readonly<Record<number, number>>;
  readonly denseObservationThreshold?: number;
  readonly bandHeight?: number;
  readonly overlap?: number;
  readonly reason?: 'initial' | 'repetition-detected';
  readonly onlyPages?: readonly number[];
}): HybridRetryPlan {
  const threshold = options.denseObservationThreshold ?? DEFAULT_DENSE_OBSERVATION_THRESHOLD;
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 10_000) {
    throw new Error('hybrid-dense-threshold-invalid');
  }
  const bands = createOverlappingVerticalBands(
    options.bandHeight ?? DEFAULT_BAND_HEIGHT,
    options.overlap ?? DEFAULT_OVERLAP,
  );
  const selected =
    options.onlyPages === undefined
      ? [...new Set(options.deferredPageIndexes)]
      : [...new Set(options.onlyPages)];
  const deferred = new Set(options.deferredPageIndexes);
  const pages = selected
    .toSorted((left, right) => left - right)
    .map((pageIndexValue) => {
      pageIndex(pageIndexValue);
      if (!deferred.has(pageIndexValue)) throw new Error('hybrid-retry-page-not-deferred');
      const observationCount = options.observationCounts?.[pageIndexValue] ?? 0;
      if (!Number.isSafeInteger(observationCount) || observationCount < 0) {
        throw new Error('hybrid-observation-count-invalid');
      }
      const dense = observationCount >= threshold;
      return {
        pageIndex: pageIndexValue,
        pageNumber: pageIndexValue + 1,
        routeReason: options.routeReasons?.[pageIndexValue] ?? 'deferred',
        observationCount,
        dense,
        // The initial adapter attempt is full-page. A repetition retry can be requested for any
        // page and then carries the generic overlapping band set. Dense is metadata used by the
        // adapter to apply an aggressive repetition guard; it does not force extra model calls.
        bands: options.reason === 'repetition-detected' ? bands : [],
      } satisfies HybridFallbackPage;
    });
  return {
    schemaVersion: HYBRID_BAND_RETRY_VERSION,
    reason: options.reason ?? 'initial',
    overlap: options.overlap ?? DEFAULT_OVERLAP,
    bandHeight: options.bandHeight ?? DEFAULT_BAND_HEIGHT,
    denseObservationThreshold: threshold,
    pages,
  };
}

function normalizedString(value: string | null): string | null {
  return value === null ? null : value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function rowKey(measurement: EvaluationMeasurement): string {
  // Location is intentionally excluded: the same source row can be seen at different relative
  // y coordinates in overlapping crops. All source-facing fields remain part of the exact key.
  return JSON.stringify([
    measurement.page,
    normalizedString(measurement.sourceLabel),
    normalizedString(measurement.valueString),
    measurement.valueType,
    measurement.parsedValue,
    measurement.comparator,
    normalizedString(measurement.unit),
    normalizedString(measurement.referenceInterval),
    normalizedString(measurement.flag),
    normalizedString(measurement.collectionDate),
    normalizedString(measurement.collectionGroup),
    normalizedString(measurement.specimen),
    measurement.sourceIds === undefined ? null : [...measurement.sourceIds].toSorted(),
  ]);
}

/** Deduplicate exact rows from overlapping attempts while retaining first-seen provenance. */
export function deduplicateExactRows(
  measurements: readonly EvaluationMeasurement[],
): ExactRowDeduplication {
  const seen = new Set<string>();
  const kept: EvaluationMeasurement[] = [];
  const duplicatePageIndexes = new Set<number>();
  let duplicateCount = 0;
  for (const measurement of measurements) {
    const key = rowKey(measurement);
    if (seen.has(key)) {
      duplicateCount += 1;
      if (measurement.page !== null) duplicatePageIndexes.add(measurement.page - 1);
      continue;
    }
    seen.add(key);
    kept.push(measurement);
  }
  return {
    measurements: kept,
    duplicateCount,
    duplicatePageIndexes: [...duplicatePageIndexes].toSorted((left, right) => left - right),
  };
}
