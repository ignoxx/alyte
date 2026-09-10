import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { formatLocaleDate } from '@alyte/domain';
import type { HomeStackParamList } from '../../navigation/types';
import { dispatchHomeQuickActionFromStack } from '../../navigation/parent-tab';
import { useServices } from '../../services';
import { t } from '../../localization';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  ScreenScrollView,
  ScreenStatusView,
  TidalHero,
  TidalIconStage,
} from '../../ui/primitives';
import { colors, radii, screenStyles, spacing } from '../../theme';
import { getScreenSurfaceMode } from '../../ui/screen-scroll-model';
import { useHomeLayout } from '../settings/HomeLayoutProvider';
import {
  buildHomeLabViewModel,
  getHomeMeasuredChangeColumnCount,
  type HomeLabViewModel,
  type HomeLatestMeasurement,
  type HomeMeasuredChange,
} from './home-model';

type HomeNavigation = NativeStackNavigationProp<HomeStackParamList, 'HomeRoot'>;

function measuredValue(
  change: HomeMeasuredChange,
  latest: boolean,
  formatter: Intl.NumberFormat,
): string {
  const point = latest ? change.latest : change.previous;
  return `${formatter.format(point.normalized.value)} ${point.normalized.unit}`;
}

function measuredDate(change: HomeMeasuredChange, latest: boolean, locale: string): string {
  return formatLocaleDate(
    latest ? change.latest.collectionDate : change.previous.collectionDate,
    locale,
  );
}

