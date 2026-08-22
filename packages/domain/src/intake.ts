import type { CanonicalId } from './index';

export type IntakeEventType = 'food' | 'drink' | 'supplement' | 'medication' | 'other';
export type IntakeOrigin = 'manual' | 'snap' | 'cloud-recognized';
export type IntakeProvenance = 'user-entered' | 'extracted' | 'estimated' | 'user-corrected';
export type IntakeReviewState = 'confirmed' | 'needs-review';
export type AnalysisInclusion = 'included' | 'excluded';

export type IntakeAmount =
  | { readonly kind: 'known'; readonly value: number; readonly unit: string }
  | {
      readonly kind: 'unknown';
      readonly reason: 'not-provided' | 'not-confirmed' | 'not-applicable';
    };

export type IntakeComponentSnapshot = {
  readonly name: string;
  readonly amount: IntakeAmount;
  readonly canonicalId: CanonicalId | null;
};

export type IntakeComponent = IntakeComponentSnapshot & {
  readonly id: string;
  readonly eventId: string;
  /** The immutable first-known component state, retained when a recognized value is corrected. */
  readonly original: IntakeComponentSnapshot;
  readonly provenance: IntakeProvenance;
  readonly reviewState: IntakeReviewState;
  /** Quantity is an ergonomic alias for amount/dose in UI-facing code. */
  readonly quantity: IntakeAmount;
};

export type IntakeEvent = {
  readonly id: string;
  readonly eventType: IntakeEventType;
  readonly occurredAt: string;
  /** Calendar date in the device's local timezone; never inferred from a laboratory date. */
  readonly localDate: string;
  readonly origin: IntakeOrigin;
  readonly provenance: IntakeProvenance;
  readonly reviewState: IntakeReviewState;
  readonly analysisInclusion: AnalysisInclusion;
  readonly notes: string | null;
  /** A protected local media path, when this event owns one. */
  readonly sourceMediaPath: string | null;
  readonly copiedFromEventId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly components: readonly IntakeComponent[];
};

export type CreateIntakeComponentInput = {
  readonly id?: string;
  readonly name: string;
  readonly amount?: IntakeAmount;
  readonly quantity?: IntakeAmount;
  readonly canonicalId?: CanonicalId | null;
  readonly provenance?: IntakeProvenance;
  readonly reviewState?: IntakeReviewState;
};

export type CreateIntakeEventInput = {
  readonly id?: string;
  readonly eventType: IntakeEventType;
  readonly occurredAt?: string;
  readonly localDate?: string;
  readonly origin?: IntakeOrigin;
  readonly provenance?: IntakeProvenance;
  readonly reviewState?: IntakeReviewState;
  readonly analysisInclusion?: AnalysisInclusion;
  readonly notes?: string | null;
  readonly sourceMediaPath?: string | null;
  readonly copiedFromEventId?: string | null;
  readonly components: readonly CreateIntakeComponentInput[];
};

export type UpdateIntakeEventInput = {
  readonly eventType?: IntakeEventType;
  readonly occurredAt?: string;
  readonly localDate?: string;
  readonly origin?: IntakeOrigin;
  readonly reviewState?: IntakeReviewState;
  readonly analysisInclusion?: AnalysisInclusion;
  readonly notes?: string | null;
  readonly sourceMediaPath?: string | null;
  readonly components?: readonly CreateIntakeComponentInput[];
};

export type IntakeChangeKind =
  | 'created'
  | 'updated'
  | 'analysis-inclusion-changed'
  | 'image-removed'
  | 'deleted'
  | 'logged-again';

export type IntakeChange = {
  readonly kind: IntakeChangeKind;
  readonly eventId: string;
  readonly occurredAt: string | null;
  readonly invalidatesInsights: boolean;
};

export type IntakeChangeListener = (change: IntakeChange) => void;

export function assertIntakeLocalDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Intake local date must be YYYY-MM-DD: ${value}`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Intake local date is invalid: ${value}`);
  }
}

export function formatIntakeLocalDate(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    throw new Error('Intake event date must be valid');
  }
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function parseIntakeLocalDateInput(input: string, locale?: string): string | null {
  const parts = input
    .trim()
    .split(/[./-]/)
    .map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return null;
  let year: number;
  let month: number;
  let day: number;
  if (String(parts[0]).length === 4) {
    [year, month, day] = parts as [number, number, number];
  } else {
    const resolvedLocale = (locale ?? Intl.DateTimeFormat().resolvedOptions().locale).toLowerCase();
    const monthFirst = resolvedLocale.startsWith('en-us') || resolvedLocale.startsWith('en-ca');
    if (monthFirst) [month, day, year] = parts as [number, number, number];
    else [day, month, year] = parts as [number, number, number];
  }
  if (year < 100) year += 2000;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatIntakeLocalDateInput(localDate: string, locale?: string): string {
  assertIntakeLocalDate(localDate);
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function parseIntakeTimeInput(
  input: string,
): { readonly hours: number; readonly minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

export function formatIntakeTimeInput(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

export function parseIntakeDateTimeInput(
  dateInput: string,
  timeInput: string,
  locale?: string,
): { readonly localDate: string; readonly occurredAt: string } | null {
  const localDate = parseIntakeLocalDateInput(dateInput, locale);
  const time = parseIntakeTimeInput(timeInput);
  if (localDate === null || time === null) return null;
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  const value = new Date(year, month - 1, day, time.hours, time.minutes, 0, 0);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day ||
    value.getHours() !== time.hours ||
    value.getMinutes() !== time.minutes
  ) {
    return null;
  }
  return { localDate, occurredAt: value.toISOString() };
}

export function assertIntakeAmount(value: IntakeAmount): void {
  if (value.kind === 'unknown') return;
  if (!Number.isFinite(value.value) || value.value < 0) {
    throw new Error('Known intake amounts must be finite and non-negative');
  }
  if (value.unit.trim().length === 0) {
    throw new Error('Known intake amounts must include a unit');
  }
}

export function amountForInput(input: CreateIntakeComponentInput): IntakeAmount {
  const amount = input.amount ?? input.quantity;
  if (amount === undefined) {
    return { kind: 'unknown', reason: 'not-provided' };
  }
  assertIntakeAmount(amount);
  return amount;
}

export function formatIntakeAmount(value: IntakeAmount): string {
  return value.kind === 'known' ? `${value.value} ${value.unit}` : 'Unknown';
}

export function sameIntakeAmount(left: IntakeAmount, right: IntakeAmount): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'unknown' && right.kind === 'unknown') return left.reason === right.reason;
  return (
    left.kind === 'known' &&
    right.kind === 'known' &&
    left.value === right.value &&
    left.unit === right.unit
  );
}
