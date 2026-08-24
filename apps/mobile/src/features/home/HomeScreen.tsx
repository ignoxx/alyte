import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { formatLocaleDate, formatLocaleDecimal, type LabDateState } from '@alyte/domain';
import type { HomeStackParamList } from '../../navigation/types';
import { dispatchHomeQuickActionFromStack } from '../../navigation/parent-tab';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import {
  buildHomeLabViewModel,
  type HomeLabViewModel,
  type HomeMeasuredChange,
  type HomeReportRow,
} from './home-model';

type HomeNavigation = NativeStackNavigationProp<HomeStackParamList, 'HomeRoot'>;

function dateLabel(date: LabDateState, locale: string): string {
  return date.kind === 'known' ? formatLocaleDate(date.value, locale) : t('home.dateMissing');
}

function measuredValue(change: HomeMeasuredChange, latest: boolean, locale: string): string {
  const point = latest ? change.latest : change.previous;
  return `${formatLocaleDecimal(point.normalized.value, locale)} ${point.normalized.unit}`;
}

function reportDetail(row: HomeReportRow, locale: string): string {
  const date = dateLabel(row.date, locale);
  const count = t('home.measurementsCount').replace('{count}', String(row.measurementCount));
  return `${date} · ${count}`;
}

function changeDirection(change: HomeMeasuredChange): string {
  return t(
    change.direction === 'increased'
      ? 'home.directionIncreased'
      : change.direction === 'decreased'
        ? 'home.directionDecreased'
        : 'home.directionStable',
  );
}

function ReportRow({ row, locale }: { readonly row: HomeReportRow; readonly locale: string }) {
  return (
    <View
      accessibilityLabel={`${row.title}, ${reportDetail(row, locale)}`}
      accessible
      style={styles.reportRow}
    >
      <AppIcon name={row.kind === 'report' ? 'doc' : 'labs'} size={22} />
      <View style={styles.rowBody}>
        <AppText numberOfLines={2} variant="heading">
          {row.title}
        </AppText>
        <AppText style={styles.muted}>{reportDetail(row, locale)}</AppText>
      </View>
    </View>
  );
}

function EmptyHome({ onImport }: { readonly onImport: () => void }) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.heroSymbol}>
        <AppIcon name="doc" size={30} />
      </View>
      <AppText style={styles.emptyTitle} variant="title">
        {t('home.emptyTitle')}
      </AppText>
      <AppText style={styles.emptyBody}>{t('home.emptyBody')}</AppText>
      <AppButton
        icon="plus"
        label={t('home.importAction')}
        onPress={onImport}
        style={styles.importButton}
      />
    </View>
  );
}

function PendingWork({ model }: { readonly model: HomeLabViewModel }) {
  if (model.pendingImports.length === 0 && model.reviewCount === 0) return null;
  return (
    <View accessibilityRole="summary" style={styles.pendingWork}>
      <AppText variant="heading">{t('home.reviewWork')}</AppText>
      {model.pendingImports.length > 0 && (
        <AppText style={styles.muted}>
          {t('home.pendingImports').replace('{count}', String(model.pendingImports.length))}
        </AppText>
      )}
      {model.reviewCount > 0 && (
        <AppText style={styles.muted}>
          {t('home.pendingMeasurements').replace('{count}', String(model.reviewCount))}
        </AppText>
      )}
    </View>
  );
}

function PopulatedHome({
  model,
  locale,
  onImport,
}: {
  readonly model: HomeLabViewModel;
  readonly locale: string;
  readonly onImport: () => void;
}) {
  const latest = model.latestReport;
  if (latest === null) return <EmptyHome onImport={onImport} />;
  return (
    <View style={styles.sections}>
      <AppText style={styles.eyebrow} variant="caption">
        {t('home.latestReport')}
      </AppText>
      <AppText style={styles.heroDate} variant="display">
        {dateLabel(latest.date, locale)}
      </AppText>
      <AppText style={styles.muted} numberOfLines={2}>
        {latest.title} ·{' '}
        {t('home.measurementsCount').replace('{count}', String(latest.measurementCount))}
      </AppText>
      <View style={styles.rule} />
      <PendingWork model={model} />
      {model.measuredChanges.length > 0 && (
        <View style={styles.section}>
          <AppText variant="title">{t('home.measuredChanges')}</AppText>
          {model.measuredChanges.map((change) => (
            <View
              accessibilityLabel={`${change.label}, ${measuredValue(change, true, locale)}, ${changeDirection(change)}`}
              accessible
              key={change.biomarkerId}
              style={styles.changeRow}
            >
              <View style={styles.rowBody}>
                <AppText variant="heading">{change.label}</AppText>
                <AppText style={styles.muted}>
                  {t('home.fromValue').replace('{value}', measuredValue(change, false, locale))} ·{' '}
                  {changeDirection(change)}
                </AppText>
              </View>
              <AppText selectable style={styles.value}>
                {measuredValue(change, true, locale)}
              </AppText>
            </View>
          ))}
        </View>
      )}
      <View style={styles.section}>
        <AppText variant="title">{t('home.recentReports')}</AppText>
        {model.recentReports.map((row) => (
          <ReportRow key={`${row.kind}-${row.id}`} locale={locale} row={row} />
        ))}
      </View>
      <AppButton
        icon="plus"
        label={t('home.importAnotherAction')}
        onPress={onImport}
        style={styles.importButton}
      />
    </View>
  );
}

export function HomeScreen() {
  const navigation = useNavigation<HomeNavigation>();
  const { labs, reports } = useServices();
  const isFocused = useIsFocused();
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const [model, setModel] = useState<HomeLabViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextReports, nextRecords] = await Promise.all([
        reports.listReports(),
        labs.listRecords(),
      ]);
      setModel(buildHomeLabViewModel(nextReports, nextRecords));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [labs, reports]);

  useEffect(() => {
    if (isFocused) void load();
  }, [isFocused, load]);

  function openImport() {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'import-report' });
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        {loading && <AppText style={styles.muted}>{t('home.loading')}</AppText>}
        {error && <AppText style={styles.error}>{t('home.error')}</AppText>}
        {!loading &&
          !error &&
          model !== null &&
          (model.latestReport === null ? (
            <EmptyHome onImport={openImport} />
          ) : (
            <PopulatedHome locale={locale} model={model} onImport={openImport} />
          ))}
        {error && (
          <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.retry}>
            <AppText style={styles.retryText}>{t('home.retry')}</AppText>
          </Pressable>
        )}
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  sections: { gap: spacing.lg, paddingBottom: spacing.lg },
  section: { gap: spacing.sm },
  emptyState: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    minHeight: 440,
    paddingHorizontal: spacing.lg,
  },
  heroSymbol: {
    alignItems: 'center',
    backgroundColor: colors.disabledFill,
    borderCurve: 'continuous',
    borderRadius: 16,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  emptyTitle: { textAlign: 'center' },
  emptyBody: { color: colors.mutedInk, textAlign: 'center' },
  importButton: { alignSelf: 'stretch', marginTop: spacing.sm },
  eyebrow: {
    color: colors.mutedInk,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  heroDate: { color: colors.ink },
  rule: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
  pendingWork: { gap: spacing.xs },
  changeRow: {
    alignItems: 'flex-end',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  reportRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 64,
    paddingVertical: spacing.sm,
  },
  rowBody: { flex: 1, gap: spacing.xs },
  value: { fontVariant: ['tabular-nums'], textAlign: 'right' },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
  retry: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44 },
  retryText: { color: colors.accent, fontWeight: '600' },
});
