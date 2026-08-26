import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import {
  useNavigation,
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
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import { extractionSourcePresentation, sourceRegionPresentation } from './extraction-ui-model';

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

export function ExtractionMeasurementEditorScreen() {
  const navigation = useNavigation<EditorNavigation>();
  const route = useRoute<EditorRoute>();
  const { reports } = useServices();
  const [row, setRow] = useState<ExtractionDraftRow | null>(null);
  const [edit, setEdit] = useState<RowEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [allowRemove, setAllowRemove] = useState(false);
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

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <AppButton label={t('labs.done')} onPress={() => navigation.goBack()} tone="quiet" />
      ),
    });
  }, [navigation]);

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
      requestAnimationFrame(() => navigation.goBack());
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function viewInReport() {
    const saved = dirty ? await save() : row;
    if (saved === null) return;
    const target = sourceRegionPresentation(saved);
    if (saved.source.artifact?.kind === 'original') {
      navigation.push('OriginalSourcePreview', {
        reportId: route.params.reportId,
        pageIndex: target.pageIndex,
      });
      return;
    }
    if (saved.source.artifact?.kind === 'sanitized') {
      navigation.push('SanitizedSourcePreview', {
        reportId: route.params.reportId,
        pageIndex: target.pageIndex,
        boundingBox: target.boundingBox,
      });
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
    return <AppText style={styles.loading}>{t('labs.loading')}</AppText>;

  const included = row.decision !== 'skip';
  const sourcePresentation = extractionSourcePresentation(row);
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={styles.content}
      key={`${route.key}-${row.id}`}
      keyboardShouldPersistTaps="handled"
      style={[styles.safe, styles.scroll]}
    >
      {error && (
        <AppText selectable style={styles.error}>
          {t('labs.extractionSaveError')}
        </AppText>
      )}
      <AppSurface tone="soft" style={styles.sourceCard}>
        <View style={styles.sourceHeader}>
          <AppText variant="label">{t(sourcePresentation.labelKey)}</AppText>
          <StatusPill tone="extracted">{t('labs.extracted')}</StatusPill>
        </View>
        <AppText selectable>{row.sourceText}</AppText>
        <AppText selectable style={styles.muted}>
          {t(sourcePresentation.regionKey).replace('{page}', String(row.source.pageIndex + 1))}
        </AppText>
        <AppButton
          disabled={sourcePresentation.artifactKind === 'unavailable'}
          label={t('labs.extractionViewInReport')}
          onPress={viewInReport}
          tone="quiet"
        />
      </AppSurface>

      <View style={styles.recordContext}>
        <AppText variant="label">{t('labs.extractionLabRecord')}</AppText>
        <AppText selectable style={styles.muted}>
          {`${row.collectionDate.kind === 'known' ? row.collectionDate.value : t('labs.recordDateMissing')} · ${t(`labs.specimen.${row.proposedSpecimenType}`)}`}
        </AppText>
      </View>

      {row.reviewReasons.length > 0 && (
        <AppSurface tone="soft" style={styles.reasons}>
          <StatusPill tone="reviewNeeded">{t('labs.extractionNeedsReview')}</StatusPill>
          <AppText selectable style={styles.muted}>
            {row.reviewReasons.map((reason) => t(`labs.extractionReason.${reason}`)).join(' · ')}
          </AppText>
        </AppSurface>
      )}

      <View style={styles.form}>
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
        <AppButton
          disabled={busy || !dirty}
          label={t('labs.extractionSaveRow')}
          onPress={() => void save()}
          tone="secondary"
        />
      </View>
      <View style={styles.footer}>
        <AppButton
          disabled={busy}
          label={included ? t('labs.extractionKeep') : t('labs.extractionInclude')}
          labelMaxFontSizeMultiplier={1.3}
          onPress={() => void choose(row.reviewState === 'ready' ? 'resolve' : 'preserve')}
          tone={included ? 'primary' : 'secondary'}
          style={styles.action}
        />
        <AppButton
          disabled={busy}
          label={t('labs.extractionSkip')}
          labelMaxFontSizeMultiplier={1.3}
          onPress={() => void choose('skip')}
          tone={included ? 'secondary' : 'primary'}
          style={styles.action}
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
  safe: { backgroundColor: colors.canvas, flex: 1 },
  scroll: { flex: 1 },
  loading: { padding: spacing.lg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  content: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.lg },
  sourceCard: { gap: spacing.sm },
  sourceHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  recordContext: { gap: spacing.xs },
  reasons: { gap: spacing.sm },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
  form: { gap: spacing.md },
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
  footer: {
    backgroundColor: colors.elevatedSurface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    paddingBottom: spacing.lg,
  },
  action: { flex: 1 },
});
