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
export function correctionDraftIsDirty(
  initial: MeasurementDraft,
  current: MeasurementDraft,
): boolean {
  return JSON.stringify(initial) !== JSON.stringify(current);
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

export type DeletionFact =
  | { readonly kind: 'measurements-remain' }
  | { readonly kind: 'measurements-deleted'; readonly count: number }
  | { readonly kind: 'record-remains' | 'record-deleted' | 'source-remains' | 'source-deleted' }
  | { readonly kind: 'linked-records-source-deleted'; readonly count: number };

export function deletionFacts(plan: LabDeletionPlan): readonly DeletionFact[] {
  const facts: DeletionFact[] = [
    plan.measurementIdsDeleted.length === 0
      ? { kind: 'measurements-remain' }
      : { kind: 'measurements-deleted', count: plan.measurementIdsDeleted.length },
    { kind: plan.recordRemains ? 'record-remains' : 'record-deleted' },
    { kind: plan.sourceRemains ? 'source-remains' : 'source-deleted' },
  ];
  if (plan.linkedRecordIdsAffectedBySourceDeletion.length > 0)
    facts.push({
      kind: 'linked-records-source-deleted',
      count: plan.linkedRecordIdsAffectedBySourceDeletion.length,
    });
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

export type MeasurementFact = { readonly key: string; readonly value: string };
export function measurementFacts(
  detail: LabRecordDetail,
  measurement: LabRecordDetail['measurements'][number],
): readonly MeasurementFact[] {
  const valueText = (snapshot: Measurement['current']) =>
    `${snapshot.valueString}${snapshot.unit ? ` ${snapshot.unit}` : ''}`;
  return [
    { key: 'current-label', value: measurement.current.label },
    { key: 'current-value', value: valueText(measurement.current) },
    { key: 'value-type', value: measurement.current.value.kind },
    ...(measurement.current.value.kind === 'bounded'
      ? [{ key: 'comparator', value: measurement.current.value.comparator }]
      : []),
    { key: 'unit', value: measurement.current.unit ?? '' },
    { key: 'reference', value: measurement.current.referenceInterval ?? '' },
    { key: 'flag', value: measurement.current.flag ?? '' },
    { key: 'specimen', value: measurement.specimenType },
    {
      key: 'date',
      value: detail.collectionDate.kind === 'known' ? detail.collectionDate.value : '',
    },
    { key: 'panel', value: measurement.panelLabel ?? '' },
    {
      key: 'support',
      value:
        measurement.support.kind === 'comparable-supported'
          ? measurement.support.kind
          : measurement.support.reason,
    },
    { key: 'source-state', value: detail.source.kind },
    { key: 'provenance', value: measurement.provenance },
    {
      key: 'source-location',
      value: measurement.source ? String(measurement.source.pageIndex + 1) : '',
    },
    { key: 'original-label', value: measurement.original.label },
    { key: 'original-value', value: valueText(measurement.original) },
  ];
}

export function correctionChangedFields(
  correction: Measurement['corrections'][number],
): readonly string[] {
  const previous = correction.previous;
  const next = correction.next;
  const fields: string[] = [];
  if (previous.snapshot.label !== next.snapshot.label) fields.push('label');
  if (JSON.stringify(previous.snapshot.value) !== JSON.stringify(next.snapshot.value))
    fields.push('value');
  for (const key of ['unit', 'referenceInterval', 'flag'] as const)
    if (previous.snapshot[key] !== next.snapshot[key]) fields.push(key);
  if (previous.specimenType !== next.specimenType) fields.push('specimen');
  if (previous.reviewState !== next.reviewState) fields.push('reviewState');
  if (previous.biomarkerId !== next.biomarkerId) fields.push('biomarker');
  return fields;
}
