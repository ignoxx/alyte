import { Host, Switch } from '@expo/ui';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { type AppLockGrace } from './policy';
import { useAppLock } from './AppLockProvider';
import { AppLockGracePicker } from './AppLockGracePicker';
import { appLockControlsPresentation, appLockGraceOptions } from './app-lock-ui-model';

export function AppLockScreen() {
  const { controller, state } = useAppLock();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const preferences = state.preferences ?? { enabled: false, grace: 'immediate' as const };
  const controls = appLockControlsPresentation(preferences, busy);
  const graceOptions = appLockGraceOptions();

  async function changeEnabled(enabled: boolean): Promise<void> {
    setBusy(true);
    setError(false);
    const result = await controller.setEnabled(enabled);
    setBusy(false);
    if (!result.ok) setError(true);
  }

  async function changeGrace(grace: AppLockGrace): Promise<void> {
    if (!preferences.enabled || busy || grace === preferences.grace) return;
    setBusy(true);
    setError(false);
    const result = await controller.setGrace(grace);
    setBusy(false);
    if (!result.ok) setError(true);
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText variant="caption" style={styles.intro} selectable>
          {t('settings.appLock.intro')}
        </AppText>
        <View style={styles.group}>
          <View
            accessible
            accessibilityRole="switch"
            accessibilityLabel={controls.enable.accessibilityLabel}
            accessibilityHint={controls.enable.accessibilityHint}
            accessibilityState={{
              checked: controls.enable.checked,
              disabled: controls.enable.disabled,
            }}
            onAccessibilityTap={() => {
              if (!controls.enable.disabled) void changeEnabled(!preferences.enabled);
            }}
            style={styles.row}
          >
            <AppIcon name="lockShield" size={22} color={colors.accent} />
            <View style={styles.copy} importantForAccessibility="no-hide-descendants">
              <AppText variant="heading" style={styles.rowTitle}>
                {t('settings.appLock.enable')}
              </AppText>
              <AppText variant="caption" style={styles.supporting}>
                {t('settings.appLock.enableSupporting')}
              </AppText>
            </View>
            <View
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.controlSlot}
            >
              <Host matchContents ignoreSafeArea="all">
                <Switch
                  value={preferences.enabled}
                  disabled={controls.enable.disabled}
                  testID={controls.enable.testID}
                  onValueChange={(value) => void changeEnabled(value)}
                />
              </Host>
            </View>
          </View>
          <View style={[styles.row, styles.lastRow]}>
            <AppIcon name="clock" size={22} color={colors.accent} />
            <View style={styles.copy}>
              <AppText variant="heading" style={styles.rowTitle}>
                {t('settings.appLock.grace')}
              </AppText>
              <AppText variant="caption" style={styles.supporting}>
                {t('settings.appLock.graceSupporting')}
              </AppText>
            </View>
            <View style={styles.controlSlot}>
              <AppLockGracePicker
                accessibilityLabel={controls.grace.accessibilityLabel}
                enabled={!controls.grace.disabled}
                options={graceOptions}
                selectedValue={controls.grace.value}
                testID={controls.grace.testID}
                onValueChange={(value) => void changeGrace(value)}
              />
            </View>
          </View>
        </View>
        {error ? (
          <AppText style={styles.error} selectable>
            {t('settings.appLock.settingsError')}
          </AppText>
        ) : null}
        <AppText variant="caption" style={styles.note} selectable>
          {t('settings.appLock.note')}
        </AppText>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.mutedInk, marginBottom: spacing.sm },
  error: { color: colors.danger, marginTop: spacing.md },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 84,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  lastRow: { borderBottomWidth: 0 },
  copy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  rowTitle: { fontSize: 16, lineHeight: 21 },
  supporting: { color: colors.mutedInk },
  controlSlot: { alignItems: 'flex-end', flexShrink: 0, justifyContent: 'center' },
  note: { color: colors.mutedInk, marginTop: spacing.lg },
});
