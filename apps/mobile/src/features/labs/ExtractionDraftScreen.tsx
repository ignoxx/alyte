import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  SectionList,
  StyleSheet,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
  type TextInputFocusEventData,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  extractionReviewBlocksConfirmation,
  parseLabDate,
  type ExtractionDraft,
  type ExtractionDraftRow,
  type LabDateState,
} from '@alyte/domain';
import type { LabsStackParamList, RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppIcon, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, radii, spacing } from '../../theme';
import {
  buildExtractionReviewSections,
  canConfirmExtraction,
  extractionConfirmationDestination,
  extractionConfirmationSummary,
  extractionNeedsResolution,
  filterExtractionRows,
  type ExtractionReviewFilter,
} from './extraction-ui-model';
import { ExtractionConfirmation } from './ExtractionConfirmation';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type DraftRoute = RouteProp<LabsStackParamList, 'ExtractionDraft'>;

type ListSection = {
  readonly key: string;
  readonly recordKey: string;
  readonly showRecordHeader: boolean;
  readonly collectionDateLabel: string | null;
  readonly collectionDate: LabDateState;
  readonly dateDefaulted: boolean;
  readonly specimenType: ExtractionDraftRow['proposedSpecimenType'];
  readonly panelLabel: string | null;
  readonly data: readonly ExtractionDraftRow[];
};

function valueText(row: ExtractionDraftRow): string {
  const value = row.proposedValue;
  return value.kind === 'numeric'
    ? String(value.value)
    : value.kind === 'bounded'
      ? `${value.comparator}${value.value}`
      : value.value;
}

function countCopy(count: number, singularKey: string, pluralKey: string): string {
  return t(count === 1 ? singularKey : pluralKey).replace('{count}', String(count));
}

function flattenSections(rows: readonly ExtractionDraftRow[]): readonly ListSection[] {
  return buildExtractionReviewSections(rows).flatMap((record) =>
    record.panels.map((panel, index) => ({
      key: `${record.key}|${panel.label ?? 'other'}`,
      recordKey: record.key,
      showRecordHeader: index === 0,
      collectionDateLabel: record.collectionDateLabel,
      collectionDate: record.collectionDate,
      dateDefaulted: record.dateDefaulted,
      specimenType: record.specimenType,
      panelLabel: panel.label,
      data: panel.rows,
    })),
  );
}

function rowAccessibilityLabel(row: ExtractionDraftRow): string {
  const state = extractionNeedsResolution(row)
    ? t('labs.extractionNeedsReview')
    : row.decision === 'skip'
      ? t('labs.extractionSkipped')
      : t('labs.extractionIncluded');
  const sourceLabel = row.sourceLabel === row.proposedLabel ? '' : ` ${row.sourceLabel}.`;
  const range = row.proposedReferenceInterval
    ? ` ${t('labs.measurementReference')}: ${row.proposedReferenceInterval}.`
    : '';
  const flag = row.proposedFlag ? ` ${t('labs.measurementFlag')}: ${row.proposedFlag}.` : '';
  return `${row.proposedLabel}.${sourceLabel} ${valueText(row)} ${row.proposedUnit ?? ''}.${range}${flag} ${state}.`;
}

