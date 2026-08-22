import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppSurface, AppText, GroupedRow, ScreenScrollView, StatusPill } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';

type SettingsScreenProps = BottomTabScreenProps<MainTabParamList, 'Settings'>;

export function SettingsScreen(_props: SettingsScreenProps) {
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <AppSurface style={styles.card}>
          <GroupedRow icon="settings">
            <StatusPill>{t('settings.localMode')}</StatusPill>
            <AppText variant="heading">{t('settings.privacy')}</AppText>
            <AppText style={styles.body}>{t('settings.localModeBody')}</AppText>
          </GroupedRow>
        </AppSurface>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  body: { color: colors.mutedInk },
});
