import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import {
  useNavigation,
  usePreventRemove,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { SettingsStackParamList } from '../../navigation/types';
import { useAppReset } from '../../app-reset';
import { t } from '../../localization';
import { useServices } from '../../services';
import { AppButton, AppSurface, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import { shouldHideDeletionPreview } from './deletion-ui-model';
import type { DeletionPlan, DeletionResult, LocalDeletionScope } from '../local-controls/model';

type Navigation = NativeStackNavigationProp<SettingsStackParamList, 'DeleteLocalData'>;
type Route = RouteProp<SettingsStackParamList, 'DeleteLocalData'>;

function CountRow({ label, count }: { readonly label: string; readonly count: number }) {
  return (
    <View accessible accessibilityRole="text" style={styles.countRow}>
      <AppText style={styles.countLabel}>{label}</AppText>
      <AppText selectable style={styles.count}>
        {count.toLocaleString()}
      </AppText>
    </View>
  );
}

export function DeleteLocalDataScreen() {
  const services = useServices();
  const reset = useAppReset();
  const navigation = useNavigation<Navigation>();
  const route = useRoute<Route>();
  const appReset = route.params.mode === 'app-reset';
  const scope: LocalDeletionScope = appReset ? 'reset-app' : 'all-health';
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState(false);
  const [failedOperationId, setFailedOperationId] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const [previewHidden, setPreviewHidden] = useState(false);
  // Reset has two independent local boundaries: the health store and the optional cloud session
  // markers. Keep their completion state separate so a retry resumes only the unfinished side.
  const [localResetCompleted, setLocalResetCompleted] = useState(false);
  const [deviceStateCleared, setDeviceStateCleared] = useState(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: t(appReset ? 'settings.resetTitle' : 'settings.deleteTitle'),
    });
  }, [appReset, navigation]);

  usePreventRemove(working, () => {
    Alert.alert(
      t(appReset ? 'settings.resetWorking' : 'settings.deleteWorking'),
      t('settings.operationInProgress'),
      [{ text: t('settings.ok') }],
    );
  });

  const loadPreview = useCallback(async () => {
    setLoading(true);
    setFailure(false);
    setFailedOperationId(null);
    setCompleted(false);
    setPreviewHidden(false);
    setLocalResetCompleted(false);
    setDeviceStateCleared(false);
    setPlan(null);
    try {
      setPlan(await services.controls.preview(scope));
    } catch {
      setFailure(true);
    } finally {
      setLoading(false);
    }
  }, [scope, services.controls]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  function confirmDeletion() {
    if (plan === null || plan.scope !== scope || working) return;
    Alert.alert(
      t(appReset ? 'settings.resetConfirmTitle' : 'settings.deleteConfirmTitle'),
      t(appReset ? 'settings.resetConfirmBody' : 'settings.deleteConfirmBody'),
      [
        { text: t(appReset ? 'settings.resetCancel' : 'settings.deleteCancel'), style: 'cancel' },
        {
          text: t(appReset ? 'settings.resetConfirm' : 'settings.deleteConfirm'),
          style: 'destructive',
          onPress: () => void runDeletion(plan, failure ? failedOperationId : null),
        },
      ],
    );
  }

  async function runDeletion(currentPlan: DeletionPlan, retryOperationId: string | null) {
    if (currentPlan.scope !== scope) return;
    setWorking(true);
    setFailure(false);
    try {
      if (appReset) {
        // Reset owns two independent local cleanup boundaries. Always attempt the health
        // deletion and device-only session cleanup even when the other one fails. A transient
        // Keychain failure must not leave reports and measurements behind.
        let localResult: DeletionResult | null = null;
        let localFailure = false;
        if (!localResetCompleted) {
          try {
            localResult =
              retryOperationId === null
                ? await services.controls.execute(currentPlan)
                : await services.controls.retry(retryOperationId);
            if (localResult.state === 'completed') {
              setLocalResetCompleted(true);
              setFailedOperationId(null);
            } else {
              localFailure = true;
              setFailure(true);
              if (localResult.failureCategories.includes('stale-preview')) {
                setFailedOperationId(null);
                try {
                  setPlan(await services.controls.preview(scope));
                } catch {
                  // Preserve the current plan so the retry action remains available.
                }
              } else {
                setFailedOperationId(localResult.operationId);
                if (shouldHideDeletionPreview(localResult)) {
                  setPreviewHidden(true);
                  try {
                    setPlan(await services.controls.preview(scope));
                    setPreviewHidden(false);
                  } catch {
                    // The storage-only retry remains available without showing stale counts.
                  }
                }
              }
            }
          } catch {
            localFailure = true;
            setFailure(true);
          }
        }

        let deviceFailure = false;
        if (!deviceStateCleared) {
          try {
            // This clears only device session material and never contacts the server.
            await services.account.clearDeviceState();
            setDeviceStateCleared(true);
          } catch {
            deviceFailure = true;
            setFailure(true);
          }
        }

        const localDone = localResetCompleted || localResult?.state === 'completed';
        const deviceDone = deviceStateCleared || !deviceFailure;
        if (localDone && deviceDone && !localFailure) {
          reset.restartAtOnboarding();
          return;
        }

        // Keep this screen mounted until both boundaries report success. The next tap retries
        // only the failed operation, so a completed health delete cannot be rejected as stale.
        if (localDone) {
          try {
            setPlan(await services.controls.preview(scope));
          } catch {
            // Completion is tracked separately, so the retry remains actionable if storage is busy.
          }
        }
        setFailure(true);
        return;
      }
      const result =
        retryOperationId === null
          ? await services.controls.execute(currentPlan)
          : await services.controls.retry(retryOperationId);
      if (result.state === 'completed') {
        setFailedOperationId(null);
        if (appReset) {
          reset.restartAtOnboarding();
          return;
        }
        setCompleted(true);
        setPreviewHidden(false);
        try {
          setPlan(await services.controls.preview(scope));
        } catch {
          // The completed operation remains visible even if refreshed counts are unavailable.
        }
        return;
      }

      setFailure(true);
      if (result.failureCategories.includes('stale-preview')) {
        setFailedOperationId(null);
        try {
          setPlan(await services.controls.preview(scope));
        } catch {
          setPlan(null);
        }
        return;
      }
      setFailedOperationId(result.operationId);
      if (shouldHideDeletionPreview(result)) {
        setPreviewHidden(true);
        try {
          setPlan(await services.controls.preview(scope));
          setPreviewHidden(false);
        } catch {
          // Retry remains available without showing stale pre-deletion counts.
        }
      }
    } catch {
      setFailure(true);
    } finally {
      setWorking(false);
    }
  }

  const title = t(appReset ? 'settings.resetSummaryTitle' : 'settings.deleteSummaryTitle');
  const intro = t(appReset ? 'settings.resetIntro' : 'settings.deleteIntro');
  const keepCopy = t(appReset ? 'settings.resetKeeps' : 'settings.deleteKeeps');

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText style={styles.intro}>{intro}</AppText>
        {loading ? (
          <AppText style={styles.muted}>{t('settings.privacyLoading')}</AppText>
        ) : plan === null ? (
          <AppSurface tone="soft" style={styles.message}>
            <AppText variant="heading">{t('settings.previewUnavailableTitle')}</AppText>
            <AppText style={styles.muted}>{t('settings.previewUnavailableBody')}</AppText>
            <AppButton
              label={t('settings.retry')}
              onPress={() => void loadPreview()}
              tone="secondary"
            />
          </AppSurface>
        ) : (
          <>
            {!completed && !previewHidden && (
              <AppSurface style={styles.summary}>
                <AppText variant="heading">{title}</AppText>
                <CountRow label={t('settings.privacyReports')} count={plan.counts.reports} />
                <CountRow
                  label={t('settings.privacyMeasurements')}
                  count={plan.counts.measurements}
                />
                <CountRow
                  label={t('settings.privacyIntakeEvents')}
                  count={plan.counts.intakeEvents}
                />
                <AppText style={styles.muted} variant="caption">
                  {t('settings.deleteRelatedData')}
                </AppText>
              </AppSurface>
            )}
            {!completed && (
              <AppSurface tone="soft" style={styles.message}>
                <AppText>{keepCopy}</AppText>
              </AppSurface>
            )}
            {completed && (
              <AppSurface tone="soft" style={styles.message}>
                <AppText variant="heading">{t('settings.deleteSuccessTitle')}</AppText>
                <AppText style={styles.muted}>{t('settings.deleteSuccessBody')}</AppText>
                <AppButton
                  label={t('settings.deleteDone')}
                  onPress={() => navigation.goBack()}
                  tone="secondary"
                />
              </AppSurface>
            )}
            {failure && (
              <AppText accessibilityLiveRegion="polite" selectable style={styles.failure}>
                {t(appReset ? 'settings.resetFailureBody' : 'settings.deleteFailureBody')}
              </AppText>
            )}
            {!completed && (
              <AppButton
                disabled={working}
                label={
                  working
                    ? t(appReset ? 'settings.resetWorking' : 'settings.deleteWorking')
                    : failure
                      ? t('settings.retry')
                      : t(appReset ? 'settings.resetConfirm' : 'settings.deleteConfirm')
                }
                onPress={confirmDeletion}
                tone={failure ? 'secondary' : 'destructive'}
              />
            )}
          </>
        )}
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { ...typography.body, color: colors.mutedInk, marginBottom: spacing.lg },
  muted: { color: colors.mutedInk },
  summary: { gap: spacing.sm, marginBottom: spacing.md },
  countRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: 32,
  },
  countLabel: { flex: 1, minWidth: 0 },
  count: { fontVariant: ['tabular-nums'] },
  message: { gap: spacing.sm, marginBottom: spacing.md },
  failure: { color: colors.danger, marginBottom: spacing.md },
});
