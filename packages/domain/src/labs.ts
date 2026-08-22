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

export type MeasurementCorrection = {
  readonly id: string;
  readonly measurementId: string;
  readonly correctedAt: string;
  readonly reason: string | null;
  readonly previous: MeasurementSnapshot;
  readonly next: MeasurementSnapshot;
  readonly previousProvenance: MeasurementProvenance;
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
  readonly corrections: readonly MeasurementCorrection[];
};

export type LabRecord = {
  readonly id: string;
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
};

export type CreateLabRecordInput = {
  readonly id?: string;
  readonly collectionDate: LabDateState;
  readonly specimenType?: SpecimenType;
  readonly laboratoryName?: string | null;
  readonly notes?: string | null;
  readonly measurements: readonly CreateMeasurementInput[];
};

export type UpdateLabRecordInput = {
  readonly collectionDate: LabDateState;
  readonly specimenType: SpecimenType;
  readonly laboratoryName: string | null;
  readonly notes: string | null;
};

export type CorrectMeasurementInput = {
  readonly label?: string;
  readonly value?: MeasurementValue;
  readonly valueString?: string;
  readonly unit?: string | null;
  readonly referenceInterval?: string | null;
  readonly flag?: string | null;
  readonly reason?: string | null;
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