export function ExtractionDraftScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DraftRoute>();
  const { reports } = useServices();
  const { fontScale } = useWindowDimensions();
  const largeType = fontScale > 1;
  const [draft, setDraft] = useState<ExtractionDraft | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ExtractionReviewFilter>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await reports.getExtractionDraft(route.params.draftId);
      if (next === null) throw new Error('Extraction Draft unavailable');
      setDraft(next);
      setLoadError(false);
      setSaveError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [reports, route.params.draftId, route.params.reportId]);

  useEffect(() => {
    void load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      if (!loading) void load();
    }, [load, loading]),
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerSearchBarOptions: {
        placeholder: t('labs.extractionSearch'),
        hideWhenScrolling: false,
        onChangeText: (event: NativeSyntheticEvent<TextInputFocusEventData>) =>
          setSearch(event.nativeEvent.text),
        onCancelButtonPress: () => setSearch(''),
      },
    });
  }, [navigation]);

  const visibleRows = useMemo(
    () => filterExtractionRows(draft?.rows ?? [], search, filter),
    [draft?.rows, filter, search],
  );
  const sections = useMemo(() => flattenSections(visibleRows), [visibleRows]);
  const confirmation = extractionConfirmationSummary(draft?.rows ?? []);
  const needsReview = confirmation.needsReview;
  const included = confirmation.included;
  const canConfirm = draft !== null && confirmation.canConfirm;
  const hasBottomAccessory = confirmation.included > 0;
  const canReprocess =
    (draft?.state === 'draft' || draft?.state === 'confirmed') && draft.pipelineStatus === 'older';
  const canImprove =
    draft?.state === 'draft' &&
    draft.rows.some(
      (row) =>
        row.editState === 'automatic' &&
        row.source.observations !== undefined &&
        row.source.observations.length > 0 &&
        (row.proposedBiomarkerId === null || row.reviewReasons.length > 0),
    );

  const reprocess = useCallback(() => {
    if (busy || draft === null || !canReprocess) return;
    Alert.alert(t('labs.extractionReprocessTitle'), t('labs.extractionReprocessBody'), [
      { text: t('labs.cancel'), style: 'cancel' },
      {
        text: t('labs.extractionReprocess'),
        style: 'destructive',
        onPress: () => {
          navigation
            .getParent()
            ?.getParent<NativeStackNavigationProp<RootStackParamList>>()
            ?.navigate('ExtractionProgress', {
              reportId: route.params.reportId,
              mode: 'reprocess',
            });
        },
      },
    ]);
  }, [busy, canReprocess, draft, navigation, route.params.reportId]);

  const improve = useCallback(() => {
    if (busy || draft === null || !canImprove) return;
    Alert.alert(t('labs.extractionImproveTitle'), t('labs.extractionImproveBody'), [
      { text: t('labs.cancel'), style: 'cancel' },
      {
        text: t('labs.extractionImprove'),
        onPress: () => {
          setBusy(true);
          setSaveError(false);
          void reports
            .improveExtraction(draft.id)
            .then(() => load())
            .catch(() => setSaveError(true))
            .finally(() => setBusy(false));
        },
      },
    ]);
  }, [busy, canImprove, draft, load, reports]);

  const openRow = useCallback(
    (rowId: string, selectNeedsReview = false) => {
      if (draft === null) return;
      if (selectNeedsReview) {
        setSearch('');
        setFilter('needs-review');
      }
      navigation
        .getParent()
        ?.getParent<NativeStackNavigationProp<RootStackParamList>>()
        ?.navigate('ExtractionMeasurementEditor', {
          reportId: route.params.reportId,
          draftId: draft.id,
          rowId,
        });
    },
    [draft, navigation, route.params.reportId],
  );

  const reviewRemaining = useCallback(() => {
    const nextBlockingRow = draft?.rows.find(extractionReviewBlocksConfirmation);
    if (nextBlockingRow === undefined) return;
    openRow(nextBlockingRow.id, true);
  }, [draft?.rows, openRow]);

  const editGroupDate = useCallback(
    (section: ListSection) => {
      if (busy || draft === null) return;
      const current = section.collectionDate.kind === 'known' ? section.collectionDate.value : '';
      Alert.prompt(
        t('labs.extractionDateEditorTitle'),
        t('labs.extractionDateEditorBody'),
        [
          { text: t('labs.cancel'), style: 'cancel' },
          {
            text: t('labs.extractionDateSave'),
            onPress: (input?: string) => {
              const value = input?.trim() ?? '';
              const parsed: LabDateState | null =
                value.length === 0
                  ? { kind: 'missing' }
                  : parseLabDate(value, Intl.DateTimeFormat().resolvedOptions().locale);
              if (parsed === null) {
                Alert.alert(
                  t('labs.extractionDateEditorErrorTitle'),
                  t('labs.extractionDateEditorErrorBody'),
                );
                return;
              }
              const next = parsed;
              setBusy(true);
              void reports
                .updateExtractionGroupDate(
                  draft.id,
                  section.collectionDate,
                  section.specimenType,
                  next,
                )
                .then(() => load())
                .catch(() => setSaveError(true))
                .finally(() => setBusy(false));
            },
          },
        ],
        'plain-text',
        current,
      );
    },
    [busy, draft, load, reports],
  );

  const confirm = useCallback(async () => {
    if (busy || draft === null || !canConfirmExtraction(draft.rows)) return;
    setSaveError(false);
    setBusy(true);
    try {
      const records = await reports.confirmExtraction(draft.id);
      const destination = extractionConfirmationDestination(records);
      if (destination.kind === 'record') {
        navigation.replace(destination.route, { recordId: destination.recordId });
      } else {
        navigation.popToTop();
      }
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  }, [busy, draft, navigation, reports]);

  if (loading) return <AppText style={styles.loading}>{t('labs.loading')}</AppText>;
  if (draft === null) {
    return (
      <View style={styles.center}>
        <AppText selectable>{t('labs.extractionLoadError')}</AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
      </View>
    );
  }

  return (
    <View style={styles.safe}>
      <SectionList
        contentContainerStyle={[styles.content, hasBottomAccessory && styles.contentWithAccessory]}
        contentInsetAdjustmentBehavior="automatic"
        sections={sections}
        keyExtractor={(row) => row.id}
        keyboardDismissMode="interactive"
        ListHeaderComponent={
          <View style={styles.header}>
            <AppText selectable variant="heading" style={styles.summary}>
              {`${countCopy(
                draft.rows.length,
                'labs.extractionMeasurementFound',
                'labs.extractionMeasurementsFound',
              )} · ${countCopy(
                needsReview,
                'labs.extractionMeasurementNeedsReview',
                'labs.extractionMeasurementsNeedReview',
              )}`}
            </AppText>
            <AppText style={styles.intro}>{t('labs.extractionCompactIntro')}</AppText>
            <View style={styles.pipelineStatus}>
              <StatusPill tone={draft.pipelineStatus === 'current' ? 'neutral' : 'reviewNeeded'}>
                {draft.pipelineStatus === 'current'
                  ? t('labs.extractionCurrentStatus')
                  : t('labs.extractionOlderStatus')}
              </StatusPill>
              {draft.hasUserEdits && (
                <AppText style={styles.muted}>{`· ${t('labs.extractionEditedStatus')}`}</AppText>
              )}
              {draft.hasUnknownEdits && (
                <AppText
                  style={styles.muted}
                >{`· ${t('labs.extractionUnknownEditStatus')}`}</AppText>
              )}
            </View>
            {canReprocess && (
              <View style={styles.reprocessCard}>
                <AppText style={styles.muted}>{t('labs.extractionReprocessBody')}</AppText>
                <AppButton
                  disabled={busy}
                  label={busy ? t('labs.extractionReprocessBusy') : t('labs.extractionReprocess')}
                  onPress={reprocess}
                  tone="secondary"
                />
              </View>
            )}
            {canImprove && (
              <View style={styles.reprocessCard}>
                <AppText style={styles.muted}>{t('labs.extractionImproveBody')}</AppText>
                <AppButton
                  disabled={busy}
                  label={busy ? t('labs.extractionImproveBusy') : t('labs.extractionImprove')}
                  onPress={improve}
                  tone="secondary"
                />
              </View>
            )}
            {loadError && (
              <AppText selectable style={styles.loadError}>
                {t('labs.extractionLoadError')}
              </AppText>
            )}
            <View accessibilityRole="tablist" style={styles.filters}>
              <FilterButton
                active={filter === 'all'}
                label={t('labs.extractionFilterAll').replace('{count}', String(draft.rows.length))}
                onPress={() => setFilter('all')}
              />
              <FilterButton
                active={filter === 'needs-review'}
                label={t('labs.extractionFilterNeedsReview').replace(
                  '{count}',
                  String(needsReview),
                )}
                onPress={() => setFilter('needs-review')}
              />
            </View>
          </View>
        }
        ListEmptyComponent={
          <AppSurface tone="soft" style={styles.empty}>
            <AppText variant="heading">{t('labs.extractionNoMatches')}</AppText>
            <AppText style={styles.muted}>{t('labs.extractionNoMatchesBody')}</AppText>
          </AppSurface>
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            {section.showRecordHeader && (
              <View style={styles.recordHeader}>
                <Pressable
                  accessibilityLabel={t('labs.extractionEditCollectionDate')}
                  accessibilityRole="button"
                  onPress={() => editGroupDate(section)}
                  style={styles.recordCopy}
                >
                  <AppText variant="label">{t('labs.extractionLabRecord')}</AppText>
                  <AppText selectable variant="heading">
                    {section.collectionDateLabel ?? t('labs.recordDateMissing')}
                  </AppText>
                  <AppText style={styles.dateEditorLabel}>
                    {t('labs.extractionEditCollectionDate')}
                  </AppText>
                </Pressable>
                <StatusPill tone="neutral">{t(`labs.specimen.${section.specimenType}`)}</StatusPill>
              </View>
            )}
            {section.showRecordHeader && section.dateDefaulted && (
              <AppText selectable style={styles.dateCallout}>
                {t('labs.extractionDateFallbackCallout')}
              </AppText>
            )}
            {section.showRecordHeader && section.collectionDate.kind === 'missing' && (
              <AppText selectable style={styles.dateCallout}>
                {t('labs.extractionDateMissing')}
              </AppText>
            )}
            {section.panelLabel !== null && (
              <AppText style={styles.panelLabel} variant="label">
                {section.panelLabel}
              </AppText>
            )}
          </View>
        )}
        renderItem={({ item: row }) => (
          <Pressable
            accessibilityLabel={rowAccessibilityLabel(row)}
            accessibilityRole="button"
            onPress={() => openRow(row.id)}
            style={({ pressed }) => [
              styles.row,
              largeType && styles.rowLarge,
              pressed && styles.rowPressed,
              row.decision === 'skip' && styles.rowSkipped,
            ]}
          >
            <View style={styles.rowCopy}>
              <View style={[styles.rowTitleLine, largeType && styles.rowTitleLineLarge]}>
                <AppText
                  selectable
                  numberOfLines={largeType ? undefined : 1}
                  variant="heading"
                  style={[styles.rowTitle, largeType && styles.rowTitleLarge]}
                >
                  {row.proposedLabel || t('labs.extractionUnmapped')}
                </AppText>
                {extractionNeedsResolution(row) && (
                  <StatusPill tone="reviewNeeded">{t('labs.extractionNeedsReview')}</StatusPill>
                )}
                {row.decision === 'skip' && (
                  <StatusPill tone="neutral">{t('labs.extractionSkipped')}</StatusPill>
                )}
              </View>
              {row.sourceLabel !== row.proposedLabel && (
                <AppText selectable numberOfLines={largeType ? undefined : 1} style={styles.muted}>
                  {row.sourceLabel}
                </AppText>
              )}
              <View style={[styles.valueLine, largeType && styles.valueLineLarge]}>
                <AppText
                  selectable
                  variant="heading"
                  style={[styles.value, largeType && styles.valueLarge]}
                >{`${valueText(row)}${row.proposedUnit ? ` ${row.proposedUnit}` : ''}`}</AppText>
                {(row.proposedFlag || row.proposedReferenceInterval) && (
                  <AppText selectable style={styles.muted}>
                    {[row.proposedFlag, row.proposedReferenceInterval].filter(Boolean).join(' · ')}
                  </AppText>
                )}
              </View>
            </View>
            <AppIcon name="chevronRight" size={16} />
          </Pressable>
        )}
        stickySectionHeadersEnabled={false}
        style={styles.list}
      />
      <ExtractionConfirmation
        busy={busy}
        canConfirm={canConfirm}
        failure={saveError}
        included={included}
        needsReview={needsReview}
        remainingBlockers={confirmation.remainingBlockers}
        blockedReason={confirmation.blockedReason}
        onConfirm={confirm}
        onReviewRemaining={reviewRemaining}
      />
    </View>
  );
}

