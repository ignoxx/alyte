import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  parseComparatorValue,
  parseLabDate,
  type ExtractionDraft,
  type ExtractionDraftRow,
  type LabDateState,
} from '@alyte/domain';
import type { LabReportPreview } from './report-service';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppIcon, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import { canConfirmExtraction, extractionDecisionPresentation } from './extraction-ui-model';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type DraftRoute = RouteProp<LabsStackParamList, 'ExtractionDraft'>;

type RowEdit = {
  readonly label: string;
  readonly value: string;
  readonly unit: string;
  readonly reference: string;
  readonly date: string;
};

function valueText(row: ExtractionDraftRow): string {
  const value = row.proposedValue;
  return value.kind === 'numeric'
    ? String(value.value)
    : value.kind === 'bounded'
      ? `${value.comparator}${value.value}`
      : value.value;
}

function dateText(date: LabDateState): string {
  return date.kind === 'known' ? date.value : '';
}

function editFrom(row: ExtractionDraftRow): RowEdit {
  return {
    label: row.proposedLabel,
    value: valueText(row),
    unit: row.proposedUnit ?? '',
    reference: row.proposedReferenceInterval ?? '',
    date: dateText(row.collectionDate),
  };
}

function decisionLabel(row: ExtractionDraftRow): string {
  switch (extractionDecisionPresentation(row.decision).label) {
    case 'kept':
      return t('labs.extractionKept');
    case 'skipped':
      return t('labs.extractionSkipped');
    case 'resolved':
      return t('labs.extractionResolved');
    case 'needs-decision':
      return t('labs.extractionDecisionPending');
  }
}

function rowAccessibilityLabel(row: ExtractionDraftRow): string {
  const source = row.sourceText || row.sourceLabel || t('labs.extractionUnmapped');
  const proposed = row.proposedLabel || t('labs.extractionUnmapped');
  const value = `${valueText(row)}${row.proposedUnit === null ? '' : ` ${row.proposedUnit}`}`;
  const date = dateText(row.collectionDate) || t('labs.recordDateMissing');
  const review =
    row.reviewState === 'needs-review'
      ? t('labs.extractionNeedsReview')
      : t('labs.extractionReady');
  const reasons =
    row.reviewReasons.length === 0
      ? ''
      : ` ${row.reviewReasons.map((reason) => t(`labs.extractionReason.${reason}`)).join(', ')}`;
  return [
    `${t('labs.extractionRow')} ${row.order + 1}`,
    `${t('labs.extractionSource')}: ${source}`,
    `${t('labs.extractionProposedValues')}: ${proposed}, ${value}`,
    `${t('labs.recordDateLabel')}: ${date}`,
    `${t('labs.extractionDecision')}: ${decisionLabel(row)}`,
    `${review}${reasons}`,
  ].join('. ');
}

