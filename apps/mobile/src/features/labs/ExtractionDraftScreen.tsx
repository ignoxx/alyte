import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  Platform,
  Pressable,
  SectionList,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  useFocusEffect,
  useNavigation,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ExtractionDraft, ExtractionDraftRow } from '@alyte/domain';
import type { LabsStackParamList, RootStackParamList } from '../../navigation/types';
import { handoffAfterAppearance } from '../../navigation/dismissal-handoff';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppIcon, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import {
  buildExtractionReviewSections,
  canConfirmExtraction,
  extractionNeedsResolution,
  filterExtractionRows,
  type ExtractionReviewFilter,
} from './extraction-ui-model';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type DraftRoute = RouteProp<LabsStackParamList, 'ExtractionDraft'>;

type ListSection = {
  readonly key: string;
  readonly recordKey: string;
  readonly showRecordHeader: boolean;
  readonly collectionDateLabel: string | null;
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

function flattenSections(rows: readonly ExtractionDraftRow[]): readonly ListSection[] {
  return buildExtractionReviewSections(rows).flatMap((record) =>
    record.panels.map((panel, index) => ({
      key: `${record.key}|${panel.label ?? 'other'}`,
      recordKey: record.key,
      showRecordHeader: index === 0,
      collectionDateLabel: record.collectionDateLabel,
      specimenType: record.specimenType,
      panelLabel: panel.label,
      data: panel.rows,
    })),
  );
}

function rowAccessibilityLabel(row: ExtractionDraftRow): string {
  const state =
    row.decision === 'skip'
      ? t('labs.extractionSkipped')
      : extractionNeedsResolution(row)
        ? t('labs.extractionNeedsReview')
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
  const [error, setError] = useState(false);

  useEffect(() => {
    const sourcePreview = route.params.sourcePreview;
    if (sourcePreview === undefined) return;
    const root = navigation.getParent()?.getParent<NavigationProp<RootStackParamList>>();
    if (root === undefined) return;
    return handoffAfterAppearance(navigation, () => {
      navigation.setParams({ sourcePreview: undefined });
      root.navigate('SanitizedSourcePreview', sourcePreview);
    });
  }, [navigation, route.params.sourcePreview]);

  const load = useCallback(async () => {
    try {
      const next = await reports.getExtractionDraft(route.params.draftId);
      if (next === null) throw new Error('Extraction Draft unavailable');
      setDraft(next);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [reports, route.params.draftId]);

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
        onChangeText: (event) => setSearch(event.nativeEvent.text),
        onCancelButtonPress: () => setSearch(''),
      },
    });
  }, [navigation]);

  const visibleRows = useMemo(
    () => filterExtractionRows(draft?.rows ?? [], search, filter),
    [draft?.rows, filter, search],
  );
  const sections = useMemo(() => flattenSections(visibleRows), [visibleRows]);
  const needsReview = draft?.rows.filter(extractionNeedsResolution).length ?? 0;
  const included = draft?.rows.filter((row) => row.decision !== 'skip').length ?? 0;
  const canConfirm = draft !== null && canConfirmExtraction(draft.rows);

  const confirm = useCallback(async () => {
    if (draft === null || !canConfirmExtraction(draft.rows)) return;
    setBusy(true);
    try {
      const records = await reports.confirmExtraction(draft.id);
      const first = records[0];
      if (first === undefined) throw new Error('No Lab Record created');
      navigation.replace('LabRecordDetail', { recordId: first.id });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }, [draft, navigation, reports]);

  const usesNativeTabAccessory =
    Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
  useLayoutEffect(() => {
    if (!usesNativeTabAccessory || draft === null) return;
    const tabNavigation = navigation.getParent();
    if (tabNavigation === undefined) return;
    tabNavigation.setOptions({
      bottomAccessory: () => (
        <ReviewFooter
          busy={busy}
          canConfirm={canConfirm}
          included={included}
          needsReview={needsReview}
          onConfirm={() => void confirm()}
          compact
        />
      ),
    });
    return () => tabNavigation.setOptions({ bottomAccessory: undefined });
  }, [busy, canConfirm, confirm, draft, included, navigation, needsReview, usesNativeTabAccessory]);

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
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        sections={sections}
        keyExtractor={(row) => row.id}
        keyboardDismissMode="interactive"
        ListHeaderComponent={
          <View style={styles.header}>
            <AppText selectable variant="heading" style={styles.summary}>
              {t('labs.extractionSummary')
                .replace('{count}', String(draft.rows.length))
                .replace('{review}', String(needsReview))}
            </AppText>
            <AppText style={styles.intro}>{t('labs.extractionCompactIntro')}</AppText>
            {error && (
              <AppText selectable style={styles.error}>
                {t('labs.extractionSaveError')}
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
                <View style={styles.recordCopy}>
                  <AppText variant="label">{t('labs.extractionLabRecord')}</AppText>
                  <AppText selectable variant="heading">
                    {section.collectionDateLabel ?? t('labs.recordDateMissing')}
                  </AppText>
                </View>
                <StatusPill tone="neutral">{t(`labs.specimen.${section.specimenType}`)}</StatusPill>
              </View>
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
            onPress={() =>
              navigation.navigate('ExtractionMeasurementEditor', {
                reportId: route.params.reportId,
                draftId: draft.id,
                rowId: row.id,
              })
            }
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
      {!usesNativeTabAccessory && (
        <ReviewFooter
          busy={busy}
          canConfirm={canConfirm}
          included={included}
          needsReview={needsReview}
          onConfirm={() => void confirm()}
        />
      )}
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

function ReviewFooter({
  busy,
  canConfirm,
  included,
  needsReview,
  onConfirm,
  compact = false,
}: {
  readonly busy: boolean;
  readonly canConfirm: boolean;
  readonly included: number;
  readonly needsReview: number;
  readonly onConfirm: () => void;
  readonly compact?: boolean;
}) {
  return (
    <View style={[styles.footer, compact && styles.footerCompact]}>
      {!compact && (
        <AppText style={[styles.muted, styles.footerProgress]}>
          {t('labs.extractionConfirmationProgress')
            .replace('{included}', String(included))
            .replace('{review}', String(needsReview))}
        </AppText>
      )}
      <AppButton
        accessibilityLabel={`${t('labs.extractionConfirm')}. ${t(
          'labs.extractionConfirmationProgress',
        )
          .replace('{included}', String(included))
          .replace('{review}', String(needsReview))}`}
        disabled={busy || !canConfirm}
        label={t(compact ? 'labs.extractionConfirmShort' : 'labs.extractionConfirm')}
        {...(compact ? { labelMaxFontSizeMultiplier: 1.3 } : {})}
        onPress={onConfirm}
        style={[styles.confirm, compact && styles.confirmCompact]}
      />
    </View>
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
  header: {
    alignItems: 'stretch',
    gap: spacing.sm,
    paddingBottom: spacing.lg,
    paddingTop: spacing.md,
  },
  summary: { flexShrink: 1, fontVariant: ['tabular-nums'], width: '100%' },
  intro: { color: colors.mutedInk, flexShrink: 1, width: '100%' },
  error: { color: colors.danger },
  muted: { color: colors.mutedInk },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.xs },
  filter: {
    alignItems: 'center',
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 999,
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
  footer: {
    alignItems: 'center',
    backgroundColor: colors.elevatedSurface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    paddingBottom: spacing.lg,
  },
  footerCompact: { paddingBottom: spacing.sm },
  footerProgress: { flex: 1, minWidth: 0 },
  confirm: { flexShrink: 0, minWidth: 164 },
  confirmCompact: { flex: 1, minWidth: 0 },
});
