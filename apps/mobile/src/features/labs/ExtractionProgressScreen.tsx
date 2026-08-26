import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
import {
  useIsFocused,
  useNavigation,
  usePreventRemove,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import {
  LabReportExtractionError,
  type LabReportExtractionProgress,
  type PasswordRequest,
} from './report-service';
import { ExtractionProgressController } from './extraction-progress-controller';
import { extractionFailurePresentation } from './extraction-progress-presentation';
import { canStartAutomatedExtraction } from '../local-models/model';

type Route = RouteProp<RootStackParamList, 'ExtractionProgress'>;
type Navigation = NativeStackNavigationProp<RootStackParamList, 'ExtractionProgress'>;

const stages: readonly LabReportExtractionProgress['stage'][] = [
  'import',
  'ocr',
  'model',
  'review',
];

function passwordRequest(): PasswordRequest {
  return ({ report }) =>
    new Promise<string | null>((resolve) => {
      Alert.prompt(
        t('labs.reportPasswordTitle'),
        t('labs.reportPasswordBody').replace('{filename}', report.originalFilename),
        (value) => resolve(value),
        'secure-text',
        undefined,
        undefined,
        { onDismiss: () => resolve(null) },
      );
    });
}

function stageLabel(stage: LabReportExtractionProgress['stage']): string {
  return t(
    stage === 'import'
      ? 'labs.extractionProgressImport'
      : stage === 'ocr'
        ? 'labs.extractionProgressOcr'
        : stage === 'model'
          ? 'labs.extractionProgressModel'
          : 'labs.extractionProgressReview',
  );
}

export function ExtractionProgressScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<Route>();
  const isFocused = useIsFocused();
  const { reports, models } = useServices();
  const [progress, setProgress] = useState<LabReportExtractionProgress | null>(() =>
    reports.getExtractionProgress(route.params.reportId),
  );
  const [modelReady, setModelReady] = useState(false);
  const [failure, setFailure] = useState<LabReportExtractionError['reason'] | null>(null);
  const [activeOperation, setActiveOperation] = useState(false);
  const [cancellationRequested, setCancellationRequested] = useState(false);
  const [durableLoaded, setDurableLoaded] = useState(false);
  const [modelStateLoaded, setModelStateLoaded] = useState(false);
  const controller = useMemo(
    () =>
      new ExtractionProgressController({
        reportId: route.params.reportId,
        startExtraction: (reportId) => reports.startExtraction(reportId, passwordRequest()),
        classifyFailure: (error) =>
          error instanceof LabReportExtractionError ? error.reason : 'recognition',
        openModelSetup: () => navigation.navigate('ModelInstall'),
        openDraft: (reportId, draftId) =>
          navigation.navigate('MainTabs', {
            screen: 'Labs',
            params: {
              screen: 'ExtractionDraft',
              params: { reportId, draftId },
            },
          }),
        setActiveOperation,
        setFailure,
        setModelUnavailable: () => {
          setModelReady(false);
          setModelStateLoaded(true);
          setFailure(null);
        },
      }),
    [navigation, reports, route.params.reportId],
  );

  useEffect(() => {
    return () => controller.dispose();
  }, [controller]);
  usePreventRemove(activeOperation && failure === null, () => {
    // Extraction is an in-flight local write. Explicit Cancel is the only dismissal path until
    // the operation reaches a terminal state.
  });

  useEffect(() => {
    let active = true;
    const unsubscribe = reports.subscribeExtractionProgress((next) => {
      if (!active) return;
      if (next.reportId !== route.params.reportId) return;
      setProgress(next);
      if (next.status === 'active') setActiveOperation(true);
      if (
        next.status === 'failed' ||
        next.status === 'cancelled' ||
        next.status === 'interrupted'
      ) {
        setActiveOperation(false);
        if (next.error === 'model-unavailable') {
          // Model readiness is a setup concern, not a report-preservation failure screen. The
          // operation has not produced a draft, so keep the report and progress route in place
          // while the contextual setup route takes over.
          controller.modelBecameUnavailable();
        } else {
          setFailure(next.error ?? 'recognition');
        }
      }
    });
    const current = reports.getExtractionProgress(route.params.reportId);
    if (current !== null) setProgress(current);
    void reports
      .loadExtractionProgress(route.params.reportId)
      .then((durable) => {
        if (!active) return;
        setDurableLoaded(true);
        if (durable === null) return;
        setProgress(durable);
        if (durable.status === 'active') setActiveOperation(true);
        if (
          durable.status === 'failed' ||
          durable.status === 'cancelled' ||
          durable.status === 'interrupted'
        ) {
          if (durable.error === 'model-unavailable') {
            // A previous model gate may have been interrupted. Let the current native model state
            // decide whether to resume or reopen setup instead of replaying the old dead end.
            setFailure(null);
            setActiveOperation(false);
          } else {
            setFailure(durable.error ?? 'recognition');
          }
        }
      })
      .catch(() => {
        if (!active) return;
        setDurableLoaded(true);
        // The in-memory subscription remains the live source while durable state is unavailable.
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [controller, reports, route.params.reportId]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const snapshot = await models.getState();
        if (active) {
          setModelReady(canStartAutomatedExtraction(snapshot));
          setModelStateLoaded(true);
        }
      } catch {
        if (active) {
          setModelReady(false);
          setModelStateLoaded(true);
        }
      }
    };
    void refresh();
    const unsubscribe = models.subscribe((snapshot) => {
      if (active) setModelReady(canStartAutomatedExtraction(snapshot));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [models]);

  useEffect(() => {
    controller.evaluate({
      focused: isFocused,
      durableLoaded,
      modelStateLoaded,
      modelReady,
      hasFailure: failure !== null,
      cancellationRequested,
    });
  }, [
    cancellationRequested,
    controller,
    durableLoaded,
    failure,
    isFocused,
    modelReady,
    modelStateLoaded,
  ]);

  const currentStageIndex = useMemo(
    () => Math.max(0, stages.indexOf(progress?.stage ?? 'import')),
    [progress?.stage],
  );
  const failurePresentation =
    failure === null || failure === 'model-unavailable'
      ? null
      : extractionFailurePresentation(failure);
  async function cancel() {
    await reports.cancelExtraction(route.params.reportId);
    setCancellationRequested(true);
  }

  function retry() {
    controller.retry();
    setFailure(null);
    setCancellationRequested(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.content}>
        <AppText variant="heading" accessibilityRole="header" style={styles.title}>
          {t('labs.extractionProgressTitle')}
        </AppText>
        <AppText style={styles.body}>{t('labs.extractionProgressBody')}</AppText>
        <AppSurface
          tone="soft"
          accessibilityLabel={t('labs.extractionProgressJourneyLabel')}
          style={styles.journey}
        >
          {stages.map((stage, index) => {
            const stageProgress = progress?.stage === stage ? progress : null;
            const done =
              progress !== null &&
              (index < currentStageIndex ||
                (progress.status === 'complete' && index === currentStageIndex));
            const isCurrent = progress?.stage === stage && progress.status === 'active';
            return (
              <View key={stage} accessibilityLabel={stageLabel(stage)} style={styles.stage}>
                <View style={[styles.dot, done && styles.doneDot, isCurrent && styles.currentDot]}>
                  {isCurrent && (
                    <ActivityIndicator color={colors.onAccent as string} size="small" />
                  )}
                </View>
                <View style={styles.stageText}>
                  <AppText variant="label">{stageLabel(stage)}</AppText>
                  {isCurrent && stageProgress !== null && stageProgress.total > 0 && (
                    <AppText variant="caption" style={styles.muted}>
                      {stage === 'ocr'
                        ? t('labs.extractionProgressPage')
                            .replace('{current}', String(stageProgress.completed))
                            .replace('{total}', String(stageProgress.total))
                        : t('labs.extractionProgressSection')
                            .replace('{current}', String(stageProgress.completed))
                            .replace('{total}', String(stageProgress.total))}
                    </AppText>
                  )}
                </View>
              </View>
            );
          })}
        </AppSurface>
        {failurePresentation === null ? (
          <>
            {modelStateLoaded && !modelReady && (
              <>
                <AppText style={styles.muted}>{t('labs.extractionProgressModelRequired')}</AppText>
                <AppButton
                  label={t('labs.extractionModelAction')}
                  onPress={() => controller.requestModelSetup(isFocused)}
                />
              </>
            )}
            <AppButton
              label={t('labs.extractionProgressCancel')}
              tone="quiet"
              disabled={cancellationRequested || !activeOperation}
              onPress={() => void cancel()}
            />
          </>
        ) : (
          <AppSurface tone="soft" style={styles.failure}>
            <AppText variant="label">{t(failurePresentation.titleKey)}</AppText>
            <AppText style={styles.muted}>{t(failurePresentation.messageKey)}</AppText>
            <AppButton label={t('labs.extractionProgressRetry')} onPress={retry} />
            <AppButton
              label={t('labs.extractionProgressBackToReport')}
              onPress={() => navigation.goBack()}
              tone="quiet"
            />
          </AppSurface>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { backgroundColor: colors.canvas, flex: 1 },
  content: { flex: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
  title: { textAlign: 'center' },
  body: { color: colors.mutedInk, textAlign: 'center' },
  muted: { color: colors.mutedInk },
  journey: { gap: spacing.md, padding: spacing.lg },
  stage: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  stageText: { flex: 1, gap: spacing.xs },
  dot: {
    alignItems: 'center',
    backgroundColor: colors.border,
    borderRadius: 12,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  doneDot: { backgroundColor: colors.accent },
  currentDot: { backgroundColor: colors.accent },
  failure: { gap: spacing.md, padding: spacing.lg },
});
