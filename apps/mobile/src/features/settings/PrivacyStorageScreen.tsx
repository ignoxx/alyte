import { useEffect, useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { useServices } from '../../services';
import { AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
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
  onPress,
}: {
  readonly icon: 'square.and.arrow.up' | 'trash';
  readonly title: string;
  readonly subtitle: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
    >
      <AppIcon name={icon === 'trash' ? 'trash' : 'doc'} size={21} color={colors.accent} />
      <View style={styles.actionCopy}>
        <AppText variant="heading" style={styles.actionTitle}>
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

  useEffect(() => {
    let active = true;
    void services.controls
      .summary()
      .then((summary) => {
        if (active) setCounts(summary.counts);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [services.controls]);

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
          <AppText style={styles.subtitle}>{t('settings.privacyUnavailable')}</AppText>
        ) : (
          <View style={styles.group}>
            <CountRow label={t('settings.privacyReports')} count={counts?.reports ?? 0} />
            <CountRow label={t('settings.privacyReportPages')} count={counts?.reportPages ?? 0} />
            <CountRow
              label={t('settings.privacySanitizedReports')}
              count={counts?.sanitizedReports ?? 0}
            />
            <CountRow label={t('settings.privacyRecords')} count={counts?.records ?? 0} />
            <CountRow label={t('settings.privacyMeasurements')} count={counts?.measurements ?? 0} />
            <CountRow label={t('settings.privacyIntakeEvents')} count={counts?.intakeEvents ?? 0} />
            <CountRow label={t('settings.privacyIntakeImages')} count={counts?.intakeImages ?? 0} />
          </View>
        )}
        <View style={styles.group}>
          <ActionRow
            icon="square.and.arrow.up"
            title={t('settings.privacyExport')}
            subtitle={t('settings.privacyExportSubtitle')}
            onPress={() => rootNavigation?.navigate('FullExport')}
          />
          <ActionRow
            icon="trash"
            title={t('settings.privacyDelete')}
            subtitle={t('settings.privacyDeleteSubtitle')}
            onPress={() => navigation.navigate('DeleteLocalData')}
          />
        </View>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.mutedInk, lineHeight: 22 },
  sectionTitle: { marginBottom: spacing.sm, marginTop: spacing.lg },
  subtitle: { color: colors.mutedInk, flexShrink: 1 },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg,
    overflow: 'hidden',
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
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 70,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: { backgroundColor: colors.accentSoft },
  actionCopy: { flex: 1, flexShrink: 1, gap: spacing.xs, minWidth: 0 },
  actionTitle: { flexShrink: 1, fontSize: 16, lineHeight: 21 },
});
