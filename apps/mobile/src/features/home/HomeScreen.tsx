import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { formatLocaleDate, formatLocaleDecimal, type LabDateState } from '@alyte/domain';
import type { HomeStackParamList } from '../../navigation/types';
import { dispatchHomeQuickActionFromStack } from '../../navigation/parent-tab';
import { useServices } from '../../services';
import { t } from '../../localization';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  LabEmptyState,
  ScreenScrollView,
  ScreenStatusView,
  StatusPill,
} from '../../ui/primitives';
import { colors, radii, screenStyles, spacing } from '../../theme';
import {
  getScreenPlatformPolicy,
  getScreenSafeAreaEdges,
  getScreenSurfaceMode,
} from '../../ui/screen-scroll-model';
import {
  buildHomeLabViewModel,
  getHomeMeasuredChangeColumnCount,
  type HomeLabViewModel,
  type HomeMeasuredChange,
  type HomeReportRow,
} from './home-model';

type HomeNavigation = NativeStackNavigationProp<HomeStackParamList, 'HomeRoot'>;

const screenSafeAreaEdges = getScreenSafeAreaEdges(getScreenPlatformPolicy(process.env.EXPO_OS));

function dateLabel(date: LabDateState, locale: string): string {
  return date.kind === 'known' ? formatLocaleDate(date.value, locale) : t('home.dateMissing');
}

function measuredValue(change: HomeMeasuredChange, latest: boolean, locale: string): string {
  const point = latest ? change.latest : change.previous;
  return `${formatLocaleDecimal(point.normalized.value, locale)} ${point.normalized.unit}`;
}

