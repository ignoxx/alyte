import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useIsFocused, useNavigation, type NavigationProp } from '@react-navigation/native';
import { formatLocaleDate, type LabRecord, type LabReport, type SpecimenType } from '@alyte/domain';
import type { LabsStackParamList, RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import {
  AppButton,
  AppIcon,
  AppText,
  LabEmptyState,
  ScreenStatusView,
  StatusPill,
  TidalHero,
  TidalIconStage,
} from '../../ui/primitives';
import { colors, radii, screenStyles, spacing } from '../../theme';
import {
  getScreenPlatformPolicy,
  getScreenScrollBottomInset,
  getScreenSurfaceMode,
} from '../../ui/screen-scroll-model';
import { listHistoryEntries } from './biomarker-history-model';
import { summarizeLabReport } from './lab-read-model';
import { getLabReportFailureRecovery } from './report-detail-model';
import { openReportImportFromStack } from '../../navigation/parent-tab';
import {
  buildLabsWorkspaceModel,
  type LabsAttentionItem,
  type OpenDraftReference,
} from './labs-workspace-model';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type HistoryEntry = ReturnType<typeof listHistoryEntries>[number];
type LabsListItem =
  | { readonly kind: 'attention'; readonly value: LabsAttentionItem }
  | { readonly kind: 'report'; readonly value: LabReport }
  | { readonly kind: 'record'; readonly value: LabRecord }
  | { readonly kind: 'history'; readonly value: HistoryEntry };
type LabsSection = {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly data: readonly LabsListItem[];
};

const screenPlatformPolicy = getScreenPlatformPolicy(process.env.EXPO_OS);
function specimenLabel(value: SpecimenType): string {
  const suffix =
    value === 'unknown' ? 'Unknown' : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  return t(`labs.specimen${suffix}`);
}

function reportSourceLabel(report: LabReport): string {
  return report.sourceType === 'pdf' ? t('labs.reportPdf') : t('labs.reportImage');
}

function reportStateLabel(report: LabReport): string {
  const recovery = getLabReportFailureRecovery(report);
  if (recovery.message === 'missing-source') {
    if (report.importState === 'failed') return t('labs.reportStateFailedNoSource');
    if (report.importState === 'interrupted') return t('labs.reportStateInterruptedNoSource');
  }
  return t(
    report.importState === 'imported'
      ? 'labs.reportStateImported'
      : report.importState === 'failed'
        ? 'labs.reportStateFailed'
        : report.importState === 'interrupted'
          ? 'labs.reportStateInterrupted'
          : report.importState === 'deleted'
            ? 'labs.reportStateDeleted'
            : 'labs.reportStateImporting',
  );
}

function countCopy(count: number, singularKey: string, pluralKey: string): string {
  return t(count === 1 ? singularKey : pluralKey).replace('{count}', String(count));
}

function measurementCount(count: number): string {
  return countCopy(count, 'labs.recordMeasurement', 'labs.recordMeasurements');
}

function historyMeasurementCount(count: number): string {
  return countCopy(count, 'labs.historyEntrySubtitleSingular', 'labs.historyEntrySubtitle');
}

function reportCount(count: number): string {
  return countCopy(count, 'labs.workspaceOneReport', 'labs.workspaceReports');
}

function reviewedResultCount(count: number): string {
  return countCopy(count, 'labs.workspaceOneResult', 'labs.workspaceResults');
}

function workspaceSummary(reportTotal: number, reviewedResultTotal: number): string {
  if (reportTotal === 0) {
    return countCopy(
      reviewedResultTotal,
      'labs.workspaceOneManualResult',
      'labs.workspaceManualResults',
    );
  }
  if (reviewedResultTotal === 0) return reportCount(reportTotal);
  return t('labs.workspaceSummary')
    .replace('{reports}', reportCount(reportTotal))
    .replace('{results}', reviewedResultCount(reviewedResultTotal));
}

function reportDetail(report: LabReport, records: readonly LabRecord[], locale: string): string {
  const summary = summarizeLabReport(report, records);
  const date =
    summary.collectionDate.kind === 'known'
      ? formatLocaleDate(summary.collectionDate.value, locale)
      : t('labs.recordDateMissing');
  return `${date} · ${reportSourceLabel(report)} · ${measurementCount(summary.measurementCount)}`;
}

function rowPosition(index: number, length: number) {
  return [index === 0 && styles.firstRow, index === length - 1 && styles.lastRow];
}

export function LabsScreen() {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= 1.4;
  const heroTitleScale = Math.min(fontScale, 1.8);
  const heroBodyScale = Math.min(fontScale, 2);
  const navigation = useNavigation<Navigation>();
  const services = useServices();
  const { labs } = services;
  const isFocused = useIsFocused();
  const root = navigation.getParent()?.getParent<NavigationProp<RootStackParamList>>();
  const tabBarHeight = useContext(BottomTabBarHeightContext);
  const safeAreaInsets = useSafeAreaInsets();
  const [records, setRecords] = useState<readonly LabRecord[]>([]);
  const [reports, setReports] = useState<readonly LabReport[]>([]);
  const [drafts, setDrafts] = useState<readonly OpenDraftReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [nextRecords, nextReports, nextDrafts] = await Promise.all([
        labs.listRecords(),
        services.reports.listReports(),
        services.reports.listOpenExtractionDrafts(),
      ]);
      setRecords(nextRecords);
      setReports(nextReports);
      setDrafts(nextDrafts);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [labs, services.reports]);

  useEffect(() => {
    if (isFocused) void loadRecords();
  }, [isFocused, loadRecords]);

  const workspace = useMemo(
    () => buildLabsWorkspaceModel(reports, records, drafts),
    [drafts, records, reports],
  );
  const historyEntries = useMemo(() => listHistoryEntries(workspace.records), [workspace.records]);
  const trendEntries = useMemo(
    () => historyEntries.filter((entry) => entry.measurementCount >= 2),
    [historyEntries],
  );
  const sections = useMemo<readonly LabsSection[]>(
    () =>
      [
        {
          key: 'attention',
          title: t('labs.attentionSection'),
          body: t('labs.attentionBody'),
          data: workspace.attention.map((value) => ({ kind: 'attention' as const, value })),
        },
        {
          key: 'reports',
          title: t('labs.reportsSection'),
          body: t('labs.reportsBody'),
          data: workspace.reports.map((value) => ({ kind: 'report' as const, value })),
        },
        {
          key: 'records',
          title: t('labs.standaloneRecordsSection'),
          body: t('labs.standaloneRecordsBody'),
          data: workspace.standaloneRecords.map((value) => ({ kind: 'record' as const, value })),
        },
        {
          key: 'history',
          title: t('labs.historySection'),
          body: t('labs.historyBody'),
          data: trendEntries.map((value) => ({ kind: 'history' as const, value })),
        },
      ].filter((section) => section.data.length > 0),
    [trendEntries, workspace],
  );

  const hasData = workspace.records.length > 0 || workspace.reportCount > 0;
  const isEmptyState = !loading && !error && !hasData;
  const surfaceState = loading ? 'loading' : error ? 'error' : isEmptyState ? 'empty' : 'populated';
  const statusSurface = getScreenSurfaceMode(surfaceState) === 'status';
  const bottomInset = getScreenScrollBottomInset(
    tabBarHeight,
    safeAreaInsets.bottom,
    screenPlatformPolicy === 'ios-native-tabs' ? spacing.xxl : 0,
    screenPlatformPolicy === 'ios-native-tabs' ? 'automatic' : 'legacy',
  );

  function openAttention(item: LabsAttentionItem) {
    if (item.kind === 'review-draft' && item.draftId !== undefined) {
      navigation.navigate('ExtractionDraft', {
        reportId: item.report.id,
        draftId: item.draftId,
      });
      return;
    }
    navigation.navigate('LabReportDetail', { reportId: item.report.id });
  }

  function renderItem({
    item,
    index,
    section,
  }: {
    readonly item: LabsListItem;
    readonly index: number;
    readonly section: LabsSection;
  }) {
    const positionStyle = rowPosition(index, section.data.length);
    if (item.kind === 'attention') {
      const title =
        item.value.kind === 'review-draft'
          ? t('labs.reviewExtractedMeasurements')
          : t('labs.continueReport');
      const status =
        item.value.kind === 'review-draft'
          ? t('labs.reviewRequired')
          : reportStateLabel(item.value.report);
      return (
        <Pressable
          accessibilityHint={t('labs.reportRowHint')}
          accessibilityLabel={`${title}, ${item.value.report.originalFilename}, ${status}`}
          accessibilityRole="button"
          onPress={() => openAttention(item.value)}
          style={({ pressed }) => [
            styles.listRow,
            usesAccessibleLayout && styles.listRowAccessible,
            styles.attentionRow,
            positionStyle,
            pressed && styles.rowPressed,
          ]}
        >
          {!usesAccessibleLayout && (
            <View style={styles.attentionIcon}>
              <AppIcon color={colors.accent} name="clock" size={20} />
            </View>
          )}
          <View style={styles.rowBody}>
            <AppText variant="heading">{title}</AppText>
            <AppText
              numberOfLines={usesAccessibleLayout ? undefined : 2}
              selectable
              style={styles.muted}
            >
              {item.value.report.originalFilename}
            </AppText>
            <AppText style={styles.statusText} variant="caption">
              {status}
            </AppText>
          </View>
          <AppIcon
            name="chevronRight"
            size={16}
            style={usesAccessibleLayout ? styles.rowChevronAccessible : undefined}
          />
        </Pressable>
      );
    }

    if (item.kind === 'report') {
      const detail = reportDetail(item.value, workspace.records, locale);
      return (
        <Pressable
          accessibilityHint={t('labs.reportRowHint')}
          accessibilityLabel={`${t('labs.reportTitle')}: ${item.value.originalFilename}, ${detail}, ${reportStateLabel(item.value)}`}
          accessibilityRole="button"
          onPress={() => navigation.navigate('LabReportDetail', { reportId: item.value.id })}
          style={({ pressed }) => [
            styles.listRow,
            usesAccessibleLayout && styles.listRowAccessible,
            positionStyle,
            pressed && styles.rowPressed,
          ]}
        >
          {!usesAccessibleLayout && <AppIcon color={colors.accent} name="doc" size={22} />}
          <View style={styles.rowBody}>
            <AppText
              numberOfLines={usesAccessibleLayout ? undefined : 2}
              selectable
              variant="heading"
            >
              {item.value.originalFilename}
            </AppText>
            <AppText selectable style={styles.muted}>
              {detail}
            </AppText>
            {item.value.importState !== 'imported' && (
              <StatusPill subtle>{reportStateLabel(item.value)}</StatusPill>
            )}
          </View>
          <AppIcon
            name="chevronRight"
            size={16}
            style={usesAccessibleLayout ? styles.rowChevronAccessible : undefined}
          />
        </Pressable>
      );
    }

    if (item.kind === 'record') {
      const date =
        item.value.collectionDate.kind === 'known'
          ? formatLocaleDate(item.value.collectionDate.value, locale)
          : t('labs.recordDateMissing');
      const summary = measurementCount(item.value.measurements.length);
      return (
        <Pressable
          accessibilityHint={t('labs.recordRowHint')}
          accessibilityLabel={`${t('labs.recordTitle')}: ${date}, ${summary}`}
          accessibilityRole="button"
          onPress={() => navigation.navigate('LabRecordDetail', { recordId: item.value.id })}
          style={({ pressed }) => [
            styles.listRow,
            usesAccessibleLayout && styles.listRowAccessible,
            positionStyle,
            pressed && styles.rowPressed,
          ]}
        >
          {!usesAccessibleLayout && <AppIcon color={colors.accent} name="labs" size={22} />}
          <View style={styles.rowBody}>
            <AppText selectable variant="heading">
              {date}
            </AppText>
            <AppText selectable style={styles.muted}>
              {`${item.value.laboratoryName ?? t('labs.recordTitle')} · ${specimenLabel(item.value.specimenType)} · ${summary}`}
            </AppText>
          </View>
          <AppIcon
            name="chevronRight"
            size={16}
            style={usesAccessibleLayout ? styles.rowChevronAccessible : undefined}
          />
        </Pressable>
      );
    }

    return (
      <Pressable
        accessibilityHint={t('labs.historyRowHint')}
        accessibilityLabel={`${item.value.canonicalLabel}, ${historyMeasurementCount(item.value.measurementCount)}`}
        accessibilityRole="button"
        onPress={() =>
          navigation.navigate('BiomarkerHistory', { biomarkerId: item.value.biomarkerId })
        }
        style={({ pressed }) => [
          styles.listRow,
          usesAccessibleLayout && styles.listRowAccessible,
          positionStyle,
          pressed && styles.rowPressed,
        ]}
      >
        {!usesAccessibleLayout && <AppIcon color={colors.accent} name="chart" size={22} />}
        <View style={styles.rowBody}>
          <AppText selectable variant="heading">
            {item.value.canonicalLabel}
          </AppText>
          <AppText selectable style={styles.muted}>
            {historyMeasurementCount(item.value.measurementCount)}
          </AppText>
        </View>
        <AppIcon
          name="chevronRight"
          size={16}
          style={usesAccessibleLayout ? styles.rowChevronAccessible : undefined}
        />
      </Pressable>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[screenStyles.safe, styles.screenSafe]}>
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
              <AppText style={styles.muted}>{t('labs.loading')}</AppText>
            </View>
          )}
          {error && (
            <View style={styles.errorState}>
              <AppText variant="heading">{t('labs.errorTitle')}</AppText>
              <AppText style={styles.muted}>{t('labs.errorBody')}</AppText>
              <AppButton
                label={t('labs.retry')}
                onPress={() => void loadRecords()}
                tone="secondary"
              />
            </View>
          )}
          {isEmptyState && (
            <View style={styles.emptyComposition}>
              <LabEmptyState
                actionLabel={t('labs.action')}
                icon="addDocument"
                onAction={() => openReportImportFromStack(navigation)}
                body={t('labs.emptyBody')}
                title={t('labs.emptyTitle')}
              />
              <View accessibilityRole="text" style={styles.localNote}>
                <AppIcon color={colors.mutedInk} name="lockShield" size={16} />
                <AppText style={styles.localNoteText} variant="caption">
                  {t('labs.localOnly')}
                </AppText>
              </View>
            </View>
          )}
        </ScreenStatusView>
      ) : (
        <SectionList
          automaticallyAdjustContentInsets
          automaticallyAdjustKeyboardInsets
          automaticallyAdjustsScrollIndicatorInsets
          contentInset={{ bottom: bottomInset }}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.listContent}
          initialNumToRender={16}
          keyExtractor={(item) =>
            item.kind === 'attention'
              ? `attention-${item.value.report.id}`
              : item.kind === 'history'
                ? `history-${item.value.biomarkerId}`
                : `${item.kind}-${item.value.id}`
          }
          ListFooterComponent={
            <AppButton
              label={t('labs.manualAction')}
              onPress={() => root?.navigate('LabRecordForm')}
              style={styles.manualAction}
              tone="quiet"
            />
          }
          ListHeaderComponent={
            <TidalHero edge="bottom" style={styles.workspaceHeader}>
              <View
                style={[
                  styles.workspaceHeading,
                  usesAccessibleLayout && styles.workspaceHeadingAccessible,
                ]}
              >
                {!usesAccessibleLayout && <TidalIconStage name="library" size="compact" />}
                <View style={styles.workspaceCopy}>
                  <AppText
                    allowFontScaling={false}
                    style={[
                      styles.workspaceTitle,
                      { fontSize: 26 * heroTitleScale, lineHeight: 32 * heroTitleScale },
                    ]}
                    variant="title"
                  >
                    {t('labs.workspaceTitle')}
                  </AppText>
                  <AppText
                    allowFontScaling={false}
                    style={[
                      styles.workspaceBody,
                      { fontSize: 13 * heroBodyScale, lineHeight: 18 * heroBodyScale },
                    ]}
                    variant="caption"
                  >
                    {workspaceSummary(workspace.reportCount, workspace.reviewedResultCount)}
                  </AppText>
                </View>
              </View>
              <AppButton
                label={t('labs.action')}
                labelMaxFontSizeMultiplier={1.8}
                labelNumberOfLines={2}
                onPress={() => openReportImportFromStack(navigation)}
                style={styles.workspaceAction}
                tone="secondary"
              >
                <AppIcon color={colors.accent} name="plus" size={17} />
              </AppButton>
            </TidalHero>
          }
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <AppText style={styles.sectionLabel} variant="label">
                {section.title}
              </AppText>
              {section.body.length > 0 && (
                <AppText style={styles.sectionBody} variant="caption">
                  {section.body}
                </AppText>
              )}
            </View>
          )}
          scrollIndicatorInsets={{ bottom: bottomInset }}
          sections={sections}
          stickySectionHeadersEnabled={false}
          style={[screenStyles.scroll, styles.canvas]}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screenSafe: { backgroundColor: colors.brand },
  canvas: { backgroundColor: colors.canvas },
  statusState: { alignItems: 'center', justifyContent: 'center' },
  loadingState: { alignItems: 'center', gap: spacing.md },
  errorState: { alignItems: 'center', gap: spacing.md, maxWidth: 340 },
  emptyComposition: { alignItems: 'center', gap: spacing.lg, width: '100%' },
  localNote: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  localNoteText: { color: colors.mutedInk, flexShrink: 1, textAlign: 'center' },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  workspaceHeader: {
    justifyContent: 'flex-end',
    gap: spacing.lg,
    marginBottom: spacing.sm,
    marginHorizontal: -spacing.lg,
    minHeight: 214,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    paddingTop: spacing.xxl,
  },
  workspaceAction: { marginTop: spacing.sm },
  workspaceHeading: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  workspaceHeadingAccessible: { alignItems: 'flex-start', flexDirection: 'column' },
  workspaceCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  workspaceTitle: { color: colors.onBrand },
  workspaceBody: { color: colors.onBrandMuted },
  sectionHeader: { gap: spacing.xs, paddingBottom: spacing.sm, paddingTop: spacing.lg },
  sectionLabel: { color: colors.ink },
  sectionBody: { color: colors.mutedInk },
  listRow: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 72,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  listRowAccessible: {
    alignItems: 'stretch',
    paddingRight: spacing.xl + spacing.md,
    position: 'relative',
  },
  rowChevronAccessible: { position: 'absolute', right: spacing.md, top: spacing.md },
  firstRow: { borderTopLeftRadius: radii.md, borderTopRightRadius: radii.md },
  lastRow: {
    borderBottomLeftRadius: radii.md,
    borderBottomRightRadius: radii.md,
    borderBottomWidth: 0,
  },
  attentionRow: { backgroundColor: colors.accentSoft },
  attentionIcon: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  rowBody: { flex: 1, gap: spacing.xs, minWidth: 0 },
  rowPressed: { opacity: 0.72 },
  statusText: { color: colors.accent, fontWeight: '600' },
  manualAction: { alignSelf: 'flex-start', marginTop: spacing.lg },
  muted: { color: colors.mutedInk },
});
