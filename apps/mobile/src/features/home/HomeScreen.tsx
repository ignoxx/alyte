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
import { AppButton, AppIcon, AppText, LabEmptyState, ScreenScrollView } from '../../ui/primitives';
import { colors, radii, screenStyles, spacing } from '../../theme';
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
      <AppIcon color={colors.accent} name={isReport ? 'doc' : 'labs'} size={22} />
      <View style={styles.rowBody}>
        <AppText numberOfLines={2} selectable variant="heading">
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
    <LabEmptyState
      actionLabel={t('home.importAction')}
      icon="doc"
      onAction={onImport}
      body={t('home.emptyBody')}
      title={t('home.emptyTitle')}
    />
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
      <AppIcon color={colors.accent} name="doc" size={22} />
      <View style={styles.rowBody}>
        <AppText variant="heading">{t('home.continueReport')}</AppText>
        <AppText numberOfLines={2} selectable style={styles.muted}>
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
  const latestRecord = model.latestRecord;
  // A confirmed Lab Record is the person's measured history anchor. Fall back to the source report
  // only while an import has not produced a record yet, keeping extracted/source state honest.
  const latestItem = latestRecord ?? latest;
  if (latestItem === null) return <EmptyHome onImport={onImport} />;
  const title = latestItem.title ?? t('home.manualRecord');
  const latestIsRecord = latestItem.kind === 'record';
  return (
    <View style={styles.sections}>
      <AppText style={styles.eyebrow} variant="caption">
        {t(latestIsRecord ? 'home.latestRecord' : 'home.latestReport')}
      </AppText>
      <Pressable
        accessibilityHint={t(latestIsRecord ? 'home.recordRowHint' : 'home.reportRowHint')}
        accessibilityLabel={`${title}, ${reportDetail(latestItem, locale)}`}
        accessibilityRole="button"
        onPress={() => (latestIsRecord ? onOpenRecord(latestItem.id) : onOpenReport(latestItem.id))}
        pressRetentionOffset={8}
        style={({ pressed }) => [styles.latestRow, pressed && styles.rowPressed]}
      >
        <View style={styles.latestCopy}>
          <AppText numberOfLines={2} selectable style={styles.heroDate} variant="display">
            {dateLabel(latestItem.date, locale)}
          </AppText>
          <AppText numberOfLines={2} selectable variant="heading">
            {title}
          </AppText>
          <AppText selectable style={styles.muted}>
            {t('home.measurementsCount').replace('{count}', String(latestItem.measurementCount))}
          </AppText>
        </View>
        <AppIcon name="chevronRight" size={18} />
      </Pressable>
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
          <AppText variant="heading">{t('home.measuredChanges')}</AppText>
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
          <AppText variant="heading">{t('home.recentReports')}</AppText>
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
          <AppText variant="heading">{t('home.recordHistory')}</AppText>
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
        tone="secondary"
      >
        <AppIcon color={colors.accent} name="plus" size={17} />
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

  const isEmptyState =
    !loading &&
    !error &&
    model !== null &&
    model.latestReport === null &&
    model.latestRecord === null &&
    model.recentRecords.length === 0;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        alwaysBounceVertical={!isEmptyState}
        bounces={!isEmptyState}
        contentContainerStyle={screenStyles.content}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        {loading && <AppText style={styles.muted}>{t('home.loading')}</AppText>}
        {error && <AppText style={styles.error}>{t('home.error')}</AppText>}
        {!loading &&
          !error &&
          model !== null &&
          (isEmptyState ? (
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
  importButton: { alignSelf: 'stretch' },
  eyebrow: {
    color: colors.mutedInk,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  heroDate: { color: colors.ink },
  rule: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
  pendingWork: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  continueAction: {
    alignItems: 'center',
    borderColor: colors.accent,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 68,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  latestRow: {
    alignItems: 'center',
    borderCurve: 'continuous',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 100,
    paddingVertical: spacing.sm,
  },
  latestCopy: { flex: 1, gap: spacing.xs },
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