function measuredDate(change: HomeMeasuredChange, latest: boolean, locale: string): string {
  return formatLocaleDate(
    latest ? change.latest.collectionDate : change.previous.collectionDate,
    locale,
  );
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

function countCopy(count: number, singularKey: string, pluralKey: string): string {
  return t(count === 1 ? singularKey : pluralKey).replace('{count}', String(count));
}

function measurementCount(count: number): string {
  return countCopy(count, 'home.measurementCount', 'home.measurementsCount');
}

function EmptyHome({ onImport }: { readonly onImport: () => void }) {
  return (
    <View style={styles.emptyComposition}>
      <LabEmptyState
        actionLabel={t('home.importAction')}
        icon="addDocument"
        onAction={onImport}
        body={t('home.emptyBody')}
        title={t('home.emptyTitle')}
      />
      <View accessibilityRole="text" style={styles.privacyNote}>
        <AppIcon color={colors.mutedInk} name="lockShield" size={16} />
        <AppText style={styles.privacyNoteText} variant="caption">
          {t('home.emptyPrivacy')}
        </AppText>
      </View>
    </View>
  );
}

function NextAction({
  model,
  onPress,
}: {
  readonly model: HomeLabViewModel;
  readonly onPress: (reportId: string, draftId?: string) => void;
}) {
  const report = model.unfinishedReports[0];
  if (report === undefined) return null;
  const draft = model.openDrafts.find((item) => item.reportId === report.id);
  const actionTitle = draft === undefined ? t('home.continueReport') : t('home.reviewMeasurements');

  return (
    <View style={styles.actionSection}>
      <AppText style={styles.sectionEyebrow} variant="caption">
        {t('home.nextAction')}
      </AppText>
      <Pressable
        accessibilityHint={t('home.continueReportHint')}
        accessibilityLabel={`${actionTitle}: ${report.originalFilename}`}
        accessibilityRole="button"
        onPress={() => onPress(report.id, draft?.draftId)}
        style={({ pressed }) => [styles.nextAction, pressed && styles.pressed]}
      >
        <View style={styles.actionIcon}>
          <AppIcon color={colors.accent} name={draft === undefined ? 'clock' : 'doc'} size={21} />
        </View>
        <View style={styles.flexCopy}>
          <AppText variant="heading">{actionTitle}</AppText>
          <AppText numberOfLines={2} selectable style={styles.muted}>
            {report.originalFilename}
          </AppText>
        </View>
        <AppIcon name="chevronRight" size={16} />
      </Pressable>
    </View>
  );
}

function LatestMeasuredSummary({
  item,
  locale,
  onPress,
}: {
  readonly item: HomeReportRow;
  readonly locale: string;
  readonly onPress: () => void;
}) {
  const title = item.title ?? t('home.manualRecord');
  return (
    <Pressable
      accessibilityHint={t(item.kind === 'record' ? 'home.recordRowHint' : 'home.reportRowHint')}
      accessibilityLabel={`${title}, ${dateLabel(item.date, locale)}, ${measurementCount(item.measurementCount)}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.latestPressable, pressed && styles.pressed]}
    >
      <AppSurface style={styles.latestSurface} tone="soft">
        <View style={styles.latestHeader}>
          <StatusPill subtle>
            {t(item.kind === 'record' ? 'home.measuredRecord' : 'home.sourceReport')}
          </StatusPill>
          <AppIcon name="chevronRight" size={16} />
        </View>
        <AppText selectable variant="title">
          {dateLabel(item.date, locale)}
        </AppText>
        <AppText selectable style={styles.latestTitle} variant="heading">
          {title}
        </AppText>
        <AppText selectable style={styles.muted}>
          {measurementCount(item.measurementCount)}
        </AppText>
      </AppSurface>
    </Pressable>
  );
}

function MeasuredChanges({
  changes,
  locale,
  onOpen,
}: {
  readonly changes: readonly HomeMeasuredChange[];
  readonly locale: string;
  readonly onOpen: (biomarkerId: string) => void;
}) {
  const { width, fontScale } = useWindowDimensions();
  if (changes.length === 0) return null;
  const columnCount = getHomeMeasuredChangeColumnCount(width, fontScale);
  const rows = Array.from({ length: Math.ceil(changes.length / columnCount) }, (_, index) =>
    changes.slice(index * columnCount, index * columnCount + columnCount),
  );

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <AppText variant="heading">{t('home.measuredChanges')}</AppText>
        <AppText style={styles.muted}>{t('home.measuredChangesBody')}</AppText>
      </View>
      <View style={styles.changeGrid}>
        {rows.map((row, rowIndex) => (
          <View key={`change-row-${rowIndex}`} style={styles.changeGridRow}>
            {row.map((change) => (
              <Pressable
                accessibilityHint={t('home.measuredChangeHint')}
                accessibilityLabel={`${change.label}, ${measuredValue(change, false, locale)} on ${measuredDate(change, false, locale)}, to ${measuredValue(change, true, locale)} on ${measuredDate(change, true, locale)}, ${changeDirection(change)}`}
                accessibilityRole="button"
                key={change.biomarkerId}
                onPress={() => onOpen(change.biomarkerId)}
                style={({ pressed }) => [styles.changeCard, pressed && styles.pressed]}
              >
                <View style={styles.changeCardHeader}>
                  <AppText selectable style={styles.changeCardTitle} variant="heading">
                    {change.label}
                  </AppText>
                  <AppIcon name="chevronRight" size={14} />
                </View>
                <View style={styles.changeLatest}>
                  <View style={styles.changeValueLine}>
                    <AppText selectable style={styles.changeValue} variant="title">
                      {formatLocaleDecimal(change.latest.normalized.value, locale)}
                    </AppText>
                    <AppText selectable style={styles.changeUnit} variant="label">
                      {change.latest.normalized.unit}
                    </AppText>
                  </View>
                  <AppText selectable style={styles.muted} variant="caption">
                    {measuredDate(change, true, locale)}
                  </AppText>
                </View>
                <View style={styles.changePrevious}>
                  <AppText style={styles.direction} variant="label">
                    {changeDirection(change)}
                  </AppText>
                  <AppText selectable style={styles.muted} variant="caption">
                    {`${measuredValue(change, false, locale)} · ${measuredDate(change, false, locale)}`}
                  </AppText>
                </View>
              </Pressable>
            ))}
            {columnCount === 2 && row.length === 1 && <View style={styles.changeCardSpacer} />}
          </View>
        ))}
      </View>
      <AppText style={styles.limitNote} variant="caption">
        {t('home.measuredChangesLimit')}
      </AppText>
    </View>
  );
}

function Coverage({ model }: { readonly model: HomeLabViewModel }) {
  const records = countCopy(model.recordCount, 'home.recordCount', 'home.recordsCount');
  const biomarkers = countCopy(model.biomarkerCount, 'home.biomarkerCount', 'home.biomarkersCount');
  return (
    <View accessibilityRole="summary" style={styles.coverage}>
      <AppIcon color={colors.mutedInk} name="chart" size={18} />
      <View style={styles.flexCopy}>
        <AppText variant="label">{t('home.historyCoverage')}</AppText>
        <AppText style={styles.muted}>{`${records} · ${biomarkers}`}</AppText>
      </View>
    </View>
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
  readonly onContinueReport: (reportId: string, draftId?: string) => void;
  readonly onOpenReport: (reportId: string) => void;
  readonly onOpenRecord: (recordId: string) => void;
  readonly onOpenBiomarkerHistory: (biomarkerId: string) => void;
}) {
  const latestItem = model.latestRecord ?? model.latestReport;
  if (latestItem === null) return <EmptyHome onImport={onImport} />;

  return (
    <View style={styles.sections}>
      <NextAction model={model} onPress={onContinueReport} />
      <MeasuredChanges
        changes={model.measuredChanges}
        locale={locale}
        onOpen={onOpenBiomarkerHistory}
      />
      <View style={styles.section}>
        <View style={styles.sectionHeading}>
          <AppText variant="heading">{t('home.overviewTitle')}</AppText>
          <AppText style={styles.muted}>{t('home.overviewBody')}</AppText>
        </View>
        <LatestMeasuredSummary
          item={latestItem}
          locale={locale}
          onPress={() =>
            latestItem.kind === 'record' ? onOpenRecord(latestItem.id) : onOpenReport(latestItem.id)
          }
        />
        <Coverage model={model} />
      </View>
      {model.recordCount === 1 && model.measuredChanges.length === 0 && (
        <View accessibilityRole="summary" style={styles.secondReportPrompt}>
          <View style={styles.actionIcon}>
            <AppIcon color={colors.accent} name="chart" size={21} />
          </View>
          <View style={styles.flexCopy}>
            <AppText variant="heading">{t('home.secondReportTitle')}</AppText>
            <AppText style={styles.muted}>{t('home.secondReportBody')}</AppText>
          </View>
        </View>
      )}
      <AppButton label={t('home.importAnotherAction')} onPress={onImport} tone="secondary">
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
      const [nextReports, nextRecords, nextDrafts] = await Promise.all([
        reports.listReports(),
        labs.listRecords(),
        reports.listOpenExtractionDrafts(),
      ]);
      setModel(buildHomeLabViewModel(nextReports, nextRecords, nextDrafts.length, nextDrafts));
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

  function continueReport(reportId: string, draftId?: string) {
    dispatchHomeQuickActionFromStack(navigation, {
      kind: 'continue-report',
      reportId,
      ...(draftId === undefined ? {} : { draftId }),
    });
  }

  function openReport(reportId: string) {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'open-report', reportId });
  }

  function openRecord(recordId: string) {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'open-record', recordId });
  }

  function openBiomarkerHistory(biomarkerId: string) {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'open-biomarker-history', biomarkerId });
  }

  const isEmptyState =
    !loading &&
    !error &&
    model !== null &&
    model.latestReport === null &&
    model.latestRecord === null &&
    model.recordCount === 0;
  const surfaceState = loading ? 'loading' : error ? 'error' : isEmptyState ? 'empty' : 'populated';
  const statusSurface = getScreenSurfaceMode(surfaceState) === 'status';

  return (
    <SafeAreaView edges={screenSafeAreaEdges} style={screenStyles.safe}>
      {statusSurface ? (
        <ScreenStatusView
          contentContainerStyle={styles.statusState}
          style={screenStyles.scroll}
          tabBarClearance="native"
        >
          {loading && (
            <View accessibilityRole="progressbar" style={styles.loadingState}>
              <ActivityIndicator color={colors.accent} />
              <AppText style={styles.muted}>{t('home.loading')}</AppText>
            </View>
          )}
          {error && (
            <View style={styles.errorState}>
              <AppText variant="heading">{t('home.errorTitle')}</AppText>
              <AppText style={styles.muted}>{t('home.error')}</AppText>
              <AppButton label={t('home.retry')} onPress={() => void load()} tone="secondary" />
            </View>
          )}
          {isEmptyState && <EmptyHome onImport={openImport} />}
        </ScreenStatusView>
      ) : (
        <ScreenScrollView
          contentContainerStyle={screenStyles.content}
          style={screenStyles.scroll}
          tabBarClearance="native"
        >
          {model !== null && (
            <PopulatedHome
              locale={locale}
              model={model}
              onContinueReport={continueReport}
              onOpenBiomarkerHistory={openBiomarkerHistory}
              onOpenRecord={openRecord}
              onOpenReport={openReport}
              onImport={openImport}
            />
          )}
        </ScreenScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  sections: { gap: spacing.xl, paddingBottom: spacing.lg, width: '100%' },
  section: { gap: spacing.md },
  sectionHeading: { gap: spacing.xs, width: '100%' },
  sectionEyebrow: {
    color: colors.mutedInk,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  statusState: { alignItems: 'center', justifyContent: 'center' },
  loadingState: { alignItems: 'center', gap: spacing.md },
  errorState: { alignItems: 'center', gap: spacing.md, maxWidth: 340 },
  emptyComposition: { alignItems: 'center', gap: spacing.lg, width: '100%' },
  privacyNote: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  privacyNoteText: { color: colors.mutedInk, flexShrink: 1, textAlign: 'center' },
  actionSection: { gap: spacing.sm },
  nextAction: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 76,
    padding: spacing.md,
  },
  actionIcon: {
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  latestPressable: { borderCurve: 'continuous', borderRadius: radii.lg },
  latestSurface: { gap: spacing.xs, minHeight: 156, padding: spacing.lg },
  latestHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  latestTitle: { marginTop: spacing.xs },
  coverage: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  changeGrid: { gap: spacing.md },
  changeGridRow: { alignItems: 'stretch', flexDirection: 'row', gap: spacing.md },
  changeCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: spacing.md,
    minWidth: 0,
    padding: spacing.md,
  },
  changeCardSpacer: { flex: 1 },
  changeCardHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  changeCardTitle: { flex: 1, minWidth: 0 },
  changeLatest: { gap: spacing.xs },
  changeValueLine: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  changeValue: { fontVariant: ['tabular-nums'] },
  changeUnit: { color: colors.mutedInk },
  changePrevious: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingTop: spacing.md,
  },
  direction: { color: colors.ink, fontWeight: '600', textTransform: 'capitalize' },
  limitNote: { color: colors.mutedInk },
  secondReportPrompt: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    paddingTop: spacing.lg,
  },
  flexCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  muted: { color: colors.mutedInk },
  pressed: { opacity: 0.72 },
});
