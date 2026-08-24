import {
  formatLocaleDecimal,
  parseLocaleDecimal,
  type CorrectMeasurementInput,
  type LabRecordDetail,
  type Measurement,
  type MeasurementReviewState,
  type MeasurementValue,
  type SpecimenType,
} from '@alyte/domain';
import type { LabDeletionPlan } from './service';

export type MeasurementDraft = {
  readonly label: string;
  readonly value: string;
  readonly kind: MeasurementValue['kind'];
  readonly comparator: '<' | '>';
  readonly unit: string;
  readonly referenceInterval: string;
  readonly flag: string;
  readonly specimenType: SpecimenType;
  readonly reviewState: MeasurementReviewState;
};

export function measurementDraft(measurement: Measurement): MeasurementDraft {
  const value = measurement.current.value;
  return {
    label: measurement.current.label,
    value: value.kind === 'numeric' || value.kind === 'bounded' ? String(value.value) : value.value,
    kind: value.kind,
    comparator: value.kind === 'bounded' ? value.comparator : '<',
    unit: measurement.current.unit ?? '',
    referenceInterval: measurement.current.referenceInterval ?? '',
    flag: measurement.current.flag ?? '',
    specimenType: measurement.specimenType,
    reviewState: measurement.reviewState,
  };
}

export function correctionInput(
  draft: MeasurementDraft,
  measurement: Measurement,
  reason: string,
): CorrectMeasurementInput | null {
  const label = draft.label.trim();
  if (label.length === 0) return null;
  let value: MeasurementValue;
  if (draft.kind === 'numeric' || draft.kind === 'bounded') {
    const parsed = parseLocaleDecimal(draft.value);
    if (parsed === null) return null;
    value =
      draft.kind === 'numeric'
        ? { kind: 'numeric', value: parsed }
        : { kind: 'bounded', comparator: draft.comparator, value: parsed };
  } else {
    const text = draft.value.trim();
    if (text.length === 0) return null;
    value = { kind: draft.kind, value: text };
  }
  return {
    biomarkerId: measurement.biomarkerId,
    label,
    value,
    unit: draft.unit.trim() || null,
    referenceInterval: draft.referenceInterval.trim() || null,
    flag: draft.flag.trim() || null,
    specimenType: draft.specimenType,
    reviewState: draft.reviewState,
    reason,
  };
}

export function measurementValue(measurement: Measurement, locale: string): string {
  const value = measurement.current.value;
  if (value.kind === 'numeric') return formatLocaleDecimal(value.value, locale);
  if (value.kind === 'bounded')
    return `${value.comparator}${formatLocaleDecimal(value.value, locale)}`;
  return value.value;
}

export function deletionFacts(plan: LabDeletionPlan): readonly string[] {
  const facts = [
    plan.measurementIdsDeleted.length === 0
      ? 'measurements-remain'
      : `measurements-deleted:${plan.measurementIdsDeleted.length}`,
    plan.recordRemains ? 'record-remains' : 'record-deleted',
    plan.sourceRemains ? 'source-remains' : 'source-deleted',
  ];
  if (plan.linkedRecordIdsAffectedBySourceDeletion.length > 0)
    facts.push(
      `linked-records-source-deleted:${plan.linkedRecordIdsAffectedBySourceDeletion.length}`,
    );
  return facts;
}

export function recordSections(detail: LabRecordDetail) {
  const grouped = new Map<string, typeof detail.measurements>();
  for (const measurement of detail.measurements) {
    const key = measurement.panelLabel?.trim() || '';
    grouped.set(key, [...(grouped.get(key) ?? []), measurement]);
  }
  return [...grouped].map(([panel, data]) => ({ panel, data }));
}
