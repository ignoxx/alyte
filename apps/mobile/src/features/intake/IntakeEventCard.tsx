import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { formatIntakeAmount, type IntakeEvent } from '@alyte/domain';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import { intakeEventMenuActions, intakeEventTypeLabel, type IntakeEventMenuAction } from './ui';
import type { IntakeCloudJob } from './outbox';

type IntakeEventCardProps = {
  readonly event: IntakeEvent;
  readonly compact?: boolean;
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

function provenanceLabel(provenance: IntakeEvent['provenance']): string {
  return t(
    provenance === 'user-entered'
      ? 'intake.provenanceUserEntered'
      : provenance === 'user-corrected'
        ? 'intake.provenanceUserCorrected'
        : provenance === 'extracted'
          ? 'intake.provenanceExtracted'
          : 'intake.provenanceEstimated',
  );
}

function provenanceTone(
  provenance: IntakeEvent['provenance'],
): 'userEntered' | 'userCorrected' | 'extracted' | 'estimated' {
  return provenance === 'user-entered'
    ? 'userEntered'
    : provenance === 'user-corrected'
      ? 'userCorrected'
      : provenance === 'estimated'
        ? 'estimated'
        : 'extracted';
}

function menuActionLabel(action: IntakeEventMenuAction, event: IntakeEvent): string {
  switch (action) {
    case 'cancel-analysis':
      return t('home.cancelAnalysis');
    case 'toggle-inclusion':
      return event.analysisInclusion === 'included' ? t('intake.exclude') : t('intake.restore');
    case 'remove-image':
      return t('intake.removeImage');
    case 'delete':
      return t('intake.delete');
  }
}

export function IntakeEventCard({
  event,
  compact = false,
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
  const menuActions = intakeEventMenuActions(event, cloudJob);

  function runMenuAction(action: IntakeEventMenuAction): void {
    switch (action) {
      case 'cancel-analysis':
        onCancelAnalysis?.();
        return;
      case 'toggle-inclusion':
        onToggleInclusion?.();
        return;
      case 'remove-image':
        onRemoveImage?.();
        return;
      case 'delete':
        onDelete?.();
        return;
    }
  }

  function openMenu(): void {
    const options = [
      ...menuActions.map((action) => menuActionLabel(action, event)),
      t('intake.cancel'),
    ];
    const cancelButtonIndex = options.length - 1;
    const destructiveButtonIndex = menuActions.indexOf('delete');
    const onSelect = (index: number) => {
      const action = menuActions[index];
      if (action !== undefined) runMenuAction(action);
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex,
          destructiveButtonIndex: destructiveButtonIndex >= 0 ? destructiveButtonIndex : undefined,
          title: t('intake.moreActions'),
        },
        onSelect,
      );
      return;
    }
    Alert.alert(t('intake.moreActions'), undefined, [
      ...menuActions.map((action) => ({
        text: menuActionLabel(action, event),
        onPress: () => runMenuAction(action),
      })),
      { text: t('intake.cancel'), style: 'cancel' },
    ]);
  }

  const content = (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.heading}>
          <AppText variant="heading">
            {event.components.map((component) => component.name).join(', ')}
          </AppText>
          <View style={styles.meta}>
            <AppText style={styles.muted}>
              {intakeEventTypeLabel(event.eventType)} · {time}
            </AppText>
            <StatusPill tone={provenanceTone(event.provenance)}>
              {provenanceLabel(event.provenance)}
            </StatusPill>
          </View>
        </View>
        <View style={styles.statuses}>
          {event.analysisInclusion === 'excluded' && (
            <StatusPill tone="excluded">{t('intake.excluded')}</StatusPill>
          )}
          {event.reviewState === 'needs-review' && (
            <StatusPill tone="reviewNeeded">{t('intake.checkThis')}</StatusPill>
          )}
          <Pressable
            accessibilityLabel={t('intake.moreActions')}
            accessibilityRole="button"
            hitSlop={8}
            onPress={openMenu}
            style={({ pressed }) => [styles.moreButton, pressed && styles.morePressed]}
          >
            <AppText style={styles.moreGlyph}>•••</AppText>
          </Pressable>
        </View>
      </View>
      <View style={styles.components}>
        {event.components.map((component) => (
          <AppText key={component.id} style={styles.muted}>
            {component.name}: {formatIntakeAmount(component.amount)}
          </AppText>
        ))}
      </View>
      {event.notes !== null && <AppText style={styles.muted}>{event.notes}</AppText>}
      {event.sourceMediaPath !== null && (
        <AppText variant="caption" style={styles.source}>
          {t('intake.sourceImage')}
        </AppText>
      )}
      {cloudJob !== undefined && cloudJob !== null && (
        <View style={styles.analysis}>
          <StatusPill>{cloudJobLabel(cloudJob)}</StatusPill>
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
          </>
        )}
      </View>
    </View>
  );

  return compact ? (
    <View style={styles.compactRow}>{content}</View>
  ) : (
    <AppSurface style={styles.surface}>{content}</AppSurface>
  );
}

const styles = StyleSheet.create({
  surface: { padding: spacing.md },
  card: { gap: spacing.sm },
  compactRow: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
  heading: { flex: 1, gap: spacing.xs },
  meta: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  statuses: { alignItems: 'flex-end', gap: spacing.xs },
  components: { gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  analysis: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  muted: { color: colors.mutedInk },
  source: { color: colors.mutedInk },
  moreButton: {
    alignItems: 'center',
    borderRadius: 16,
    justifyContent: 'center',
    minHeight: 32,
    minWidth: 32,
  },
  morePressed: { backgroundColor: colors.accentSoft },
  moreGlyph: { color: colors.mutedInk, fontSize: 16, letterSpacing: 1, lineHeight: 20 },
});
