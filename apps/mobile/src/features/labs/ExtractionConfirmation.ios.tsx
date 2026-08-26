import { useLayoutEffect } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { LabsStackParamList } from '../../navigation/types';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppText } from '../../ui/primitives';
import type { ExtractionConfirmationProps } from './ExtractionConfirmation.shared';
import {
  confirmationAccessibilityLabel,
  extractionConfirmationLayout,
  extractionConfirmationPresentation,
} from './ExtractionConfirmation.shared';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;

/** iOS 26 owns the accessory's size and placement above the native Liquid Glass tab bar. */
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
  const navigation = useNavigation<Navigation>();

  useLayoutEffect(() => {
    const tabNavigation = navigation.getParent();
    if (tabNavigation === undefined) return;
    tabNavigation.setOptions({
      bottomAccessory: () => (
        <ReviewAccessory
          busy={busy}
          canConfirm={canConfirm}
          failure={failure}
          included={included}
          needsReview={needsReview}
          remainingBlockers={remainingBlockers}
          blockedReason={blockedReason}
          onConfirm={onConfirm}
        />
      ),
    });
    return () => tabNavigation.setOptions({ bottomAccessory: undefined });
  }, [
    blockedReason,
    busy,
    canConfirm,
    failure,
    included,
    navigation,
    needsReview,
    onConfirm,
    remainingBlockers,
  ]);

  return null;
}

function ReviewAccessory({
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
  const disabled = presentation.disabled;

  return (
    <View style={[styles.accessory, layout === 'stacked' && styles.accessoryStacked]}>
      <View
        accessibilityRole="text"
        style={[styles.summary, layout === 'stacked' && styles.summaryStacked]}
      >
        <AppText
          selectable
          style={styles.progress}
          // Keep the compact native slot readable while VoiceOver receives the full label below.
          numberOfLines={layout === 'stacked' ? undefined : 2}
        >
          {t('labs.extractionConfirmationProgress')
            .replace('{included}', String(included))
            .replace('{review}', String(needsReview))}
        </AppText>
        <AppText
          selectable
          numberOfLines={layout === 'stacked' ? undefined : 2}
          style={presentation.state === 'blocked' ? styles.blocked : styles.status}
        >
          {presentation.statusLabel}
        </AppText>
      </View>
      <Pressable
        accessibilityLabel={confirmationAccessibilityLabel(
          included,
          needsReview,
          remainingBlockers,
          blockedReason,
        )}
        accessibilityRole="button"
        accessibilityState={{ busy, disabled }}
        disabled={disabled}
        onPress={onConfirm}
        style={({ pressed }) => [
          styles.action,
          layout === 'stacked' && styles.actionStacked,
          pressed && !disabled && styles.actionPressed,
          disabled && styles.actionDisabled,
        ]}
      >
        <AppText variant="label" style={styles.actionLabel}>
          {busy ? t('labs.extractionConfirmationBusyAction') : t('labs.extractionConfirmShort')}
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  accessory: {
    alignItems: 'stretch',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  accessoryStacked: { flexDirection: 'column' },
  summary: { flex: 1, gap: spacing.xs, justifyContent: 'center', minWidth: 0 },
  summaryStacked: { flex: 0, width: '100%' },
  progress: { color: colors.mutedInk, fontVariant: ['tabular-nums'] },
  status: { color: colors.mutedInk },
  blocked: { color: colors.danger },
  action: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 104,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  actionStacked: { alignSelf: 'flex-end' },
  actionPressed: { backgroundColor: colors.accentSoft },
  actionDisabled: { opacity: 0.45 },
  actionLabel: { color: colors.accent, textAlign: 'center' },
});
