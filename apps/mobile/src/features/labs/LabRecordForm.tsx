import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from 'react';
import { Host, Picker } from '@expo/ui';
import { Alert, Pressable, StyleSheet, TextInput, View, type ScrollView } from 'react-native';
import {
  parseLocaleDecimal,
  parseLocalDateInput,
  type CreateMeasurementInput,
  type LabRecord,
  type MeasurementValue,
  type SpecimenType,
} from '@alyte/domain';
import { useNavigation, usePreventRemove, type NavigationProp } from '@react-navigation/native';
import { t } from '../../localization';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  ScreenScrollView,
  StatusPill,
} from '../../ui/primitives';
import type { RootStackParamList } from '../../navigation/types';
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
  readonly onSavingChange?: (saving: boolean) => void;
};

export type LabRecordFormHandle = {
  readonly save: () => Promise<void>;
};

type PickerOption<T extends string> = {
  readonly value: T;
  readonly label: string;
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

export const LabRecordForm = forwardRef<LabRecordFormHandle, LabRecordFormProps>(
  function LabRecordForm({ service, initialRecord, onSaved, onSavingChange }, ref) {
    const navigation = useNavigation<NavigationProp<RootStackParamList>>();
    const editing = initialRecord !== undefined && initialRecord !== null;
    const initialMeasurements = useMemo(() => (editing ? [] : [emptyMeasurement()]), [editing]);
    const [date, setDate] = useState(
      initialRecord?.collectionDate.kind === 'known' ? initialRecord.collectionDate.value : '',
    );
    const [dateMissing, setDateMissing] = useState(initialRecord?.collectionDate.kind !== 'known');
    const [specimenType, setSpecimenType] = useState<SpecimenType>(
      initialRecord?.specimenType ?? 'unknown',
    );
    const [laboratoryName, setLaboratoryName] = useState(initialRecord?.laboratoryName ?? '');
    const [notes, setNotes] = useState(initialRecord?.notes ?? '');
    const [measurements, setMeasurements] = useState<MeasurementDraft[]>(initialMeasurements);
    const [showRecordDetails, setShowRecordDetails] = useState(false);
    const [expandedMeasurementDetails, setExpandedMeasurementDetails] = useState<
      ReadonlySet<number>
    >(new Set());
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const allowRemovalRef = useRef(false);
    const saveInFlightRef = useRef<Promise<void> | null>(null);
    const scrollRef = useRef<ScrollView | null>(null);
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const initialSnapshot = useMemo(
      () =>
        JSON.stringify({
          date:
            initialRecord?.collectionDate.kind === 'known'
              ? initialRecord.collectionDate.value
              : '',
          dateMissing: initialRecord?.collectionDate.kind !== 'known',
          specimenType: initialRecord?.specimenType ?? 'unknown',
          laboratoryName: initialRecord?.laboratoryName ?? '',
          notes: initialRecord?.notes ?? '',
          measurements: initialMeasurements,
        }),
      [initialMeasurements, initialRecord],
    );
    const dirty =
      JSON.stringify({ date, dateMissing, specimenType, laboratoryName, notes, measurements }) !==
      initialSnapshot;

    const showError = useCallback((message: string) => {
      scrollRef.current?.scrollTo({ animated: false, y: 0 });
      setError(message);
    }, []);

    useEffect(() => {
      onSavingChange?.(saving);
    }, [onSavingChange, saving]);

    usePreventRemove(true, ({ data }) => {
      const saveInFlight = saveInFlightRef.current !== null;
      if (allowRemovalRef.current || (!dirty && !saving && !saveInFlight)) {
        navigation.dispatch(data.action);
        return;
      }
      if (saving || saveInFlight) return;
      Alert.alert(t('labs.recordDiscardTitle'), t('labs.recordDiscardBody'), [
        { text: t('labs.recordKeepEditing'), style: 'cancel' },
        {
          text: t('labs.recordDiscard'),
          style: 'destructive',
          onPress: () => navigation.dispatch(data.action),
        },
      ]);
    });

    const updateMeasurement = useCallback((index: number, patch: Partial<MeasurementDraft>) => {
      setError(null);
      setMeasurements((current) =>
        current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
      );
    }, []);

    const toggleMeasurementDetails = useCallback((index: number) => {
      setExpandedMeasurementDetails((current) => {
        const next = new Set(current);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
    }, []);

    const save = useCallback((): Promise<void> => {
      if (saveInFlightRef.current !== null) return saveInFlightRef.current;
      const operation = (async () => {
        setError(null);
        const parsedDate = dateMissing ? null : parseLocalDateInput(date, locale);
        if (!dateMissing && parsedDate === null) {
          showError(t('labs.invalidDate'));
          return;
        }
        if (!editing && measurements.length === 0) {
          showError(t('labs.requiredMeasurement'));
          return;
        }
        if (
          measurements.some(
            (measurement) =>
              measurement.label.trim().length === 0 || measurement.value.trim().length === 0,
          )
        ) {
          showError(t('labs.requiredField'));
          return;
        }
        const inputs = measurements.map(inputForMeasurement);
        if (inputs.some((input) => input === null)) {
          showError(t('labs.invalidNumeric'));
          return;
        }

        setSaving(true);
        try {
          const collectionDate =
            parsedDate === null
              ? { kind: 'missing' as const }
              : { kind: 'known' as const, value: parsedDate };
          if (editing && initialRecord !== null && initialRecord !== undefined) {
            await service.updateRecord(initialRecord.id, {
              collectionDate,
              specimenType,
              laboratoryName: laboratoryName.trim() || null,
              notes: notes.trim() || null,
            });
            allowRemovalRef.current = true;
            onSaved(initialRecord.id);
          } else {
            const record = await service.createRecord({
              collectionDate,
              specimenType,
              laboratoryName: laboratoryName.trim() || null,
              notes: notes.trim() || null,
              measurements: inputs as CreateMeasurementInput[],
            });
            allowRemovalRef.current = true;
            onSaved(record.id);
          }
        } catch {
          showError(t('labs.recordSaveError'));
        } finally {
          setSaving(false);
        }
      })();
      saveInFlightRef.current = operation;
      void operation.then(
        () => {
          if (saveInFlightRef.current === operation) saveInFlightRef.current = null;
        },
        () => {
          if (saveInFlightRef.current === operation) saveInFlightRef.current = null;
        },
      );
      return operation;
    }, [
      date,
      dateMissing,
      editing,
      initialRecord,
      laboratoryName,
      locale,
      measurements,
      notes,
      onSaved,
      service,
      showError,
      specimenType,
    ]);

    useImperativeHandle(ref, () => ({ save }), [save]);

    return (
      <SafeForm scrollRef={scrollRef}>
        {error !== null && (
          <AppText accessibilityRole="alert" style={styles.error}>
            {error}
          </AppText>
        )}
        <AppSurface style={styles.section}>
          <AppText variant="label">{t('labs.recordDateLabel')}</AppText>
          <TextInput
            accessibilityLabel={t('labs.recordDateLabel')}
            editable={!dateMissing && !saving}
            onChangeText={(value) => {
              setError(null);
              setDate(value);
            }}
            placeholder={t('labs.recordDatePlaceholder')}
            style={[styles.input, dateMissing && styles.disabledInput]}
            value={date}
          />
          <AppButton
            accessibilityRole="checkbox"
            accessibilityState={{ selected: dateMissing }}
            disabled={saving}
            label={t('labs.recordDateMissingLabel')}
            onPress={() => {
              setError(null);
              setDateMissing((current) => !current);
            }}
            tone="quiet"
          />
          {dateMissing && <StatusPill>{t('labs.dateMissing')}</StatusPill>}
          <NativePickerField
            disabled={saving}
            label={t('labs.recordSpecimenLabel')}
            onChange={(value) => {
              setError(null);
              setSpecimenType(value);
            }}
            options={specimens.map((value) => ({ value, label: specimenLabel(value) }))}
            value={specimenType}
          />
          <DisclosureButton
            expanded={showRecordDetails}
            label={showRecordDetails ? t('labs.recordLessDetails') : t('labs.recordMoreDetails')}
            onPress={() => setShowRecordDetails((current) => !current)}
          />
          {showRecordDetails && (
            <View style={styles.details}>
              <Field
                editable={!saving}
                label={t('labs.recordLabLabel')}
                onChangeText={(value) => {
                  setError(null);
                  setLaboratoryName(value);
                }}
                value={laboratoryName}
              />
              <Field
                editable={!saving}
                label={t('labs.recordNotesLabel')}
                multiline
                onChangeText={(value) => {
                  setError(null);
                  setNotes(value);
                }}
                value={notes}
              />
            </View>
          )}
        </AppSurface>

        {!editing && (
          <>
            {measurements.length === 0 && (
              <AppText style={styles.secondary}>{t('labs.recordNoMeasurements')}</AppText>
            )}
            {measurements.map((measurement, index) => {
              const detailsExpanded = expandedMeasurementDetails.has(index);
              return (
                <AppSurface key={index} style={styles.section}>
                  <AppText variant="heading">
                    {`${t('labs.recordMeasurementTitle')} ${index + 1}`}
                  </AppText>
                  <Field
                    editable={!saving}
                    label={t('labs.measurementLabel')}
                    onChangeText={(label) => updateMeasurement(index, { label })}
                    value={measurement.label}
                  />
                  <NativePickerField
                    disabled={saving}
                    label={t('labs.measurementType')}
                    onChange={(valueType) => updateMeasurement(index, { valueType })}
                    options={valueTypes.map((value) => ({ value, label: valueTypeLabel(value) }))}
                    value={measurement.valueType}
                  />
                  {measurement.valueType === 'bounded' && (
                    <NativePickerField
                      disabled={saving}
                      label={t('labs.measurementComparator')}
                      onChange={(comparator) => updateMeasurement(index, { comparator })}
                      options={[
                        { value: '<', label: '<' },
                        { value: '>', label: '>' },
                      ]}
                      value={measurement.comparator}
                    />
                  )}
                  <Field
                    editable={!saving}
                    keyboardType={
                      measurement.valueType === 'numeric' || measurement.valueType === 'bounded'
                        ? 'decimal-pad'
                        : 'default'
                    }
                    label={t('labs.measurementValue')}
                    onChangeText={(value) => updateMeasurement(index, { value })}
                    value={measurement.value}
                  />
                  <Field
                    editable={!saving}
                    label={t('labs.measurementUnit')}
                    onChangeText={(unit) => updateMeasurement(index, { unit })}
                    value={measurement.unit}
                  />
                  <DisclosureButton
                    expanded={detailsExpanded}
                    label={
                      detailsExpanded
                        ? t('labs.measurementLessDetails')
                        : t('labs.measurementMoreDetails')
                    }
                    onPress={() => toggleMeasurementDetails(index)}
                  />
                  {detailsExpanded && (
                    <View style={styles.details}>
                      <Field
                        editable={!saving}
                        label={t('labs.measurementReference')}
                        onChangeText={(referenceInterval) =>
                          updateMeasurement(index, { referenceInterval })
                        }
                        value={measurement.referenceInterval}
                      />
                      <Field
                        editable={!saving}
                        label={t('labs.measurementFlag')}
                        onChangeText={(flag) => updateMeasurement(index, { flag })}
                        value={measurement.flag}
                      />
                    </View>
                  )}
                </AppSurface>
              );
            })}
            <AppButton
              disabled={saving}
              label={t('labs.measurementAdd')}
              onPress={() => {
                setError(null);
                setMeasurements((current) => [...current, emptyMeasurement()]);
              }}
              tone="secondary"
            />
          </>
        )}
      </SafeForm>
    );
  },
);

function SafeForm({
  children,
  scrollRef,
}: {
  readonly children: ReactNode;
  readonly scrollRef: RefObject<ScrollView | null>;
}) {
  return (
    <ScreenScrollView
      contentContainerStyle={[screenStyles.content, styles.formContent]}
      keyboardShouldPersistTaps="handled"
      ref={scrollRef}
      style={screenStyles.safe}
    >
      {children}
    </ScreenScrollView>
  );
}

function Field({
  editable = true,
  keyboardType = 'default',
  label,
  multiline = false,
  onChangeText,
  value,
}: {
  readonly editable?: boolean;
  readonly keyboardType?: 'default' | 'decimal-pad';
  readonly label: string;
  readonly multiline?: boolean;
  readonly onChangeText: (value: string) => void;
  readonly value: string;
}) {
  return (
    <View style={styles.field}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        accessibilityLabel={label}
        editable={editable}
        keyboardType={keyboardType}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={t('labs.optionalPlaceholder')}
        style={[styles.input, multiline && styles.multiline, !editable && styles.disabledInput]}
        value={value}
      />
    </View>
  );
}

function NativePickerField<T extends string>({
  disabled = false,
  label,
  onChange,
  options,
  value,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (value: T) => void;
  readonly options: readonly PickerOption<T>[];
  readonly value: T;
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  const accessibilityLabel = `${label}: ${selectedLabel}`;
  return (
    <View style={styles.field}>
      <AppText variant="label">{label}</AppText>
      <View style={[styles.pickerSurface, disabled && styles.disabledPicker]}>
        <Host
          accessible
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          accessibilityValue={{ text: selectedLabel }}
          matchContents
        >
          <Picker
            appearance="menu"
            enabled={!disabled}
            onValueChange={(next) => {
              if (typeof next === 'string') onChange(next as T);
            }}
            selectedValue={value}
          >
            {options.map((option) => (
              <Picker.Item key={option.value} label={option.label} value={option.value} />
            ))}
          </Picker>
        </Host>
      </View>
    </View>
  );
}

function DisclosureButton({
  expanded,
  label,
  onPress,
}: {
  readonly expanded: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [styles.disclosure, pressed && styles.disclosurePressed]}
    >
      <AppText style={styles.disclosureLabel}>{label}</AppText>
      <AppIcon
        color={colors.accent}
        name="chevronRight"
        size={16}
        style={expanded ? styles.disclosureIconExpanded : undefined}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  formContent: { gap: spacing.md },
  section: { gap: spacing.sm },
  details: { gap: spacing.sm },
  field: { gap: spacing.xs },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: 1,
    color: colors.ink,
    ...typography.input,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  disabledInput: { color: colors.mutedInk, opacity: 0.65 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  pickerSurface: {
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.sm,
  },
  disabledPicker: { opacity: 0.65 },
  disclosure: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 44,
    paddingVertical: spacing.xs,
  },
  disclosureLabel: { color: colors.accent, flex: 1 },
  disclosureIconExpanded: { transform: [{ rotate: '90deg' }] },
  disclosurePressed: { opacity: 0.7 },
  secondary: { color: colors.mutedInk },
  error: { color: colors.danger },
});
