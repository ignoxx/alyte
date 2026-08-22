import { useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';
import {
  formatLocaleDate,
  formatLocaleDecimal,
  parseLocaleDecimal,
  type LabRecord,
  type Measurement,
  type MeasurementReviewState,
  type MeasurementValue,
  type SpecimenType,
} from '@alyte/domain';
import { t } from '../../localization';
import { colors, screenStyles, spacing, type StatusTone } from '../../theme';
import { AppButton, AppSurface, AppText, ScreenScrollView, StatusPill } from '../../ui/primitives';
import type { LabsService } from './service';

type LabRecordDetailProps = {
  readonly record: LabRecord;
  readonly service: LabsService;
  readonly onEditRecord: () => void;
  readonly onChanged: (record: LabRecord) => void;
  readonly onDeleted: () => void;
};

type MeasurementDraft = {
  label: string;
  value: string;
  kind: MeasurementValue['kind'];
  comparator: '<' | '>';
  unit: string;
  referenceInterval: string;
  flag: string;
  specimenType: SpecimenType;
  reviewState: MeasurementReviewState;
};

const specimenTypes: readonly SpecimenType[] = [
  'unknown',
  'blood',
  'serum',
  'plasma',
  'urine',
  'stool',
  'saliva',
];
const valueKinds: readonly MeasurementValue['kind'][] = [
  'numeric',
  'bounded',
  'categorical',
  'free_text',
];

function specimenLabel(value: SpecimenType): string {
  const suffix =
    value === 'unknown' ? 'Unknown' : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  return t(`labs.specimen${suffix}`);
}

function kindLabel(value: MeasurementValue['kind']): string {
  return t(
    value === 'numeric'
      ? 'labs.measurementNumeric'
      : value === 'bounded'
        ? 'labs.measurementBounded'
        : value === 'categorical'
          ? 'labs.measurementCategorical'
          : 'labs.measurementFreeText',
  );
}

function provenanceLabel(value: Measurement['provenance']): string {
  return t(
    value === 'user-entered'
      ? 'labs.provenanceUserEntered'
      : value === 'user-corrected'
        ? 'labs.provenanceUserCorrected'
        : 'labs.provenanceExtracted',
  );
}

function provenanceTone(value: Measurement['provenance']): StatusTone {
  return value === 'extracted' ? 'extracted' : 'userEntered';
}

function displayValue(measurement: Measurement, locale: string): string {
  const value = measurement.current.value;
  if (value.kind === 'numeric') return formatLocaleDecimal(value.value, locale);
  if (value.kind === 'bounded')
    return `${value.comparator}${formatLocaleDecimal(value.value, locale)}`;
  return value.value;
}

function draftFrom(measurement: Measurement): MeasurementDraft {
  const value = measurement.current.value;
  return {
    label: measurement.current.label,
    value: value.kind === 'numeric' || value.kind === 'bounded' ? String(value.value) : value.value,
    kind: value.kind,
    comparator: value.kind === 'bounded' ? value.comparator : '<',
    unit: measurement.current.unit ?? '',
    referenceInterval: measurement.current.referenceInterval ?? '',
    flag: measurement.current.flag ?? '',
    specimenType: measurement.specimenType,
    reviewState: measurement.reviewState,
  };
}

function valueFrom(draft: MeasurementDraft): MeasurementValue | null {
  if (draft.kind === 'numeric' || draft.kind === 'bounded') {
    const value = parseLocaleDecimal(draft.value);
    if (value === null) return null;
    return draft.kind === 'numeric'
      ? { kind: 'numeric', value }
      : { kind: 'bounded', comparator: draft.comparator, value };
  }
  const value = draft.value.trim();
  return value.length === 0 ? null : { kind: draft.kind, value };
}

export function LabRecordDetail({
  record,
  service,
  onEditRecord,
  onChanged,
  onDeleted,
}: LabRecordDetailProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MeasurementDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  function beginCorrection(measurement: Measurement) {
    setEditingId(measurement.id);
    setDraft(draftFrom(measurement));
    setError(null);
  }

  async function saveCorrection(measurement: Measurement) {
    if (draft === null) return;
    setError(null);
    const value = valueFrom(draft);
    if (value === null) {
      setError(t('labs.invalidNumeric'));
      return;
    }
    setBusy(true);
    try {
      await service.correctMeasurement(measurement.id, {
        biomarkerId: measurement.biomarkerId,
        label: draft.label.trim(),
        value,
        unit: draft.unit.trim() || null,
        referenceInterval: draft.referenceInterval.trim() || null,
        flag: draft.flag.trim() || null,
        specimenType: draft.specimenType,
        reviewState: draft.reviewState,
        reason: t('labs.correctionReason'),
      });
      const nextRecord = await service.getRecord(record.id);
      if (nextRecord !== null) onChanged(nextRecord);
      setEditingId(null);
      setDraft(null);
    } catch {
      setError(t('labs.measurementCorrectionError'));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    Alert.alert(t('labs.recordDelete'), t('labs.recordDeleteConfirm'), [
      { text: t('labs.recordDeleteCancel'), style: 'cancel' },
      {
        text: t('labs.recordDeleteConfirmAction'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              await service.deleteRecord(record.id);
              onDeleted();
            } catch {
              setError(t('labs.recordDeleteError'));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }

  const dateLabel =
    record.collectionDate.kind === 'known'
      ? formatLocaleDate(record.collectionDate.value, locale)
      : t('labs.recordDateMissing');
  return (
    <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
      <View style={styles.header}>
        <View style={styles.headerActions}>
          <AppButton
            disabled={busy}
            label={t('labs.recordEditAction')}
            onPress={onEditRecord}
            tone="secondary"
          />
          <AppButton
            disabled={busy}
            label={t('labs.recordDelete')}
            onPress={confirmDelete}
            tone="secondary"
          />
        </View>
      </View>
      <AppText style={styles.date}>{dateLabel}</AppText>
      <StatusPill>{specimenLabel(record.specimenType)}</StatusPill>
      {record.laboratoryName !== null && <AppText>{record.laboratoryName}</AppText>}
      {record.notes !== null && <AppText style={styles.notes}>{record.notes}</AppText>}
      <AppText variant="heading">{t('labs.recordDetail')}</AppText>
      {record.measurements.length === 0 && (
        <AppText style={styles.date}>{t('labs.recordNoMeasurements')}</AppText>
      )}
      {record.measurements.map((measurement) => (
        <AppSurface key={measurement.id} style={styles.measurement}>
          <AppText variant="heading">{measurement.current.label}</AppText>
          <AppText variant="title">
            {displayValue(measurement, locale)}
            {measurement.current.unit ? ` ${measurement.current.unit}` : ''}
          </AppText>
          <AppText style={styles.source}>
            {t('labs.measurementOriginal').replace('{value}', measurement.original.valueString)}
          </AppText>
          <StatusPill
            tone={
              measurement.reviewState === 'needs-review'
                ? 'reviewNeeded'
                : provenanceTone(measurement.provenance)
            }
          >
            {provenanceLabel(measurement.provenance)}
          </StatusPill>
          <AppText
            style={styles.meta}
          >{`${t('labs.measurementSpecimen')}: ${specimenLabel(measurement.specimenType)}`}</AppText>
          {measurement.current.referenceInterval !== null && (
            <AppText>{measurement.current.referenceInterval}</AppText>
          )}
          {measurement.current.flag !== null && <AppText>{measurement.current.flag}</AppText>}
          {editingId === measurement.id && draft !== null ? (
            <MeasurementEditor
              draft={draft}
              setDraft={setDraft}
              onCancel={() => {
                setEditingId(null);
                setDraft(null);
              }}
              onSave={() => void saveCorrection(measurement)}
              busy={busy}
            />
          ) : (
            <AppButton
              label={t('labs.measurementCorrect')}
              onPress={() => beginCorrection(measurement)}
              tone="secondary"
            />
          )}
        </AppSurface>
      ))}
      {error !== null && <AppText style={styles.error}>{error}</AppText>}
    </ScreenScrollView>
  );
}

function MeasurementEditor({
  draft,
  setDraft,
  onCancel,
  onSave,
  busy,
}: {
  readonly draft: MeasurementDraft;
  readonly setDraft: (draft: MeasurementDraft) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly busy: boolean;
}) {
  return (
    <View style={styles.correction}>
      <AppText variant="label">{t('labs.correctionLabel')}</AppText>
      <TextInput
        accessibilityLabel={t('labs.measurementLabel')}
        onChangeText={(label) => setDraft({ ...draft, label })}
        style={styles.input}
        value={draft.label}
      />
      <AppText variant="label">{t('labs.measurementType')}</AppText>
      <View style={styles.choiceRow}>
        {valueKinds.map((kind) => (
          <AppButton
            key={kind}
            accessibilityRole="radio"
            accessibilityState={{ selected: draft.kind === kind }}
            label={kindLabel(kind)}
            onPress={() => setDraft({ ...draft, kind })}
            tone={draft.kind === kind ? 'primary' : 'secondary'}
          />
        ))}
      </View>
      <View style={styles.valueRow}>
        {draft.kind === 'bounded' && (
          <AppButton
            accessibilityLabel={t('labs.measurementComparator')}
            accessibilityState={{ selected: true }}
            label={draft.comparator}
            onPress={() => setDraft({ ...draft, comparator: draft.comparator === '<' ? '>' : '<' })}
            tone="secondary"
          />
        )}
        <TextInput
          accessibilityLabel={t('labs.measurementValue')}
          keyboardType={
            draft.kind === 'numeric' || draft.kind === 'bounded' ? 'decimal-pad' : 'default'
          }
          onChangeText={(value) => setDraft({ ...draft, value })}
          style={[styles.input, styles.valueInput]}
          value={draft.value}
        />
      </View>
      <AppText variant="label">{t('labs.measurementUnit')}</AppText>
      <TextInput
        accessibilityLabel={t('labs.measurementUnit')}
        onChangeText={(unit) => setDraft({ ...draft, unit })}
        style={styles.input}
        value={draft.unit}
      />
      <AppText variant="label">{t('labs.measurementReference')}</AppText>
      <TextInput
        accessibilityLabel={t('labs.measurementReference')}
        onChangeText={(referenceInterval) => setDraft({ ...draft, referenceInterval })}
        style={styles.input}
        value={draft.referenceInterval}
      />
      <AppText variant="label">{t('labs.measurementFlag')}</AppText>
      <TextInput
        accessibilityLabel={t('labs.measurementFlag')}
        onChangeText={(flag) => setDraft({ ...draft, flag })}
        style={styles.input}
        value={draft.flag}
      />
      <AppText variant="label">{t('labs.measurementSpecimen')}</AppText>
      <View style={styles.choiceRow}>
        {specimenTypes.map((specimenType) => (
          <AppButton
            key={specimenType}
            accessibilityRole="radio"
            accessibilityState={{ selected: draft.specimenType === specimenType }}
            label={specimenLabel(specimenType)}
            onPress={() => setDraft({ ...draft, specimenType })}
            tone={draft.specimenType === specimenType ? 'primary' : 'secondary'}
          />
        ))}
      </View>
      <AppText variant="label">{t('labs.measurementReviewState')}</AppText>
      <View style={styles.choiceRow}>
        {(['confirmed', 'needs-review'] as const).map((reviewState) => (
          <AppButton
            key={reviewState}
            accessibilityRole="radio"
            accessibilityState={{ selected: draft.reviewState === reviewState }}
            label={
              reviewState === 'confirmed' ? t('labs.reviewConfirmed') : t('labs.reviewNeedsReview')
            }
            onPress={() => setDraft({ ...draft, reviewState })}
            tone={draft.reviewState === reviewState ? 'primary' : 'secondary'}
          />
        ))}
      </View>
      <View style={styles.header}>
        <AppButton label={t('labs.recordCancel')} onPress={onCancel} tone="quiet" />
        <AppButton disabled={busy} label={t('labs.measurementSaveCorrection')} onPress={onSave} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  headerActions: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  date: { color: colors.mutedInk },
  notes: { color: colors.mutedInk, marginTop: spacing.sm },
  measurement: { gap: spacing.sm },
  source: { color: colors.mutedInk },
  meta: { color: colors.mutedInk },
  correction: { gap: spacing.sm },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  valueRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  valueInput: { flex: 1 },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
  },
  error: { color: colors.danger, marginTop: spacing.md },
});
