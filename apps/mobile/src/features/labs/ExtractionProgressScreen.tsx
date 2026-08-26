import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

function failureMessage(reason: LabReportExtractionError['reason']): string {
  if (reason === 'model-unavailable') return t('labs.extractionProgressModelRequired');
  if (reason === 'wrong-password') return t('labs.extractionProgressPasswordError');
  if (reason === 'original-source') return t('labs.extractionProgressSourceError');
  if (reason === 'no-reviewable-measurements') return t('labs.extractionNoMeasurementsError');
  if (reason === 'cancelled') return t('labs.extractionProgressCancelled');
  if (reason === 'interrupted') return t('labs.extractionProgressInterrupted');
  return t('labs.extractionRecognitionError');
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
  const started = useRef(false);
  const completed = useRef(false);
  const mounted = useRef(true);
  const focused = useRef(isFocused);

  useEffect(() => {
    focused.current = isFocused;
  }, [isFocused]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  usePreventRemove(activeOperation && failure === null, () => {
    // Extraction is an in-flight local write. Explicit Cancel is the only dismissal path until
    // the operation reaches a terminal state.
  });

  useEffect(() => {
    const unsubscribe = reports.subscribeExtractionProgress((next) => {
      if (next.reportId !== route.params.reportId) return;
      setProgress(next);
      if (next.status === 'active') setActiveOperation(true);
      if (
        next.status === 'failed' ||
        next.status === 'cancelled' ||
        next.status === 'interrupted'
      ) {
        setFailure(next.error ?? 'recognition');
        setActiveOperation(false);
      }
    });
    const current = reports.getExtractionProgress(route.params.reportId);
    if (current !== null) setProgress(current);
    void reports
      .loadExtractionProgress(route.params.reportId)
      .then((durable) => {
        setDurableLoaded(true);
        if (!mounted.current || durable === null) return;
        setProgress(durable);
        if (durable.status === 'active') setActiveOperation(true);
        if (
          durable.status === 'failed' ||
          durable.status === 'cancelled' ||
          durable.status === 'interrupted'
        ) {
          setFailure(durable.error ?? 'recognition');
        }
      })
      .catch(() => {
        setDurableLoaded(true);
        // The in-memory subscription remains the live source while durable state is unavailable.
      });
    return unsubscribe;
  }, [reports, route.params.reportId]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const snapshot = await models.getState();
        if (active) setModelReady(canStartAutomatedExtraction(snapshot));
      } catch {
        if (active) setModelReady(false);
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

  const start = useCallback(async () => {
    if (
      started.current ||
      completed.current ||
      !isFocused ||
      !durableLoaded ||
      failure !== null ||
      cancellationRequested
    )
      return;
    started.current = true;
    setActiveOperation(true);
    setCancellationRequested(false);
    setFailure(null);
    try {
      const draft = await reports.startExtraction(route.params.reportId, passwordRequest());
      completed.current = true;
      setActiveOperation(false);
      if (!mounted.current || !focused.current) return;
      navigation.navigate('MainTabs', {
        screen: 'Labs',
        params: {
          screen: 'ExtractionDraft',
          params: { reportId: route.params.reportId, draftId: draft.id },
        },
      });
    } catch (error) {
      setFailure(error instanceof LabReportExtractionError ? error.reason : 'recognition');
      started.current = false;
      setActiveOperation(false);
    }
  }, [
    cancellationRequested,
    durableLoaded,
    failure,
    isFocused,
    modelReady,
    navigation,
    reports,
    route.params.reportId,
  ]);

  useEffect(() => {
    void start();
  }, [start]);

  const currentStageIndex = useMemo(
    () => Math.max(0, stages.indexOf(progress?.stage ?? 'import')),
    [progress?.stage],
  );
  async function cancel() {
    await reports.cancelExtraction(route.params.reportId);
    setCancellationRequested(true);
  }

  function retry() {
    completed.current = false;
    started.current = false;
    setFailure(null);
    setCancellationRequested(false);
    void start();
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.content}>
        <AppText variant="heading" accessibilityRole="header" style={styles.title}>
          {failure === null
            ? t('labs.extractionProgressTitle')
            : t('labs.extractionProgressFailedTitle')}
        </AppText>
        {failure === null ? (
          <>
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
                    <View
                      style={[styles.dot, done && styles.doneDot, isCurrent && styles.currentDot]}
                    >
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
            {!modelReady && (
              <>
                <AppText style={styles.muted}>{t('labs.extractionProgressModelRequired')}</AppText>
                <AppButton
                  label={t('labs.extractionModelAction')}
                  onPress={() => navigation.navigate('ModelInstall')}
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
            <AppText style={styles.body}>{failureMessage(failure)}</AppText>
            {failure === 'model-unavailable' ? (
              <AppButton
                label={t('labs.extractionModelAction')}
                onPress={() => navigation.navigate('ModelInstall')}
              />
            ) : (
              <AppButton label={t('labs.extractionProgressRetry')} onPress={retry} />
            )}
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
