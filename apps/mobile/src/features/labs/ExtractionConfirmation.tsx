import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppButton, AppText } from '../../ui/primitives';
import type { ExtractionConfirmationProps } from './ExtractionConfirmation.shared';
import {
  confirmationAccessibilityLabel,
  extractionConfirmationLayout,
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
  const { fontScale, width } = useWindowDimensions();
  const layout = extractionConfirmationLayout(fontScale, width);
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

  return (
    <View style={[styles.footer, layout === 'stacked' && styles.footerStacked]}>
      <View
        accessibilityRole="text"
        style={[styles.summary, layout === 'stacked' && styles.summaryStacked]}
      >
        <AppText selectable style={styles.progress}>
          {t('labs.extractionConfirmationProgress')
            .replace('{included}', String(included))
            .replace('{review}', String(needsReview))}
        </AppText>
        <AppText
          selectable
          style={presentation.state === 'blocked' ? styles.blocked : styles.status}
        >
          {presentation.statusLabel}
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
        style={[styles.confirm, layout === 'stacked' && styles.confirmStacked]}
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
  footerStacked: { flexDirection: 'column' },
  summary: { flex: 1, gap: spacing.xs, justifyContent: 'center', minWidth: 0 },
  summaryStacked: { flex: 0, width: '100%' },
  progress: { color: colors.mutedInk, fontVariant: ['tabular-nums'] },
  status: { color: colors.mutedInk },
  blocked: { color: colors.danger },
  confirm: { flexShrink: 0, minWidth: 164 },
  confirmStacked: { alignSelf: 'flex-end' },
});
