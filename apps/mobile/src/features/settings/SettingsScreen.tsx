import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Host, Picker } from '@expo/ui';
import { StatusBar } from 'expo-status-bar';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import type { SettingsStackParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppIcon, AppText, ScreenScrollView, TidalHero, TidalIconStage } from '../../ui/primitives';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
import { useAppLock } from '../app-lock/AppLockProvider';
import { useHomeLayout } from './HomeLayoutProvider';
import { isHomeLayout } from './home-layout-preference';
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
  last,
  onPress,
}: {
  readonly icon: 'lockShield' | 'shield' | 'folder' | 'settings' | 'doc';
  readonly title: string;
  readonly subtitle: string;
  readonly layout: SettingsRowLayout;
  readonly last: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        last && styles.lastRow,
        layout === 'accessible' && styles.rowAccessible,
        pressed && styles.rowPressed,
      ]}
    >
      {layout === 'accessible' ? (
        <>
          <View style={styles.rowAccessibleHeader}>
            <View style={styles.rowIconWell}>
              <AppIcon name={icon} size={20} color={colors.accent} style={styles.rowIcon} />
            </View>
            <AppIcon
              name="chevronRight"
              size={16}
              color={colors.mutedInk}
              style={styles.rowChevron}
            />
          </View>
          <View style={styles.rowCopy}>
            <AppText variant="heading" style={styles.rowTitle}>
              {title}
            </AppText>
            <AppText variant="caption" style={styles.rowSubtitle}>
              {subtitle}
            </AppText>
          </View>
        </>
      ) : (
        <>
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
          <AppIcon
            name="chevronRight"
            size={16}
            color={colors.mutedInk}
            style={styles.rowChevron}
          />
        </>
      )}
    </Pressable>
  );
}

