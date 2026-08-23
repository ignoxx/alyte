import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { formatIntakeAmount, type IntakeEvent } from '@alyte/domain';
import { t } from '../../localization';
import { AppButton, AppIcon, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import {
  intakeEventMenuActions,
  intakeEventTypeLabel,
  intakeProvenanceDescriptor,
  type IntakeEventMenuAction,
} from './ui';
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
    case 'edit':
      return t('intake.edit');
    case 'log-again':
      return t('intake.logAgain');
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
  const { fontScale } = useWindowDimensions();
  const usesAccessibilityTextSize = fontScale >= 1.3;
  const menuActions = intakeEventMenuActions(event, cloudJob);
  const componentProvenances = new Set(event.components.map((component) => component.provenance));
  const mixedComponentProvenance =
    componentProvenances.size > 1 ||
    event.components.some((component) => component.provenance !== event.provenance);
  const eventProvenance = mixedComponentProvenance
    ? { label: t('intake.mixedProvenance'), tone: 'neutral' as const }
    : intakeProvenanceDescriptor(event.provenance);
  const compactProvenanceLabel = mixedComponentProvenance
    ? Array.from(
        new Set(
          event.components.map(
            (component) => intakeProvenanceDescriptor(component.provenance).label,
          ),
        ),
      ).join(' · ')
    : eventProvenance.label;
  const componentNames = event.components.map((component) => component.name).join(', ');

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
      case 'edit':
        onEdit?.();
        return;
      case 'log-again':
        onLogAgain?.();
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

  if (compact) {
    return (
      <View style={styles.compactRow}>
        <Pressable
          accessibilityLabel={`${componentNames} · ${time} · ${compactProvenanceLabel}`}
          accessibilityRole="button"
          onPress={onEdit}
          style={({ pressed }) => [styles.compactMain, pressed && styles.rowPressed]}
        >
          <AppIcon name="snap" size={21} />
          <View style={styles.compactBody}>
            <View
              style={[
                styles.compactTitleRow,
                usesAccessibilityTextSize && styles.accessibilityTitleRow,
              ]}
            >
              <AppText
                variant="heading"
                style={[
                  styles.compactTitle,
                  usesAccessibilityTextSize && styles.accessibilityTitle,
                ]}
              >
                {componentNames}
              </AppText>
              <AppText style={styles.muted}>{time}</AppText>
            </View>
            <View style={styles.compactMeta}>
              <AppText style={styles.muted}>{intakeEventTypeLabel(event.eventType)}</AppText>
              <StatusPill subtle tone={eventProvenance.tone}>
                {compactProvenanceLabel}
              </StatusPill>
              {event.analysisInclusion === 'excluded' && (
                <StatusPill tone="excluded">{t('intake.excluded')}</StatusPill>
              )}
              {event.reviewState === 'needs-review' && (
                <StatusPill tone="reviewNeeded">{t('intake.checkThis')}</StatusPill>
              )}
              {cloudJob !== undefined && cloudJob !== null && (
                <StatusPill>{cloudJobLabel(cloudJob)}</StatusPill>
              )}
            </View>
          </View>
        </Pressable>
        <Pressable
          accessibilityLabel={`${t('intake.moreActions')}: ${componentNames}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={openMenu}
          style={({ pressed }) => [styles.moreButton, pressed && styles.morePressed]}
        >
          <AppIcon name="ellipsis" size={20} />
        </Pressable>
      </View>
    );
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
            <StatusPill tone={eventProvenance.tone}>{eventProvenance.label}</StatusPill>
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
            <AppIcon name="ellipsis" size={20} />
          </Pressable>
        </View>
      </View>
      <View style={styles.components}>
        {event.components.map((component) => (
          <View key={component.id} style={styles.componentRow}>
            <AppText style={styles.muted}>
              {component.name}: {formatIntakeAmount(component.amount)}
            </AppText>
            {mixedComponentProvenance && (
              <StatusPill tone={intakeProvenanceDescriptor(component.provenance).tone}>
                {intakeProvenanceDescriptor(component.provenance).label}
              </StatusPill>
            )}
            {component.reviewState === 'needs-review' && (
              <StatusPill tone="reviewNeeded">{t('intake.checkThis')}</StatusPill>
            )}
          </View>
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

  return <AppSurface style={styles.surface}>{content}</AppSurface>;
}

const styles = StyleSheet.create({
  surface: { padding: spacing.md },
  card: { gap: spacing.sm },
  compactRow: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 72,
    paddingRight: spacing.xs,
  },
  compactMain: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 72,
    minWidth: 0,
    paddingLeft: spacing.md,
    paddingVertical: spacing.sm,
  },
  compactBody: { flex: 1, gap: spacing.xs, minWidth: 0 },
  compactTitle: { flex: 1 },
  compactTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  accessibilityTitle: { flex: 0 },
  accessibilityTitleRow: { alignItems: 'flex-start', flexDirection: 'column' },
  compactMeta: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  rowPressed: { backgroundColor: colors.accentSoft },
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.sm },
  heading: { flex: 1, gap: spacing.xs },
  meta: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  statuses: { alignItems: 'flex-end', gap: spacing.xs },
  components: { gap: spacing.xs },
  componentRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  analysis: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  muted: { color: colors.mutedInk },
  source: { color: colors.mutedInk },
  moreButton: {
    alignItems: 'center',
    borderRadius: 16,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
  },
  morePressed: { backgroundColor: colors.accentSoft },
});
