import { useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import type { CreateMeasurementInput, MeasurementValue, SpecimenType } from '@alyte/domain';
import { t } from '../../localization';
import { colors, screenStyles, spacing } from '../../theme';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import type { LabsService } from './service';

type MeasurementDraft = {
  label: string;
  value: string;
  valueType: MeasurementValue['kind'];
  comparator: '<' | '>';
  unit: string;
  referenceInterval: string;
  flag: string;
};

type LabRecordFormProps = {
  readonly service: LabsService;
  readonly onSaved: (recordId: string) => void;
  readonly onCancel: () => void;
};

const specimens: readonly SpecimenType[] = [
  'unknown',
  'blood',
  'serum',
  'plasma',
  'urine',
  'stool',
  'saliva',
];
const valueTypes: readonly MeasurementValue['kind'][] = [
  'numeric',
  'bounded',
  'categorical',
  'free_text',
];

function emptyMeasurement(): MeasurementDraft {
  return {
    label: '',
    value: '',
    valueType: 'numeric',
    comparator: '<',
    unit: '',
    referenceInterval: '',
    flag: '',
  };
}

function inputForMeasurement(draft: MeasurementDraft): CreateMeasurementInput {
  const value =
    draft.valueType === 'numeric'
      ? { kind: 'numeric' as const, value: Number(draft.value) }
      : draft.valueType === 'bounded'
        ? { kind: 'bounded' as const, comparator: draft.comparator, value: Number(draft.value) }
        : draft.valueType === 'categorical'
          ? { kind: 'categorical' as const, value: draft.value }
          : { kind: 'free_text' as const, value: draft.value };
  return {
    label: draft.label.trim(),
    value,
    valueString: draft.valueType === 'bounded' ? `${draft.comparator}${draft.value}` : draft.value,
    unit: draft.unit.trim() || null,
    referenceInterval: draft.referenceInterval.trim() || null,
    flag: draft.flag.trim() || null,
  };
}

export function LabRecordForm({ service, onSaved, onCancel }: LabRecordFormProps) {
  const [date, setDate] = useState('');
  const [dateMissing, setDateMissing] = useState(false);
  const [specimenType, setSpecimenType] = useState<SpecimenType>('unknown');
  const [laboratoryName, setLaboratoryName] = useState('');
  const [notes, setNotes] = useState('');
  const [measurements, setMeasurements] = useState<MeasurementDraft[]>([emptyMeasurement()]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    if (!dateMissing && date.trim().length === 0) {
      setError(t('labs.invalidDate'));
      return;
    }
    if (
      measurements.some(
        (measurement) =>
          measurement.label.trim().length === 0 || measurement.value.trim().length === 0,
      )
    ) {
      setError(t('labs.requiredField'));
      return;
    }
    if (
      measurements.some(
        (measurement) =>
          (measurement.valueType === 'numeric' || measurement.valueType === 'bounded') &&
          !Number.isFinite(Number(measurement.value)),
      )
    ) {
      setError(t('labs.invalidNumeric'));
      return;
    }

    setSaving(true);
    try {
      const record = await service.createRecord({
        collectionDate: dateMissing ? { kind: 'missing' } : { kind: 'known', value: date.trim() },
        specimenType,
        laboratoryName: laboratoryName.trim() || null,
        notes: notes.trim() || null,
        measurements: measurements.map(inputForMeasurement),
      });
      onSaved(record.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('labs.recordSaveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeForm>
      <AppText variant="title">{t('labs.recordCreateTitle')}</AppText>
      <AppText style={styles.intro}>{t('labs.recordIntro')}</AppText>

      <AppSurface style={styles.section}>
        <AppText variant="label">{t('labs.recordDateLabel')}</AppText>
        <TextInput
          accessibilityLabel={t('labs.recordDateLabel')}
          editable={!dateMissing}
          onChangeText={setDate}
          placeholder="2026-08-22"
          style={[styles.input, dateMissing && styles.disabledInput]}
          value={date}
        />
        <AppButton
          label={t('labs.recordDateMissingLabel')}
          onPress={() => setDateMissing((current) => !current)}
          tone="quiet"
        />
        {dateMissing && <StatusPill>{t('labs.dateMissing')}</StatusPill>}

        <AppText variant="label">{t('labs.recordSpecimenLabel')}</AppText>
        <ChoiceRow>
          {specimens.map((value) => (
            <ChoiceButton
              key={value}
              label={value}
              selected={specimenType === value}
              onPress={() => setSpecimenType(value)}
            />
          ))}
        </ChoiceRow>
        <AppText variant="label">{t('labs.recordLabLabel')}</AppText>
        <TextInput onChangeText={setLaboratoryName} style={styles.input} value={laboratoryName} />
        <AppText variant="label">{t('labs.recordNotesLabel')}</AppText>
        <TextInput
          multiline
          onChangeText={setNotes}
          style={[styles.input, styles.multiline]}
          value={notes}
        />
      </AppSurface>

      {measurements.map((measurement, index) => (
        <AppSurface key={index} style={styles.section}>
          <AppText variant="heading">{`${t('labs.recordDetail')} ${index + 1}`}</AppText>
          <AppText variant="label">{t('labs.measurementLabel')}</AppText>
          <TextInput
            accessibilityLabel={t('labs.measurementLabel')}
            onChangeText={(label) =>
              setMeasurements((current) =>
                current.map((item, itemIndex) => (itemIndex === index ? { ...item, label } : item)),
              )
            }
            style={styles.input}
            value={measurement.label}
          />
          <AppText variant="label">{t('labs.measurementType')}</AppText>
          <ChoiceRow>
            {valueTypes.map((valueType) => (
              <ChoiceButton
                key={valueType}
                label={
                  valueType === 'numeric'
                    ? t('labs.measurementNumeric')
                    : valueType === 'bounded'
                      ? t('labs.measurementBounded')
                      : valueType === 'categorical'
                        ? t('labs.measurementCategorical')
                        : t('labs.measurementFreeText')
                }
                selected={measurement.valueType === valueType}
                onPress={() =>
                  setMeasurements((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, valueType } : item,
                    ),
                  )
                }
              />
            ))}
          </ChoiceRow>
          <View style={styles.valueRow}>
            {measurement.valueType === 'bounded' && (
              <ChoiceButton
                label={measurement.comparator}
                selected
                onPress={() =>
                  setMeasurements((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, comparator: item.comparator === '<' ? '>' : '<' }
                        : item,
                    ),
                  )
                }
              />
            )}
            <TextInput
              accessibilityLabel={t('labs.measurementValue')}
              keyboardType={
                measurement.valueType === 'numeric' || measurement.valueType === 'bounded'
                  ? 'decimal-pad'
                  : 'default'
              }
              onChangeText={(value) =>
                setMeasurements((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, value } : item,
                  ),
                )
              }
              placeholder={t('labs.measurementValue')}
              style={[styles.input, styles.valueInput]}
              value={measurement.value}
            />
          </View>
          <AppText variant="label">{t('labs.measurementUnit')}</AppText>
          <TextInput
            onChangeText={(unit) =>
              setMeasurements((current) =>
                current.map((item, itemIndex) => (itemIndex === index ? { ...item, unit } : item)),
              )
            }
            style={styles.input}
            value={measurement.unit}
          />
          <AppText variant="label">{t('labs.measurementReference')}</AppText>
          <TextInput
            onChangeText={(referenceInterval) =>
              setMeasurements((current) =>
                current.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, referenceInterval } : item,
                ),
              )
            }
            style={styles.input}
            value={measurement.referenceInterval}
          />
          <AppText variant="label">{t('labs.measurementFlag')}</AppText>
          <TextInput
            onChangeText={(flag) =>
              setMeasurements((current) =>
                current.map((item, itemIndex) => (itemIndex === index ? { ...item, flag } : item)),
              )
            }
            style={styles.input}
            value={measurement.flag}
          />
        </AppSurface>
      ))}

      <AppButton
        label={t('labs.measurementAdd')}
        onPress={() => setMeasurements((current) => [...current, emptyMeasurement()])}
        tone="secondary"
      />
      {error !== null && <AppText style={styles.error}>{error}</AppText>}
      <View style={styles.actions}>
        <AppButton label={t('labs.recordCancel')} onPress={onCancel} tone="quiet" />
        <AppButton
          disabled={saving}
          label={saving ? t('labs.loading') : t('labs.recordSave')}
          onPress={save}
        />
      </View>
    </SafeForm>
  );
}

function SafeForm({ children }: { readonly children: ReactNode }) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={screenStyles.safe}
    >
      <ScrollView
        contentContainerStyle={[screenStyles.content, styles.formContent]}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ChoiceRow({ children }: { readonly children: ReactNode }) {
  return <View style={styles.choiceRow}>{children}</View>;
}

function ChoiceButton({
  label,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return <AppButton label={label} onPress={onPress} tone={selected ? 'primary' : 'secondary'} />;
}

const styles = StyleSheet.create({
  formContent: { gap: spacing.md },
  intro: { color: colors.mutedInk },
  section: { gap: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  disabledInput: { color: colors.mutedInk, opacity: 0.65 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  valueRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs },
  valueInput: { flex: 1 },
  actions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
  error: { color: colors.danger },
});
