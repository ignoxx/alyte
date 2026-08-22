import { StyleSheet, View } from 'react-native';
import { formatIntakeAmount, type IntakeEvent, type IntakeEventType } from '@alyte/domain';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, spacing } from '../../theme';

type IntakeEventCardProps = {
  readonly event: IntakeEvent;
  readonly onEdit?: (() => void) | undefined;
  readonly onLogAgain?: (() => void) | undefined;
  readonly onUndo?: (() => void) | undefined;
  readonly onToggleInclusion?: (() => void) | undefined;
  readonly onDelete?: (() => void) | undefined;
};

function eventTypeLabel(eventType: IntakeEventType): string {
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

export function IntakeEventCard({
  event,
  onEdit,
  onLogAgain,
  onUndo,
  onToggleInclusion,
  onDelete,
}: IntakeEventCardProps) {
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
    new Date(event.occurredAt),
  );
  return (
    <AppSurface style={styles.card}>
      <View style={styles.header}>
        <View style={styles.heading}>
          <AppText variant="heading">
            {event.components.map((component) => component.name).join(', ')}
          </AppText>
          <AppText style={styles.muted}>
            {eventTypeLabel(event.eventType)} · {time}
          </AppText>
        </View>
        {event.analysisInclusion === 'excluded' && <StatusPill>{t('intake.excluded')}</StatusPill>}
        {event.reviewState === 'needs-review' && <StatusPill>{t('intake.checkThis')}</StatusPill>}
      </View>
      <View style={styles.components}>
        {event.components.map((component) => (
          <AppText key={component.id} style={styles.muted}>
            {component.name}: {formatIntakeAmount(component.amount)}
          </AppText>
        ))}
      </View>
      {event.notes !== null && <AppText style={styles.muted}>{event.notes}</AppText>}
      <View style={styles.actions}>
        {onUndo !== undefined && (
          <AppButton label={t('intake.undo')} tone="secondary" onPress={onUndo} />
        )}
        {onEdit !== undefined && (
          <AppButton label={t('intake.edit')} tone="secondary" onPress={onEdit} />
        )}
        {onUndo === undefined && (
          <>
            {onLogAgain !== undefined && (
              <AppButton label={t('intake.logAgain')} tone="quiet" onPress={onLogAgain} />
            )}
            {onToggleInclusion !== undefined && (
              <AppButton
                label={
                  event.analysisInclusion === 'included' ? t('intake.exclude') : t('intake.restore')
                }
                tone="quiet"
                onPress={onToggleInclusion}
              />
            )}
            {onDelete !== undefined && (
              <AppButton label={t('intake.delete')} tone="quiet" onPress={onDelete} />
            )}
          </>
        )}
      </View>
    </AppSurface>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
  heading: { flex: 1, gap: spacing.xs },
  components: { gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  muted: { color: colors.mutedInk },
});
