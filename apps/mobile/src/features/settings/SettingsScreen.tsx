import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import type { SettingsStackParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppIcon, AppText, ScreenScrollView, TidalHero, TidalIconStage } from '../../ui/primitives';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
import { useAppLock } from '../app-lock/AppLockProvider';
import {
  buildLocalSettingsRows,
  getSettingsRowLayout,
  type SettingsRowLayout,
} from './settings-ui-model';

type SettingsScreenProps = BottomTabScreenProps<MainTabParamList, 'Settings'>;
type SettingsNavigation = NativeStackNavigationProp<SettingsStackParamList, 'SettingsRoot'>;

function SettingsRow({
  icon,
  title,
  subtitle,
  layout,
  onPress,
}: {
  readonly icon: 'lockShield' | 'shield' | 'folder' | 'settings' | 'doc';
  readonly title: string;
  readonly subtitle: string;
  readonly layout: SettingsRowLayout;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        layout === 'accessible' && styles.rowAccessible,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={styles.rowIconWell}>
        <AppIcon name={icon} size={20} color={colors.accent} style={styles.rowIcon} />
      </View>
      <View style={styles.rowCopy}>
        <AppText variant="heading" style={styles.rowTitle}>
          {title}
        </AppText>
        <AppText variant="caption" style={styles.rowSubtitle}>
          {subtitle}
        </AppText>
      </View>
      <AppIcon name="chevronRight" size={16} color={colors.mutedInk} style={styles.rowChevron} />
    </Pressable>
  );
}

export function SettingsScreen(_props: SettingsScreenProps) {
  const navigation = useNavigation<SettingsNavigation>();
  const { state } = useAppLock();
  const { fontScale } = useWindowDimensions();
  const rowLayout = getSettingsRowLayout(fontScale);
  const appLockStatus = state.preferences?.enabled
    ? t('settings.appLockEnabled')
    : t('settings.appLockDisabled');
  const rows = buildLocalSettingsRows(appLockStatus);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <TidalHero style={styles.settingsHero}>
          <View style={styles.settingsHeroHeading}>
            <TidalIconStage name="lockShield" size="compact" />
            <View style={styles.settingsHeroCopy}>
              <AppText style={styles.settingsHeroTitle} variant="title">
                {t('settings.localTitle')}
              </AppText>
              <AppText style={styles.settingsHeroBody} variant="caption">
                {t('settings.localBody')}
              </AppText>
            </View>
          </View>
        </TidalHero>
        <View style={styles.group}>
          {rows.map((row) => (
            <SettingsRow
              key={row.route}
              icon={row.icon}
              layout={rowLayout}
              title={row.title}
              subtitle={row.subtitle}
              onPress={() => navigation.navigate(row.route)}
            />
          ))}
        </View>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  settingsHero: { marginBottom: spacing.xl, padding: spacing.lg },
  settingsHeroHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  settingsHeroCopy: { flex: 1, gap: spacing.xs, minWidth: 200 },
  settingsHeroTitle: { color: colors.onBrand },
  settingsHeroBody: { color: colors.onBrandMuted },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
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
  rowAccessible: { alignItems: 'flex-start', paddingVertical: spacing.md },
  rowPressed: { backgroundColor: colors.accentSoft },
  rowIconWell: {
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderRadius: radii.sm,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  rowIcon: { flexShrink: 0 },
  rowCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  rowTitle: { ...typography.row, flexShrink: 1, minWidth: 0 },
  rowSubtitle: { color: colors.mutedInk, flexShrink: 1, minWidth: 0 },
  rowChevron: { flexShrink: 0 },
});
