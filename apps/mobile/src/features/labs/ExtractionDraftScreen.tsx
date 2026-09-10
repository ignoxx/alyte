import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
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
import DateTimePicker from '@expo/ui/community/datetime-picker';
import {
  useFocusEffect,
  useNavigation,
  usePreventRemove,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  formatLocaleDate,
  formatLocaleDecimal,
  type ExtractionDraftRow,
  type LabDateState,
} from '@alyte/domain';
import type { LabsStackParamList, RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  ScreenStatusView,
  StatusPill,
} from '../../ui/primitives';
import { colors, radii, screenStyles, spacing } from '../../theme';
import {
  buildExtractionReviewSections,
  canConfirmCurrentExtraction,
  extractionBlockingRowIds,
  extractionConfirmationDestination,
  extractionConfirmationSummary,
  extractionDraftActionError,
  extractionNeedsResolution,
  extractionSourcePresentation,
  filterExtractionRows,
  labDateFromPickerValue,
  pickerValueFromLabDate,
  type ExtractionReviewFilter,
} from './extraction-ui-model';
import { ExtractionConfirmation } from './ExtractionConfirmation';
import {
  extractionDraftViewReducer,
  extractionDraftRouteNeedsLoad,
  initialExtractionDraftViewState,
} from './extraction-draft-state';

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