export function SettingsScreen(_props: SettingsScreenProps) {
  const isFocused = useIsFocused();
  const navigation = useNavigation<SettingsNavigation>();
  const { state } = useAppLock();
  const { fontScale } = useWindowDimensions();
  const {
    layout: homeLayout,
    loading: homeLayoutLoading,
    saving: homeLayoutSaving,
    error: homeLayoutError,
    retry: retryHomeLayout,
    setLayout: setHomeLayout,
  } = useHomeLayout();
  const rowLayout = getSettingsRowLayout(fontScale);
  const heroTitleScale = Math.min(fontScale, 1.8);
  const heroBodyScale = Math.min(fontScale, 2);
  const appLockStatus = state.preferences?.enabled
    ? t('settings.appLockEnabled')
    : t('settings.appLockDisabled');
  const rows = buildLocalSettingsRows(appLockStatus);
  const homeLayoutLabel = t(`settings.homeLayout.${homeLayout}`);
  const homeLayoutErrorLabel =
    homeLayoutError === 'read-failed'
      ? t('settings.homeLayout.readError')
      : homeLayoutError === 'write-failed'
        ? t('settings.homeLayout.writeError')
        : null;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[screenStyles.safe, styles.screenSafe]}>
      {isFocused && <StatusBar style="light" />}
      <ScreenScrollView
        contentContainerStyle={[screenStyles.content, styles.settingsContent]}
        style={[screenStyles.scroll, styles.canvas]}
        tabBarClearance="native"
      >
        <TidalHero edge="bottom" style={styles.settingsHero}>
          <View
            style={[
              styles.settingsHeroHeading,
              rowLayout === 'accessible' && styles.settingsHeroHeadingAccessible,
            ]}
          >
            {rowLayout !== 'accessible' && <TidalIconStage name="lockShield" size="compact" />}
            <View
              style={[
                styles.settingsHeroCopy,
                rowLayout === 'accessible' && styles.settingsHeroCopyAccessible,
              ]}
            >
              <AppText
                allowFontScaling={false}
                style={[
                  styles.settingsHeroTitle,
                  { fontSize: 26 * heroTitleScale, lineHeight: 32 * heroTitleScale },
                ]}
                variant="title"
              >
                {t('settings.localTitle')}
              </AppText>
              <AppText
                allowFontScaling={false}
                style={[
                  styles.settingsHeroBody,
                  { fontSize: 13 * heroBodyScale, lineHeight: 18 * heroBodyScale },
                ]}
                variant="caption"
              >
                {t('settings.localBody')}
              </AppText>
            </View>
          </View>
        </TidalHero>
        <View style={styles.group}>
          {rows.map((row, index) => (
            <SettingsRow
              key={row.route}
              icon={row.icon}
              layout={rowLayout}
              last={index === rows.length - 1}
              title={row.title}
              subtitle={row.subtitle}
              onPress={() => navigation.navigate(row.route)}
            />
          ))}
        </View>
        <View style={[styles.group, styles.layoutGroup]}>
          <View
            style={[styles.layoutRow, rowLayout === 'accessible' && styles.layoutRowAccessible]}
          >
            <View style={styles.layoutCopy}>
              <AppText variant="heading" style={styles.rowTitle}>
                {t('settings.homeLayout.title')}
              </AppText>
              <AppText variant="caption" style={styles.rowSubtitle}>
                {t('settings.homeLayout.body')}
              </AppText>
            </View>
            <View
              style={[
                styles.layoutPickerSurface,
                rowLayout === 'accessible' && styles.layoutPickerSurfaceAccessible,
              ]}
            >
              <Host
                accessible
                accessibilityLabel={`${t('settings.homeLayout.title')}: ${homeLayoutLabel}`}
                accessibilityRole="button"
                accessibilityState={{
                  disabled:
                    homeLayoutLoading || homeLayoutSaving || homeLayoutError === 'read-failed',
                }}
                accessibilityValue={{ text: homeLayoutLabel }}
                ignoreSafeArea="all"
                matchContents
              >
                <Picker
                  appearance="menu"
                  enabled={
                    !homeLayoutLoading && !homeLayoutSaving && homeLayoutError !== 'read-failed'
                  }
                  selectedValue={homeLayout}
                  testID="home-layout-picker"
                  onValueChange={(value) => {
                    if (isHomeLayout(value)) void setHomeLayout(value);
                  }}
                >
                  <Picker.Item label={t('settings.homeLayout.masonry')} value="masonry" />
                  <Picker.Item label={t('settings.homeLayout.list')} value="list" />
                </Picker>
              </Host>
            </View>
          </View>
          {homeLayoutErrorLabel !== null ? (
            <View style={styles.layoutErrorRow}>
              <AppText variant="caption" style={styles.layoutError}>
                {homeLayoutErrorLabel}
              </AppText>
              {homeLayoutError === 'read-failed' ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('settings.homeLayout.retry')}
                  disabled={homeLayoutLoading || homeLayoutSaving}
                  onPress={() => void retryHomeLayout()}
                  style={({ pressed }) => [styles.layoutRetry, pressed && styles.rowPressed]}
                >
                  <AppText style={styles.layoutRetryLabel}>
                    {t('settings.homeLayout.retry')}
                  </AppText>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screenSafe: { backgroundColor: colors.brand },
  canvas: { backgroundColor: colors.canvas },
  settingsContent: { paddingTop: 0 },
  settingsHero: {
    justifyContent: 'flex-end',
    marginBottom: spacing.xl,
    marginHorizontal: -spacing.lg,
    minHeight: 214,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    paddingTop: spacing.xxl,
  },
  settingsHeroHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  settingsHeroHeadingAccessible: { alignItems: 'flex-start', flexDirection: 'column' },
  settingsHeroCopy: { flex: 1, gap: spacing.xs, minWidth: 200 },
  settingsHeroCopyAccessible: { flex: 0, minWidth: 0, width: '100%' },
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
  layoutGroup: { marginTop: spacing.lg, overflow: 'hidden' },
  layoutRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 76,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  layoutRowAccessible: {
    alignItems: 'stretch',
    flexDirection: 'column',
    paddingVertical: spacing.md,
  },
  layoutCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  layoutPickerSurface: { alignItems: 'flex-end', flexShrink: 0 },
  layoutPickerSurfaceAccessible: { alignItems: 'flex-start', maxWidth: '100%', width: '100%' },
  layoutErrorRow: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  layoutError: { color: colors.danger, flex: 1 },
  layoutRetry: {
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  layoutRetryLabel: { color: colors.accent, fontWeight: '700' },
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
  rowAccessible: {
    alignItems: 'stretch',
    flexDirection: 'column',
    paddingVertical: spacing.md,
  },
  rowAccessibleHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  lastRow: { borderBottomWidth: 0 },
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
