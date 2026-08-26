import { StyleSheet, View } from 'react-native';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppButton, AppText } from '../../ui/primitives';
import type { ExtractionConfirmationProps } from './ExtractionConfirmation.shared';
import {
  confirmationAccessibilityLabel,
  extractionConfirmationPresentation,
} from './ExtractionConfirmation.shared';

/** Safe fallback for platforms without the iOS native tab accessory contract. */
export function ExtractionConfirmation({
  busy,
  canConfirm,
  failure = false,
  included,
  needsReview,
  remainingBlockers,
  blockedReason,
  onConfirm,
}: ExtractionConfirmationProps) {
  const presentation = extractionConfirmationPresentation(
    {
      included,
      needsReview,
      remainingBlockers,
      canConfirm,
      blockedReason,
    },
    { busy, failure },
  );
  const statusLabel =
    presentation.state === 'busy'
      ? t('labs.extractionConfirmationBusy')
      : presentation.state === 'failure'
        ? t('labs.extractionConfirmationFailure')
        : presentation.state === 'blocked'
          ? blockedReason === 'no-included-rows'
            ? t('labs.extractionConfirmationNoIncluded')
            : t('labs.extractionConfirmationBlocked').replace('{count}', String(remainingBlockers))
          : t('labs.extractionConfirmationReady');

  return (
    <View style={styles.footer}>
      <View accessibilityRole="text" style={styles.summary}>
        <AppText selectable style={styles.progress}>
          {t('labs.extractionConfirmationProgress')
            .replace('{included}', String(included))
            .replace('{review}', String(needsReview))}
        </AppText>
        <AppText
          selectable
          style={presentation.state === 'blocked' ? styles.blocked : styles.status}
        >
          {statusLabel}
        </AppText>
      </View>
      <AppButton
        accessibilityLabel={confirmationAccessibilityLabel(
          included,
          needsReview,
          remainingBlockers,
          blockedReason,
        )}
        accessibilityState={{ busy, disabled: presentation.disabled }}
        disabled={presentation.disabled}
        label={
          presentation.state === 'busy'
            ? t('labs.extractionConfirmationBusyAction')
            : t('labs.extractionConfirm')
        }
        onPress={onConfirm}
        style={styles.confirm}
      />
    </View>
  );
}

/* Keep the summary in normal flow so large text grows the accessory instead of covering Confirm. */
const styles = StyleSheet.create({
  footer: {
    alignItems: 'stretch',
    backgroundColor: colors.elevatedSurface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  summary: { flex: 1, gap: spacing.xs, justifyContent: 'center', minWidth: 0 },
  progress: { color: colors.mutedInk, fontVariant: ['tabular-nums'] },
  status: { color: colors.mutedInk },
  blocked: { color: colors.danger },
  confirm: { flexShrink: 0, minWidth: 164 },
});
