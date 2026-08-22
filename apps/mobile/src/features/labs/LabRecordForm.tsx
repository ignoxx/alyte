import { useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import {
  formatLocaleDecimal,
  parseLocaleDecimal,
  parseLocalDateInput,
  type CreateMeasurementInput,
  type LabRecord,
  type MeasurementValue,
  type SpecimenType,
} from '@alyte/domain';
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
  readonly initialRecord?: LabRecord | null;
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

function draftFromMeasurement(measurement: LabRecord['measurements'][number]): MeasurementDraft {
  const value = measurement.current.value;
  return {
    label: measurement.current.label,
    value:
      value.kind === 'numeric' || value.kind === 'bounded'
        ? formatLocaleDecimal(value.value)
        : value.value,
    valueType: value.kind,
    comparator: value.kind === 'bounded' ? value.comparator : '<',
    unit: measurement.current.unit ?? '',
    referenceInterval: measurement.current.referenceInterval ?? '',
    flag: measurement.current.flag ?? '',
  };
}

function inputForMeasurement(draft: MeasurementDraft): CreateMeasurementInput | null {
  const trimmedValue = draft.value.trim();
  const parsed =
    draft.valueType === 'numeric' || draft.valueType === 'bounded'
      ? parseLocaleDecimal(trimmedValue)
      : null;
  if ((draft.valueType === 'numeric' || draft.valueType === 'bounded') && parsed === null) {
    return null;
  }
  const value =
    draft.valueType === 'numeric'
      ? { kind: 'numeric' as const, value: parsed as number }
      : draft.valueType === 'bounded'
        ? { kind: 'bounded' as const, comparator: draft.comparator, value: parsed as number }
        : draft.valueType === 'categorical'
          ? { kind: 'categorical' as const, value: trimmedValue }
          : { kind: 'free_text' as const, value: trimmedValue };
  return {
    label: draft.label.trim(),
    value,
    unit: draft.unit.trim() || null,
    referenceInterval: draft.referenceInterval.trim() || null,
    flag: draft.flag.trim() || null,
  };
}

function specimenLabel(value: SpecimenType): string {
  const suffix =
    value === 'unknown' ? 'Unknown' : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  return t(`labs.specimen${suffix}`);
}

function valueTypeLabel(value: MeasurementValue['kind']): string {
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

export function LabRecordForm({ service, initialRecord, onSaved, onCancel }: LabRecordFormProps) {
  const editing = initialRecord !== undefined && initialRecord !== null;
  const [date, setDate] = useState(
    initialRecord?.collectionDate.kind === 'known' ? initialRecord.collectionDate.value : '',
  );
  const [dateMissing, setDateMissing] = useState(initialRecord?.collectionDate.kind !== 'known');
  const [specimenType, setSpecimenType] = useState<SpecimenType>(
    initialRecord?.specimenType ?? 'unknown',
  );
  const [laboratoryName, setLaboratoryName] = useState(initialRecord?.laboratoryName ?? '');
  const [notes, setNotes] = useState(initialRecord?.notes ?? '');
  const [measurements, setMeasurements] = useState<MeasurementDraft[]>(
    !editing ? [emptyMeasurement()] : initialRecord.measurements.map(draftFromMeasurement),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  async function save() {
    setError(null);
    const parsedDate = dateMissing ? null : parseLocalDateInput(date, locale);
    if (!dateMissing && parsedDate === null) {
      setError(t('labs.invalidDate'));
      return;
    }
    if (!editing && measurements.length === 0) {
      setError(t('labs.requiredMeasurement'));
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
    const inputs = measurements.map(inputForMeasurement);
    if (inputs.some((input) => input === null)) {
      setError(t('labs.invalidNumeric'));
      return;
    }

    setSaving(true);
    try {
      const collectionDate =
        parsedDate === null
          ? { kind: 'missing' as const }
          : { kind: 'known' as const, value: parsedDate };
      const record = editing
        ? await service.updateRecord(initialRecord.id, {
            collectionDate,
            specimenType,
            laboratoryName: laboratoryName.trim() || null,
            notes: notes.trim() || null,
          })
        : await service.createRecord({
            collectionDate,
            specimenType,
            laboratoryName: laboratoryName.trim() || null,
            notes: notes.trim() || null,
            measurements: inputs as CreateMeasurementInput[],
          });
      onSaved(record.id);
    } catch {
      setError(t('labs.recordSaveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeForm>
      <AppText variant="title">
        {editing ? t('labs.recordEditTitle') : t('labs.recordCreateTitle')}
      </AppText>
      {!editing && <AppText style={styles.intro}>{t('labs.recordIntro')}</AppText>}
      <AppSurface style={styles.section}>
        <AppText variant="label">{t('labs.recordDateLabel')}</AppText>
        <TextInput
          accessibilityLabel={t('labs.recordDateLabel')}
          editable={!dateMissing}
          onChangeText={setDate}
          placeholder={t('labs.recordDatePlaceholder')}
          style={[styles.input, dateMissing && styles.disabledInput]}
          value={date}
        />
        <AppButton
          accessibilityRole="checkbox"
          accessibilityState={{ selected: dateMissing }}
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
              label={specimenLabel(value)}
              selected={specimenType === value}
              onPress={() => setSpecimenType(value)}
            />
          ))}
        </ChoiceRow>
        <AppText variant="label">{t('labs.recordLabLabel')}</AppText>
        <TextInput
          accessibilityLabel={t('labs.recordLabLabel')}
          onChangeText={setLaboratoryName}
          placeholder={t('labs.optionalPlaceholder')}
          style={styles.input}
          value={laboratoryName}
        />
        <AppText variant="label">{t('labs.recordNotesLabel')}</AppText>
        <TextInput
          accessibilityLabel={t('labs.recordNotesLabel')}
          multiline
          onChangeText={setNotes}
          placeholder={t('labs.optionalPlaceholder')}
          style={[styles.input, styles.multiline]}
          value={notes}
        />
      </AppSurface>

      {!editing &&
        measurements.map((measurement, index) => (
          <AppSurface key={index} style={styles.section}>
            <AppText variant="heading">{`${t('labs.recordDetail')} ${index + 1}`}</AppText>
            <AppText variant="label">{t('labs.measurementLabel')}</AppText>
            <TextInput
              accessibilityLabel={t('labs.measurementLabel')}
              onChangeText={(label) =>
                setMeasurements((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, label } : item,
                  ),
                )
              }
              placeholder={t('labs.measurementLabel')}
              style={styles.input}
              value={measurement.label}
            />
            <AppText variant="label">{t('labs.measurementType')}</AppText>
            <ChoiceRow>
              {valueTypes.map((valueType) => (
                <ChoiceButton
                  key={valueType}
                  label={valueTypeLabel(valueType)}
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
                  accessibilityLabel={t('labs.measurementComparator')}
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
            {(
              [
                ['measurementUnit', 'unit'],
                ['measurementReference', 'referenceInterval'],
                ['measurementFlag', 'flag'],
              ] as const
            ).map(([labelKey, field]) => (
              <View key={field}>
                <AppText variant="label">{t(`labs.${labelKey}`)}</AppText>
                <TextInput
                  accessibilityLabel={t(`labs.${labelKey}`)}
                  onChangeText={(value) =>
                    setMeasurements((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, [field]: value } : item,
                      ),
                    )
                  }
                  placeholder={t('labs.optionalPlaceholder')}
                  style={styles.input}
                  value={measurement[field]}
                />
              </View>
            ))}
          </AppSurface>
        ))}
      {!editing && (
        <AppButton
          label={t('labs.measurementAdd')}
          onPress={() => setMeasurements((current) => [...current, emptyMeasurement()])}
          tone="secondary"
        />
      )}
      {error !== null && <AppText style={styles.error}>{error}</AppText>}
      <View style={styles.actions}>
        <AppButton label={t('labs.recordCancel')} onPress={onCancel} tone="quiet" />
        <AppButton
          disabled={saving}
          label={saving ? t('labs.loading') : t('labs.recordSave')}
          onPress={() => void save()}
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
  accessibilityLabel,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly accessibilityLabel?: string;
}) {
  return (
    <AppButton
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      label={label}
      onPress={onPress}
      tone={selected ? 'primary' : 'secondary'}
    />
  );
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
