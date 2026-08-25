import { FieldGroup, Host, Icon, ListItem } from '@expo/ui';
import { useNavigation } from '@react-navigation/native';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';

type SettingsScreenProps = BottomTabScreenProps<MainTabParamList, 'Settings'>;

export function SettingsScreen(_props: SettingsScreenProps) {
  const navigation = useNavigation<any>();

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <AppText variant="caption" style={styles.intro}>
          {t('settings.privacySubtitle')}
        </AppText>
        <Host matchContents>
          <FieldGroup>
            <FieldGroup.Section>
              <ListItem
                leading={<Icon name="lock.shield" size={22} color={colors.accent} />}
                trailing={<AppText>›</AppText>}
                supportingText={t('settings.privacySubtitle')}
                onPress={() => navigation.navigate('PrivacyStorage')}
              >
                {t('settings.privacy')}
              </ListItem>
              <ListItem
                leading={<Icon name="arrow.down.circle" size={22} color={colors.accent} />}
                trailing={<AppText>›</AppText>}
                supportingText={t('settings.modelStorageSubtitle')}
                onPress={() => navigation.navigate('ModelStorage')}
              >
                {t('settings.modelStorage')}
              </ListItem>
              <ListItem
                leading={<Icon name="questionmark.circle" size={22} color={colors.accent} />}
                trailing={<AppText>›</AppText>}
                supportingText={t('settings.supportSubtitle')}
                onPress={() => navigation.navigate('SupportFaq')}
              >
                {t('settings.support')}
              </ListItem>
            </FieldGroup.Section>
          </FieldGroup>
        </Host>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.mutedInk, marginBottom: spacing.sm },
});
