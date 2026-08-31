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
import { AppButton, AppSurface, AppText, TidalHero, TidalIconStage } from '../../ui/primitives';
import { colors, radii, spacing } from '../../theme';
import {
  LabReportExtractionError,
  type LabReportExtractionProgress,
  type PasswordRequest,
} from './report-service';
import {
  extractionTerminalNavigationReady,
  ExtractionProgressController,
  type ExtractionProgressTerminalDestination,
} from './extraction-progress-controller';
import { extractionFailurePresentation } from './extraction-progress-presentation';

type Route = RouteProp<RootStackParamList, 'ExtractionProgress'>;
type Navigation = NativeStackNavigationProp<RootStackParamList, 'ExtractionProgress'>;

const stages: readonly LabReportExtractionProgress['stage'][] = ['import', 'ocr', 'review'];

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
        : 'labs.extractionProgressReview',
  );
}

export function ExtractionProgressScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<Route>();
  const isFocused = useIsFocused();
  const { reports } = useServices();
  const extractionMode = route.params.mode ?? 'start';
  const [progress, setProgress] = useState<LabReportExtractionProgress | null>(() =>
    reports.getExtractionProgress(route.params.reportId),
  );
  const [failure, setFailure] = useState<LabReportExtractionError['reason'] | null>(null);
  const [activeOperation, setActiveOperation] = useState(false);
  const [cancellationRequested, setCancellationRequested] = useState(false);
  const [durableLoaded, setDurableLoaded] = useState(false);
  const [restoredProgress, setRestoredProgress] = useState<LabReportExtractionProgress | null>(
    null,
  );
  const [restoredDraftId, setRestoredDraftId] = useState<string | null | undefined>(undefined);
  const [restoredDraftLookupFailed, setRestoredDraftLookupFailed] = useState(false);
  const [terminalDestination, setTerminalDestination] =
    useState<ExtractionProgressTerminalDestination | null>(null);
  const controller = useMemo(
    () =>
      new ExtractionProgressController({
        reportId: route.params.reportId,
        startExtraction: (reportId) =>
          extractionMode === 'reprocess'
            ? reports.reprocessExtraction(reportId, passwordRequest())
            : reports.startExtraction(reportId, passwordRequest()),
        classifyFailure: (error) =>
          error instanceof LabReportExtractionError ? error.reason : 'recognition',
        setTerminalDestination,
        setActiveOperation,
        setFailure,
      }),
    [extractionMode, navigation, reports, route.params.reportId],
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
        setFailure(next.error ?? 'recognition');
      }
    });
    const current = reports.getExtractionProgress(route.params.reportId);
    if (current !== null) setProgress(current);
    void reports
      .loadExtractionProgress(route.params.reportId)
      .then((durable) => {
        if (!active) return;
        setDurableLoaded(true);
        if (extractionMode === 'reprocess') {
          // A reprocess is an explicit fresh run. Ignore the previous start operation's terminal
          // marker so the controller cannot short-circuit back to the old draft.
          setProgress(null);
          setRestoredProgress(null);
          setRestoredDraftId(undefined);
          setRestoredDraftLookupFailed(false);
          return;
        }
        if (durable === null) return;
        setProgress(durable);
        setRestoredProgress(durable);
        if (durable.status === 'active') setActiveOperation(true);
        if (durable.status !== 'complete') {
          setRestoredDraftId(null);
          setRestoredDraftLookupFailed(false);
        }
        if (durable.status === 'complete') {
          setRestoredDraftId(undefined);
          setRestoredDraftLookupFailed(false);
          void reports
            .listOpenExtractionDrafts()
            .then((drafts) => {
              if (!active) return;
              setRestoredDraftId(
                drafts.find((draft) => draft.reportId === route.params.reportId)?.draftId ?? null,
              );
            })
            .catch(() => {
              if (!active) return;
              setRestoredDraftLookupFailed(true);
              setFailure('persistence');
            });
        }
        if (
          durable.status === 'failed' ||
          durable.status === 'cancelled' ||
          durable.status === 'interrupted'
        ) {
          setFailure(durable.error ?? 'recognition');
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
  }, [controller, extractionMode, reports, route.params.reportId]);

  useEffect(() => {
    const destination = terminalDestination;
    if (
      destination === null ||
      !extractionTerminalNavigationReady(destination, {
        focused: isFocused,
        activeOperation,
        hasFailure: failure !== null,
      })
    )
      return;
    setTerminalDestination(null);
    if (destination.kind === 'draft') {
      navigation.navigate(
        'MainTabs',
        {
          screen: 'Labs',
          params: {
            screen: 'ExtractionDraft',
            params: { reportId: destination.reportId, draftId: destination.draftId },
            pop: true,
          },
        },
        { pop: true },
      );
    } else {
      navigation.navigate(
        'MainTabs',
        {
          screen: 'Labs',
          params: {
            screen: 'LabReportDetail',
            params: { reportId: destination.reportId },
            pop: true,
          },
        },
        { pop: true },
      );
    }
  }, [activeOperation, failure, isFocused, navigation, terminalDestination]);

  useEffect(() => {
    controller.evaluate({
      focused: isFocused,
      durableLoaded,
      hasFailure: failure !== null,
      cancellationRequested,
      restoredProgress: extractionMode === 'reprocess' ? null : restoredProgress,
      restoredDraftId,
    });
  }, [
    cancellationRequested,
    controller,
    durableLoaded,
    extractionMode,
    failure,
    isFocused,
    restoredDraftId,
    restoredProgress,
  ]);

  const currentStageIndex = useMemo(
    () => Math.max(0, stages.indexOf(progress?.stage ?? 'import')),
    [progress?.stage],
  );
  const failurePresentation = failure === null ? null : extractionFailurePresentation(failure);
  async function cancel() {
    await reports.cancelExtraction(route.params.reportId);
    setCancellationRequested(true);
  }

  function retry() {
    if (restoredProgress?.status === 'complete' && restoredDraftLookupFailed) {
      setRestoredDraftLookupFailed(false);
      setRestoredDraftId(undefined);
      setFailure(null);
      void reports
        .listOpenExtractionDrafts()
        .then((drafts) => {
          setRestoredDraftId(
            drafts.find((draft) => draft.reportId === route.params.reportId)?.draftId ?? null,
          );
        })
        .catch(() => {
          setRestoredDraftLookupFailed(true);
          setFailure('persistence');
        });
      return;
    }
    controller.retry();
    setFailure(null);
    setCancellationRequested(false);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.content}>
        <TidalHero style={styles.progressHero}>
          <View style={styles.progressHeroHeading}>
            <TidalIconStage name="doc" size="compact" />
            <View style={styles.progressHeroCopy}>
              <AppText variant="title" accessibilityRole="header" style={styles.title}>
                {t(
                  extractionMode === 'reprocess'
                    ? 'labs.extractionReprocessProgressTitle'
                    : 'labs.extractionProgressTitle',
                )}
              </AppText>
              <AppText style={styles.body}>
                {t(
                  extractionMode === 'reprocess'
                    ? 'labs.extractionReprocessProgressBody'
                    : 'labs.extractionProgressBody',
                )}
              </AppText>
            </View>
          </View>
        </TidalHero>
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
            {progress?.status === 'complete' ? (
              <AppSurface tone="soft" style={styles.failure}>
                <AppText variant="label">{t('labs.extractionProgressCompleteTitle')}</AppText>
                <AppText style={styles.muted}>{t('labs.extractionProgressCompleteBody')}</AppText>
                <AppButton
                  label={t('labs.extractionProgressBackToReport')}
                  onPress={() => navigation.goBack()}
                  tone="quiet"
                />
              </AppSurface>
            ) : (
              <>
                <AppButton
                  label={t('labs.extractionProgressCancel')}
                  tone="quiet"
                  disabled={cancellationRequested || !activeOperation}
                  onPress={() => void cancel()}
                />
              </>
            )}
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
  progressHero: { padding: spacing.lg },
  progressHeroHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  progressHeroCopy: { flex: 1, gap: spacing.xs, minWidth: 200 },
  title: { color: colors.onBrand },
  body: { color: colors.onBrandMuted },
  muted: { color: colors.mutedInk },
  journey: { gap: spacing.md, padding: spacing.lg },
  stage: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  stageText: { flex: 1, gap: spacing.xs },
  dot: {
    alignItems: 'center',
    backgroundColor: colors.border,
    borderRadius: radii.pill,
    height: 24,
    justifyContent: 'center',
    width: 24,
  },
  doneDot: { backgroundColor: colors.accent },
  currentDot: { backgroundColor: colors.accent },
  failure: { gap: spacing.md, padding: spacing.lg },
});
