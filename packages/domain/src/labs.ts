import type { CanonicalId } from './index';

export type LabDateState =
  { readonly kind: 'known'; readonly value: string } | { readonly kind: 'missing' };

export type SpecimenType = 'blood' | 'serum' | 'plasma' | 'urine' | 'stool' | 'saliva' | 'unknown';

export type MeasurementValue =
  | { readonly kind: 'numeric'; readonly value: number }
  | { readonly kind: 'bounded'; readonly comparator: '<' | '>'; readonly value: number }
  | { readonly kind: 'categorical'; readonly value: string }
  | { readonly kind: 'free_text'; readonly value: string };

export type MeasurementSnapshot = {
  readonly label: string;
  readonly value: MeasurementValue;
  readonly valueString: string;
  readonly unit: string | null;
  readonly referenceInterval: string | null;
  readonly flag: string | null;
};

export type MeasurementProvenance = 'user-entered' | 'extracted' | 'user-corrected';
export type MeasurementReviewState = 'confirmed' | 'needs-review';

export type MeasurementSourceLocation = {
  readonly pageIndex: number;
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly orientation: number;
  /** OCR observations contributing to this source region, when extracted. */
  readonly observationIds?: readonly string[];
  readonly observations?: readonly {
    readonly id: string;
    readonly text: string;
    readonly pageIndex: number;
    readonly boundingBox: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  }[];
  readonly semantic?: {
    readonly adapterVersion: string;
    readonly schemaVersion: 'alyte.semantic-mapper.v1';
    readonly sourceObservationIds: readonly string[];
  } | null;
};

export type MeasurementCorrection = {
  readonly id: string;
  readonly measurementId: string;
  readonly correctedAt: string;
  readonly reason: string | null;
  readonly previous: MeasurementCorrectionState;
  readonly next: MeasurementCorrectionState;
  readonly previousProvenance: MeasurementProvenance;
};

export type MeasurementCorrectionState = {
  readonly biomarkerId: CanonicalId | null;
  readonly specimenType: SpecimenType;
  readonly snapshot: MeasurementSnapshot;
  readonly reviewState: MeasurementReviewState;
  readonly provenance: MeasurementProvenance;
  readonly source: MeasurementSourceLocation | null;
};

export type Measurement = {
  readonly id: string;
  readonly labRecordId: string;
  readonly biomarkerId: CanonicalId | null;
  readonly specimenType: SpecimenType;
  readonly panelLabel: string | null;
  readonly original: MeasurementSnapshot;
  /** Immutable full state captured when the Measurement first entered confirmed history. */
  readonly originalState: MeasurementCorrectionState;
  readonly current: MeasurementSnapshot;
  readonly provenance: MeasurementProvenance;
  readonly reviewState: MeasurementReviewState;
  readonly source: MeasurementSourceLocation | null;
  readonly corrections: readonly MeasurementCorrection[];
};

export type LabRecord = {
  readonly id: string;
  readonly labReportId: string | null;
  readonly collectionDate: LabDateState;
  readonly specimenType: SpecimenType;
  readonly laboratoryName: string | null;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly measurements: readonly Measurement[];
};

export type CreateMeasurementInput = {
  readonly id?: string;
  readonly biomarkerId?: CanonicalId | null;
  readonly specimenType?: SpecimenType;
  readonly panelLabel?: string | null;
  readonly label: string;
  readonly value: MeasurementValue;
  readonly valueString?: string;
  readonly unit?: string | null;
  readonly referenceInterval?: string | null;
  readonly flag?: string | null;
  readonly provenance?: MeasurementProvenance;
  readonly reviewState?: MeasurementReviewState;
  readonly source?: MeasurementSourceLocation | null;
  /** Source-shaped value is immutable provenance; current fields remain separately normalized. */
  readonly original?: MeasurementSnapshot;
};

