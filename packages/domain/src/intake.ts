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
  'created' | 'updated' | 'analysis-inclusion-changed' | 'deleted' | 'logged-again';

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
