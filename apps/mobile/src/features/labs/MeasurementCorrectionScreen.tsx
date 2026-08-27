import { useEffect, useLayoutEffect, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Host, Picker } from '@expo/ui';
import {
  useNavigation,
  usePreventRemove,
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
import {
  correctionDraftIsDirty,
  correctionInput,
  measurementDraft,
  type MeasurementDraft,
} from './record-detail-model';

type Route = RouteProp<RootStackParamList, 'MeasurementCorrection'>;
const kinds = ['numeric', 'bounded', 'categorical', 'free_text'] as const;
const specimens = ['unknown', 'blood', 'serum', 'plasma', 'urine', 'stool', 'saliva'] as const;

export function MeasurementCorrectionScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<Route>();
  const { labs } = useServices();
  const [draft, setDraft] = useState<MeasurementDraft | null>(null);
  const [initialDraft, setInitialDraft] = useState<MeasurementDraft | null>(null);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty =
    draft !== null && initialDraft !== null && correctionDraftIsDirty(initialDraft, draft);
  usePreventRemove((dirty || busy) && !saved, ({ data }) => {
    if (busy) return;
    Alert.alert(t('labs.detailDiscardCorrectionTitle'), t('labs.detailDiscardCorrectionBody'), [
      { text: t('labs.detailKeepEditing'), style: 'cancel' },
      {
        text: t('labs.detailDiscardCorrection'),
        style: 'destructive',
        onPress: () => navigation.dispatch(data.action),
      },
    ]);
  });
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
          // Corrections are new review work. A confirmed source must be explicitly reviewed
          // again before this edit can restore its canonical identity.
          const nextDraft = { ...measurementDraft(found), reviewState: 'needs-review' as const };
          setDraft(nextDraft);
          setInitialDraft(nextDraft);
        } else setError(t('labs.recordNotFound'));
      })
      .catch(() => setError(t('labs.recordLoadError')));
  }, [labs, route.params]);
  function updateDraft(patch: Partial<MeasurementDraft>) {
    setDraft((current) => {
      if (current === null) return current;
      return {
        ...current,
        ...patch,
        ...(patch.reviewState === undefined && current.reviewState === 'confirmed'
          ? { reviewState: 'needs-review' as const }
          : {}),
      };
    });
  }
  async function save() {
    if (!draft || !measurement || !dirty) return;
    const input = correctionInput(draft, measurement, t('labs.correctionReason'));
    if (!input) {
      setError(t('labs.detailCorrectionValidation'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await labs.correctMeasurement(measurement.id, input);
      setSaved(true);
      setTimeout(() => navigation.goBack(), 0);
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
          onChange={(label) => updateDraft({ label })}
        />
        <View style={styles.reviewField}>
          <AppText variant="label">{t('labs.measurementReviewState')}</AppText>
          <Host matchContents>
            <Picker
              appearance="menu"
              enabled={!busy}
              selectedValue={draft.reviewState}
              testID="measurement-review-state"
              onValueChange={(value) =>
                updateDraft({ reviewState: value as MeasurementDraft['reviewState'] })
              }
            >
              <Picker.Item label={t('labs.reviewConfirmed')} value="confirmed" />
              <Picker.Item label={t('labs.reviewNeedsReview')} value="needs-review" />
            </Picker>
          </Host>
        </View>
        <AppButton
          label={`${t('labs.measurementType')}: ${draft.kind}`}
          onPress={() =>
            choose(t('labs.measurementType'), kinds, draft.kind, (kind) => updateDraft({ kind }))
          }
          tone="secondary"
        />
        {draft.kind === 'bounded' && (
          <AppButton
            label={`${t('labs.measurementComparator')}: ${draft.comparator}`}
            onPress={() => updateDraft({ comparator: draft.comparator === '<' ? '>' : '<' })}
            tone="secondary"
          />
        )}
        <Field
          label={t('labs.measurementValue')}
          value={draft.value}
          onChange={(value) => updateDraft({ value })}
          keyboard={draft.kind === 'numeric' || draft.kind === 'bounded'}
        />
        <Field
          label={t('labs.measurementUnit')}
          value={draft.unit}
          onChange={(unit) => updateDraft({ unit })}
        />
        <Field
          label={t('labs.measurementReference')}
          value={draft.referenceInterval}
          onChange={(referenceInterval) => updateDraft({ referenceInterval })}
        />
        <Field
          label={t('labs.measurementFlag')}
          value={draft.flag}
          onChange={(flag) => updateDraft({ flag })}
        />
        <AppButton
          label={`${t('labs.measurementSpecimen')}: ${draft.specimenType}`}
          onPress={() =>
            choose(t('labs.measurementSpecimen'), specimens, draft.specimenType, (specimenType) =>
              updateDraft({ specimenType }),
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
          disabled={busy || !dirty}
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
  reviewField: { gap: spacing.xs },
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