export type ComparableBiomarkerConstraint = {
  readonly id: string;
  readonly catalogueVersion?: string;
  readonly specimens: readonly SpecimenType[];
  readonly units: readonly string[];
  readonly canonicalUnit?: string;
  readonly unitConversions?: readonly {
    readonly from: string;
    readonly to: string;
    readonly factor: number;
    readonly offset?: number;
    readonly sourceId: string;
  }[];
  /** Explicit groups keep serum/plasma compatibility a catalogue decision, not a guess. */
  readonly specimenCompatibility?: readonly (readonly [SpecimenType, ...SpecimenType[]])[];
  readonly methodPolicy?: {
    readonly version: string;
    readonly kind: 'method-agnostic' | 'standardized' | 'requires-explicit-method';
    readonly allowedMethods: readonly string[];
    readonly unsafePatterns: readonly string[];
  };
  readonly valueType?: 'numeric';
  readonly explanation?: string;
  readonly generalGuidance?: readonly ComparableGeneralGuidance[];
};

export type ComparableGeneralGuidance = {
  readonly id: string;
  readonly thresholds: readonly {
    readonly operator: '<' | '<=' | '>' | '>=';
    readonly value: number;
    readonly unit: string;
  }[];
  readonly applicability: {
    readonly population: 'adults';
    readonly jurisdiction: string;
    readonly context: 'screening';
    readonly purpose?: 'screening' | 'monitoring';
    readonly sex: 'all' | 'female' | 'male';
    readonly fasting: 'any' | 'fasting' | 'non-fasting';
    readonly specimen?: SpecimenType;
    readonly limitations: readonly string[];
  };
  readonly authority: string;
  readonly publicationVersion: string;
  readonly reviewDate: string | null;
  readonly unit: string;
  readonly boundarySemantics: 'exclusive' | 'inclusive' | 'sex-specific';
  readonly sources: readonly string[];
};

export type GuidanceContext = {
  readonly population: 'adults';
  readonly jurisdiction: string;
  readonly sex: 'female' | 'male' | 'unknown';
  readonly fasting: 'fasting' | 'non-fasting' | 'unknown';
  readonly purpose?: 'screening' | 'monitoring' | 'unknown';
  readonly specimen?: SpecimenType;
};

export type SelectedGeneralGuidance = {
  readonly guidanceId: string;
  readonly catalogueVersion: string | null;
  readonly sourceIds: readonly string[];
  readonly guidance: ComparableGeneralGuidance;
};

export type LabRecordSourceState =
  | { readonly kind: 'manual' }
  | { readonly kind: 'retained'; readonly reportId: string }
  | { readonly kind: 'deletion-pending'; readonly reportId: string }
  | { readonly kind: 'deletion-failed'; readonly reportId: string }
  | { readonly kind: 'deleted'; readonly reportId: string };

export type MeasurementSupportState =
  | { readonly kind: 'comparable-supported'; readonly canonicalId: CanonicalId }
  | {
      readonly kind: 'preserved-only';
      readonly reason:
        | 'unmapped'
        | 'unsupported-canonical-id'
        | 'unconfirmed'
        | 'non-numeric-value'
        | 'missing-unit'
        | 'incompatible-unit'
        | 'incompatible-specimen'
        | 'incompatible-method';
    };

export type LabRecordDetail = {
  readonly id: string;
  readonly collectionDate: LabDateState;
  readonly specimenType: SpecimenType;
  readonly laboratoryName: string | null;
  readonly source: LabRecordSourceState;
  readonly chronology: { readonly kind: 'eligible' } | { readonly kind: 'date-missing' };
  readonly summary: {
    readonly measurementCount: number;
    readonly flaggedCount: number;
    readonly comparableCount: number;
    readonly preservedOnlyCount: number;
  };
  readonly measurements: readonly (Measurement & { readonly support: MeasurementSupportState })[];
};

