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
  AppText,
  ScreenScrollView,
  ScreenStatusView,
  TidalHero,
  TidalIconStage,
} from '../../ui/primitives';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
import { getScreenSurfaceMode } from '../../ui/screen-scroll-model';
import {
  buildHomeLabViewModel,
  getHomeMeasuredChangeColumnCount,
  type HomeLabViewModel,
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
  return (
    <View style={styles.emptyComposition}>
      <TidalHero style={styles.emptyHero}>
        <View style={styles.emptyHeroContent}>
          <TidalIconStage name="addDocument" />
          <View style={styles.emptyHeroCopy}>
            <AppText style={styles.onBrand} variant="title">
              {t('home.emptyTitle')}
            </AppText>
            <AppText style={styles.onBrandMuted}>{t('home.emptyBody')}</AppText>
          </View>
        </View>
      </TidalHero>
      <AppButton label={t('home.importAction')} onPress={onImport} style={styles.emptyAction}>
        <AppIcon color={colors.onAccent} name="plus" size={17} />
      </AppButton>
      <View accessibilityRole="text" style={styles.privacyNote}>
        <AppIcon color={colors.mutedInk} name="lockShield" size={16} />
        <AppText style={styles.privacyNoteText} variant="caption">
          {t('home.emptyPrivacy')}
        </AppText>
      </View>
    </View>
  );
}

function HomeSummaryHero({ model }: { readonly model: HomeLabViewModel }) {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= 1.4;
  const hasComparableHistory = model.measuredChanges.length > 0;
  const prominentValue = hasComparableHistory ? model.measuredChanges.length : model.recordCount;
  const prominentLabel = hasComparableHistory
    ? t(
        model.measuredChanges.length === 1
          ? 'home.compatibleChangeLabel'
          : 'home.compatibleChangesNoun',
      )
    : t(model.recordCount === 1 ? 'home.labRecordReadyLabel' : 'home.labRecordsReadyLabel');
  const facts = [
    { label: t('home.labRecordsLabel'), value: model.recordCount },
    { label: t('home.biomarkersLabel'), value: model.biomarkerCount },
    { label: t('home.compatibleChangesLabel'), value: model.measuredChanges.length },
  ];

  return (
    <TidalHero edge="bottom" style={styles.summaryHero}>
      <View style={[styles.heroLead, usesAccessibleLayout && styles.heroLeadAccessible]}>
        <View accessibilityRole="summary" style={styles.heroLens}>
          <View accessibilityElementsHidden style={styles.heroLensOuter} />
          <View accessibilityElementsHidden style={styles.heroLensMiddle} />
          <View style={styles.heroLensCore}>
            <AppText style={styles.heroLensValue}>{prominentValue}</AppText>
          </View>
        </View>
        <View style={[styles.heroCopy, usesAccessibleLayout && styles.heroCopyAccessible]}>
          <AppText
            style={[styles.heroEyebrow, usesAccessibleLayout && styles.heroTextAccessible]}
            variant="label"
          >
            {t(hasComparableHistory ? 'home.heroSinceLastReport' : 'home.heroHistoryStarted')}
          </AppText>
          <AppText
            style={[styles.heroTitle, usesAccessibleLayout && styles.heroTextAccessible]}
            variant="title"
          >
            {prominentLabel}
          </AppText>
          <AppText
            style={[styles.heroBody, usesAccessibleLayout && styles.heroTextAccessible]}
            variant="caption"
          >
            {t('home.heroMeasuredOnly')}
          </AppText>
        </View>
      </View>
      <View
        accessibilityRole="summary"
        style={[styles.heroFacts, usesAccessibleLayout && styles.heroFactsAccessible]}
      >
        {facts.map((fact) => (
          <View
            key={fact.label}
            style={[styles.heroFact, usesAccessibleLayout && styles.heroFactAccessible]}
          >
            <AppText style={styles.heroFactValue}>{fact.value}</AppText>
            <AppText style={styles.heroFactLabel} variant="caption">
              {fact.label}
            </AppText>
          </View>
        ))}
      </View>
    </TidalHero>
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

function TrendMark({ change }: { readonly change: HomeMeasuredChange }) {
  const width = 112;
  const height = 42;
  const padding = 9;
  const y1 = change.direction === 'increased' ? 31 : change.direction === 'decreased' ? 11 : 21;
  const y2 = change.direction === 'decreased' ? 31 : change.direction === 'increased' ? 11 : 21;
  const run = width - padding * 2;
  const rise = y2 - y1;
  const lineWidth = Math.sqrt(run * run + rise * rise);
  const angle = Math.atan2(rise, run);

  return (
    <View accessibilityElementsHidden style={[styles.trendMark, { height, width }]}>
      <View
        style={[
          styles.trendLine,
          {
            left: padding,
            top: (y1 + y2) / 2 - 1,
            transform: [{ rotate: `${angle}rad` }],
            width: lineWidth,
          },
        ]}
      />
      {[
        { left: padding, top: y1 },
        { left: width - padding, top: y2 },
      ].map((point, index) => (
        <View
          key={index}
          style={[styles.trendPoint, { left: point.left - 5.5, top: point.top - 5.5 }]}
        />
      ))}
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
  const { width, fontScale } = useWindowDimensions();
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 }),
    [locale],
  );
  if (changes.length === 0) return null;
  const columnCount = getHomeMeasuredChangeColumnCount(width, fontScale);
  const masonryColumns = [
    changes.filter((_, index) => index % 2 === 0),
    changes.filter((_, index) => index % 2 === 1),
  ];

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
            {measuredDate(change, true, locale)}
          </AppText>
        </View>
        <TrendMark change={change} />
      </Pressable>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeading}>
        <AppText variant="heading">{t('home.measuredChanges')}</AppText>
        <AppText style={styles.muted}>{t('home.measuredChangesBody')}</AppText>
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
      <AppText style={styles.limitNote} variant="caption">
        {t('home.measuredChangesLimit')}
      </AppText>
    </View>
  );
}

