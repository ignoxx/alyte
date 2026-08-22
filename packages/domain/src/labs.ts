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
  readonly original: MeasurementSnapshot;
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
