import { FieldGroup, Host, Icon, ListItem, Picker, Switch } from '@expo/ui';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { APP_LOCK_GRACES, type AppLockGrace } from './policy';
import { useAppLock } from './AppLockProvider';

const graceLabel: Record<AppLockGrace, string> = {
  immediate: 'settings.appLock.graceImmediate',
  oneMinute: 'settings.appLock.graceOneMinute',
  fiveMinutes: 'settings.appLock.graceFiveMinutes',
};

export function AppLockScreen() {
  const { controller, state } = useAppLock();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const preferences = state.preferences ?? { enabled: false, grace: 'immediate' as const };

  async function changeEnabled(enabled: boolean): Promise<void> {
    setBusy(true);
    setError(false);
    const result = await controller.setEnabled(enabled);
    setBusy(false);
    if (!result.ok) setError(true);
  }

  async function changeGrace(grace: AppLockGrace): Promise<void> {
    if (!preferences.enabled || busy || grace === preferences.grace) return;
    setError(false);
    const result = await controller.setGrace(grace);
    if (!result.ok) setError(true);
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <AppText variant="caption" style={styles.intro} selectable>
          {t('settings.appLock.intro')}
        </AppText>
        <Host matchContents>
          <FieldGroup>
            <FieldGroup.Section>
              <ListItem
                leading={<Icon name="lock.shield" size={22} color={colors.accent} />}
                trailing={
                  <Switch
                    value={preferences.enabled}
                    disabled={busy}
                    testID="app-lock-enabled"
                    onValueChange={(value) => void changeEnabled(value)}
                  />
                }
                supportingText={t('settings.appLock.enableSupporting')}
              >
                {t('settings.appLock.enable')}
              </ListItem>
              <ListItem
                leading={<Icon name="clock" size={22} color={colors.accent} />}
                trailing={
                  <Picker
                    appearance="menu"
                    enabled={preferences.enabled && !busy}
                    selectedValue={preferences.grace}
                    testID="app-lock-grace"
                    onValueChange={(value) => void changeGrace(value as AppLockGrace)}
                  >
                    {APP_LOCK_GRACES.map((grace) => (
                      <Picker.Item key={grace} label={t(graceLabel[grace])} value={grace} />
                    ))}
                  </Picker>
                }
                supportingText={t('settings.appLock.graceSupporting')}
              >
                {t('settings.appLock.grace')}
              </ListItem>
            </FieldGroup.Section>
          </FieldGroup>
        </Host>
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
  note: { color: colors.mutedInk, marginTop: spacing.lg },
});
