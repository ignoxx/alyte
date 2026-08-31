import { Host, Switch } from '@expo/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { useServices } from '../../services';
import { AppButton, AppIcon, AppSurface, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, radii, screenStyles, spacing } from '../../theme';
import type { ExportSelection } from '../export/export-contract';
import type { LocalExportOperation, LocalExportProgress } from '../export/service';
import type { ExportMediaSummary } from '../local-controls/model';
import { exportMediaOptionState, type ExportMediaSummaryStatus } from './export-ui-model';

type ExportStage = 'selection' | 'preview' | 'working' | 'result';
type ResultKind = 'success' | 'cancelled' | 'failed' | 'unavailable';

function shareResultForError(error: unknown): Extract<ResultKind, 'failed' | 'unavailable'> {
  return error instanceof Error &&
    /unavailable|unsupported|not registered|no share/i.test(error.message)
    ? 'unavailable'
    : 'failed';
}

function availableLabel(count: number, status: ExportMediaSummaryStatus): string {
  if (status === 'loading') return t('settings.exportMediaChecking');
  if (status === 'failed') return t('settings.exportMediaUnavailableCount');
  const countLabel = t('settings.exportCount').replace('{count}', count.toLocaleString());
  return count > 0 ? countLabel : `${countLabel} · ${t('settings.exportUnavailable')}`;
}

function selectedLabel(selected: number, available: number): string {
  return t('settings.exportSelectedCount')
    .replace('{selected}', selected.toLocaleString())
    .replace('{available}', available.toLocaleString());
}

function progressLabel(progress: LocalExportProgress | null): string {
  if (progress === null) return t('settings.exportProgressPreparing');
  const phaseKey: Record<LocalExportProgress['phase'], string> = {
    staging: 'settings.exportProgressStaging',
    archiving: 'settings.exportProgressArchiving',
    promoting: 'settings.exportProgressPromoting',
    ready: 'settings.exportProgressReady',
    cancelled: 'settings.exportCancelledTitle',
    failed: 'settings.exportFailedTitle',
  };
  const phase = t(phaseKey[progress.phase]);
  if (progress.totalEntries <= 0) return phase;
  return `${phase} · ${t('settings.exportProgressPercent').replace(
    '{percent}',
    Math.round((progress.completedEntries / progress.totalEntries) * 100).toLocaleString(),
  )}`;
}

function ExportToggle({
  title,
  count,
  status,
  value,
  onValueChange,
}: {
  readonly title: string;
  readonly count: number;
  readonly status: ExportMediaSummaryStatus;
  readonly value: boolean;
  readonly onValueChange: (next: boolean) => void;
}) {
  const option = exportMediaOptionState(status, count, value);
  const countLabel = availableLabel(count, status);
  const accessibilityLabel = `${title}, ${countLabel}`;

  return (
    <View
      accessible
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: option.selected, disabled: option.disabled }}
      onAccessibilityTap={() => {
        if (!option.disabled) onValueChange(!option.selected);
      }}
      style={styles.toggleRow}
    >
      <View style={[styles.toggleCopy, option.availability === 'empty' && styles.unavailableCopy]}>
        <AppText>{title}</AppText>
        <AppText variant="caption" style={styles.muted}>
          {countLabel}
        </AppText>
      </View>
      <View
        style={styles.switchSlot}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Host matchContents>
          <Switch
            value={option.selected}
            disabled={option.disabled}
            onValueChange={(next) => {
              if (!option.disabled) onValueChange(next);
            }}
          />
        </Host>
      </View>
    </View>
  );
}

