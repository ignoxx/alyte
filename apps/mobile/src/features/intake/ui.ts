import type { IntakeEventType } from '@alyte/domain';
import { t } from '../../localization';

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