export function ExtractionDraftScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DraftRoute>();
  const { reports } = useServices();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const usesAccessibilityTextSize = fontScale >= 1.3;
  const [draft, setDraft] = useState<ExtractionDraft | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [sourcePreview, setSourcePreview] = useState<{
    readonly preview: LabReportPreview;
    readonly row: ExtractionDraftRow;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await reports.getExtractionDraft(route.params.draftId);
      setDraft(next);
      if (next !== null) {
        setEdits(Object.fromEntries(next.rows.map((row) => [row.id, editFrom(row)])));
      }
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

  async function saveRow(row: ExtractionDraftRow): Promise<boolean> {
    const edit = edits[row.id];
    if (edit === undefined) return false;
    const parsed = parseComparatorValue(edit.value);
    const date = edit.date.trim() ? parseLabDate(edit.date, locale) : { kind: 'missing' as const };
    if (parsed === null) {
      Alert.alert(t('labs.extractionEditErrorTitle'), t('labs.extractionEditValueError'));
      return false;
    }
    if (edit.date.trim() && date === null) {
      Alert.alert(t('labs.extractionEditErrorTitle'), t('labs.invalidDate'));
      return false;
    }
    setBusy(true);
    try {
      const updated = await reports.updateExtractionRow(row.id, {
        proposedLabel: edit.label.trim(),
        proposedValue: parsed,
        proposedUnit: edit.unit.trim() || null,
        proposedReferenceInterval: edit.reference.trim() || null,
        collectionDate: date as LabDateState,
      });
      setDraft((current) =>
        current === null
          ? current
          : {
              ...current,
              rows: current.rows.map((candidate) =>
                candidate.id === row.id ? updated : candidate,
              ),
            },
      );
      setError(false);
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function decide(
    row: ExtractionDraftRow,
    decision: 'preserve' | 'skip' | 'resolve',
  ): Promise<void> {
    setBusy(true);
    try {
      const updated = await reports.updateExtractionRow(row.id, { decision });
      setDraft((current) =>
        current === null
          ? current
          : {
              ...current,
              rows: current.rows.map((candidate) =>
                candidate.id === row.id ? updated : candidate,
              ),
            },
      );
      setSelectedRowId(null);
      setSourcePreview(null);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function openSource(row: ExtractionDraftRow) {
    setBusy(true);
    try {
      const preview = await reports.previewOriginal(route.params.reportId);
      if (preview.uris[row.source.pageIndex] === undefined) throw new Error('Source page missing');
      setSourcePreview({ preview, row });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (draft === null || !canConfirmExtraction(draft.rows)) return;
    setBusy(true);
    try {
      const records = await reports.confirmExtraction(draft.id);
      const first = records[0];
      if (first === undefined) throw new Error('No Lab Record was created');
      navigation.replace('LabRecordDetail', { recordId: first.id });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <AppText>{t('labs.loading')}</AppText>;
  if (error || draft === null) {
    return (
      <View style={styles.center}>
        <AppText>{t('labs.extractionLoadError')}</AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
      </View>
    );
  }

  const unresolved = draft.rows.filter((row) => row.decision === 'unresolved').length;
  const resolved = draft.rows.length - unresolved;
  const canConfirm = canConfirmExtraction(draft.rows);
  const selectedRow = draft.rows.find((row) => row.id === selectedRowId) ?? null;
  const selectedEdit =
    selectedRow === null ? null : (edits[selectedRow.id] ?? editFrom(selectedRow));

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.safe}>
      <FlatList
        contentContainerStyle={styles.queueContent}
        contentInsetAdjustmentBehavior="automatic"
        data={draft.rows}
        keyExtractor={(row) => row.id}
        ListHeaderComponent={
          <View style={styles.queueHeader}>
            <AppText style={styles.intro}>{t('labs.extractionIntro')}</AppText>
            <AppSurface tone="soft" style={styles.notice}>
              <AppText>{t('labs.extractionSourceNotice')}</AppText>
              {draft.collectionDate.kind === 'missing' && (
                <AppText style={styles.warning}>{t('labs.extractionDateMissing')}</AppText>
              )}
              <AppText style={styles.muted}>
                {t('labs.extractionReviewCount').replace(
                  '{count}',
                  String(draft.rows.filter((row) => row.reviewState === 'needs-review').length),
                )}
              </AppText>
            </AppSurface>
            <AppText variant="label" style={styles.queueLabel}>
              {t('labs.extractionQueue')}
            </AppText>
          </View>
        }
        renderItem={({ item: row }) => {
          const decision = extractionDecisionPresentation(row.decision);
          const source = row.sourceText || row.sourceLabel || t('labs.extractionUnmapped');
          const numberOfLines = usesAccessibilityTextSize ? undefined : 1;
          return (
            <Pressable
              accessibilityLabel={rowAccessibilityLabel(row)}
              accessibilityRole="button"
              onPress={() => setSelectedRowId(row.id)}
              style={({ pressed }) => [
                styles.queueRow,
                usesAccessibilityTextSize && styles.accessibilityQueueRow,
                pressed && styles.rowPressed,
              ]}
            >
              <AppIcon name="doc" size={21} />
              <View style={styles.rowBody}>
                <View
                  style={[
                    styles.rowTopline,
                    usesAccessibilityTextSize && styles.accessibilityRowTopline,
                  ]}
                >
                  <AppText numberOfLines={numberOfLines} style={styles.sourceLabel}>
                    {source}
                  </AppText>
                  <StatusPill tone={decision.tone}>{decisionLabel(row)}</StatusPill>
                </View>
                {row.reviewState === 'needs-review' && (
                  <StatusPill tone="reviewNeeded">{t('labs.extractionNeedsReview')}</StatusPill>
                )}
                <AppText numberOfLines={numberOfLines} variant="heading">
                  {row.proposedLabel || t('labs.extractionUnmapped')}
                </AppText>
                <AppText numberOfLines={numberOfLines} style={styles.muted}>
                  {`${valueText(row)}${row.proposedUnit === null ? '' : ` ${row.proposedUnit}`} · ${dateText(row.collectionDate) || t('labs.recordDateMissing')}`}
                </AppText>
              </View>
              <AppIcon name="chevronRight" size={16} />
            </Pressable>
          );
        }}
        showsVerticalScrollIndicator
        style={styles.list}
      />

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <View style={styles.progressCopy}>
          <AppText variant="label">{t('labs.extractionProgress')}</AppText>
          <AppText style={styles.muted}>
            {t('labs.extractionProgressCount')
              .replace('{resolved}', String(resolved))
              .replace('{total}', String(draft.rows.length))}
          </AppText>
        </View>
        <AppButton
          disabled={busy || !canConfirm}
          label={t('labs.extractionConfirm')}
          onPress={() => void confirm()}
          style={styles.confirmButton}
        />
      </View>

      <Modal
        accessibilityViewIsModal
        animationType="slide"
        onRequestClose={() => {
          setSelectedRowId(null);
          setSourcePreview(null);
        }}
        presentationStyle="pageSheet"
        visible={selectedRow !== null}
      >
        <SafeAreaView edges={['top', 'bottom']} style={styles.editorSafe}>
          {selectedRow !== null && selectedEdit !== null && sourcePreview === null && (
            <>
              <View style={styles.editorHeader}>
                <View style={styles.editorTitle}>
                  <AppText variant="heading">
                    {`${t('labs.extractionRow')} ${selectedRow.order + 1}`}
                  </AppText>
                  <AppText style={styles.muted}>{t('labs.extractionEditorSubtitle')}</AppText>
                </View>
                <AppButton
                  label={t('labs.extractionEditorClose')}
                  onPress={() => setSelectedRowId(null)}
                  tone="quiet"
                />
              </View>
              <ScrollView
                contentContainerStyle={styles.editorContent}
                keyboardShouldPersistTaps="handled"
              >
                <AppSurface tone="soft" style={styles.sourceCard}>
                  <AppText variant="label">{t('labs.extractionSource')}</AppText>
                  <AppText selectable>{selectedRow.sourceText}</AppText>
                  <AppText style={styles.muted}>
                    {`${t('labs.extractionLocation')}: ${selectedRow.source.pageIndex + 1} · x ${selectedRow.source.boundingBox.x.toFixed(3)}, y ${selectedRow.source.boundingBox.y.toFixed(3)}`}
                  </AppText>
                  {selectedRow.reviewReasons.length > 0 && (
                    <AppText style={styles.warning}>
                      {selectedRow.reviewReasons
                        .map((reason) => t(`labs.extractionReason.${reason}`))
                        .join(' · ')}
                    </AppText>
                  )}
                  <AppButton
                    disabled={busy}
                    label={t('labs.extractionViewInReport')}
                    onPress={() => void openSource(selectedRow)}
                    tone="quiet"
                  />
                </AppSurface>

                <View style={styles.formSection}>
                  <AppText variant="label">{t('labs.extractionProposedValues')}</AppText>
                  <Field
                    accessibilityLabel={t('labs.measurementLabel')}
                    label={t('labs.measurementLabel')}
                    onChangeText={(value) =>
                      setEdits((current) => ({
                        ...current,
                        [selectedRow.id]: { ...selectedEdit, label: value },
                      }))
                    }
                    value={selectedEdit.label}
                  />
                  <Field
                    accessibilityLabel={t('labs.measurementValue')}
                    keyboardType="numeric"
                    label={t('labs.measurementValue')}
                    onChangeText={(value) =>
                      setEdits((current) => ({
                        ...current,
                        [selectedRow.id]: { ...selectedEdit, value },
                      }))
                    }
                    value={selectedEdit.value}
                  />
                  <Field
                    accessibilityLabel={t('labs.measurementUnit')}
                    label={t('labs.measurementUnit')}
                    onChangeText={(value) =>
                      setEdits((current) => ({
                        ...current,
                        [selectedRow.id]: { ...selectedEdit, unit: value },
                      }))
                    }
                    value={selectedEdit.unit}
                  />
                  <Field
                    accessibilityLabel={t('labs.measurementReference')}
                    label={t('labs.measurementReference')}
                    onChangeText={(value) =>
                      setEdits((current) => ({
                        ...current,
                        [selectedRow.id]: { ...selectedEdit, reference: value },
                      }))
                    }
                    value={selectedEdit.reference}
                  />
                  <Field
                    accessibilityLabel={t('labs.recordDateLabel')}
                    label={t('labs.recordDateLabel')}
                    onChangeText={(value) =>
                      setEdits((current) => ({
                        ...current,
                        [selectedRow.id]: { ...selectedEdit, date: value },
                      }))
                    }
                    value={selectedEdit.date}
                  />
                  <AppButton
                    disabled={busy}
                    label={t('labs.extractionSaveRow')}
                    onPress={() => void saveRow(selectedRow)}
                    tone="secondary"
                  />
                </View>
              </ScrollView>
              <View style={styles.editorFooter}>
                <AppText variant="label">{t('labs.extractionDecision')}</AppText>
                <View style={styles.decisionRow}>
                  <AppButton
                    disabled={busy}
                    label={t('labs.extractionKeep')}
                    onPress={() => void decide(selectedRow, 'preserve')}
                    tone={selectedRow.decision === 'preserve' ? 'primary' : 'secondary'}
                  />
                  <AppButton
                    disabled={busy}
                    label={t('labs.extractionSkip')}
                    onPress={() => void decide(selectedRow, 'skip')}
                    tone={selectedRow.decision === 'skip' ? 'primary' : 'secondary'}
                  />
                  {selectedRow.reviewState === 'ready' && (
                    <AppButton
                      disabled={busy}
                      label={t('labs.extractionResolve')}
                      onPress={() => void decide(selectedRow, 'resolve')}
                      tone={selectedRow.decision === 'resolve' ? 'primary' : 'secondary'}
                    />
                  )}
                </View>
              </View>
            </>
          )}
          {sourcePreview !== null && (
            <>
              <View style={styles.editorHeader}>
                <AppText variant="heading">{t('labs.extractionSourcePreviewTitle')}</AppText>
                <AppButton
                  label={t('labs.extractionBackToRow')}
                  onPress={() => setSourcePreview(null)}
                  tone="quiet"
                />
              </View>
              <ScrollView contentContainerStyle={styles.previewPages}>
                <View
                  accessible
                  accessibilityLabel={`${t('labs.extractionSourceRegionLabel')} ${sourcePreview.row.source.pageIndex + 1}`}
                  style={styles.previewPage}
                >
                  <Image
                    accessibilityLabel={`${t('labs.reportPreviewImageLabel')} ${sourcePreview.row.source.pageIndex + 1}`}
                    resizeMode="contain"
                    source={{ uri: sourcePreview.preview.uris[sourcePreview.row.source.pageIndex] }}
                    style={styles.previewImage}
                  />
                  <View
                    pointerEvents="none"
                    style={[
                      styles.sourceRegion,
                      {
                        height: `${sourcePreview.row.source.boundingBox.height * 100}%`,
                        left: `${sourcePreview.row.source.boundingBox.x * 100}%`,
                        top: `${sourcePreview.row.source.boundingBox.y * 100}%`,
                        width: `${sourcePreview.row.source.boundingBox.width * 100}%`,
                      },
                    ]}
                  />
                  <AppText style={styles.sourceRegionText}>
                    {t('labs.extractionSourceRegion')
                      .replace('{page}', String(sourcePreview.row.source.pageIndex + 1))
                      .replace('{x}', sourcePreview.row.source.boundingBox.x.toFixed(3))
                      .replace('{y}', sourcePreview.row.source.boundingBox.y.toFixed(3))}
                  </AppText>
                </View>
              </ScrollView>
            </>
          )}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function Field({
  accessibilityLabel,
  keyboardType,
  label,
  onChangeText,
  value,
}: {
  readonly accessibilityLabel: string;
  readonly keyboardType?: 'default' | 'numeric';
  readonly label: string;
  readonly onChangeText: (value: string) => void;
  readonly value: string;
}) {
  return (
    <View style={styles.field}>
      <AppText style={styles.fieldLabel}>{label}</AppText>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        autoCapitalize="sentences"
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
  list: { flex: 1 },
  queueContent: { paddingHorizontal: spacing.lg },
  queueHeader: { gap: spacing.sm, paddingBottom: spacing.sm, paddingTop: spacing.md },
  intro: { color: colors.mutedInk },
  notice: { gap: spacing.xs },
  queueLabel: { color: colors.mutedInk, marginTop: spacing.sm, textTransform: 'uppercase' },
  queueRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 82,
    paddingVertical: spacing.sm,
  },
  accessibilityQueueRow: { alignItems: 'flex-start' },
  rowPressed: { backgroundColor: colors.accentSoft },
  rowBody: { flex: 1, gap: spacing.xs, minWidth: 0 },
  rowTopline: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  accessibilityRowTopline: { alignItems: 'flex-start', flexDirection: 'column' },
  sourceLabel: { color: colors.mutedInk, flex: 1 },
  muted: { color: colors.mutedInk },
  warning: { color: colors.danger },
  footer: {
    alignItems: 'center',
    backgroundColor: colors.elevatedSurface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  progressCopy: { flex: 1, gap: spacing.xs },
  confirmButton: { minWidth: 150 },
  editorSafe: { backgroundColor: colors.canvas, flex: 1 },
  editorHeader: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: spacing.lg,
  },
  editorTitle: { flex: 1, gap: spacing.xs },
  editorContent: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.xl },
  sourceCard: { gap: spacing.xs },
  formSection: { gap: spacing.sm },
  field: { gap: spacing.xs },
  fieldLabel: { color: colors.mutedInk },
  input: {
    backgroundColor: colors.elevatedSurface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.ink,
    minHeight: 46,
    paddingHorizontal: spacing.sm,
  },
  editorFooter: {
    backgroundColor: colors.elevatedSurface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  decisionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingBottom: spacing.xs,
  },
  previewPages: { gap: spacing.md, padding: spacing.lg },
  previewPage: { minHeight: 560, position: 'relative', width: '100%' },
  previewImage: { height: 520, width: '100%' },
  sourceRegion: {
    borderColor: colors.danger,
    borderRadius: 4,
    borderWidth: 3,
    position: 'absolute',
  },
  sourceRegionText: { color: colors.danger, marginTop: spacing.xs },
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
});