export function FullExportScreen() {
  const services = useServices();
  const navigation = useNavigation<any>();
  const [media, setMedia] = useState<ExportMediaSummary | null>(null);
  const [mediaStatus, setMediaStatus] = useState<ExportMediaSummaryStatus>('loading');
  const [mediaRetry, setMediaRetry] = useState(0);
  const [stage, setStage] = useState<ExportStage>('selection');
  const [includeOriginal, setIncludeOriginal] = useState(false);
  const [includeSanitized, setIncludeSanitized] = useState(false);
  const [includeIntake, setIncludeIntake] = useState(false);
  const [progress, setProgress] = useState<LocalExportProgress | null>(null);
  const [result, setResult] = useState<ResultKind | null>(null);
  const [operation, setOperation] = useState<LocalExportOperation | null>(null);
  const cancelRequestedRef = useRef(false);
  const cancelInFlightRef = useRef(false);

  useEffect(() => {
    let active = true;
    setMediaStatus('loading');
    void services.controls
      .exportMediaSummary()
      .then((summary) => {
        if (active) {
          setMedia(summary);
          setMediaStatus('ready');
        }
      })
      .catch(() => {
        if (active) {
          setMedia(null);
          setMediaStatus('failed');
        }
      });
    return () => {
      active = false;
    };
  }, [mediaRetry, services.controls]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: t('settings.exportTitle'),
      headerLeft: () => (
        <AppButton
          label={t('cancel')}
          tone="quiet"
          onPress={() => (stage === 'working' ? void cancelWorkingExport() : navigation.goBack())}
        />
      ),
      headerRight:
        stage === 'result'
          ? () => (
              <AppButton
                label={t('settings.exportDone')}
                tone="quiet"
                onPress={() => navigation.goBack()}
              />
            )
          : undefined,
    });
  }, [navigation, stage]);

  function selection(): ExportSelection {
    if (media === null) return {};
    const original = exportMediaOptionState(
      mediaStatus,
      media.counts.originalReports,
      includeOriginal,
    );
    const sanitized = exportMediaOptionState(
      mediaStatus,
      media.counts.sanitizedReports,
      includeSanitized,
    );
    const intake = exportMediaOptionState(mediaStatus, media.counts.intakeImages, includeIntake);
    return {
      originalReportIds: original.selected ? (media.selection.originalReportIds ?? []) : [],
      sanitizedReportDerivativeIds: sanitized.selected
        ? (media.selection.sanitizedReportDerivativeIds ?? [])
        : [],
      intakeImageEventIds: intake.selected ? (media.selection.intakeImageEventIds ?? []) : [],
    };
  }

  function startExport() {
    const nextOperation = services.export.start({ selection: selection() });
    setOperation(nextOperation);
    cancelRequestedRef.current = false;
    setStage('working');
    setProgress(null);
    const unsubscribe = nextOperation.subscribe((nextProgress) => setProgress(nextProgress));
    void nextOperation.promise
      .then(async (prepared) => {
        unsubscribe();
        const path = await services.export.sharePath(prepared.job.id);
        // React Native's iOS action-sheet bridge accepts a local file URL and returns a distinct
        // dismissedAction. Keeping this seam here lets the #54 terminal cleanup distinguish a
        // user dismissal from a native share failure without attaching any health metadata.
        const shareResult = await Share.share({
          url: path,
          title: t('settings.exportTitle'),
        });
        if (shareResult.action === Share.dismissedAction) {
          await services.export.cancelShare(prepared.job.id);
          setResult('cancelled');
        } else {
          await services.export.completeShare(prepared.job.id);
          setResult('success');
        }
        setStage('result');
      })
      .catch(async (error: unknown) => {
        unsubscribe();
        try {
          if (nextOperation.operationId)
            await services.export.cancelShare(nextOperation.operationId);
        } catch {
          // The export service retains a retryable cleanup state.
        }
        setResult(cancelRequestedRef.current ? 'cancelled' : shareResultForError(error));
        setStage('result');
      });
  }

  async function cancelWorkingExport() {
    if (operation === null || cancelInFlightRef.current) return;
    cancelInFlightRef.current = true;
    cancelRequestedRef.current = true;
    try {
      await operation.cancel();
      setResult('cancelled');
      setStage('result');
    } catch {
      setResult('failed');
      setStage('result');
    } finally {
      cancelInFlightRef.current = false;
    }
  }

  // The native stack can receive a swipe-back/remove action while the archive is being built.
  // Route that action through the same explicit cancellation lifecycle as the visible Cancel
  // button; never leave a ready archive behind because a route disappeared mid-operation.
  usePreventRemove(stage === 'working', () => {
    void cancelWorkingExport();
  });

  useEffect(() => {
    if (mediaStatus !== 'ready' || media === null) return;
    setIncludeOriginal(
      (selected) =>
        exportMediaOptionState(mediaStatus, media.counts.originalReports, selected).selected,
    );
    setIncludeSanitized(
      (selected) =>
        exportMediaOptionState(mediaStatus, media.counts.sanitizedReports, selected).selected,
    );
    setIncludeIntake(
      (selected) =>
        exportMediaOptionState(mediaStatus, media.counts.intakeImages, selected).selected,
    );
  }, [media, mediaStatus]);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        contentInset={{ bottom: spacing.xxl }}
        style={screenStyles.scroll}
      >
        {stage === 'selection' && (
          <>
            <AppText variant="heading" style={styles.title}>
              {t('settings.exportSelectTitle')}
            </AppText>
            <AppText style={styles.intro}>{t('settings.exportSelectBody')}</AppText>
            <View style={styles.group}>
              <View style={styles.structuredRow}>
                <AppIcon name="doc" size={21} color={colors.accent} />
                <View style={styles.toggleCopy}>
                  <AppText>{t('settings.exportStructured')}</AppText>
                  <AppText variant="caption" style={styles.muted}>
                    {t('settings.exportStructuredSubtitle')}
                  </AppText>
                </View>
                <AppIcon name="shield" size={18} color={colors.mutedInk} />
              </View>
              <ExportToggle
                title={t('settings.exportOriginalReports')}
                count={media?.counts.originalReports ?? 0}
                status={mediaStatus}
                value={includeOriginal}
                onValueChange={setIncludeOriginal}
              />
              <ExportToggle
                title={t('settings.exportSanitizedReports')}
                count={media?.counts.sanitizedReports ?? 0}
                status={mediaStatus}
                value={includeSanitized}
                onValueChange={setIncludeSanitized}
              />
              <ExportToggle
                title={t('settings.exportIntakeImages')}
                count={media?.counts.intakeImages ?? 0}
                status={mediaStatus}
                value={includeIntake}
                onValueChange={setIncludeIntake}
              />
            </View>
            {mediaStatus === 'failed' && (
              <AppSurface tone="soft" style={styles.unavailableSurface}>
                <AppText variant="label">{t('settings.exportMediaUnavailable')}</AppText>
                <AppText style={styles.muted}>{t('settings.exportMediaUnavailableBody')}</AppText>
                <AppButton
                  label={t('settings.exportMediaRetry')}
                  tone="secondary"
                  onPress={() => setMediaRetry((value) => value + 1)}
                />
              </AppSurface>
            )}
            <AppButton
              label={t('settings.exportContinue')}
              disabled={mediaStatus !== 'ready'}
              onPress={() => setStage('preview')}
            />
          </>
        )}
        {stage === 'preview' && (
          <>
            <AppText variant="heading" style={styles.title}>
              {t('settings.exportPreviewTitle')}
            </AppText>
            <AppSurface tone="soft" style={styles.warningSurface}>
              <AppText>{t('settings.exportPreviewBody')}</AppText>
            </AppSurface>
            <View style={styles.previewList}>
              <AppText>{t('settings.exportStructured')}</AppText>
              <AppText>
                {t('settings.exportOriginalReports')}:{' '}
                {includeOriginal
                  ? selectedLabel(
                      media?.counts.originalReports ?? 0,
                      media?.counts.originalReports ?? 0,
                    )
                  : t('settings.exportOff')}
              </AppText>
              <AppText>
                {t('settings.exportSanitizedReports')}:{' '}
                {includeSanitized
                  ? selectedLabel(
                      media?.counts.sanitizedReports ?? 0,
                      media?.counts.sanitizedReports ?? 0,
                    )
                  : t('settings.exportOff')}
              </AppText>
              <AppText>
                {t('settings.exportIntakeImages')}:{' '}
                {includeIntake
                  ? selectedLabel(media?.counts.intakeImages ?? 0, media?.counts.intakeImages ?? 0)
                  : t('settings.exportOff')}
              </AppText>
            </View>
            <AppButton label={t('settings.exportCreate')} onPress={startExport} />
          </>
        )}
        {stage === 'working' && (
          <>
            <AppText variant="heading" style={styles.title}>
              {t('settings.exportCreating')}
            </AppText>
            <AppText style={styles.intro}>{t('settings.exportProgress')}</AppText>
            <AppSurface style={styles.progressSurface}>
              <AppText selectable accessibilityLabel={progressLabel(progress)}>
                {progressLabel(progress)}
              </AppText>
            </AppSurface>
            <AppButton
              label={t('cancel')}
              tone="secondary"
              onPress={() => void cancelWorkingExport()}
            />
          </>
        )}
        {stage === 'result' && result !== null && (
          <>
            <AppText variant="heading" style={styles.title}>
              {result === 'success'
                ? t('settings.exportDoneTitle')
                : result === 'cancelled'
                  ? t('settings.exportCancelledTitle')
                  : result === 'unavailable'
                    ? t('settings.exportUnavailableTitle')
                    : t('settings.exportFailedTitle')}
            </AppText>
            <AppText style={styles.intro}>
              {result === 'success'
                ? t('settings.exportDoneBody')
                : result === 'cancelled'
                  ? t('settings.exportCancelledBody')
                  : result === 'unavailable'
                    ? t('settings.exportUnavailableBody')
                    : t('settings.exportFailedBody')}
            </AppText>
          </>
        )}
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: spacing.md },
  intro: { color: colors.mutedInk, lineHeight: 22, marginBottom: spacing.lg },
  muted: { color: colors.mutedInk },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg,
    overflow: 'hidden',
  },
  structuredRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 65,
    paddingHorizontal: spacing.lg,
  },
  toggleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 65,
    paddingHorizontal: spacing.lg,
  },
  toggleCopy: { flex: 1, flexShrink: 1, gap: spacing.xs, minWidth: 0 },
  unavailableCopy: { opacity: 0.7 },
  switchSlot: {
    alignItems: 'flex-end',
    flexShrink: 0,
    minHeight: 44,
    width: 52,
  },
  warningSurface: { gap: spacing.md, marginBottom: spacing.lg },
  unavailableSurface: { gap: spacing.sm, marginBottom: spacing.lg },
  previewList: { gap: spacing.md, marginBottom: spacing.lg },
  progressSurface: { alignItems: 'center', marginBottom: spacing.lg, paddingVertical: spacing.xl },
});
