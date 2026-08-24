import { StyleSheet, View } from 'react-native';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppButton, AppText } from '../../ui/primitives';
import type { ExtractionConfirmationProps } from './ExtractionConfirmation.shared';
import { confirmationAccessibilityLabel } from './ExtractionConfirmation.shared';

/** Safe fallback for platforms without the iOS native tab accessory contract. */
export function ExtractionConfirmation({
  busy,
  canConfirm,
  included,
  needsReview,
  onConfirm,
}: ExtractionConfirmationProps) {
  return (
    <View style={styles.footer}>
      <AppText style={styles.progress}>
        {t('labs.extractionConfirmationProgress')
          .replace('{included}', String(included))
          .replace('{review}', String(needsReview))}
      </AppText>
      <AppButton
        accessibilityLabel={confirmationAccessibilityLabel(included, needsReview)}
        disabled={busy || !canConfirm}
        label={t('labs.extractionConfirm')}
        onPress={onConfirm}
        style={styles.confirm}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  footer: {
    alignItems: 'center',
    backgroundColor: colors.elevatedSurface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    paddingBottom: spacing.lg,
  },
  progress: { color: colors.mutedInk, flex: 1, minWidth: 0 },
  confirm: { flexShrink: 0, minWidth: 164 },
});
