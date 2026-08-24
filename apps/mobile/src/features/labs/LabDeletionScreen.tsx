import { useEffect, useLayoutEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { spacing } from '../../theme';
import { AppButton, AppSurface, AppText } from '../../ui/primitives';
import { deletionFacts } from './record-detail-model';
import type { LabDeletionScope } from './service';

type Route = RouteProp<RootStackParamList, 'LabDeletion'>;
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
    setPlan(null);
    setError(null);
    void labs
      .planDeletion(scope)
      .then(setPlan)
      .catch(() => setError(t('labs.detailDeletionPlanError')));
  }, [labs, scope]);
  const choices: readonly LabDeletionScope[] = route.params.measurementId
    ? [scope]
    : [
        { kind: 'record-only', recordId: route.params.recordId },
        { kind: 'source-only', recordId: route.params.recordId },
        { kind: 'record-plus-source', recordId: route.params.recordId },
      ];
  async function execute() {
    setBusy(true);
    setError(null);
    try {
      await labs.executeDeletion(scope);
      navigation.goBack();
    } catch {
      setError(t('labs.detailDeletionRetry'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {!route.params.measurementId && (
        <View style={styles.choices}>
          {choices.map((choice) => (
            <AppButton
              key={choice.kind}
              label={t(`labs.deletionScope.${choice.kind.replaceAll('-', '_')}`)}
              onPress={() => setScope(choice)}
              tone={scope.kind === choice.kind ? 'primary' : 'secondary'}
            />
          ))}
        </View>
      )}
      <AppSurface style={styles.plan}>
        <AppText variant="heading">{t('labs.detailDeletionPreview')}</AppText>
        {plan ? (
          deletionFacts(plan).map((fact) => (
            <AppText key={fact} selectable>
              {fact.startsWith('measurements-deleted:')
                ? t('labs.deletionFact.measurements_deleted').replace(
                    '{count}',
                    fact.split(':')[1]!,
                  )
                : fact.startsWith('linked-records-source-deleted:')
                  ? t('labs.deletionFact.linked_records').replace('{count}', fact.split(':')[1]!)
                  : t(`labs.deletionFact.${fact.replaceAll('-', '_')}`)}
            </AppText>
          ))
        ) : (
          <AppText>{error ?? t('labs.loading')}</AppText>
        )}
      </AppSurface>
      {error && <AppText selectable>{error}</AppText>}
      <AppButton
        disabled={!plan || busy}
        label={busy ? t('labs.detailDeleting') : t('labs.detailConfirmDeletion')}
        onPress={() => void execute()}
        tone="secondary"
      />
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  content: { gap: spacing.lg, padding: spacing.lg },
  choices: { gap: spacing.sm },
  plan: { gap: spacing.md },
});