function valueText(row: ExtractionDraftRow, locale: string): string {
  const value = row.proposedValue;
  return value.kind === 'numeric'
    ? formatLocaleDecimal(value.value, locale)
    : value.kind === 'bounded'
      ? `${value.comparator}${formatLocaleDecimal(value.value, locale)}`
      : value.value;
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

function rowAccessibilityLabel(row: ExtractionDraftRow, locale: string): string {
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
  const source = extractionSourcePresentation(row);
  const sourceArtifact = t(source.labelKey);
  const edited = row.editState === 'user-edited' ? ` ${t('labs.extractionEditedStatus')}.` : '';
  return `${row.proposedLabel}.${sourceLabel} ${valueText(row, locale)} ${row.proposedUnit ?? ''}.${range}${flag} ${sourceArtifact}. ${t('labs.extractionSourcePage').replace('{page}', String(row.source.pageIndex + 1))}.${edited} ${state}.`;
}

export function ExtractionDraftScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DraftRoute>();
  const { reports } = useServices();
  const { fontScale } = useWindowDimensions();
  const largeType = fontScale > 1;
  const [viewState, dispatchViewState] = useReducer(
    extractionDraftViewReducer,
    initialExtractionDraftViewState,
  );
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ExtractionReviewFilter>('all');
  const [busy, setBusy] = useState(false);
  const [editingDateKey, setEditingDateKey] = useState<string | null>(null);
  const [pendingDate, setPendingDate] = useState<Date | null>(null);
  const { draft, loading, loadError, actionError } = viewState;
  const [saveError, setSaveError] = useState(false);
  const loadRequest = useRef(0);
  const loadedRouteKey = useRef<string | null>(null);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    dispatchViewState({ type: 'load-start' });
    // Initial loading and an explicit retry from the full-screen error may clear the draft. A
    // refocus refresh uses the separate path below so this mounted list stays interactive.
    setEditingDateKey(null);
    setPendingDate(null);
    setSaveError(false);
    try {
      const next = await reports.getExtractionDraft(route.params.draftId);
      if (next === null) throw new Error('Extraction Draft unavailable');
      if (request !== loadRequest.current) return;
      loadedRouteKey.current = `${route.params.reportId}:${route.params.draftId}`;
      dispatchViewState({ type: 'load-success', draft: next });
    } catch {
      if (request !== loadRequest.current) return;
      dispatchViewState({ type: 'load-failure' });
      setEditingDateKey(null);
      setPendingDate(null);
    }
  }, [reports, route.params.draftId, route.params.reportId]);

  useEffect(() => {
    // The draft screen remains mounted underneath the row editor sheet. Initial route loading is
    // the only load that clears the draft; successful local mutations update `draft` directly.
    const routeKey = `${route.params.reportId}:${route.params.draftId}`;
    if (!extractionDraftRouteNeedsLoad(loadedRouteKey.current, routeKey)) return;
    void load();
  }, [load, route.params.draftId, route.params.reportId]);

  const refresh = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const next = await reports.getExtractionDraft(route.params.draftId);
      if (next === null) throw new Error('Extraction Draft unavailable');
      if (request !== loadRequest.current) return;
      dispatchViewState({ type: 'refresh-success', draft: next });
    } catch {
      if (request !== loadRequest.current) return;
      // Keep the mounted draft interactive and report the refresh problem inline. The user can
      // retry without losing the rows or their current SectionList position.
      dispatchViewState({ type: 'refresh-failure' });
    }
  }, [reports, route.params.draftId]);

  useFocusEffect(
    useCallback(() => {
      const routeKey = `${route.params.reportId}:${route.params.draftId}`;
      // On the first focused render, the route effect above owns initial loading. Subsequent
      // focuses refresh the mounted draft in place so editor decisions reach this screen without
      // remounting its SectionList or changing its scroll offset.
      if (loadedRouteKey.current !== routeKey) return undefined;
      void refresh();
      return undefined;
    }, [refresh, route.params.draftId, route.params.reportId]),
  );

  // Prevent the native back button, sheet gesture, or system dismissal from dropping an in-flight
  // local write. Once the write settles, ordinary navigation remains unchanged.
  usePreventRemove(busy, () => undefined);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerBackVisible: !busy,
      headerSearchBarOptions: {
        placeholder: t('labs.extractionSearch'),
        hideWhenScrolling: false,
        onChangeText: (event: NativeSyntheticEvent<TextInputFocusEventData>) =>
          setSearch(event.nativeEvent.text),
        onCancelButtonPress: () => setSearch(''),
      },
    });
  }, [busy, navigation]);

  const visibleRows = useMemo(
    () => filterExtractionRows(draft?.rows ?? [], search, filter),
    [draft?.rows, filter, search],
  );
  const sections = useMemo(() => flattenSections(visibleRows), [visibleRows]);
  const confirmation = extractionConfirmationSummary(draft?.rows ?? []);
  const needsReview = confirmation.needsReview;
  const included = confirmation.included;
  const canConfirm =
    draft !== null && canConfirmCurrentExtraction(draft.rows, draft.pipelineStatus);
  const hasBottomAccessory =
    confirmation.included > 0 || confirmation.blockedReason === 'no-included-rows';
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
          dispatchViewState({ type: 'clear-action-error' });
          void reports
            // The improvement service is keyed by the Lab Report, while the current draft ID is
            // only the local review revision. Passing the draft ID makes every retry fail as if
            // the report were missing.
            .improveExtraction(route.params.reportId)
            .then((next) => {
              dispatchViewState({ type: 'mutation-success', draft: next });
            })
            .catch((error: unknown) =>
              dispatchViewState({
                type: 'action-failure',
                message: extractionDraftActionError(error),
              }),
            )
            .finally(() => setBusy(false));
        },
      },
    ]);
  }, [busy, canImprove, draft, reports, route.params.reportId]);

  const openRow = useCallback(
    (rowId: string, selectNeedsReview = false, reviewQueue?: readonly string[]) => {
      if (busy || draft === null) return;
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
          ...(reviewQueue === undefined ? {} : { reviewQueue }),
        });
    },
    [busy, draft, navigation, route.params.reportId],
  );

  const reviewRemaining = useCallback(() => {
    if (busy) return;
    const queue = extractionBlockingRowIds(draft?.rows ?? []);
    const nextBlockingRowId = queue[0];
    if (nextBlockingRowId === undefined) {
      // A draft containing only skipped rows has no Measurement to confirm. Leaving this screen
      // keeps the Original Report available and never creates an empty Lab Record.
      if (draft !== null && included === 0) navigation.popToTop();
      return;
    }
    openRow(nextBlockingRowId, true, queue);
  }, [busy, draft, included, navigation, openRow]);

  const leaveWithoutSaving = useCallback(async () => {
    if (busy || draft === null || included !== 0) return;
    setBusy(true);
    setSaveError(false);
    dispatchViewState({ type: 'clear-action-error' });
    try {
      // Discard only the extracted draft. The immutable Original Report remains the user's
      // source of truth and can be opened or imported again later.
      await reports.discardExtractionDraft(draft.id);
      navigation.popToTop();
    } catch {
      // Keep the draft mounted and the action available so a transient local-write failure is
      // recoverable without losing the source report or pretending the draft was discarded.
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  }, [busy, draft, included, navigation, reports]);

  const editGroupDate = useCallback(
    (section: ListSection, next: LabDateState) => {
      if (busy || draft === null) return;
      setBusy(true);
      setSaveError(false);
      dispatchViewState({ type: 'clear-action-error' });
      void reports
        .updateExtractionGroupDate(draft.id, section.collectionDate, section.specimenType, next)
        .then((updated) => {
          // The repository already returns the updated draft. Applying it in place avoids a
          // second full draft read, which made date changes appear blocked for several seconds.
          dispatchViewState({ type: 'mutation-success', draft: updated });
          setEditingDateKey(null);
          setPendingDate(null);
        })
        .catch((error: unknown) =>
          dispatchViewState({
            type: 'action-failure',
            message: extractionDraftActionError(error),
          }),
        )
        .finally(() => setBusy(false));
    },
    [busy, draft, reports],
  );

  const confirm = useCallback(async () => {
    if (busy || draft === null || !canConfirmCurrentExtraction(draft.rows, draft.pipelineStatus))
      return;
    setSaveError(false);
    dispatchViewState({ type: 'clear-action-error' });
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

  if (loading) {
    return (
      <ScreenStatusView
        contentContainerStyle={styles.center}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText>{t('labs.loading')}</AppText>
      </ScreenStatusView>
    );
  }
  if (draft === null) {
    return (
      <ScreenStatusView
        contentContainerStyle={styles.center}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText selectable variant="heading">
          {t('labs.extractionLoadError')}
        </AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
        <AppButton
          label={t('accessibility.back')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </ScreenStatusView>
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
            <AppText selectable variant="title" style={styles.summary}>
              {t(needsReview > 0 ? 'labs.extractionReviewSummary' : 'labs.extractionReadySummary')
                .replace('{total}', String(draft.rows.length))
                .replace('{review}', String(needsReview))}
            </AppText>
            {(draft.pipelineStatus !== 'current' ||
              draft.hasUserEdits ||
              draft.hasUnknownEdits) && (
              <View style={styles.pipelineStatus}>
                {draft.pipelineStatus !== 'current' && (
                  <StatusPill tone="reviewNeeded">{t('labs.extractionOlderStatus')}</StatusPill>
                )}
                {draft.hasUserEdits && (
                  <StatusPill subtle>{t('labs.extractionEditedStatus')}</StatusPill>
                )}
                {draft.hasUnknownEdits && (
                  <StatusPill subtle>{t('labs.extractionUnknownEditStatus')}</StatusPill>
                )}
              </View>
            )}
            {canReprocess && (
              <View style={styles.reprocessCard}>
                <AppText style={styles.muted}>{t('labs.extractionReprocessCompact')}</AppText>
                <AppButton
                  disabled={busy}
                  label={busy ? t('labs.extractionReprocessBusy') : t('labs.extractionReprocess')}
                  onPress={reprocess}
                  tone="secondary"
                />
              </View>
            )}
            {canImprove && (
              <AppButton
                disabled={busy}
                label={busy ? t('labs.extractionImproveBusy') : t('labs.extractionImprove')}
                onPress={improve}
                style={styles.improveAction}
                tone="quiet"
              />
            )}
            {loadError && (
              <View style={styles.refreshError}>
                <AppText selectable style={styles.loadError}>
                  {t('labs.extractionRefreshError')}
                </AppText>
                <AppButton
                  label={t('labs.retry')}
                  onPress={() => void (draft === null ? load() : refresh())}
                  tone="quiet"
                />
              </View>
            )}
            {actionError !== null && (
              <AppText selectable style={styles.loadError}>
                {actionError}
              </AppText>
            )}
            <View accessibilityRole="tablist" style={styles.filters}>
              <FilterButton
                active={filter === 'all'}
                disabled={busy}
                label={t('labs.extractionFilterAll').replace('{count}', String(draft.rows.length))}
                onPress={() => setFilter('all')}
              />
              <FilterButton
                active={filter === 'needs-review'}
                disabled={busy}
                label={t('labs.extractionFilterNeedsReview').replace(
                  '{count}',
                  String(needsReview),
                )}
                onPress={() => setFilter('needs-review')}
              />
            </View>
            {included === 0 && (
              <AppText selectable style={styles.muted}>
                {t('labs.extractionNoSelection')}
              </AppText>
            )}
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
              <AppSurface tone="soft" style={styles.recordCard}>
                <View style={[styles.recordHeader, largeType && styles.recordHeaderLarge]}>
                  <View style={styles.recordCopy}>
                    <AppText style={styles.muted} variant="caption">
                      {t('labs.extractionCollectionDate')}
                    </AppText>
                    <AppText selectable variant="heading">
                      {section.collectionDate.kind === 'known'
                        ? formatLocaleDate(section.collectionDate.value, locale)
                        : t('labs.recordDateMissing')}
                    </AppText>
                  </View>
                  <StatusPill tone="neutral">
                    {t(`labs.specimen.${section.specimenType}`)}
                  </StatusPill>
                </View>
                <View style={styles.dateActions}>
                  <AppButton
                    disabled={busy}
                    label={t(
                      section.collectionDate.kind === 'known'
                        ? 'labs.extractionChangeDate'
                        : 'labs.extractionChooseDate',
                    )}
                    onPress={() =>
                      setEditingDateKey((current) => {
                        if (current === section.recordKey) {
                          setPendingDate(null);
                          return null;
                        }
                        setPendingDate(pickerValueFromLabDate(section.collectionDate));
                        return section.recordKey;
                      })
                    }
                    style={styles.dateAction}
                    tone="secondary"
                  />
                  {section.collectionDate.kind === 'known' && (
                    <AppButton
                      disabled={busy}
                      label={t('labs.extractionDateUnknown')}
                      onPress={() => editGroupDate(section, { kind: 'missing' })}
                      style={styles.dateAction}
                      tone="quiet"
                    />
                  )}
                </View>
                {editingDateKey === section.recordKey && (
                  <View style={styles.datePickerSurface}>
                    <DateTimePicker
                      disabled={busy}
                      display="inline"
                      mode="date"
                      onValueChange={(_, value) => setPendingDate(value)}
                      style={styles.datePicker}
                      value={pendingDate ?? pickerValueFromLabDate(section.collectionDate)}
                    />
                    <View style={styles.datePickerActions}>
                      <AppButton
                        disabled={busy}
                        label={t('labs.cancel')}
                        onPress={() => {
                          setEditingDateKey(null);
                          setPendingDate(null);
                        }}
                        tone="quiet"
                      />
                      <AppButton
                        disabled={busy || pendingDate === null}
                        label={t('labs.extractionDateSave')}
                        onPress={() => {
                          if (pendingDate !== null) {
                            editGroupDate(section, labDateFromPickerValue(pendingDate));
                          }
                        }}
                      />
                    </View>
                  </View>
                )}
                {section.dateDefaulted && (
                  <AppText selectable style={styles.dateCallout}>
                    {t('labs.extractionDateFallbackCallout')}
                  </AppText>
                )}
                {section.collectionDate.kind === 'missing' && (
                  <AppText selectable style={styles.dateCallout}>
                    {t('labs.extractionDateMissing')}
                  </AppText>
                )}
              </AppSurface>
            )}
            {section.panelLabel !== null && (
              <AppText style={styles.panelLabel} variant="label">
                {section.panelLabel}
              </AppText>
            )}
          </View>
        )}
        renderItem={({ item: row, index, section }) => (
          <Pressable
            accessibilityLabel={rowAccessibilityLabel(row, locale)}
            accessibilityRole="button"
            disabled={busy}
            onPress={() => openRow(row.id)}
            style={({ pressed }) => [
              styles.row,
              index === 0 && styles.rowFirst,
              index === section.data.length - 1 && styles.rowLast,
              largeType && styles.rowLarge,
              pressed && styles.rowPressed,
              row.decision === 'skip' && styles.rowSkipped,
            ]}
          >
            <View style={styles.rowCopy}>
              <View style={styles.rowMeta}>
                <AppText selectable style={styles.sourcePage} variant="caption">
                  {t(extractionSourcePresentation(row).labelKey)}
                </AppText>
                <AppText selectable style={styles.sourcePage} variant="caption">
                  {t('labs.extractionSourcePage').replace(
                    '{page}',
                    String(row.source.pageIndex + 1),
                  )}
                </AppText>
                {extractionNeedsResolution(row) && (
                  <StatusPill tone="reviewNeeded">{t('labs.extractionCheck')}</StatusPill>
                )}
                {row.editState === 'user-edited' && (
                  <AppText selectable style={styles.sourcePage} variant="caption">
                    {t('labs.extractionEditedStatus')}
                  </AppText>
                )}
                {row.decision === 'skip' && (
                  <StatusPill tone="neutral">{t('labs.extractionSkipped')}</StatusPill>
                )}
              </View>
              <View style={[styles.rowTitleLine, largeType && styles.rowTitleLineLarge]}>
                <AppText
                  selectable
                  numberOfLines={largeType ? undefined : 2}
                  variant="heading"
                  style={[styles.rowTitle, largeType && styles.rowTitleLarge]}
                >
                  {row.proposedLabel || t('labs.extractionUnmapped')}
                </AppText>
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
                >{`${valueText(row, locale)}${row.proposedUnit ? ` ${row.proposedUnit}` : ''}`}</AppText>
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
        onLeaveWithoutSaving={leaveWithoutSaving}
        onReviewRemaining={reviewRemaining}
      />
    </View>
  );
}

function FilterButton({
  active,
  disabled = false,
  label,
  onPress,
}: {
  readonly active: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ disabled, selected: active }}
      disabled={disabled}
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
  center: {
    alignItems: 'center',
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  // UIKit adjusts for the native tab bar; this extra end-cap keeps the last row above the
  // iOS bottom accessory as well when the tab controller does not report its accessory height.
  contentWithAccessory: { paddingBottom: spacing.xxl + 144 },
  header: {
    alignItems: 'stretch',
    gap: spacing.sm,
    paddingBottom: spacing.lg,
    paddingTop: spacing.md,
  },
  summary: { flexShrink: 1, fontVariant: ['tabular-nums'], width: '100%' },
  pipelineStatus: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  reprocessCard: {
    backgroundColor: colors.accentSoft,
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.md,
  },
  improveAction: { alignSelf: 'flex-start' },
  refreshError: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  loadError: { color: colors.danger },
  muted: { color: colors.mutedInk },
  filters: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accentSoft,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    padding: spacing.xs,
  },
  filter: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  filterActive: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  filterActiveText: { color: colors.accent },
  filterPressed: { opacity: 0.72 },
  sectionHeader: {
    backgroundColor: colors.canvas,
    gap: spacing.sm,
    paddingBottom: spacing.sm,
    paddingTop: spacing.lg,
  },
  recordCard: { gap: spacing.md, padding: spacing.md },
  recordHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  recordHeaderLarge: { alignItems: 'flex-start', flexDirection: 'column' },
  recordCopy: { alignItems: 'flex-start', flex: 1, gap: spacing.xs, minWidth: 0 },
  dateActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  dateAction: { minHeight: 44 },
  datePickerSurface: {
    alignItems: 'center',
    backgroundColor: colors.elevatedSurface,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    overflow: 'hidden',
    padding: spacing.xs,
  },
  datePicker: { width: '100%' },
  datePickerActions: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  dateCallout: { color: colors.mutedInk },
  panelLabel: { color: colors.mutedInk, paddingTop: spacing.xs },
  row: {
    alignItems: 'center',
    backgroundColor: colors.elevatedSurface,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 72,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowFirst: {
    borderCurve: 'continuous',
    borderTopLeftRadius: radii.md,
    borderTopRightRadius: radii.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowLast: {
    borderBottomLeftRadius: radii.md,
    borderBottomRightRadius: radii.md,
    marginBottom: spacing.sm,
  },
  rowLarge: { alignItems: 'flex-start', minHeight: 96 },
  rowPressed: { backgroundColor: colors.accentSoft },
  rowSkipped: { opacity: 0.58 },
  rowCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  rowMeta: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sourcePage: { color: colors.mutedInk },
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
