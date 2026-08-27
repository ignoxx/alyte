import { useLayoutEffect, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { LabsStackParamList } from '../../navigation/types';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppText } from '../../ui/primitives';
import type {
  ExtractionConfirmationAction,
  ExtractionConfirmationProps,
} from './ExtractionConfirmation.shared';
import { extractionConfirmationPresentation } from './ExtractionConfirmation.shared';

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
  onReviewRemaining,
}: ExtractionConfirmationProps) {
  const navigation = useNavigation<Navigation>();
  const presentation = useMemo(
    () =>
      extractionConfirmationPresentation(
        {
          included,
          needsReview,
          remainingBlockers,
          canConfirm,
          blockedReason,
        },
        { busy, failure },
      ),
    [blockedReason, busy, canConfirm, failure, included, needsReview, remainingBlockers],
  );
  const action = presentation.action;

  useLayoutEffect(() => {
    const tabNavigation = navigation.getParent();
    if (tabNavigation === undefined) return;
    if (action === null) {
      tabNavigation.setOptions({ bottomAccessory: undefined });
      return;
    }

    tabNavigation.setOptions({
      bottomAccessory: () => (
        <ReviewAccessory
          action={action}
          failure={presentation.state === 'failure'}
          onConfirm={onConfirm}
          onReviewRemaining={onReviewRemaining}
        />
      ),
    });
    return () => tabNavigation.setOptions({ bottomAccessory: undefined });
  }, [action, navigation, onConfirm, onReviewRemaining, presentation.state]);

  return null;
}

function ReviewAccessory({
  action,
  failure,
  onConfirm,
  onReviewRemaining,
}: {
  readonly action: ExtractionConfirmationAction;
  readonly failure: boolean;
  readonly onConfirm: () => void;
  readonly onReviewRemaining: () => void;
}) {
  const handlePress = () => {
    if (action.kind === 'review') onReviewRemaining();
    else onConfirm();
  };

  return (
    <View style={[styles.accessory, failure && styles.failureAccessory]}>
      {failure && (
        <AppText accessibilityRole="text" numberOfLines={1} selectable style={styles.failure}>
          {t('labs.extractionConfirmationFailure')}
        </AppText>
      )}
      <Pressable
        accessibilityLabel={action.accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ busy: action.disabled, disabled: action.disabled }}
        disabled={action.disabled}
        onPress={handlePress}
        style={({ pressed }) => [
          styles.action,
          action.kind === 'save' && !failure ? styles.saveAction : styles.quietAction,
          pressed && !action.disabled && styles.actionPressed,
          action.disabled && styles.actionDisabled,
        ]}
      >
        <AppText
          numberOfLines={1}
          variant="label"
          style={[styles.actionLabel, action.kind === 'save' && !failure && styles.saveLabel]}
        >
          {action.label}
        </AppText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  accessory: {
    alignItems: 'stretch',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  failureAccessory: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  failure: { color: colors.danger, flex: 1, minWidth: 0 },
  action: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  quietAction: { backgroundColor: colors.accentSoft },
  saveAction: { backgroundColor: colors.accent },
  actionPressed: { opacity: 0.78 },
  actionDisabled: { opacity: 0.58 },
  actionLabel: { color: colors.accent, textAlign: 'center' },
  saveLabel: { color: colors.onAccent },
});