export function measurementSupportState(
  measurement: Measurement,
  catalogue: readonly ComparableBiomarkerConstraint[],
): MeasurementSupportState {
  if (measurement.biomarkerId === null) return { kind: 'preserved-only', reason: 'unmapped' };
  const entry = catalogue.find((candidate) => candidate.id === measurement.biomarkerId);
  if (entry === undefined) return { kind: 'preserved-only', reason: 'unsupported-canonical-id' };
  if (measurement.current.value.kind !== 'numeric')
    return { kind: 'preserved-only', reason: 'non-numeric-value' };
  if (measurement.reviewState !== 'confirmed')
    return { kind: 'preserved-only', reason: 'unconfirmed' };
  if (measurement.current.unit === null) return { kind: 'preserved-only', reason: 'missing-unit' };
  if (!entry.units.includes(measurement.current.unit))
    return { kind: 'preserved-only', reason: 'incompatible-unit' };
  if (!entry.specimens.includes(measurement.specimenType))
    return { kind: 'preserved-only', reason: 'incompatible-specimen' };
  if (!methodPolicyCompatible(measurement, entry))
    return { kind: 'preserved-only', reason: 'incompatible-method' };
  return { kind: 'comparable-supported', canonicalId: measurement.biomarkerId };
}

export function buildLabRecordDetail(
  record: LabRecord,
  source: LabRecordSourceState,
  catalogue: readonly ComparableBiomarkerConstraint[],
): LabRecordDetail {
  if (record.labReportId === null && source.kind !== 'manual') {
    throw new Error('A manual Lab Record cannot claim report provenance');
  }
  if (
    record.labReportId !== null &&
    (source.kind === 'manual' || source.reportId !== record.labReportId)
  ) {
    throw new Error('Lab Record source provenance does not match its report');
  }
  const measurements = record.measurements.map((measurement) => ({
    ...measurement,
    support: measurementSupportState(measurement, catalogue),
  }));
  const comparableCount = measurements.filter(
    (measurement) => measurement.support.kind === 'comparable-supported',
  ).length;
  return {
    id: record.id,
    collectionDate: record.collectionDate,
    specimenType: record.specimenType,
    laboratoryName: record.laboratoryName,
    source,
    chronology:
      record.collectionDate.kind === 'known' ? { kind: 'eligible' } : { kind: 'date-missing' },
    summary: {
      measurementCount: measurements.length,
      flaggedCount: measurements.filter((measurement) => measurement.current.flag !== null).length,
      comparableCount,
      preservedOnlyCount: measurements.length - comparableCount,
    },
    measurements,
  };
}

export type CreateLabRecordInput = {
  readonly id?: string;
  readonly labReportId?: string | null;
  readonly collectionDate: LabDateState;
  readonly specimenType?: SpecimenType;
  readonly laboratoryName?: string | null;
  readonly notes?: string | null;
  readonly measurements: readonly CreateMeasurementInput[];
};

export type UpdateLabRecordInput = {
  readonly labReportId?: string | null;
  readonly collectionDate: LabDateState;
  readonly specimenType: SpecimenType;
  readonly laboratoryName: string | null;
  readonly notes: string | null;
};

export type CorrectMeasurementInput = {
  readonly biomarkerId?: CanonicalId | null;
  readonly label?: string;
  readonly value?: MeasurementValue;
  readonly valueString?: string;
  readonly unit?: string | null;
  readonly referenceInterval?: string | null;
  readonly flag?: string | null;
  readonly specimenType?: SpecimenType;
  readonly reviewState?: MeasurementReviewState;
  readonly reason?: string | null;
  readonly source?: MeasurementSourceLocation | null;
};

