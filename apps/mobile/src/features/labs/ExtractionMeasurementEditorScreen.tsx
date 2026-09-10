import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type TextInputProps,
} from 'react-native';
import {
  useNavigation,
  useFocusEffect,
  usePreventRemove,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  extractionReviewRequiresAttention,
  formatLocaleDecimal,
  parseComparatorValue,
  type ExtractionDraftRow,
} from '@alyte/domain';
import type { RootStackParamList } from '../../navigation/types';
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
  extractionDecisionRequiresSubmission,
  extractionSourcePresentation,
  extractionSourcePreviewRequestAllowed,
  extractionUnitOptions,
  nextExtractionBlockingRowId,
  sourceRegionPresentation,
} from './extraction-ui-model';

type EditorRoute = RouteProp<RootStackParamList, 'ExtractionMeasurementEditor'>;
type EditorNavigation = NativeStackNavigationProp<
  RootStackParamList,
  'ExtractionMeasurementEditor'
>;

type RowEdit = {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly reference: string;
};

function valueText(row: ExtractionDraftRow, locale: string): string {
  const value = row.proposedValue;
  return value.kind === 'numeric'
    ? formatLocaleDecimal(value.value, locale)
    : value.kind === 'bounded'
      ? `${value.comparator}${formatLocaleDecimal(value.value, locale)}`
      : value.value;
}

function editFrom(row: ExtractionDraftRow, locale: string): RowEdit {
  return {
    label: row.proposedLabel,
    value: valueText(row, locale),
    unit: row.proposedUnit ?? '',
    reference: row.proposedReferenceInterval ?? '',
  };
}

function secondaryFieldsNeedReview(row: Pick<ExtractionDraftRow, 'reviewReasons'>): boolean {
  return row.reviewReasons.some(
    (reason) =>
      reason === 'missing-unit' ||
      reason === 'incompatible-unit' ||
      reason === 'unparseable-reference-interval',
  );
}

