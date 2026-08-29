import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import type { SettingsStackParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { useAppLock } from '../app-lock/AppLockProvider';
import { buildLocalSettingsRows, getSettingsRowLayout } from './settings-ui-model';

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
  readonly layout: 'inline' | 'accessible';
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
      <AppIcon name={icon} size={22} color={colors.accent} style={styles.rowIcon} />
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
  rowAccessible: { alignItems: 'flex-start', paddingVertical: spacing.md },
  rowPressed: { backgroundColor: colors.accentSoft },
  rowIcon: { flexShrink: 0 },
  rowCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  rowTitle: { flexShrink: 1, fontSize: 16, lineHeight: 21, minWidth: 0 },
  rowSubtitle: { color: colors.mutedInk, flexShrink: 1, minWidth: 0 },
  rowChevron: { flexShrink: 0 },
});