function FilterButton({
  active,
  label,
  onPress,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.filter,
        active && styles.filterActive,
        pressed && styles.filterPressed,
      ]}
    >
      <AppText variant="label" style={active ? styles.filterActiveText : styles.muted}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: colors.canvas, flex: 1 },
  list: { flex: 1 },
  loading: { padding: spacing.lg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  // UIKit adjusts for the native tab bar; this extra end-cap keeps the last row above the
  // iOS bottom accessory as well when the tab controller does not report its accessory height.
  contentWithAccessory: { paddingBottom: spacing.xxl + 56 },
  header: {
    alignItems: 'stretch',
    gap: spacing.sm,
    paddingBottom: spacing.lg,
    paddingTop: spacing.md,
  },
  summary: { flexShrink: 1, fontVariant: ['tabular-nums'], width: '100%' },
  intro: { color: colors.mutedInk, flexShrink: 1, width: '100%' },
  pipelineStatus: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  reprocessCard: {
    backgroundColor: colors.accentSoft,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.md,
  },
  loadError: { color: colors.danger },
  muted: { color: colors.mutedInk },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.xs },
  filter: {
    alignItems: 'center',
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  filterActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filterActiveText: { color: colors.onAccent },
  filterPressed: { opacity: 0.72 },
  sectionHeader: { backgroundColor: colors.canvas, gap: spacing.sm, paddingTop: spacing.md },
  recordHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  recordCopy: { flex: 1, gap: spacing.xs },
  dateEditorLabel: { color: colors.accent },
  dateCallout: { color: colors.mutedInk, paddingBottom: spacing.xs },
  panelLabel: { color: colors.mutedInk, paddingTop: spacing.xs, textTransform: 'uppercase' },
  row: {
    alignItems: 'center',
    backgroundColor: colors.elevatedSurface,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 72,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowLarge: { alignItems: 'flex-start', minHeight: 96 },
  rowPressed: { backgroundColor: colors.accentSoft },
  rowSkipped: { opacity: 0.58 },
  rowCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  rowTitleLine: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  rowTitleLineLarge: { alignItems: 'flex-start', flexDirection: 'column' },
  rowTitle: { flex: 1 },
  rowTitleLarge: { flex: 0, width: '100%' },
  valueLine: { alignItems: 'baseline', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  valueLineLarge: { alignItems: 'flex-start', flexDirection: 'column' },
  value: { fontVariant: ['tabular-nums'] },
  valueLarge: { flexShrink: 1, width: '100%' },
  empty: { gap: spacing.xs, marginTop: spacing.md },
});
