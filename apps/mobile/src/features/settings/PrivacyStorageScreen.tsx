import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { useServices } from '../../services';
import { AppButton, AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
import type { LocalDataCounts } from '../local-controls/model';

function CountRow({ label, count }: { readonly label: string; readonly count: number }) {
  return (
    <View accessible accessibilityRole="text" style={styles.countRow}>
      <AppText style={styles.countLabel}>{label}</AppText>
      <AppText selectable style={styles.count}>
        {count.toLocaleString()}
      </AppText>
    </View>
  );
}

function ActionRow({
  icon,
  title,
  subtitle,
  last = false,
  destructive = false,
  onPress,
}: {
  readonly icon: 'share' | 'trash' | 'reset' | 'folder';
  readonly title: string;
  readonly subtitle: string;
  readonly last?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
        last && styles.lastActionRow,
        destructive && styles.destructiveRow,
        pressed && styles.rowPressed,
      ]}
    >
      <AppIcon name={icon} size={21} color={destructive ? colors.danger : colors.accent} />
      <View style={styles.actionCopy}>
        <AppText
          variant="heading"
          style={[styles.actionTitle, destructive && styles.destructiveText]}
        >
          {title}
        </AppText>
        <AppText variant="caption" style={styles.subtitle}>
          {subtitle}
        </AppText>
      </View>
      <AppIcon name="chevronRight" size={16} color={colors.mutedInk} />
    </Pressable>
  );
}

export function PrivacyStorageScreen() {
  const services = useServices();
  const navigation = useNavigation<any>();
  const [counts, setCounts] = useState<LocalDataCounts | null>(null);
  const [failed, setFailed] = useState(false);
  const loadRequest = useRef(0);

  const loadCounts = useCallback(async () => {
    const request = ++loadRequest.current;
    setCounts(null);
    setFailed(false);
    try {
      const summary = await services.controls.summary();
      if (request === loadRequest.current) setCounts(summary.counts);
    } catch {
      if (request === loadRequest.current) setFailed(true);
    }
  }, [services.controls]);

  useEffect(() => {
    void loadCounts();
    return () => {
      loadRequest.current += 1;
    };
  }, [loadCounts]);

  const rootNavigation = navigation.getParent()?.getParent();
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText style={styles.intro}>{t('settings.privacyIntro')}</AppText>
        <AppText variant="heading" style={styles.sectionTitle}>
          {t('settings.privacyCountsTitle')}
        </AppText>
        {counts === null && !failed ? (
          <AppText style={styles.subtitle}>{t('settings.privacyLoading')}</AppText>
        ) : failed ? (
          <View style={styles.failureState}>
            <AppText style={styles.subtitle}>{t('settings.privacyUnavailable')}</AppText>
            <AppButton
              label={t('settings.retry')}
              onPress={() => void loadCounts()}
              tone="secondary"
            />
          </View>
        ) : (
          <View style={styles.group}>
            <CountRow label={t('settings.privacyReports')} count={counts?.reports ?? 0} />
            <View style={styles.rowDivider} />
            <CountRow label={t('settings.privacyMeasurements')} count={counts?.measurements ?? 0} />
            <View style={styles.rowDivider} />
            <CountRow label={t('settings.privacyIntakeEvents')} count={counts?.intakeEvents ?? 0} />
          </View>
        )}
        <View style={styles.group}>
          <ActionRow
            icon="folder"
            title={t('settings.importPackTitle')}
            subtitle={t('settings.importPackSubtitle')}
            onPress={() => rootNavigation?.navigate('ImportPackSetup')}
          />
          <ActionRow
            icon="share"
            title={t('settings.privacyExport')}
            subtitle={t('settings.privacyExportSubtitle')}
            onPress={() => rootNavigation?.navigate('FullExport')}
          />
        </View>
        <View style={styles.destructiveGroup}>
          <ActionRow
            destructive
            icon="trash"
            last
            title={t('settings.privacyDelete')}
            subtitle={t('settings.privacyDeleteSubtitle')}
            onPress={() => navigation.navigate('DeleteLocalData', { mode: 'health-data' })}
          />
        </View>
        <View style={styles.destructiveGroup}>
          <ActionRow
            destructive
            icon="reset"
            last
            title={t('settings.privacyReset')}
            subtitle={t('settings.privacyResetSubtitle')}
            onPress={() => navigation.navigate('DeleteLocalData', { mode: 'app-reset' })}
          />
        </View>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { ...typography.body, color: colors.mutedInk },
  sectionTitle: { marginBottom: spacing.sm, marginTop: spacing.lg },
  subtitle: { color: colors.mutedInk, flexShrink: 1 },
  failureState: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg,
    overflow: 'hidden',
  },
  destructiveGroup: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg,
    overflow: 'hidden',
  },
  rowDivider: {
    backgroundColor: colors.border,
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing.lg,
  },
  countRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  countLabel: { color: colors.ink, flex: 1, flexShrink: 1, minWidth: 0 },
  count: { color: colors.mutedInk, flexShrink: 0, fontVariant: ['tabular-nums'] },
  actionRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 70,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: { backgroundColor: colors.accentSoft },
  lastActionRow: { borderBottomWidth: 0 },
  destructiveRow: { minHeight: 68 },
  actionCopy: { flex: 1, flexShrink: 1, gap: spacing.xs, minWidth: 0 },
  actionTitle: { ...typography.row, flexShrink: 1 },
  destructiveText: { color: colors.danger },
});
