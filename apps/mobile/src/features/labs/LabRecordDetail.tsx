import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import type { LabRecord, Measurement, MeasurementValue } from '@alyte/domain';
import { t } from '../../localization';
import { colors, screenStyles, spacing } from '../../theme';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import type { LabsService } from './service';

type LabRecordDetailProps = {
  readonly record: LabRecord;
  readonly service: LabsService;
  readonly onBack: () => void;
  readonly onChanged: (record: LabRecord) => void;
  readonly onDeleted: () => void;
};

export function LabRecordDetail({
  record,
  service,
  onBack,
  onChanged,
  onDeleted,
}: LabRecordDetailProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function beginCorrection(measurement: Measurement) {
    setEditingId(measurement.id);
    setDraftValue(measurement.current.valueString);
    setError(null);
  }

  async function saveCorrection(measurement: Measurement) {
    setError(null);
    const value = correctedValue(measurement.current.value, draftValue);
    if (value === null) {
      setError(t('labs.invalidNumeric'));
      return;
    }
    setBusy(true);
    try {
      await service.correctMeasurement(measurement.id, {
        value,
        valueString: draftValue.trim(),
        reason: 'Corrected in Lab Record detail',
      });
      const nextRecord = await service.getRecord(record.id);
      if (nextRecord !== null) {
        onChanged(nextRecord);
      }
      setEditingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('labs.correctionSaveError'));
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
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : t('labs.recordDeleteError'));
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
      ? record.collectionDate.value
      : t('labs.recordDateMissing');
  return (
    <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
      <View style={styles.header}>
        <AppButton label={t('labs.recordCancel')} onPress={onBack} tone="quiet" />
        <AppButton
          disabled={busy}
          label={t('labs.recordDelete')}
          onPress={confirmDelete}
          tone="secondary"
        />
      </View>
      <AppText variant="title">{t('labs.recordTitle')}</AppText>
      <AppText style={styles.date}>{dateLabel}</AppText>
      <StatusPill>{record.specimenType}</StatusPill>
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
            {measurement.current.valueString}
            {measurement.current.unit ? ` ${measurement.current.unit}` : ''}
          </AppText>
          <AppText style={styles.source}>
            {t('labs.measurementOriginal').replace('{value}', measurement.original.valueString)}
          </AppText>
          <StatusPill>{measurement.provenance}</StatusPill>
          {measurement.current.referenceInterval !== null && (
            <AppText>{measurement.current.referenceInterval}</AppText>
          )}
          {measurement.current.flag !== null && <AppText>{measurement.current.flag}</AppText>}
          {editingId === measurement.id ? (
            <View style={styles.correction}>
              <TextInput
                autoFocus
                onChangeText={setDraftValue}
                style={styles.input}
                value={draftValue}
              />
              <View style={styles.header}>
                <AppButton
                  label={t('labs.recordCancel')}
                  onPress={() => setEditingId(null)}
                  tone="quiet"
                />
                <AppButton
                  disabled={busy}
                  label={t('labs.measurementSaveCorrection')}
                  onPress={() => void saveCorrection(measurement)}
                />
              </View>
            </View>
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
    </ScrollView>
  );
}

function correctedValue(value: MeasurementValue, draft: string): MeasurementValue | null {
  if (value.kind === 'numeric') {
    const parsed = Number(draft.trim());
    return Number.isFinite(parsed) ? { kind: 'numeric', value: parsed } : null;
  }
  if (value.kind === 'bounded') {
    const withoutComparator = draft.trim().replace(/^[<>]\s*/, '');
    const parsed = Number(withoutComparator);
    return Number.isFinite(parsed)
      ? { kind: 'bounded', comparator: value.comparator, value: parsed }
      : null;
  }
  return draft.trim().length > 0 ? { kind: value.kind, value: draft.trim() } : null;
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  date: { color: colors.mutedInk },
  notes: { color: colors.mutedInk, marginTop: spacing.sm },
  measurement: { gap: spacing.sm },
  source: { color: colors.mutedInk },
  correction: { gap: spacing.sm },
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
