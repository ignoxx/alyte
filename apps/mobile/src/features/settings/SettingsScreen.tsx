import { useNavigation } from '@react-navigation/native';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { useAppLock } from '../app-lock/AppLockProvider';

type SettingsScreenProps = BottomTabScreenProps<MainTabParamList, 'Settings'>;

function SettingsRow({
  icon,
  title,
  subtitle,
  onPress,
}: {
  readonly icon: 'lockShield' | 'shield' | 'folder' | 'settings' | 'doc' | 'cloud';
  readonly title: string;
  readonly subtitle: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <AppIcon name={icon} size={22} color={colors.accent} />
      <View style={styles.rowCopy}>
        <AppText variant="heading" style={styles.rowTitle}>
          {title}
        </AppText>
        <AppText variant="caption" style={styles.rowSubtitle}>
          {subtitle}
        </AppText>
      </View>
      <AppIcon name="chevronRight" size={16} color={colors.mutedInk} />
    </Pressable>
  );
}

export function SettingsScreen(_props: SettingsScreenProps) {
  const navigation = useNavigation<any>();
  const { state } = useAppLock();
  const appLockStatus = state.preferences?.enabled
    ? t('settings.appLockEnabled')
    : t('settings.appLockDisabled');

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <View style={styles.group}>
          <SettingsRow
            icon="cloud"
            title={t('settings.cloudAccountTitle')}
            subtitle={t('settings.cloudAccountSubtitle')}
            onPress={() => navigation.navigate('CloudAccount')}
          />
          <SettingsRow
            icon="lockShield"
            title={t('settings.appLockTitle')}
            subtitle={`${t('settings.appLockSubtitle')} · ${appLockStatus}`}
            onPress={() => navigation.navigate('AppLock')}
          />
          <SettingsRow
            icon="shield"
            title={t('settings.privacy')}
            subtitle={t('settings.privacySubtitle')}
            onPress={() => navigation.navigate('PrivacyStorage')}
          />
          <SettingsRow
            icon="folder"
            title={t('settings.modelStorage')}
            subtitle={t('settings.modelStorageSubtitle')}
            onPress={() => navigation.navigate('ModelStorage')}
          />
          <SettingsRow
            icon="doc"
            title={t('settings.support')}
            subtitle={t('settings.supportSubtitle')}
            onPress={() => navigation.navigate('SupportFaq')}
          />
        </View>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 70,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  rowPressed: { backgroundColor: colors.accentSoft },
  rowCopy: { flex: 1, gap: spacing.xs },
  rowTitle: { fontSize: 16, lineHeight: 21 },
  rowSubtitle: { color: colors.mutedInk },
});
