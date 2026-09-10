import { StyleSheet, View } from 'react-native';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppButton, AppText } from '../../ui/primitives';
import type { ExtractionConfirmationProps } from './ExtractionConfirmation.shared';
import { extractionConfirmationPresentation } from './ExtractionConfirmation.shared';

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
  onLeaveWithoutSaving,
  onReviewRemaining,
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
  const action = presentation.action;

  if (action === null) return null;

  return (
    <View style={[styles.footer, failure && styles.failureFooter]}>
      {failure && (
        <AppText selectable style={styles.failure}>
          {t('labs.extractionConfirmationFailure')}
        </AppText>
      )}
      <AppButton
        accessibilityLabel={action.accessibilityLabel}
        accessibilityState={{ busy: action.disabled, disabled: action.disabled }}
        disabled={action.disabled}
        label={action.label}
        onPress={() => {
          if (action.kind === 'review') onReviewRemaining();
          else if (action.kind === 'leave') onLeaveWithoutSaving();
          else onConfirm();
        }}
        style={styles.action}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    alignItems: 'stretch',
    backgroundColor: colors.elevatedSurface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  failureFooter: { alignItems: 'stretch', flexDirection: 'column', gap: spacing.sm },
  failure: { color: colors.danger, textAlign: 'center' },
  action: { alignSelf: 'stretch' },
});
