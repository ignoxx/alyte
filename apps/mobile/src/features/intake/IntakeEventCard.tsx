import { StyleSheet, View } from 'react-native';
import { formatIntakeAmount, type IntakeEvent } from '@alyte/domain';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import { intakeEventTypeLabel } from './ui';
import type { IntakeCloudJob } from './outbox';

type IntakeEventCardProps = {
  readonly event: IntakeEvent;
  readonly onEdit?: (() => void) | undefined;
  readonly onLogAgain?: (() => void) | undefined;
  readonly onUndo?: (() => void) | undefined;
  readonly onToggleInclusion?: (() => void) | undefined;
  readonly onDelete?: (() => void) | undefined;
  readonly onRemoveImage?: (() => void) | undefined;
  readonly cloudJob?: IntakeCloudJob | null | undefined;
  readonly onCancelAnalysis?: (() => void) | undefined;
};

function cloudJobLabel(job: IntakeCloudJob): string {
  switch (job.state) {
    case 'queued':
      return t('home.analysisQueued');
    case 'uploading':
      return t('home.analysisUploading');
    case 'submitted':
      return t('home.analysisSubmitted');
    case 'processing':
      return t('home.analysisProcessing');
    case 'ready':
      return t('home.analysisReady');
    case 'applied':
      return t('home.analysisApplied');
    case 'failed':
      return t('home.analysisFailed');
    case 'expired':
      return t('home.analysisExpired');
    case 'cancelled':
      return t('home.analysisCancelled');
  }
}

export function IntakeEventCard({
  event,
  onEdit,
  onLogAgain,
  onUndo,
  onToggleInclusion,
  onDelete,
  onRemoveImage,
  cloudJob,
  onCancelAnalysis,
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
            {intakeEventTypeLabel(event.eventType)} · {time}
          </AppText>
        </View>
        {event.analysisInclusion === 'excluded' && (
          <StatusPill tone="excluded">{t('intake.excluded')}</StatusPill>
        )}
        {event.reviewState === 'needs-review' && (
          <StatusPill tone="reviewNeeded">{t('intake.checkThis')}</StatusPill>
        )}
      </View>
      <View style={styles.components}>
        {event.components.map((component) => (
          <AppText key={component.id} style={styles.muted}>
            {component.name}: {formatIntakeAmount(component.amount)}
          </AppText>
        ))}
      </View>
      {event.notes !== null && <AppText style={styles.muted}>{event.notes}</AppText>}
      {cloudJob !== undefined && cloudJob !== null && (
        <View style={styles.analysis}>
          <StatusPill>{cloudJobLabel(cloudJob)}</StatusPill>
          {cloudJob.state === 'queued' && onCancelAnalysis !== undefined && (
            <AppButton label={t('home.cancelAnalysis')} tone="quiet" onPress={onCancelAnalysis} />
          )}
        </View>
      )}
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
            {onRemoveImage !== undefined && event.sourceMediaPath !== null && (
              <AppButton label={t('intake.removeImage')} tone="quiet" onPress={onRemoveImage} />
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
  analysis: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  muted: { color: colors.mutedInk },
});
