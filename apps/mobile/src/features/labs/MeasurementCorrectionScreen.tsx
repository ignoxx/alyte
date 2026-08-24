import { useEffect, useLayoutEffect, useState } from 'react';
import {
  ActionSheetIOS,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import {
  useNavigation,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import type { Measurement } from '@alyte/domain';
import { useServices } from '../../services';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppButton, AppText } from '../../ui/primitives';
import { correctionInput, measurementDraft, type MeasurementDraft } from './record-detail-model';

type Route = RouteProp<RootStackParamList, 'MeasurementCorrection'>;
const kinds = ['numeric', 'bounded', 'categorical', 'free_text'] as const;
const specimens = ['unknown', 'blood', 'serum', 'plasma', 'urine', 'stool', 'saliva'] as const;

export function MeasurementCorrectionScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<Route>();
  const { labs } = useServices();
  const [draft, setDraft] = useState<MeasurementDraft | null>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useLayoutEffect(
    () =>
      navigation.setOptions({
        headerLeft: () => (
          <AppButton
            label={t('labs.recordCancel')}
            onPress={() => navigation.goBack()}
            tone="quiet"
          />
        ),
      }),
    [navigation],
  );
  useEffect(() => {
    void labs
      .getRecordDetail(route.params.recordId)
      .then((detail) => {
        const found = detail?.measurements.find((item) => item.id === route.params.measurementId);
        if (found) {
          setMeasurement(found);
          setDraft(measurementDraft(found));
        } else setError(t('labs.recordNotFound'));
      })
      .catch(() => setError(t('labs.recordLoadError')));
  }, [labs, route.params]);
  async function save() {
    if (!draft || !measurement) return;
    const input = correctionInput(draft, measurement, t('labs.correctionReason'));
    if (!input) {
      setError(t('labs.detailCorrectionValidation'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await labs.correctMeasurement(measurement.id, input);
      navigation.goBack();
    } catch {
      setError(t('labs.detailCorrectionPreserved'));
    } finally {
      setBusy(false);
    }
  }
  if (!draft || !measurement)
    return (
      <View style={styles.center}>
        <AppText selectable>{error ?? t('labs.loading')}</AppText>
      </View>
    );
  const choose = <T extends string>(
    title: string,
    values: readonly T[],
    current: T,
    apply: (value: T) => void,
  ) =>
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...values, t('labs.recordCancel')], cancelButtonIndex: values.length },
      (index) => {
        const value = values[index];
        if (value) apply(value);
      },
    );
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.root}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        <Field
          label={t('labs.measurementLabel')}
          value={draft.label}
          onChange={(label) => setDraft({ ...draft, label })}
        />
        <AppButton
          label={`${t('labs.measurementType')}: ${draft.kind}`}
          onPress={() =>
            choose(t('labs.measurementType'), kinds, draft.kind, (kind) =>
              setDraft({ ...draft, kind }),
            )
          }
          tone="secondary"
        />
        {draft.kind === 'bounded' && (
          <AppButton
            label={`${t('labs.measurementComparator')}: ${draft.comparator}`}
            onPress={() => setDraft({ ...draft, comparator: draft.comparator === '<' ? '>' : '<' })}
            tone="secondary"
          />
        )}
        <Field
          label={t('labs.measurementValue')}
          value={draft.value}
          onChange={(value) => setDraft({ ...draft, value })}
          keyboard={draft.kind === 'numeric' || draft.kind === 'bounded'}
        />
        <Field
          label={t('labs.measurementUnit')}
          value={draft.unit}
          onChange={(unit) => setDraft({ ...draft, unit })}
        />
        <Field
          label={t('labs.measurementReference')}
          value={draft.referenceInterval}
          onChange={(referenceInterval) => setDraft({ ...draft, referenceInterval })}
        />
        <Field
          label={t('labs.measurementFlag')}
          value={draft.flag}
          onChange={(flag) => setDraft({ ...draft, flag })}
        />
        <AppButton
          label={`${t('labs.measurementSpecimen')}: ${draft.specimenType}`}
          onPress={() =>
            choose(t('labs.measurementSpecimen'), specimens, draft.specimenType, (specimenType) =>
              setDraft({ ...draft, specimenType }),
            )
          }
          tone="secondary"
        />
        {error && (
          <AppText selectable style={styles.error}>
            {error}
          </AppText>
        )}
        <AppButton
          disabled={busy}
          label={busy ? t('labs.detailSaving') : t('labs.measurementSaveCorrection')}
          onPress={() => void save()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({
  label,
  value,
  onChange,
  keyboard = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  keyboard?: boolean;
}) {
  return (
    <View style={styles.field}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        accessibilityLabel={label}
        keyboardType={keyboard ? 'decimal-pad' : 'default'}
        onChangeText={onChange}
        style={styles.input}
        value={value}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  field: { gap: spacing.xs },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: 1,
    color: colors.ink,
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  error: { color: colors.danger },
});
