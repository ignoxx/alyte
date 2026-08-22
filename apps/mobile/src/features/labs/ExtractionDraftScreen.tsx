import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  parseComparatorValue,
  parseLabDate,
  type ExtractionDraft,
  type ExtractionDraftRow,
  type LabDateState,
} from '@alyte/domain';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';

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

export function ExtractionDraftScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DraftRoute>();
  const { reports } = useServices();
  const [draft, setDraft] = useState<ExtractionDraft | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await reports.getExtractionDraft(route.params.draftId);
      setDraft(next);
      if (next !== null)
        setEdits(Object.fromEntries(next.rows.map((row) => [row.id, editFrom(row)])));
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

  async function saveRow(row: ExtractionDraftRow) {
    const edit = edits[row.id];
    if (edit === undefined) return;
    const parsed = parseComparatorValue(edit.value);
    const date = edit.date.trim() ? parseLabDate(edit.date, locale) : { kind: 'missing' as const };
    if (parsed === null) {
      Alert.alert(t('labs.extractionEditErrorTitle'), t('labs.extractionEditValueError'));
      return;
    }
    if (edit.date.trim() && date === null) {
      Alert.alert(t('labs.extractionEditErrorTitle'), t('labs.invalidDate'));
      return;
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
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (draft === null) return;
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

  const needsReview = draft.rows.filter((row) => row.reviewState === 'needs-review').length;
  return (
    <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
      <AppText style={styles.intro}>{t('labs.extractionIntro')}</AppText>
      <AppSurface tone="soft" style={styles.notice}>
        <AppText>{t('labs.extractionSourceNotice')}</AppText>
        {draft.collectionDate.kind === 'missing' && (
          <AppText style={styles.warning}>{t('labs.extractionDateMissing')}</AppText>
        )}
        <AppText style={styles.muted}>
          {t('labs.extractionReviewCount').replace('{count}', String(needsReview))}
        </AppText>
      </AppSurface>
      {draft.rows.map((row) => {
        const edit = edits[row.id] ?? editFrom(row);
        return (
          <AppSurface key={row.id} style={styles.row}>
            <View style={styles.rowHeading}>
              <AppText variant="heading">{`${t('labs.extractionRow')} ${row.order + 1}`}</AppText>
              <StatusPill tone={row.reviewState === 'needs-review' ? 'reviewNeeded' : 'extracted'}>
                {row.reviewState === 'needs-review'
                  ? t('labs.extractionNeedsReview')
                  : t('labs.extractionReady')}
              </StatusPill>
            </View>
            <AppText
              style={styles.source}
            >{`${t('labs.extractionSource')}: ${row.sourceText}`}</AppText>
            <AppText
              style={styles.source}
            >{`${t('labs.extractionLocation')}: ${row.source.pageIndex + 1} · x ${row.source.boundingBox.x.toFixed(3)}, y ${row.source.boundingBox.y.toFixed(3)}`}</AppText>
            {row.reviewReasons.length > 0 && (
              <AppText style={styles.warning}>
                {row.reviewReasons
                  .map((reason) => t(`labs.extractionReason.${reason}`))
                  .join(' · ')}
              </AppText>
            )}
            <TextInput
              accessibilityLabel={t('labs.measurementLabel')}
              onChangeText={(value) =>
                setEdits((current) => ({ ...current, [row.id]: { ...edit, label: value } }))
              }
              placeholder={t('labs.measurementLabel')}
              style={styles.input}
              value={edit.label}
            />
            <TextInput
              accessibilityLabel={t('labs.measurementValue')}
              onChangeText={(value) =>
                setEdits((current) => ({ ...current, [row.id]: { ...edit, value } }))
              }
              placeholder={t('labs.measurementValue')}
              style={styles.input}
              value={edit.value}
            />
            <TextInput
              accessibilityLabel={t('labs.measurementUnit')}
              onChangeText={(value) =>
                setEdits((current) => ({ ...current, [row.id]: { ...edit, unit: value } }))
              }
              placeholder={t('labs.measurementUnit')}
              style={styles.input}
              value={edit.unit}
            />
            <TextInput
              accessibilityLabel={t('labs.measurementReference')}
              onChangeText={(value) =>
                setEdits((current) => ({ ...current, [row.id]: { ...edit, reference: value } }))
              }
              placeholder={t('labs.measurementReference')}
              style={styles.input}
              value={edit.reference}
            />
            <TextInput
              accessibilityLabel={t('labs.recordDateLabel')}
              onChangeText={(value) =>
                setEdits((current) => ({ ...current, [row.id]: { ...edit, date: value } }))
              }
              placeholder={t('labs.recordDatePlaceholder')}
              style={styles.input}
              value={edit.date}
            />
            <AppButton
              disabled={busy}
              label={t('labs.extractionSaveRow')}
              onPress={() => void saveRow(row)}
              tone="secondary"
            />
          </AppSurface>
        );
      })}
      <AppButton
        disabled={busy}
        label={t('labs.extractionConfirm')}
        onPress={() => void confirm()}
      />
      <AppButton
        disabled={busy}
        label={t('labs.recordCancel')}
        onPress={() => navigation.goBack()}
        tone="quiet"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
  intro: { color: colors.mutedInk, marginBottom: spacing.md },
  notice: { gap: spacing.xs, marginBottom: spacing.md },
  row: { gap: spacing.sm, marginBottom: spacing.md },
  rowHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  source: { color: colors.mutedInk },
  muted: { color: colors.mutedInk },
  warning: { color: colors.danger },
  input: {
    backgroundColor: colors.canvas,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.ink,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
});
