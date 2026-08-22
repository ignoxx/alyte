import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { screenStyles, spacing } from '../../theme';

type SettingsScreenProps = BottomTabScreenProps<MainTabParamList, 'Settings'>;

export function SettingsScreen(_props: SettingsScreenProps) {
  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <AppText variant="title">{t('settings.title')}</AppText>
        <AppSurface style={styles.card}>
          <StatusPill>{t('settings.localMode')}</StatusPill>
          <AppText variant="heading">{t('settings.privacy')}</AppText>
          <AppText style={styles.body}>{t('settings.localModeBody')}</AppText>
        </AppSurface>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm },
  body: { color: '#617171' },
});
