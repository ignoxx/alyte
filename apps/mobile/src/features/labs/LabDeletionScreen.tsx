import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import {
  useNavigation,
  usePreventRemove,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppButton, AppSurface, AppText } from '../../ui/primitives';
import { deletionFacts } from './record-detail-model';
import { LabDeletionScopePicker } from './LabDeletionScopePicker';
import type { LabDeletionScope } from './service';

type Route = RouteProp<RootStackParamList, 'LabDeletion'>;

function deletedMeasurementCopy(count: number): string {
  return t(
    count === 1
      ? 'labs.deletionFact.measurement_deleted'
      : 'labs.deletionFact.measurements_deleted',
  ).replace('{count}', String(count));
}

export function LabDeletionScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<Route>();
  const { labs } = useServices();
  const [scope, setScope] = useState<LabDeletionScope>(() =>
    route.params.measurementId
      ? { kind: 'measurement-only', measurementId: route.params.measurementId }
      : { kind: 'record-only', recordId: route.params.recordId },
  );
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof labs.planDeletion>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planAttempt, setPlanAttempt] = useState(0);
  const request = useRef(0);
  useLayoutEffect(
    () =>
      navigation.setOptions({
        headerLeft: () => (
          <AppButton
            disabled={busy}
            label={t('labs.recordCancel')}
            labelMaxFontSizeMultiplier={1.5}
            onPress={() => navigation.goBack()}
            tone="quiet"
          />
        ),
      }),
    [busy, navigation],
  );
  usePreventRemove(busy, () => {
    Alert.alert(t('labs.detailDeleting'), t('settings.operationInProgress'), [
      { text: t('settings.ok') },
    ]);
  });
  useEffect(() => {
    const token = ++request.current;
    setPlan(null);
    setError(null);
    void labs
      .planDeletion(scope)
      .then((next) => {
        if (token === request.current) setPlan(next);
      })
      .catch(() => {
        if (token === request.current) setError(t('labs.detailDeletionPlanError'));
      });
    return () => {
      request.current += 1;
    };
  }, [labs, planAttempt, scope]);
  const choices: readonly LabDeletionScope[] = route.params.measurementId
    ? [scope]
    : [
        { kind: 'record-only', recordId: route.params.recordId },
        { kind: 'source-only', recordId: route.params.recordId },
        { kind: 'record-plus-source', recordId: route.params.recordId },
      ];
  async function execute() {
    if (plan === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await labs.executeDeletion(scope, plan);
      if (plan.recordRemains) navigation.goBack();
      else
        navigation.reset({
          index: 0,
          routes: [
            { name: 'MainTabs', params: { screen: 'Labs', params: { screen: 'LabsRoot' } } },
          ],
        });
    } catch (cause) {
      setPlan(null);
      try {
        const refreshed = await labs.planDeletion(scope);
        setPlan(refreshed);
        setError(
          cause instanceof Error && cause.message === 'Lab deletion plan changed'
            ? t('labs.detailDeletionPlanChanged')
            : t('labs.detailDeletionRetry'),
        );
      } catch {
        setError(t('labs.detailDeletionRetry'));
      }
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    if (plan === null || busy) return;
    const scopeLabel = t(`labs.deletionScope.${scope.kind.replaceAll('-', '_')}`);
    Alert.alert(
      t('labs.detailConfirmDeletionTitle'),
      t('labs.detailConfirmDeletionBody').replace('{scope}', scopeLabel),
      [
        { text: t('labs.recordCancel'), style: 'cancel' },
        {
          text: t('labs.detailConfirmDeletion'),
          style: 'destructive',
          onPress: () => void execute(),
        },
      ],
    );
  }
  const scopeOptions = choices.map((choice) => ({
    label: t(`labs.deletionScope.${choice.kind.replaceAll('-', '_')}`),
    value: choice.kind,
  }));
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {!route.params.measurementId && (
        <AppSurface style={styles.scopeSurface}>
          <AppText variant="label">{t('labs.deletionScopeTitle')}</AppText>
          <LabDeletionScopePicker
            accessibilityLabel={t('labs.deletionScopeTitle')}
            disabled={busy}
            options={scopeOptions}
            selectedValue={scope.kind}
            onValueChange={(value) => {
              const next = choices.find((choice) => choice.kind === value);
              if (next !== undefined) setScope(next);
            }}
          />
        </AppSurface>
      )}
      <AppSurface style={styles.plan}>
        <AppText variant="heading">{t('labs.detailDeletionSummary')}</AppText>
        {plan ? (
          deletionFacts(plan).map((fact) => (
            <AppText key={fact.kind} selectable>
              {fact.kind === 'measurements-deleted'
                ? deletedMeasurementCopy(fact.count)
                : fact.kind === 'linked-records-source-deleted'
                  ? t('labs.deletionFact.linked_records').replace('{count}', String(fact.count))
                  : t(`labs.deletionFact.${fact.kind.replaceAll('-', '_')}`)}
            </AppText>
          ))
        ) : error ? (
          <View style={styles.retryGroup}>
            <AppText selectable style={styles.error}>
              {error}
            </AppText>
            <AppButton
              label={t('labs.retry')}
              onPress={() => setPlanAttempt((current) => current + 1)}
              tone="secondary"
            />
          </View>
        ) : (
          <AppText>{t('labs.loading')}</AppText>
        )}
      </AppSurface>
      {error && plan !== null && (
        <AppText accessibilityLiveRegion="polite" selectable style={styles.error}>
          {error}
        </AppText>
      )}
      <AppButton
        disabled={!plan || busy}
        label={busy ? t('labs.detailDeleting') : t('labs.detailConfirmDeletion')}
        onPress={confirm}
        tone="destructive"
      />
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  content: { gap: spacing.lg, padding: spacing.lg },
  scopeSurface: {
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  plan: { gap: spacing.md },
  retryGroup: { gap: spacing.md },
  error: { color: colors.danger },
});