export function ExtractionMeasurementEditorScreen() {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= 1.4;
  const navigation = useNavigation<EditorNavigation>();
  const route = useRoute<EditorRoute>();
  const { reports } = useServices();
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const [row, setRow] = useState<ExtractionDraftRow | null>(null);
  const [edit, setEdit] = useState<RowEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [allowRemove, setAllowRemove] = useState(false);
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const [customUnit, setCustomUnit] = useState(false);
  const previewRequestPending = useRef(false);
  const loadRequest = useRef(0);
  const [previewOpening, setPreviewOpening] = useState(false);
  const included = row?.decision !== 'skip';
  const initialEdit = useMemo(() => (row === null ? null : editFrom(row, locale)), [locale, row]);
  const dirty =
    edit !== null && initialEdit !== null && JSON.stringify(edit) !== JSON.stringify(initialEdit);

  async function load(rowId = route.params.rowId) {
    const request = ++loadRequest.current;
    setBusy(true);
    setError(false);
    // Clear the previous row before reloading. A missing or unreadable draft must not leave an
    // old health result mounted and writable while the unavailable state is being resolved.
    setRow(null);
    setEdit(null);
    setSecondaryExpanded(false);
    setCustomUnit(false);
    setAllowRemove(true);
    try {
      const draft = await reports.getExtractionDraft(route.params.draftId);
      const next = draft?.rows.find((candidate) => candidate.id === rowId) ?? null;
      if (next === null) throw new Error('Extraction row unavailable');
      if (request !== loadRequest.current) return;
      setRow(next);
      setEdit(editFrom(next, locale));
      setSecondaryExpanded(secondaryFieldsNeedReview(next));
      setCustomUnit(false);
      setAllowRemove(false);
      setError(false);
    } catch {
      if (request !== loadRequest.current) return;
      setRow(null);
      setEdit(null);
      setSecondaryExpanded(false);
      setCustomUnit(false);
      setError(true);
    } finally {
      if (request === loadRequest.current) setBusy(false);
    }
  }

  useEffect(() => {
    void load(route.params.rowId);
  }, [route.params.draftId, route.params.rowId]);

  useFocusEffect(
    useCallback(() => {
      previewRequestPending.current = false;
      setPreviewOpening(false);
    }, []),
  );

  usePreventRemove(busy || (dirty && !allowRemove), ({ data }) => {
    // A native sheet can attempt to dismiss while a correction is being persisted. Keep the
    // draft mounted until that write finishes; the visible Cancel action is disabled below too.
    if (busy) return;
    Alert.alert(t('labs.extractionDiscardTitle'), t('labs.extractionDiscardBody'), [
      { text: t('labs.cancel'), style: 'cancel' },
      {
        text: t('labs.extractionDiscard'),
        style: 'destructive',
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });

  const closeEditor = useCallback(() => {
    // The editor is mounted directly in the root form sheet. Its native navigation object owns
    // both the sheet dismissal and source-preview pushes, so no nested stack parent is needed.
    if (busy) return;
    navigation.goBack();
  }, [busy, navigation]);

  useLayoutEffect(() => {
    // Keep the sheet's native header action, while leaving the entire body—including decisions—
    // inside the one supported, keyboard-aware ScrollView below.
    navigation.setOptions({
      headerLeft: () => (
        <AppButton
          disabled={busy}
          label={t('labs.recordCancel')}
          labelMaxFontSizeMultiplier={1.5}
          onPress={closeEditor}
          tone="quiet"
        />
      ),
      title:
        route.params.reviewQueue === undefined
          ? t('labs.extractionEditorTitle')
          : t('labs.extractionReviewPosition')
              .replace(
                '{current}',
                String(Math.max(1, route.params.reviewQueue.indexOf(route.params.rowId) + 1)),
              )
              .replace('{total}', String(route.params.reviewQueue.length)),
    });
  }, [busy, closeEditor, navigation, route.params.reviewQueue, route.params.rowId]);

  async function save(): Promise<ExtractionDraftRow | null> {
    if (row === null || edit === null) return null;
    const value = parseComparatorValue(edit.value);
    if (value === null || !edit.label.trim()) {
      Alert.alert(t('labs.extractionEditErrorTitle'), t('labs.extractionRequiredFieldsError'));
      return null;
    }
    setBusy(true);
    try {
      const updated = await reports.updateExtractionRow(
        row.id,
        {
          proposedLabel: edit.label.trim(),
          proposedValue: value,
          proposedUnit: edit.unit.trim() || null,
          proposedReferenceInterval: edit.reference.trim() || null,
        },
        { submission: 'correction-form' },
      );
      setRow(updated);
      setEdit(editFrom(updated, locale));
      setError(false);
      return updated;
    } catch {
      setError(true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function choose(decision: 'preserve' | 'resolve' | 'skip', discardDirtyEdits = false) {
    if (row === null) return;
    if (decision === 'skip' && dirty && !discardDirtyEdits) {
      Alert.alert(t('labs.extractionSkipEditedTitle'), t('labs.extractionSkipEditedBody'), [
        { text: t('labs.extractionSkipEditedCancel'), style: 'cancel' },
        {
          text: t('labs.extractionSkipEditedConfirm'),
          style: 'destructive',
          onPress: () => void choose('skip', true),
        },
      ]);
      return;
    }
    const saved = extractionDecisionRequiresSubmission(row, decision, dirty) ? await save() : row;
    if (saved === null) return;
    if (decision !== 'skip' && extractionReviewRequiresAttention(saved)) {
      Alert.alert(t('labs.extractionEditErrorTitle'), t('labs.extractionRequiredFieldsError'));
      return;
    }
    setBusy(true);
    try {
      await reports.updateExtractionRow(saved.id, { decision });
      const queue = route.params.reviewQueue;
      if (queue !== undefined) {
        const draft = await reports.getExtractionDraft(route.params.draftId);
        const nextId =
          draft === null ? null : nextExtractionBlockingRowId(draft.rows, queue, saved.id);
        const next = draft?.rows.find((candidate) => candidate.id === nextId) ?? null;
        if (next !== null) {
          navigation.setParams({ rowId: next.id, reviewQueue: queue });
          setRow(next);
          setEdit(editFrom(next, locale));
          setSecondaryExpanded(secondaryFieldsNeedReview(next));
          setCustomUnit(false);
          setError(false);
          return;
        }
      }
      setAllowRemove(true);
      // Let the completed decision dismiss the sheet after React has applied the removal guard.
      // This stays separate from the user-facing Cancel action, which remains disabled while busy.
      requestAnimationFrame(() => navigation.goBack());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function viewInReport() {
    if (row === null) return;
    const sourcePresentation = extractionSourcePresentation(row);
    if (
      !extractionSourcePreviewRequestAllowed({
        pending: previewRequestPending.current,
        busy,
        artifactKind: sourcePresentation.artifactKind,
      })
    )
      return;

    // Preview uses persisted provenance. Keep the mounted editor's local edit buffer and decision
    // untouched so an incomplete correction can return exactly as it was entered.
    const target = sourceRegionPresentation(row);
    previewRequestPending.current = true;
    setPreviewOpening(true);
    try {
      if (row.source.artifact?.kind === 'original') {
        navigation.push('OriginalSourcePreview', {
          reportId: route.params.reportId,
          pageIndex: target.pageIndex,
          boundingBox: target.boundingBox,
        });
        return;
      }
      if (row.source.artifact?.kind === 'sanitized') {
        navigation.push('SanitizedSourcePreview', {
          reportId: route.params.reportId,
          pageIndex: target.pageIndex,
          boundingBox: target.boundingBox,
        });
      }
    } catch {
      previewRequestPending.current = false;
      setPreviewOpening(false);
      setError(true);
    }
  }

  if (error && row === null) {
    return (
      <ScreenStatusView contentContainerStyle={styles.center} style={screenStyles.scroll}>
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
  if (row === null || edit === null)
    return (
      <ScreenStatusView contentContainerStyle={styles.center} style={screenStyles.scroll}>
        <AppText>{t('labs.loading')}</AppText>
      </ScreenStatusView>
    );

  const sourcePresentation = extractionSourcePresentation(row);
  const activeEdit = edit;
  const unitOptions = extractionUnitOptions(row);
  const suggestedUnits = unitOptions.suggested;
  const commonUnits = unitOptions.common;

  function applyUnit(unit: string) {
    setCustomUnit(false);
    setEdit({ ...activeEdit, unit });
  }

  function chooseCommonUnit() {
    const cancelIndex = commonUnits.length;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        cancelButtonIndex: cancelIndex,
        options: [...commonUnits, t('labs.cancel')],
        title: t('labs.extractionCommonUnits'),
        ...(activeEdit.unit && commonUnits.includes(activeEdit.unit)
          ? { selectedButtonIndex: commonUnits.indexOf(activeEdit.unit) }
          : {}),
      },
      (index) => {
        const unit = commonUnits[index];
        if (unit !== undefined) applyUnit(unit);
      },
    );
  }

  function chooseUnit() {
    const commonIndex = suggestedUnits.length;
    const customIndex = commonIndex + 1;
    const noUnitIndex = customIndex + 1;
    const cancelIndex = noUnitIndex + 1;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        cancelButtonIndex: cancelIndex,
        options: [
          ...suggestedUnits,
          t('labs.extractionCommonUnits'),
          t('labs.extractionCustomUnit'),
          t('labs.extractionNoUnit'),
          t('labs.cancel'),
        ],
        title: t('labs.extractionChooseUnit'),
        ...(activeEdit.unit && suggestedUnits.includes(activeEdit.unit)
          ? { selectedButtonIndex: suggestedUnits.indexOf(activeEdit.unit) }
          : {}),
      },
      (index) => {
        const suggested = suggestedUnits[index];
        if (suggested !== undefined) applyUnit(suggested);
        else if (index === commonIndex) chooseCommonUnit();
        else if (index === customIndex) {
          setCustomUnit(true);
          setEdit({ ...activeEdit, unit: '' });
        } else if (index === noUnitIndex) {
          setCustomUnit(false);
          setEdit({ ...activeEdit, unit: '' });
        }
      },
    );
  }
  return (
    <ScrollView
      automaticallyAdjustContentInsets
      automaticallyAdjustKeyboardInsets
      automaticallyAdjustsScrollIndicatorInsets
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      key={`${route.key}-${row.id}`}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      style={styles.scroll}
    >
      {error && (
        <AppText selectable style={styles.error}>
          {t('labs.extractionSaveError')}
        </AppText>
      )}

      <AppSurface tone="soft" style={styles.sourceCard}>
        <View style={[styles.sourceHeader, usesAccessibleLayout && styles.sourceHeaderAccessible]}>
          <View style={styles.provenanceCopy}>
            <View style={styles.provenanceTitle}>
              <AppText variant="label">{t(sourcePresentation.labelKey)}</AppText>
              <StatusPill tone="extracted">{t('labs.extracted')}</StatusPill>
            </View>
            <AppText selectable style={styles.sourcePage} variant="heading">
              {t('labs.extractionSourcePage').replace('{page}', String(row.source.pageIndex + 1))}
            </AppText>
          </View>
          <AppButton
            disabled={sourcePresentation.artifactKind === 'unavailable' || busy || previewOpening}
            label={t('labs.extractionViewInReport')}
            onPress={viewInReport}
            style={usesAccessibleLayout ? styles.sourceActionAccessible : undefined}
            tone="quiet"
          />
        </View>
        <AppText
          selectable
          numberOfLines={usesAccessibleLayout ? undefined : 4}
          style={styles.sourceExcerpt}
        >
          {row.sourceText}
        </AppText>
      </AppSurface>

      <View style={styles.form}>
        <AppText variant="label">{t('labs.extractionPrimaryFields')}</AppText>
        <View style={styles.fieldGroup}>
          <Field
            label={t('labs.measurementLabel')}
            value={edit.label}
            onChangeText={(label) => setEdit({ ...edit, label })}
          />
          <Field
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={row.proposedValue.kind === 'numeric' ? 'decimal-pad' : 'default'}
            label={t('labs.measurementValue')}
            value={edit.value}
            onChangeText={(value) => setEdit({ ...edit, value })}
          />
        </View>
        <Pressable
          accessibilityLabel={t(
            secondaryExpanded
              ? 'labs.extractionHideSecondaryFields'
              : 'labs.extractionShowSecondaryFields',
          )}
          accessibilityRole="button"
          accessibilityState={{ expanded: secondaryExpanded }}
          hitSlop={4}
          onPress={() => setSecondaryExpanded((expanded) => !expanded)}
          style={({ pressed }) => [styles.disclosure, pressed && styles.disclosurePressed]}
        >
          <View style={styles.disclosureCopy}>
            <AppText variant="label">{t('labs.extractionSecondaryFields')}</AppText>
            <AppText variant="caption" style={styles.muted}>
              {t(
                secondaryExpanded
                  ? 'labs.extractionHideSecondaryFields'
                  : secondaryFieldsNeedReview(row)
                    ? 'labs.extractionSecondaryFieldsNeedsReview'
                    : 'labs.extractionSecondaryFieldsOptional',
              )}
            </AppText>
          </View>
          <AppIcon
            name="chevronRight"
            size={16}
            color={colors.mutedInk}
            style={{ transform: [{ rotate: secondaryExpanded ? '90deg' : '0deg' }] }}
          />
        </Pressable>
        {secondaryExpanded && (
          <View style={styles.fieldGroup}>
            <View style={styles.field}>
              <AppText style={styles.fieldLabel}>{t('labs.measurementUnit')}</AppText>
              <Pressable
                accessibilityLabel={`${t('labs.measurementUnit')}: ${edit.unit || t('labs.extractionChooseUnit')}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={chooseUnit}
                style={({ pressed }) => [styles.unitPicker, pressed && styles.disclosurePressed]}
              >
                <AppText style={edit.unit ? undefined : styles.muted}>
                  {edit.unit || t('labs.extractionChooseUnit')}
                </AppText>
                <AppIcon color={colors.mutedInk} name="chevronRight" size={16} />
              </Pressable>
              {customUnit && (
                <Field
                  autoCapitalize="none"
                  autoCorrect={false}
                  label={t('labs.extractionCustomUnit')}
                  value={edit.unit}
                  onChangeText={(unit) => setEdit({ ...edit, unit })}
                />
              )}
            </View>
            <Field
              autoCapitalize="none"
              autoCorrect={false}
              label={t('labs.measurementReference')}
              value={edit.reference}
              onChangeText={(reference) => setEdit({ ...edit, reference })}
            />
          </View>
        )}
      </View>

      <View style={styles.actions}>
        <AppButton
          disabled={busy}
          label={
            route.params.reviewQueue === undefined
              ? t(included ? 'labs.extractionKeep' : 'labs.extractionInclude')
              : route.params.reviewQueue.indexOf(row.id) < route.params.reviewQueue.length - 1
                ? t('labs.extractionKeepAndContinue')
                : t('labs.extractionKeepAndFinish')
          }
          onPress={() => void choose(row.reviewState === 'ready' ? 'resolve' : 'preserve')}
          style={styles.primaryAction}
        />
        <AppButton
          disabled={busy}
          label={
            route.params.reviewQueue === undefined
              ? t('labs.extractionSkip')
              : route.params.reviewQueue.indexOf(row.id) < route.params.reviewQueue.length - 1
                ? t('labs.extractionSkipAndContinue')
                : t('labs.extractionSkipAndFinish')
          }
          onPress={() => void choose('skip')}
          style={styles.skipAction}
          tone="quiet"
        />
      </View>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChangeText,
  autoCapitalize = 'sentences',
  autoCorrect = true,
  keyboardType = 'default',
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly autoCapitalize?: TextInputProps['autoCapitalize'];
  readonly autoCorrect?: boolean;
  readonly keyboardType?: TextInputProps['keyboardType'];
}) {
  return (
    <View style={styles.field}>
      <AppText style={styles.fieldLabel}>{label}</AppText>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        style={styles.input}
        value={value}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  content: {
    flexGrow: 1,
    gap: spacing.md,
    padding: spacing.lg,
    paddingBottom: spacing.xxl + spacing.lg,
  },
  sourceCard: { gap: spacing.sm, padding: spacing.md },
  sourceHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  sourceHeaderAccessible: { alignItems: 'stretch', flexDirection: 'column' },
  sourceActionAccessible: { width: '100%' },
  provenanceCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  provenanceTitle: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  sourcePage: { color: colors.ink },
  sourceExcerpt: { color: colors.mutedInk, lineHeight: 21 },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
  form: { gap: spacing.md },
  fieldGroup: { gap: spacing.md },
  disclosure: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 56,
    paddingVertical: spacing.sm,
  },
  disclosureCopy: { flex: 1, gap: spacing.xs },
  disclosurePressed: { opacity: 0.55 },
  field: { gap: spacing.xs },
  fieldLabel: { color: colors.mutedInk },
  input: {
    backgroundColor: colors.elevatedSurface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.ink,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  unitPicker: {
    alignItems: 'center',
    backgroundColor: colors.elevatedSurface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actions: { gap: spacing.sm, paddingTop: spacing.xs },
  primaryAction: { width: '100%' },
  skipAction: { alignSelf: 'center' },
});
