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

function ReportRow({
  row,
  locale,
  onPress,
}: {
  readonly row: HomeReportRow;
  readonly locale: string;
  readonly onPress: () => void;
}) {
  const title = row.title ?? t('home.manualRecord');
  const isReport = row.kind === 'report';
  return (
    <Pressable
      accessibilityHint={t(isReport ? 'home.reportRowHint' : 'home.recordRowHint')}
      accessibilityLabel={`${title}, ${reportDetail(row, locale)}`}
      accessibilityRole="button"
      onPress={onPress}
      pressRetentionOffset={8}
      style={({ pressed }) => [styles.reportRow, pressed && styles.rowPressed]}
    >
      <AppIcon name={isReport ? 'doc' : 'labs'} size={22} />
      <View style={styles.rowBody}>
        <AppText numberOfLines={2} variant="heading">
          {title}
        </AppText>
        <AppText style={styles.muted}>{reportDetail(row, locale)}</AppText>
      </View>
      <AppIcon name="chevronRight" size={16} />
    </Pressable>
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
      <AppButton label={t('home.importAction')} onPress={onImport} style={styles.importButton}>
        <AppIcon color={colors.onAccent} name="plus" size={17} />
      </AppButton>
    </View>
  );
}

function PendingWork({ model }: { readonly model: HomeLabViewModel }) {
  if (model.pendingImports.length === 0 && model.openDraftCount === 0 && model.reviewCount === 0)
    return null;
  return (
    <View accessibilityRole="summary" style={styles.pendingWork}>
      <AppText variant="heading">{t('home.reviewWork')}</AppText>
      {model.pendingImports.length > 0 && (
        <AppText style={styles.muted}>
          {t('home.pendingImports').replace('{count}', String(model.pendingImports.length))}
        </AppText>
      )}
      {model.openDraftCount > 0 && (
        <AppText style={styles.muted}>
          {t('home.pendingDrafts').replace('{count}', String(model.openDraftCount))}
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

function ContinueReport({
  report,
  onPress,
}: {
  readonly report: NonNullable<HomeLabViewModel['unfinishedReports']>[number];
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityHint={t('home.continueReportHint')}
      accessibilityLabel={`${t('home.continueReport')}: ${report.originalFilename}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.continueAction, pressed && styles.actionPressed]}
    >
      <AppIcon name="doc" size={22} />
      <View style={styles.rowBody}>
        <AppText variant="heading">{t('home.continueReport')}</AppText>
        <AppText numberOfLines={2} style={styles.muted}>
          {report.originalFilename}
        </AppText>
      </View>
      <AppIcon name="chevronRight" size={16} />
    </Pressable>
  );
}

function PopulatedHome({
  model,
  locale,
  onImport,
  onContinueReport,
  onOpenReport,
  onOpenRecord,
  onOpenBiomarkerHistory,
}: {
  readonly model: HomeLabViewModel;
  readonly locale: string;
  readonly onImport: () => void;
  readonly onContinueReport: (reportId: string) => void;
  readonly onOpenReport: (reportId: string) => void;
  readonly onOpenRecord: (recordId: string) => void;
  readonly onOpenBiomarkerHistory: (biomarkerId: string) => void;
}) {
  const latest = model.latestReport;
  const latestRecord = model.recentRecords[0] ?? null;
  const latestItem = latest ?? latestRecord;
  if (latestItem === null) return <EmptyHome onImport={onImport} />;
  const title = latestItem.title ?? t('home.manualRecord');
  return (
    <View style={styles.sections}>
      <AppText style={styles.eyebrow} variant="caption">
        {t(latest === null ? 'home.latestRecord' : 'home.latestReport')}
      </AppText>
      <AppText style={styles.heroDate} variant="display">
        {dateLabel(latestItem.date, locale)}
      </AppText>
      <AppText style={styles.muted} numberOfLines={2}>
        {title} ·{' '}
        {t('home.measurementsCount').replace('{count}', String(latestItem.measurementCount))}
      </AppText>
      <View style={styles.rule} />
      {model.unfinishedReports[0] !== undefined && (
        <ContinueReport
          onPress={() => onContinueReport(model.unfinishedReports[0]!.id)}
          report={model.unfinishedReports[0]}
        />
      )}
      <PendingWork model={model} />
      {model.measuredChanges.length > 0 && (
        <View style={styles.section}>
          <AppText variant="title">{t('home.measuredChanges')}</AppText>
          {model.measuredChanges.map((change) => (
            <Pressable
              accessibilityLabel={`${change.label}, ${measuredValue(change, true, locale)}, ${changeDirection(change)}`}
              accessibilityHint={t('home.measuredChangeHint')}
              accessibilityRole="button"
              key={change.biomarkerId}
              onPress={() => onOpenBiomarkerHistory(change.biomarkerId)}
              pressRetentionOffset={8}
              style={({ pressed }) => [styles.changeRow, pressed && styles.rowPressed]}
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
              <AppIcon name="chevronRight" size={16} />
            </Pressable>
          ))}
        </View>
      )}
      {model.recentReports.length > 0 && (
        <View style={styles.section}>
          <AppText variant="title">{t('home.recentReports')}</AppText>
          {model.recentReports.map((row) => (
            <ReportRow
              key={`${row.kind}-${row.id}`}
              locale={locale}
              onPress={() => onOpenReport(row.id)}
              row={row}
            />
          ))}
        </View>
      )}
      {model.recentRecords.length > 0 && (
        <View style={styles.section}>
          <AppText variant="title">{t('home.recordHistory')}</AppText>
          {model.recentRecords.map((row) => (
            <ReportRow
              key={`${row.kind}-${row.id}`}
              locale={locale}
              onPress={() => onOpenRecord(row.id)}
              row={row}
            />
          ))}
        </View>
      )}
      <AppButton
        label={t('home.importAnotherAction')}
        onPress={onImport}
        style={styles.importButton}
      >
        <AppIcon color={colors.onAccent} name="plus" size={17} />
      </AppButton>
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
      const [nextReports, nextRecords, nextDraftCount] = await Promise.all([
        reports.listReports(),
        labs.listRecords(),
        reports.countOpenExtractionDrafts(),
      ]);
      setModel(buildHomeLabViewModel(nextReports, nextRecords, nextDraftCount));
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

  function continueReport(reportId: string) {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'continue-report', reportId });
  }

  function openReport(reportId: string) {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'open-report', reportId });
  }

  function openRecord(recordId: string) {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'open-record', recordId });
  }

  function openBiomarkerHistory(biomarkerId: string) {
    dispatchHomeQuickActionFromStack(navigation, {
      kind: 'open-biomarker-history',
      biomarkerId,
    });
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        {loading && <AppText style={styles.muted}>{t('home.loading')}</AppText>}
        {error && <AppText style={styles.error}>{t('home.error')}</AppText>}
        {!loading &&
          !error &&
          model !== null &&
          (model.latestReport === null && model.recentRecords.length === 0 ? (
            <EmptyHome onImport={openImport} />
          ) : (
            <PopulatedHome
              locale={locale}
              model={model}
              onContinueReport={continueReport}
              onOpenBiomarkerHistory={openBiomarkerHistory}
              onOpenRecord={openRecord}
              onOpenReport={openReport}
              onImport={openImport}
            />
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
  importButton: { alignSelf: 'stretch' },
  eyebrow: {
    color: colors.mutedInk,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  heroDate: { color: colors.ink },
  rule: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
  pendingWork: { gap: spacing.xs },
  continueAction: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 72,
    paddingVertical: spacing.sm,
  },
  actionPressed: { backgroundColor: colors.accentSoft },
  changeRow: {
    alignItems: 'center',
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
  rowPressed: { backgroundColor: colors.accentSoft },
  rowBody: { flex: 1, gap: spacing.xs },
  value: { fontVariant: ['tabular-nums'], textAlign: 'right' },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
  retry: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44 },
  retryText: { color: colors.accent, fontWeight: '600' },
});
