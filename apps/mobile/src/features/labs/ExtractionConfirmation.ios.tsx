import { useLayoutEffect } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { LabsStackParamList } from '../../navigation/types';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppText } from '../../ui/primitives';
import type { ExtractionConfirmationProps } from './ExtractionConfirmation.shared';
import { confirmationAccessibilityLabel } from './ExtractionConfirmation.shared';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;

/** iOS 26 owns the accessory's size and placement above the native Liquid Glass tab bar. */
export function ExtractionConfirmation({
  busy,
  canConfirm,
  included,
  needsReview,
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
          included={included}
          needsReview={needsReview}
          onConfirm={onConfirm}
        />
      ),
    });
    return () => tabNavigation.setOptions({ bottomAccessory: undefined });
  }, [busy, canConfirm, included, navigation, needsReview, onConfirm]);

  return null;
}

function ReviewAccessory({
  busy,
  canConfirm,
  included,
  needsReview,
  onConfirm,
}: ExtractionConfirmationProps) {
  const disabled = busy || !canConfirm;

  return (
    <View style={styles.accessory}>
      <Pressable
        accessibilityLabel={confirmationAccessibilityLabel(included, needsReview)}
        accessibilityRole="button"
        accessibilityState={{ busy, disabled }}
        disabled={disabled}
        onPress={onConfirm}
        style={({ pressed }) => [
          styles.action,
          pressed && !disabled && styles.actionPressed,
          disabled && styles.actionDisabled,
        ]}
      >
        {busy ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <AppText variant="label" style={styles.actionLabel}>
            {t('labs.extractionConfirmShort')}
          </AppText>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  accessory: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  action: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 999,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 96,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  actionPressed: { backgroundColor: colors.accentSoft },
  actionDisabled: { opacity: 0.45 },
  actionLabel: { color: colors.accent, textAlign: 'center' },
});
