import type { IntakeEvent, IntakeEventType, IntakeProvenance } from '@alyte/domain';
import { t } from '../../localization';
import type { IntakeCloudJob } from './outbox';

export type IntakeProvenanceDescriptor = {
  readonly label: string;
  readonly tone: 'userEntered' | 'userCorrected' | 'extracted' | 'estimated';
};

export function intakeProvenanceDescriptor(
  provenance: IntakeProvenance,
): IntakeProvenanceDescriptor {
  switch (provenance) {
    case 'user-entered':
      return { label: t('intake.provenanceUserEntered'), tone: 'userEntered' };
    case 'user-corrected':
      return { label: t('intake.provenanceUserCorrected'), tone: 'userCorrected' };
    case 'extracted':
      return { label: t('intake.provenanceExtracted'), tone: 'extracted' };
    case 'estimated':
      return { label: t('intake.provenanceEstimated'), tone: 'estimated' };
  }
}

export type IntakeEventMenuAction =
  'cancel-analysis' | 'toggle-inclusion' | 'remove-image' | 'delete';

/** Actions that are uncommon or destructive and should stay behind the row's ellipsis menu. */
export function intakeEventMenuActions(
  event: IntakeEvent,
  cloudJob: IntakeCloudJob | null | undefined,
): readonly IntakeEventMenuAction[] {
  const actions: IntakeEventMenuAction[] = [];
  if (cloudJob?.state === 'queued') actions.push('cancel-analysis');
  actions.push('toggle-inclusion');
  if (event.sourceMediaPath !== null) actions.push('remove-image');
  actions.push('delete');
  return actions;
}

export function intakeEventTypeLabel(eventType: IntakeEventType): string {
  return t(
    eventType === 'food'
      ? 'intake.typeFood'
      : eventType === 'drink'
        ? 'intake.typeDrink'
        : eventType === 'supplement'
          ? 'intake.typeSupplement'
          : eventType === 'medication'
            ? 'intake.typeMedication'
            : 'intake.typeOther',
  );
}