function pointUsesConvertedUnit(point: HomeMeasuredChange['latest']): boolean {
  return (
    (point.current.unit ?? '').replace(/\s+/g, '').toLocaleLowerCase() !==
    point.normalized.unit.replace(/\s+/g, '').toLocaleLowerCase()
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

function changeDirectionIcon(change: HomeMeasuredChange): 'trendUp' | 'trendDown' | 'trendStable' {
  return change.direction === 'increased'
    ? 'trendUp'
    : change.direction === 'decreased'
      ? 'trendDown'
      : 'trendStable';
}

function EmptyHome({ onImport }: { readonly onImport: () => void }) {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= 1.4;
  const titleScale = Math.min(fontScale, 1.8);
  const copyScale = Math.min(fontScale, 2);
  return (
    <View style={styles.emptyComposition}>
      <TidalHero style={styles.emptyHero}>
        <View style={styles.emptyHeroContent}>
          {!usesAccessibleLayout && <TidalIconStage name="addDocument" />}
          <View style={styles.emptyHeroCopy}>
            <AppText
              allowFontScaling={false}
              style={[styles.onBrand, { fontSize: 26 * titleScale, lineHeight: 32 * titleScale }]}
              variant="title"
            >
              {t('home.emptyTitle')}
            </AppText>
            <AppText
              allowFontScaling={false}
              style={[
                styles.onBrandMuted,
                { fontSize: 16 * copyScale, lineHeight: 23 * copyScale },
              ]}
            >
              {t('home.emptyBody')}
            </AppText>
          </View>
        </View>
      </TidalHero>
      <AppButton
        label={t('home.importAction')}
        labelMaxFontSizeMultiplier={1.8}
        labelNumberOfLines={2}
        onPress={onImport}
        style={styles.emptyAction}
      >
        <AppIcon color={colors.onAccent} name="plus" size={17} />
      </AppButton>
      <View accessibilityRole="text" style={styles.privacyNote}>
        <AppIcon color={colors.mutedInk} name="lockShield" size={16} />
        <AppText maxFontSizeMultiplier={2} style={styles.privacyNoteText} variant="caption">
          {t('home.emptyPrivacy')}
        </AppText>
      </View>
    </View>
  );
}

function HomeSummaryHero({ model }: { readonly model: HomeLabViewModel }) {
  const { fontScale } = useWindowDimensions();
  const titleScale = Math.min(fontScale, 1.8);
  const copyScale = Math.min(fontScale, 2);
  const hasSavedResults = model.totalMeasurementCount > 0;
  const title = hasSavedResults
    ? t(
        model.totalMeasurementCount === 1 ? 'home.savedResultCount' : 'home.savedResultsCount',
      ).replace('{count}', String(model.totalMeasurementCount))
    : t('home.reportReadyTitle');
  const reportSummary =
    model.reportCount === 0
      ? t('home.manualResults')
      : t(model.reportCount === 1 ? 'home.oneReport' : 'home.reportCountPlain').replace(
          '{count}',
          String(model.reportCount),
        );
  const body =
    model.reviewCount > 0
      ? t(model.reviewCount === 1 ? 'home.oneResultToCheck' : 'home.resultsToCheck').replace(
          '{count}',
          String(model.reviewCount),
        )
      : model.measuredChanges.length > 0
        ? t(
            model.measuredChanges.length === 1 ? 'home.oneChange' : 'home.changeCountPlain',
          ).replace('{count}', String(model.measuredChanges.length))
        : reportSummary;

  return (
    <TidalHero edge="bottom" style={styles.summaryHero}>
      <View accessibilityRole="summary" style={styles.heroCopy}>
        <AppText
          allowFontScaling={false}
          style={[styles.heroEyebrow, { fontSize: 15 * copyScale, lineHeight: 20 * copyScale }]}
          variant="label"
        >
          {t('home.heroHistoryStarted')}
        </AppText>
        <AppText
          allowFontScaling={false}
          style={[styles.heroTitle, { fontSize: 26 * titleScale, lineHeight: 32 * titleScale }]}
          variant="title"
        >
          {title}
        </AppText>
        <AppText
          allowFontScaling={false}
          style={[styles.heroBody, { fontSize: 13 * copyScale, lineHeight: 18 * copyScale }]}
          variant="caption"
        >
          {hasSavedResults ? body : t('home.reportReadyBody')}
        </AppText>
      </View>
    </TidalHero>
  );
}

function NextAction({
  model,
  onPress,
  onOpenRecord,
}: {
  readonly model: HomeLabViewModel;
  readonly onPress: (reportId: string, draftId?: string) => void;
  readonly onOpenRecord: (recordId: string) => void;
}) {
  const report = model.unfinishedReports[0];
  const reviewRecordId = model.latestReviewRecordId;
  if (report === undefined && reviewRecordId === null) return null;
  const draft =
    report === undefined ? undefined : model.openDrafts.find((item) => item.reportId === report.id);
  const actionTitle =
    report === undefined
      ? t('home.reviewSavedResults')
      : draft === undefined
        ? t('home.continueReport')
        : t('home.reviewMeasurements');
  const detail =
    report === undefined
      ? t(model.reviewCount === 1 ? 'home.oneResultToCheck' : 'home.resultsToCheck').replace(
          '{count}',
          String(model.reviewCount),
        )
      : report.originalFilename;

  return (
    <View style={styles.actionSection}>
      <AppText style={styles.sectionEyebrow} variant="caption">
        {t('home.nextAction')}
      </AppText>
      <Pressable
        accessibilityHint={t('home.continueReportHint')}
        accessibilityLabel={`${actionTitle}: ${detail}`}
        accessibilityRole="button"
        onPress={() => {
          if (report !== undefined) onPress(report.id, draft?.draftId);
          else if (reviewRecordId !== null) onOpenRecord(reviewRecordId);
        }}
        style={({ pressed }) => [styles.nextAction, pressed && styles.pressed]}
      >
        <View style={styles.actionIcon}>
          <AppIcon
            color={colors.accent}
            name={report === undefined || draft === undefined ? 'clock' : 'doc'}
            size={21}
          />
        </View>
        <View style={styles.flexCopy}>
          <AppText variant="heading">{actionTitle}</AppText>
          <AppText numberOfLines={2} selectable style={styles.muted}>
            {detail}
          </AppText>
        </View>
        <AppIcon name="chevronRight" size={16} />
      </Pressable>
    </View>
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
  const { layout } = useHomeLayout();
  const { width, fontScale } = useWindowDimensions();
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 }),
    [locale],
  );
  if (changes.length === 0) return null;
  const columnCount = layout === 'masonry' ? getHomeMeasuredChangeColumnCount(width, fontScale) : 1;
  const masonryColumns = [
    changes.filter((_, index) => index % 2 === 0),
    changes.filter((_, index) => index % 2 === 1),
  ];
  const usesConvertedUnits = changes.some(
    (change) => pointUsesConvertedUnit(change.previous) || pointUsesConvertedUnit(change.latest),
  );
  function changeCard(change: HomeMeasuredChange) {
    return (
      <Pressable
        accessibilityHint={t('home.measuredChangeHint')}
        accessibilityLabel={`${change.label}, ${measuredValue(change, false, numberFormatter)} on ${measuredDate(change, false, locale)}, to ${measuredValue(change, true, numberFormatter)} on ${measuredDate(change, true, locale)}, ${changeDirection(change)}`}
        accessibilityRole="button"
        key={change.biomarkerId}
        onPress={() => onOpen(change.biomarkerId)}
        style={({ pressed }) => [styles.changeCard, pressed && styles.pressed]}
      >
        <View style={styles.changeCardHeader}>
          <AppText selectable style={styles.changeCardTitle} variant="label">
            {change.label}
          </AppText>
          <View accessibilityElementsHidden style={styles.directionIcon}>
            <AppIcon color={colors.accent} name={changeDirectionIcon(change)} size={14} />
          </View>
        </View>
        <View style={styles.changeLatest}>
          <View style={styles.changeValueLine}>
            <AppText selectable style={styles.changeValue} variant="title">
              {numberFormatter.format(change.latest.normalized.value)}
            </AppText>
            <AppText selectable style={styles.changeUnit} variant="label">
              {change.latest.normalized.unit}
            </AppText>
          </View>
          <AppText selectable style={styles.muted} variant="caption">
            {`${t('home.fromValue').replace(
              '{value}',
              measuredValue(change, false, numberFormatter),
            )} · ${measuredDate(change, true, locale)}`}
          </AppText>
        </View>
      </Pressable>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <AppText variant="heading">{t('home.measuredChanges')}</AppText>
        <AppText style={styles.muted}>
          {t(usesConvertedUnits ? 'home.measuredChangesConvertedBody' : 'home.measuredChangesBody')}
        </AppText>
      </View>
      {columnCount === 2 ? (
        <View style={styles.masonryGrid}>
          {masonryColumns.map((column, columnIndex) => (
            <View key={`masonry-column-${columnIndex}`} style={styles.masonryColumn}>
              {column.map(changeCard)}
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.changeList}>{changes.map(changeCard)}</View>
      )}
    </View>
  );
}

function LatestMeasurements({
  measurements,
  locale,
  onOpenRecord,
  onViewAll,
}: {
  readonly measurements: readonly HomeLatestMeasurement[];
  readonly locale: string;
  readonly onOpenRecord: (recordId: string) => void;
  readonly onViewAll: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= 1.4;
  if (measurements.length === 0) return null;
  const preview = measurements.slice(0, 5);
  const dates = new Set(
    measurements.map((measurement) =>
      measurement.collectionDate.kind === 'known' ? measurement.collectionDate.value : 'missing',
    ),
  );
  const firstDate = measurements[0]?.collectionDate;
  const dateLabel =
    dates.size > 1
      ? t('home.multipleDates')
      : firstDate?.kind === 'known'
        ? formatLocaleDate(firstDate.value, locale)
        : t('home.dateMissing');
  const reviewCount = measurements.filter(
    (measurement) => measurement.reviewState === 'needs-review',
  ).length;
  const sectionDetail = [
    dateLabel,
    reviewCount > 0
      ? t(reviewCount === 1 ? 'home.oneResultToCheckShort' : 'home.resultsToCheckShort').replace(
          '{count}',
          String(reviewCount),
        )
      : null,
  ]
    .filter((value): value is string => value !== null)
    .join(' · ');

  function row(measurement: HomeLatestMeasurement, index: number) {
    const rowDate =
      measurement.collectionDate.kind === 'known'
        ? formatLocaleDate(measurement.collectionDate.value, locale)
        : t('home.dateMissing');
    const source = [
      rowDate,
      measurement.sourcePage === null
        ? null
        : t('home.measurementPage').replace('{page}', String(measurement.sourcePage)),
    ]
      .filter((value): value is string => value !== null)
      .join(' · ');
    return (
      <Pressable
        accessibilityHint={t('home.latestMeasurementHint')}
        accessibilityLabel={`${measurement.label}, ${measurement.valueString}${measurement.unit ? ` ${measurement.unit}` : ''}, ${source}${measurement.reviewState === 'needs-review' ? `, ${t('home.measurementNeedsReviewLabel')}` : ''}`}
        accessibilityRole="button"
        key={`${measurement.recordId}-${measurement.id}`}
        onPress={() => onOpenRecord(measurement.recordId)}
        style={({ pressed }) => [
          styles.latestMeasurementRow,
          usesAccessibleLayout && styles.latestMeasurementRowAccessible,
          index > 0 && styles.latestMeasurementDivider,
          pressed && styles.rowPressed,
        ]}
      >
        <View
          style={[
            styles.latestMeasurementCopy,
            usesAccessibleLayout && styles.latestMeasurementCopyAccessible,
          ]}
        >
          <AppText selectable style={styles.latestMeasurementLabel} variant="label">
            {measurement.label}
          </AppText>
          {dates.size > 1 && (
            <AppText selectable style={styles.muted} variant="caption">
              {rowDate}
            </AppText>
          )}
        </View>
        <View
          style={[
            styles.latestMeasurementValueLine,
            usesAccessibleLayout && styles.latestMeasurementValueLineAccessible,
          ]}
        >
          <AppText selectable style={styles.latestMeasurementValue} variant="heading">
            {measurement.valueString}
          </AppText>
          {measurement.unit !== null && (
            <AppText selectable style={styles.muted} variant="caption">
              {measurement.unit}
            </AppText>
          )}
        </View>
        <AppIcon
          color={colors.mutedInk}
          name="chevronRight"
          size={15}
          style={usesAccessibleLayout ? styles.latestMeasurementChevronAccessible : undefined}
        />
      </Pressable>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <AppText variant="heading">{t('home.latestMeasurements')}</AppText>
        <AppText style={styles.muted} variant="caption">
          {sectionDetail}
        </AppText>
      </View>
      <AppSurface style={styles.latestMeasurementGroup}>{preview.map(row)}</AppSurface>
      {measurements.length > preview.length && (
        <AppButton label={t('home.viewAllMeasurements')} onPress={onViewAll} tone="quiet" />
      )}
    </View>
  );
}

function PopulatedHome({
  model,
  locale,
  onImport,
  onContinueReport,
  onOpenBiomarkerHistory,
  onOpenRecord,
  onViewLatest,
}: {
  readonly model: HomeLabViewModel;
  readonly locale: string;
  readonly onImport: () => void;
  readonly onContinueReport: (reportId: string, draftId?: string) => void;
  readonly onOpenBiomarkerHistory: (biomarkerId: string) => void;
  readonly onOpenRecord: (recordId: string) => void;
  readonly onViewLatest: () => void;
}) {
  const latestItem = model.latestRecord ?? model.latestReport;
  if (latestItem === null) return <EmptyHome onImport={onImport} />;

  return (
    <View style={styles.populatedHome}>
      <HomeSummaryHero model={model} />
      <View style={styles.sections}>
        <NextAction model={model} onOpenRecord={onOpenRecord} onPress={onContinueReport} />
        <MeasuredChanges
          changes={model.measuredChanges}
          locale={locale}
          onOpen={onOpenBiomarkerHistory}
        />
        <LatestMeasurements
          locale={locale}
          measurements={model.latestMeasurements}
          onOpenRecord={onOpenRecord}
          onViewAll={onViewLatest}
        />
        {model.measurementCount > 0 &&
          model.reportCount === 1 &&
          model.measuredChanges.length === 0 && (
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

  function openBiomarkerHistory(biomarkerId: string) {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'open-biomarker-history', biomarkerId });
  }

  function openRecord(recordId: string) {
    dispatchHomeQuickActionFromStack(navigation, { kind: 'open-record', recordId });
  }

  function viewLatest() {
    if (model === null) return;
    if (model.latestMeasurementReportId !== null) {
      dispatchHomeQuickActionFromStack(navigation, {
        kind: 'open-report',
        reportId: model.latestMeasurementReportId,
      });
      return;
    }
    const recordIds = [
      ...new Set(model.latestMeasurements.map((measurement) => measurement.recordId)),
    ];
    if (recordIds.length === 1 && recordIds[0] !== undefined) {
      openRecord(recordIds[0]);
      return;
    }
    if (recordIds.length > 1) {
      dispatchHomeQuickActionFromStack(navigation, { kind: 'open-labs' });
      return;
    }
    if (model.latestRecord !== null) {
      openRecord(model.latestRecord.id);
    }
  }

  const isEmptyState =
    !loading &&
    !error &&
    model !== null &&
    model.latestReport === null &&
    model.latestRecord === null &&
    model.reportCount === 0 &&
    model.recordCount === 0;
  const surfaceState = loading ? 'loading' : error ? 'error' : isEmptyState ? 'empty' : 'populated';
  const statusSurface = getScreenSurfaceMode(surfaceState) === 'status';

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[screenStyles.safe, styles.homeSafe]}>
      {isFocused && <StatusBar style="light" />}
      {statusSurface ? (
        <ScreenStatusView
          contentContainerStyle={styles.statusState}
          style={[screenStyles.scroll, styles.canvas]}
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
          contentContainerStyle={styles.populatedContent}
          style={[screenStyles.scroll, styles.canvas]}
          tabBarClearance="native"
        >
          {model !== null && (
            <PopulatedHome
              locale={locale}
              model={model}
              onContinueReport={continueReport}
              onOpenBiomarkerHistory={openBiomarkerHistory}
              onOpenRecord={openRecord}
              onImport={openImport}
              onViewLatest={viewLatest}
            />
          )}
        </ScreenScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  homeSafe: { backgroundColor: colors.brand },
  canvas: { backgroundColor: colors.canvas },
  populatedContent: { flexGrow: 1 },
  populatedHome: { backgroundColor: colors.canvas, width: '100%' },
  sections: {
    gap: spacing.xl,
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    width: '100%',
  },
  section: { gap: spacing.md },
  sectionHeading: { gap: spacing.xs, width: '100%' },
  sectionEyebrow: {
    color: colors.mutedInk,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  statusState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  loadingState: { alignItems: 'center', gap: spacing.md },
  errorState: { alignItems: 'center', gap: spacing.md, maxWidth: 340 },
  emptyComposition: { alignItems: 'center', gap: spacing.lg, width: '100%' },
  emptyHero: { maxWidth: 440, padding: spacing.lg, width: '100%' },
  emptyHeroContent: { alignItems: 'center', gap: spacing.md },
  emptyHeroCopy: { alignItems: 'center', gap: spacing.sm, maxWidth: 350 },
  emptyAction: { alignSelf: 'stretch', maxWidth: 440 },
  onBrand: { color: colors.onBrand, textAlign: 'center' },
  onBrandMuted: { color: colors.onBrandMuted, textAlign: 'center' },
  privacyNote: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  privacyNoteText: { color: colors.mutedInk, flexShrink: 1, textAlign: 'center' },
  summaryHero: {
    minHeight: 214,
    justifyContent: 'flex-end',
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xxl,
  },
  heroCopy: { gap: spacing.sm, maxWidth: 360 },
  heroEyebrow: { color: colors.brandSoft },
  heroTitle: { color: colors.onBrand },
  heroBody: { color: colors.onBrandMuted },
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
  masonryGrid: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.md },
  masonryColumn: {
    alignItems: 'flex-start',
    flex: 1,
    gap: spacing.md,
    minWidth: 0,
  },
  changeList: { gap: spacing.md },
  changeCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    minHeight: 112,
    minWidth: 0,
    padding: spacing.md,
    width: '100%',
  },
  changeCardHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  changeCardTitle: { flex: 1, minWidth: 0 },
  latestMeasurementGroup: { overflow: 'hidden', padding: 0 },
  latestMeasurementRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 62,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  latestMeasurementRowAccessible: {
    alignItems: 'stretch',
    flexDirection: 'column',
    gap: spacing.xs,
    minHeight: 0,
    paddingRight: spacing.xl + spacing.md,
    paddingVertical: spacing.md,
    position: 'relative',
  },
  latestMeasurementDivider: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  latestMeasurementLabel: { flex: 1, minWidth: 0 },
  latestMeasurementCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  latestMeasurementCopyAccessible: { flex: 0, width: '100%' },
  latestMeasurementValueLine: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'flex-end',
    maxWidth: '44%',
  },
  latestMeasurementValueLineAccessible: {
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    maxWidth: '100%',
  },
  latestMeasurementChevronAccessible: {
    position: 'absolute',
    right: spacing.md,
    top: spacing.md,
  },
  latestMeasurementValue: { flexShrink: 1, fontVariant: ['tabular-nums'], textAlign: 'right' },
  changeLatest: { gap: spacing.xs, paddingTop: spacing.xs },
  changeValueLine: {
    alignItems: 'baseline',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  changeValue: { fontVariant: ['tabular-nums'] },
  changeUnit: { color: colors.mutedInk },
  directionIcon: {
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
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
  rowPressed: { backgroundColor: colors.accentSoft },
});