function PopulatedHome({
  model,
  locale,
  onImport,
  onContinueReport,
  onOpenBiomarkerHistory,
}: {
  readonly model: HomeLabViewModel;
  readonly locale: string;
  readonly onImport: () => void;
  readonly onContinueReport: (reportId: string, draftId?: string) => void;
  readonly onOpenBiomarkerHistory: (biomarkerId: string) => void;
}) {
  const latestItem = model.latestRecord ?? model.latestReport;
  if (latestItem === null) return <EmptyHome onImport={onImport} />;

  return (
    <View style={styles.populatedHome}>
      <HomeSummaryHero model={model} />
      <View style={styles.sections}>
        <NextAction model={model} onPress={onContinueReport} />
        <MeasuredChanges
          changes={model.measuredChanges}
          locale={locale}
          onOpen={onOpenBiomarkerHistory}
        />
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
    <SafeAreaView edges={['top', 'left', 'right']} style={[screenStyles.safe, styles.homeSafe]}>
      <StatusBar style="light" />
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
              onImport={openImport}
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
    paddingBottom: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  heroLead: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.lg,
    minHeight: 172,
  },
  heroLeadAccessible: { alignItems: 'center', flexDirection: 'column' },
  heroLens: {
    alignItems: 'center',
    height: 132,
    justifyContent: 'center',
    position: 'relative',
    width: 132,
  },
  heroLensOuter: {
    backgroundColor: colors.brandMid,
    borderRadius: radii.pill,
    height: 132,
    opacity: 0.42,
    position: 'absolute',
    width: 132,
  },
  heroLensMiddle: {
    backgroundColor: colors.brandSoft,
    borderRadius: radii.pill,
    height: 102,
    opacity: 0.5,
    position: 'absolute',
    width: 102,
  },
  heroLensCore: {
    alignItems: 'center',
    backgroundColor: colors.brandDeep,
    borderRadius: radii.pill,
    height: 74,
    justifyContent: 'center',
    position: 'absolute',
    width: 74,
  },
  heroLensValue: {
    ...typography.metric,
    color: colors.onBrand,
    fontVariant: ['tabular-nums'],
  },
  heroCopy: { flex: 1, gap: spacing.xs, minWidth: 180 },
  heroCopyAccessible: { flex: 0, minWidth: 0, width: '100%' },
  heroTextAccessible: { textAlign: 'center' },
  heroEyebrow: { color: colors.brandSoft },
  heroTitle: { color: colors.onBrand },
  heroBody: { color: colors.onBrandMuted },
  heroFacts: {
    borderTopColor: colors.onBrandMuted,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingTop: spacing.lg,
  },
  heroFactsAccessible: { flexDirection: 'column' },
  heroFact: { flex: 1, gap: 2, minWidth: 0 },
  heroFactAccessible: {
    alignItems: 'baseline',
    flex: 0,
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    width: '100%',
  },
  heroFactValue: {
    ...typography.stat,
    color: colors.onBrand,
    fontVariant: ['tabular-nums'],
  },
  heroFactLabel: { color: colors.onBrandMuted },
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
  masonryColumn: { flex: 1, gap: spacing.md, minWidth: 0 },
  changeList: { gap: spacing.md },
  changeCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    minHeight: 174,
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
  trendMark: { alignSelf: 'center', marginTop: 'auto', position: 'relative' },
  trendLine: {
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    height: 2,
    position: 'absolute',
  },
  trendPoint: {
    backgroundColor: colors.brandSoft,
    borderColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 2,
    height: 11,
    position: 'absolute',
    width: 11,
  },
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