export function assertLabDateState(date: LabDateState): void {
  if (date.kind === 'missing') {
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) {
    throw new Error(`Lab collection date must be YYYY-MM-DD: ${date.value}`);
  }
  const parsed = new Date(`${date.value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date.value) {
    throw new Error(`Lab collection date is invalid: ${date.value}`);
  }
}

export function formatMeasurementValue(value: MeasurementValue): string {
  switch (value.kind) {
    case 'numeric':
      return String(value.value);
    case 'bounded':
      return `${value.comparator}${value.value}`;
    case 'categorical':
    case 'free_text':
      return value.value;
  }
}

export function parseLocaleDecimal(input: string): number | null {
  const trimmed = input.trim().replace(/[\u00a0\u202f\s]/g, '');
  if (trimmed.length === 0) {
    return null;
  }
  const lastComma = trimmed.lastIndexOf(',');
  const lastDot = trimmed.lastIndexOf('.');
  let normalized = trimmed;
  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = trimmed.split(groupingSeparator).join('').replace(decimalSeparator, '.');
  } else if (lastComma >= 0) {
    normalized = trimmed.replace(',', '.');
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatLocaleDecimal(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 20 }).format(value);
}

export function parseLocalDateInput(input: string, locale?: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parts = trimmed.split(/[./-]/).map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part))) {
    return null;
  }
  let year: number;
  let month: number;
  let day: number;
  if (parts.length !== 3) {
    return null;
  }
  if (String(parts[0]).length === 4) {
    [year, month, day] = parts as [number, number, number];
  } else {
    const language = (locale ?? Intl.DateTimeFormat().resolvedOptions().locale).toLowerCase();
    const monthFirst = language.startsWith('en-us') || language.startsWith('en-ca');
    if (monthFirst) {
      [month, day, year] = parts as [number, number, number];
    } else {
      [day, month, year] = parts as [number, number, number];
    }
  }
  if (year < 100) {
    year += 2000;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatLocaleDate(value: string, locale?: string): string {
  const parts = value.split('-').map(Number);
  const year = parts[0] ?? 0;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, day)),
  );
}

export function createSortableOpaqueId(
  prefix: string,
  nowMs = Date.now(),
  randomPart?: string,
): string {
  const timestamp = Math.max(0, Math.floor(nowMs)).toString(16).padStart(12, '0');
  const entropy = randomPart ?? randomHex(20);
  return `${prefix}-${timestamp}-${entropy}`;
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

export function assertMeasurementValue(value: MeasurementValue): void {
  if (value.kind === 'numeric' || value.kind === 'bounded') {
    if (!Number.isFinite(value.value)) {
      throw new Error('Numeric measurements must contain a finite value');
    }
    return;
  }
  if (value.value.trim().length === 0) {
    throw new Error('Text measurements must not be empty');
  }
}

export type ComparableNormalizedValue = {
  readonly value: number;
  readonly unit: string;
  readonly catalogueVersion: string | null;
  readonly conversionSourceIds: readonly string[];
};

export type MeasuredTrendPoint = {
  readonly kind: 'measured-point';
  readonly measurementId: string;
  readonly labRecordId: string;
  readonly collectionDate: string;
  readonly biomarkerId: CanonicalId;
  readonly catalogueVersion: string | null;
  readonly specimenType: SpecimenType;
  /** Deterministic value used by a renderer; no value is inferred for any other record. */
  readonly normalized: ComparableNormalizedValue;
  /** Immutable source-shaped value remains available beside the normalized point. */
  readonly source: MeasurementSnapshot;
  /** Current confirmed value used for comparison (may contain an explicit user correction). */
  readonly current: MeasurementSnapshot;
  readonly laboratoryReference: {
    readonly interval: string | null;
    readonly flag: string | null;
  };
};

export type MeasuredTrendNonPoint = {
  readonly kind: 'not-measured' | 'date-missing' | 'bounded' | 'incompatible' | 'unsupported';
  readonly labRecordId: string;
  readonly collectionDate: LabDateState;
  readonly measurementId: string | null;
  readonly source: MeasurementSnapshot | null;
  readonly reason?:
    | 'unconfirmed'
    | 'non-numeric-value'
    | 'missing-unit'
    | 'incompatible-unit'
    | 'incompatible-specimen'
    | 'incompatible-method'
    | 'unsupported-canonical-id';
};

export type MeasuredTrendDirection = 'increased' | 'decreased' | 'stable' | 'not-comparable';

export type MeasuredTrend = {
  readonly biomarkerId: CanonicalId;
  readonly points: readonly MeasuredTrendPoint[];
  readonly nonPoints: readonly MeasuredTrendNonPoint[];
  /** Segments deliberately stop at date-missing, incompatible, bounded, or absent records. */
  readonly segments: readonly (readonly MeasuredTrendPoint[])[];
  readonly direction: MeasuredTrendDirection;
  /** Separate catalogue content; it never replaces a point's laboratoryReference. */
  readonly generalGuidance: readonly SelectedGeneralGuidance[];
};

export type MeasuredChartModel = MeasuredTrend;

export function convertComparableValue(
  value: number,
  fromUnit: string,
  entry: ComparableBiomarkerConstraint,
  targetUnit = entry.canonicalUnit ?? fromUnit,
): ComparableNormalizedValue | null {
  if (!Number.isFinite(value)) return null;
  if (!entry.units.includes(fromUnit) || !entry.units.includes(targetUnit)) return null;
  if (fromUnit === targetUnit) {
    return {
      value,
      unit: targetUnit,
      catalogueVersion: entry.catalogueVersion ?? null,
      conversionSourceIds: [],
    };
  }
  const conversion = entry.unitConversions?.find(
    (candidate) => candidate.from === fromUnit && candidate.to === targetUnit,
  );
  if (conversion === undefined) return null;
  // Keep conversions reproducible across engines while avoiding binary-noise in displayed values.
  const converted = Number((value * conversion.factor + (conversion.offset ?? 0)).toFixed(12));
  return Number.isFinite(converted)
    ? {
        value: converted,
        unit: targetUnit,
        catalogueVersion: entry.catalogueVersion ?? null,
        conversionSourceIds: [conversion.sourceId],
      }
    : null;
}

function specimenGroupIndex(
  entry: ComparableBiomarkerConstraint,
  specimen: SpecimenType,
): number | null {
  if (!entry.specimens.includes(specimen)) return null;
  if (entry.specimenCompatibility === undefined) return 0;
  const index = entry.specimenCompatibility.findIndex((group) => group.includes(specimen));
  return index < 0 ? null : index;
}

function specimenPairCompatible(
  entry: ComparableBiomarkerConstraint,
  measurementSpecimen: SpecimenType,
  recordSpecimen: SpecimenType,
): boolean {
  if (!entry.specimens.includes(measurementSpecimen) || !entry.specimens.includes(recordSpecimen)) {
    return false;
  }
  if (measurementSpecimen === recordSpecimen) return true;
  return (
    entry.specimenCompatibility?.some(
      (group) => group.includes(measurementSpecimen) && group.includes(recordSpecimen),
    ) ?? false
  );
}

function normalizeMethodText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function methodPolicyCompatible(
  measurement: Measurement,
  entry: ComparableBiomarkerConstraint,
): boolean {
  const policy = entry.methodPolicy;
  if (policy === undefined) return true;
  const sourceFacts = [
    measurement.current.label,
    measurement.original.label,
    ...(measurement.source?.observations?.map((observation) => observation.text) ?? []),
  ].join(' ');
  const normalizedSource = normalizeMethodText(sourceFacts);
  if (
    policy.unsafePatterns.some((pattern) => normalizedSource.includes(normalizeMethodText(pattern)))
  )
    return false;
  if (policy.kind !== 'requires-explicit-method') return true;
  return policy.allowedMethods.some((method) =>
    normalizedSource.includes(normalizeMethodText(method)),
  );
}

function nonPointForMeasurement(
  record: LabRecord,
  measurement: Measurement,
  entry: ComparableBiomarkerConstraint | undefined,
  reasonOverride?: MeasuredTrendNonPoint['reason'],
): MeasuredTrendNonPoint {
  const value = measurement.current.value;
  if (record.collectionDate.kind === 'missing') {
    return {
      kind: 'date-missing',
      labRecordId: record.id,
      collectionDate: record.collectionDate,
      measurementId: measurement.id,
      source: measurement.original,
    };
  }
  if (value.kind === 'bounded') {
    return {
      kind: 'bounded',
      labRecordId: record.id,
      collectionDate: record.collectionDate,
      measurementId: measurement.id,
      source: measurement.original,
    };
  }
  if (entry === undefined) {
    return {
      kind: 'unsupported',
      labRecordId: record.id,
      collectionDate: record.collectionDate,
      measurementId: measurement.id,
      source: measurement.original,
      reason: 'unsupported-canonical-id',
    };
  }
  if (reasonOverride !== undefined) {
    return {
      kind: 'incompatible',
      labRecordId: record.id,
      collectionDate: record.collectionDate,
      measurementId: measurement.id,
      source: measurement.original,
      reason: reasonOverride,
    };
  }
  let reason: MeasuredTrendNonPoint['reason'] = 'non-numeric-value';
  if (measurement.reviewState !== 'confirmed') reason = 'unconfirmed';
  else if (value.kind !== 'numeric') reason = 'non-numeric-value';
  else if (measurement.current.unit === null) reason = 'missing-unit';
  else if (!entry.units.includes(measurement.current.unit)) reason = 'incompatible-unit';
  else if (!specimenPairCompatible(entry, measurement.specimenType, record.specimenType)) {
    reason = 'incompatible-specimen';
  } else if (!methodPolicyCompatible(measurement, entry)) reason = 'incompatible-method';
  return {
    kind: 'incompatible',
    labRecordId: record.id,
    collectionDate: record.collectionDate,
    measurementId: measurement.id,
    source: measurement.original,
    reason,
  };
}

/**
 * Build a renderer-independent history. The only ordinary points are confirmed, exact numeric
 * values with a known collection date, compatible specimen semantics, and a deterministic unit
 * conversion. The function never creates an intermediate value or turns a bound into a point.
 */
export function buildMeasuredTrend(
  records: readonly LabRecord[],
  biomarkerId: CanonicalId,
  catalogue: readonly ComparableBiomarkerConstraint[],
  options: { readonly guidanceContext?: GuidanceContext } = {},
): MeasuredChartModel {
  const entry = catalogue.find((candidate) => candidate.id === biomarkerId);
  const orderedRecords = [...records].sort((left, right) => {
    if (left.collectionDate.kind === 'missing' && right.collectionDate.kind === 'missing') return 0;
    if (left.collectionDate.kind === 'missing') return 1;
    if (right.collectionDate.kind === 'missing') return -1;
    return left.collectionDate.value.localeCompare(right.collectionDate.value);
  });
  const points: MeasuredTrendPoint[] = [];
  const nonPoints: MeasuredTrendNonPoint[] = [];
  const segments: MeasuredTrendPoint[][] = [];
  let currentSegment: MeasuredTrendPoint[] | null = null;
  let activeSpecimenGroup: number | null = null;

  for (const record of orderedRecords) {
    const candidates = record.measurements.filter(
      (measurement): measurement is Measurement & { readonly biomarkerId: CanonicalId } =>
        measurement.biomarkerId === biomarkerId,
    );
    if (candidates.length === 0) {
      if (record.collectionDate.kind === 'known') {
        nonPoints.push({
          kind: 'not-measured',
          labRecordId: record.id,
          collectionDate: record.collectionDate,
          measurementId: null,
          source: null,
        });
      } else {
        nonPoints.push({
          kind: 'date-missing',
          labRecordId: record.id,
          collectionDate: record.collectionDate,
          measurementId: null,
          source: null,
        });
      }
      currentSegment = null;
      activeSpecimenGroup = null;
      continue;
    }
    let recordHasPoint = false;
    for (const measurement of candidates) {
      const value = measurement.current.value;
      const unit = measurement.current.unit;
      const normalized =
        entry !== undefined &&
        record.collectionDate.kind === 'known' &&
        measurement.reviewState === 'confirmed' &&
        value.kind === 'numeric' &&
        unit !== null &&
        methodPolicyCompatible(measurement, entry) &&
        specimenPairCompatible(entry, measurement.specimenType, record.specimenType)
          ? convertComparableValue(value.value, unit, entry)
          : null;
      const specimenGroup =
        entry === undefined
          ? null
          : (specimenGroupIndex(entry, measurement.specimenType) ??
            specimenGroupIndex(entry, record.specimenType));
      const crossPointSpecimenCompatible =
        specimenGroup !== null &&
        (activeSpecimenGroup === null || activeSpecimenGroup === specimenGroup);
      if (
        record.collectionDate.kind === 'known' &&
        normalized !== null &&
        crossPointSpecimenCompatible
      ) {
        const point: MeasuredTrendPoint = {
          kind: 'measured-point',
          measurementId: measurement.id,
          labRecordId: record.id,
          collectionDate: record.collectionDate.value,
          biomarkerId: measurement.biomarkerId,
          catalogueVersion: normalized.catalogueVersion,
          specimenType: measurement.specimenType,
          normalized,
          source: measurement.original,
          current: measurement.current,
          laboratoryReference: {
            interval: measurement.current.referenceInterval,
            flag: measurement.current.flag,
          },
        };
        points.push(point);
        if (currentSegment === null) {
          currentSegment = [];
          segments.push(currentSegment);
        }
        currentSegment.push(point);
        recordHasPoint = true;
        activeSpecimenGroup = specimenGroup;
      } else {
        nonPoints.push(
          nonPointForMeasurement(
            record,
            measurement,
            entry,
            normalized !== null && !crossPointSpecimenCompatible
              ? 'incompatible-specimen'
              : undefined,
          ),
        );
        currentSegment = null;
        activeSpecimenGroup = null;
      }
    }
    if (!recordHasPoint) currentSegment = null;
  }

  const direction: MeasuredTrendDirection =
    points.length < 2
      ? 'not-comparable'
      : points[points.length - 1]!.normalized.value > points[0]!.normalized.value
        ? 'increased'
        : points[points.length - 1]!.normalized.value < points[0]!.normalized.value
          ? 'decreased'
          : 'stable';
  return {
    biomarkerId,
    points,
    nonPoints,
    segments,
    direction,
    generalGuidance:
      entry === undefined || options.guidanceContext === undefined
        ? []
        : selectApplicableGeneralGuidance(entry, options.guidanceContext),
  };
}

export function selectApplicableGeneralGuidance(
  entry: ComparableBiomarkerConstraint,
  context: GuidanceContext,
): readonly SelectedGeneralGuidance[] {
  if (context.sex === 'unknown' || context.fasting === 'unknown') return [];
  if (context.purpose === 'unknown' || context.specimen === 'unknown') return [];
  return (entry.generalGuidance ?? [])
    .filter(
      (guidance) =>
        guidance.applicability.population === context.population &&
        guidance.applicability.jurisdiction === context.jurisdiction &&
        (guidance.applicability.sex === 'all' || guidance.applicability.sex === context.sex) &&
        (guidance.applicability.fasting === 'any' ||
          guidance.applicability.fasting === context.fasting) &&
        (guidance.applicability.purpose === undefined ||
          (context.purpose !== undefined &&
            context.purpose !== 'unknown' &&
            guidance.applicability.purpose === context.purpose)) &&
        (guidance.applicability.specimen === undefined ||
          (context.specimen !== undefined &&
            context.specimen !== 'unknown' &&
            guidance.applicability.specimen === context.specimen)),
    )
    .map((guidance) => ({
      guidanceId: guidance.id,
      catalogueVersion: entry.catalogueVersion ?? null,
      sourceIds: guidance.sources,
      guidance,
    }));
}
