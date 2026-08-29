import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
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
  parseComparatorValue,
  type ExtractionDraftRow,
} from '@alyte/domain';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppIcon, AppText, StatusPill } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import {
  extractionSourcePresentation,
  extractionSourcePreviewRequestAllowed,
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

function valueText(row: ExtractionDraftRow): string {
  const value = row.proposedValue;
  return value.kind === 'numeric'
    ? String(value.value)
    : value.kind === 'bounded'
      ? `${value.comparator}${value.value}`
      : value.value;
}

function editFrom(row: ExtractionDraftRow): RowEdit {
  return {
    label: row.proposedLabel,
    value: valueText(row),
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
  const navigation = useNavigation<EditorNavigation>();
  const route = useRoute<EditorRoute>();
  const { reports } = useServices();
  const [row, setRow] = useState<ExtractionDraftRow | null>(null);
  const [edit, setEdit] = useState<RowEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [allowRemove, setAllowRemove] = useState(false);
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const previewRequestPending = useRef(false);
  const [previewOpening, setPreviewOpening] = useState(false);
  const included = row?.decision !== 'skip';
  const initialEdit = useMemo(() => (row === null ? null : editFrom(row)), [row]);
  const dirty =
    edit !== null && initialEdit !== null && JSON.stringify(edit) !== JSON.stringify(initialEdit);

  async function load() {
    setBusy(true);
    try {
      const draft = await reports.getExtractionDraft(route.params.draftId);
      const next = draft?.rows.find((candidate) => candidate.id === route.params.rowId) ?? null;
      if (next === null) throw new Error('Extraction row unavailable');
      setRow(next);
      setEdit(editFrom(next));
      setSecondaryExpanded(secondaryFieldsNeedReview(next));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [route.params.draftId, route.params.rowId]);

  useFocusEffect(
    useCallback(() => {
      previewRequestPending.current = false;
      setPreviewOpening(false);
    }, []),
  );

  usePreventRemove(dirty && !allowRemove, ({ data }) => {
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
    navigation.goBack();
  }, [navigation]);

  useLayoutEffect(() => {
    // Keep the sheet's native header action, while leaving the entire body—including decisions—
    // inside the one supported, keyboard-aware ScrollView below.
    navigation.setOptions({
      headerLeft: () => <AppButton label={t('labs.done')} onPress={closeEditor} tone="quiet" />,
    });
  }, [closeEditor, navigation]);

  async function save(): Promise<ExtractionDraftRow | null> {
    if (row === null || edit === null) return null;
    const value = parseComparatorValue(edit.value);
    if (value === null || !edit.label.trim()) {
      Alert.alert(t('labs.extractionEditErrorTitle'), t('labs.extractionRequiredFieldsError'));
      return null;
    }
    setBusy(true);
    try {
      const updated = await reports.updateExtractionRow(row.id, {
        proposedLabel: edit.label.trim(),
        proposedValue: value,
        proposedUnit: edit.unit.trim() || null,
        proposedReferenceInterval: edit.reference.trim() || null,
      });
      setRow(updated);
      setEdit(editFrom(updated));
      setError(false);
      return updated;
    } catch {
      setError(true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function choose(decision: 'preserve' | 'resolve' | 'skip') {
    const saved = decision !== 'skip' && dirty ? await save() : row;
    if (saved === null) return;
    if (decision !== 'skip' && extractionReviewRequiresAttention(saved)) {
      Alert.alert(t('labs.extractionEditErrorTitle'), t('labs.extractionRequiredFieldsError'));
      return;
    }
    setBusy(true);
    try {
      await reports.updateExtractionRow(saved.id, { decision });
      setAllowRemove(true);
      requestAnimationFrame(closeEditor);
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
      <View style={styles.center}>
        <AppText selectable>{t('labs.extractionLoadError')}</AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
      </View>
    );
  }
  if (row === null || edit === null)
    return (
      <View style={styles.center}>
        <AppText>{t('labs.loading')}</AppText>
      </View>
    );

  const sourcePresentation = extractionSourcePresentation(row);
  const attentionReasons = row.reviewReasons.filter(
    (reason) => reason !== 'defaulted-collection-date',
  );
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

      <View style={styles.introduction}>
        <AppText selectable style={styles.muted}>
          {t('labs.extractionEditorSubtitle')}
        </AppText>
        {extractionReviewRequiresAttention(row) && attentionReasons.length > 0 && (
          <View style={styles.reviewSummary}>
            <StatusPill tone="reviewNeeded">{t('labs.extractionNeedsReview')}</StatusPill>
            <AppText selectable style={styles.muted}>
              {attentionReasons.map((reason) => t(`labs.extractionReason.${reason}`)).join(' · ')}
            </AppText>
          </View>
        )}
      </View>

      <View style={styles.form}>
        <AppText variant="label">{t('labs.extractionPrimaryFields')}</AppText>
        <View style={styles.fieldGroup}>
          <Field
            label={t('labs.measurementLabel')}
            value={edit.label}
            onChangeText={(label) => setEdit({ ...edit, label })}
          />
          <Field
            keyboardType="numeric"
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
            <Field
              label={t('labs.measurementUnit')}
              value={edit.unit}
              onChangeText={(unit) => setEdit({ ...edit, unit })}
            />
            <Field
              label={t('labs.measurementReference')}
              value={edit.reference}
              onChangeText={(reference) => setEdit({ ...edit, reference })}
            />
          </View>
        )}
      </View>

      <View style={styles.provenance}>
        <View style={styles.provenanceCopy}>
          <View style={styles.provenanceTitle}>
            <AppText variant="label">{t(sourcePresentation.labelKey)}</AppText>
            <StatusPill tone="extracted">{t('labs.extracted')}</StatusPill>
          </View>
          <AppText numberOfLines={2} selectable style={styles.muted}>
            {`${row.sourceText} · ${t(sourcePresentation.regionKey).replace('{page}', String(row.source.pageIndex + 1))}`}
          </AppText>
        </View>
        <AppButton
          disabled={sourcePresentation.artifactKind === 'unavailable' || busy || previewOpening}
          label={t('labs.extractionViewInReport')}
          onPress={viewInReport}
          tone="quiet"
        />
      </View>

      <View style={styles.actions}>
        <AppButton
          disabled={busy}
          label={included ? t('labs.extractionKeep') : t('labs.extractionInclude')}
          labelMaxFontSizeMultiplier={1.3}
          onPress={() => void choose(row.reviewState === 'ready' ? 'resolve' : 'preserve')}
          style={styles.primaryAction}
        />
        <AppButton
          disabled={busy}
          label={t('labs.extractionSkip')}
          labelMaxFontSizeMultiplier={1.3}
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
  keyboardType = 'default',
}: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly keyboardType?: 'default' | 'numeric';
}) {
  return (
    <View style={styles.field}>
      <AppText style={styles.fieldLabel}>{label}</AppText>
      <TextInput
        accessibilityLabel={label}
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
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  content: {
    flexGrow: 1,
    gap: spacing.lg,
    padding: spacing.lg,
    paddingBottom: spacing.xxl + spacing.lg,
  },
  introduction: { gap: spacing.sm },
  reviewSummary: { gap: spacing.xs },
  provenance: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingTop: spacing.md,
  },
  provenanceCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  provenanceTitle: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
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
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.ink,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actions: { gap: spacing.sm, paddingTop: spacing.xs },
  primaryAction: { width: '100%' },
  skipAction: { alignSelf: 'center' },
});
