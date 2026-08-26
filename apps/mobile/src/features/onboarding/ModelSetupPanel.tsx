import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { t } from '../../localization';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  ScreenScrollView,
  StatusPill,
} from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import {
  canCompleteModelOnboarding,
  hasResumableModelDownload,
  isModelDownloadActive,
  type LocalModelSnapshot,
} from '../local-models/model';
import { ModelDetailsDisclosure } from '../local-models/ModelDetailsDisclosure';
import { ModelProgress } from '../local-models/ModelProgress';
import {
  isExpectedDownloadCancellation,
  modelFailureFromError,
  modelFailureRecoveryAction,
  modelSetupFailureMessageKey,
  modelSetupFailureVisible,
  modelSetupPrimaryAction,
  modelStatusTone,
} from '../local-models/model-ui';
import type { LocalModelService } from '../local-models/native';

type ModelSetupPanelProps = {
  readonly model: LocalModelService;
  readonly onComplete: () => void;
  readonly contextual?: boolean;
};

function ModelFact({
  icon,
  children,
}: {
  readonly icon: 'phone' | 'cloud';
  readonly children: string;
}) {
  return (
    <View style={styles.fact}>
      <AppIcon name={icon} size={17} color={colors.accent} />
      <AppText variant="caption" style={styles.factLabel} selectable>
        {children}
      </AppText>
    </View>
  );
}

export function ModelSetupPanel({ model, onComplete, contextual = false }: ModelSetupPanelProps) {
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [cancelError, setCancelError] = useState(false);
  const [modelFailure, setModelFailure] = useState<LocalModelSnapshot['failure']>(null);
  const cancellationRequestedRef = useRef(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = model.subscribe((next) => {
      if (active) setSnapshot(next);
    });
    void model
      .getState()
      .then((next) => {
        if (active) {
          setSnapshot(next);
          setModelFailure(null);
        }
      })
      .catch(() => {
        if (active) setModelFailure('unavailable');
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [model]);

  const downloading = snapshot !== null && isModelDownloadActive(snapshot);
  const resumable = hasResumableModelDownload(snapshot);
  const primaryAction = modelSetupPrimaryAction(snapshot, modelFailure);
  const ready = snapshot !== null && canCompleteModelOnboarding(snapshot);
  const failed = snapshot?.state === 'failed';
  const setupFailureVisible = modelSetupFailureVisible(snapshot, modelFailure);
  const showCancelError = cancelError && !resumable;

  async function startDownload() {
    cancellationRequestedRef.current = false;
    setCancelled(false);
    setCancelError(false);
    setModelFailure(null);
    setBusy(true);
    try {
      const installed = await model.startDownload();
      // Verification and promotion happen in the native module. Loading is a separate step so
      // setup never reports success for a merely downloaded or partially verified artifact.
      if (canCompleteModelOnboarding(installed) && installed.state === 'ready') {
        await model.load();
      }
    } catch (error) {
      if (isExpectedDownloadCancellation(error, cancellationRequestedRef.current)) {
        setCancelled(true);
        setCancelError(false);
        setModelFailure(null);
      } else {
        // Native state remains the source of truth; this transient category only chooses the
        // next recovery action and never changes model lifecycle state itself.
        setModelFailure(modelFailureFromError(error));
      }
    } finally {
      cancellationRequestedRef.current = false;
      setBusy(false);
    }
  }

  async function openAlyte() {
    if (!ready && modelFailureRecoveryAction(snapshot) !== 'activate') return;
    setBusy(true);
    setModelFailure(null);
    try {
      let current = snapshot;
      if (current?.state === 'ready') current = await model.load();
      if (current !== null && canCompleteModelOnboarding(current)) onComplete();
    } catch (error) {
      setModelFailure(modelFailureFromError(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryModelPreparation() {
    if (modelFailureRecoveryAction(snapshot) === 'activate') {
      await openAlyte();
      return;
    }
    await startDownload();
  }

  async function cancelDownload() {
    cancellationRequestedRef.current = true;
    setCancelError(false);
    setCancelBusy(true);
    try {
      await model.cancelDownload();
      setCancelled(true);
      setModelFailure(null);
    } catch {
      // Cancellation can fail independently of the pending transfer. Keep the transfer visible
      // and offer only the safe cancellation retry until the native queue settles.
      cancellationRequestedRef.current = false;
      setCancelled(false);
      setCancelError(true);
    } finally {
      setCancelBusy(false);
    }
  }

  const statusLabel = ready ? t('onboarding.modelReady') : t('onboarding.modelEyebrow');
  const failureForMessage = failed ? (snapshot?.failure ?? null) : modelFailure;

  return (
    <AppSurface style={styles.modelCard}>
      <StatusPill tone={modelStatusTone(snapshot)}>{statusLabel}</StatusPill>
      <AppText variant="heading" selectable>
        {contextual ? t('onboarding.contextualModelTitle') : t('onboarding.modelTitle')}
      </AppText>
      <AppText style={styles.muted} selectable>
        {contextual ? t('onboarding.contextualModelBody') : t('onboarding.modelBody')}
      </AppText>

      <View accessible accessibilityRole="summary" style={styles.packHeader}>
        <AppIcon name="folder" size={28} color={colors.accent} />
        <View style={styles.packCopy}>
          <AppText variant="heading" selectable>
            {t('onboarding.modelName')}
          </AppText>
          <AppText variant="caption" style={styles.muted} selectable>
            {t('onboarding.modelRequiredLabel')}
          </AppText>
        </View>
      </View>

      <View accessibilityRole="summary" style={styles.facts}>
        <ModelFact icon="phone">{t('onboarding.modelSizeFact')}</ModelFact>
        <ModelFact icon="phone">{t('onboarding.modelSpaceFact')}</ModelFact>
        <ModelFact icon="phone">{t('onboarding.modelRunsLocallyFact')}</ModelFact>
        <ModelFact icon="cloud">{t('onboarding.modelNoUploadFact')}</ModelFact>
      </View>

      {snapshot === null && modelFailure === null ? (
        <View accessibilityRole="progressbar" style={styles.checking}>
          <ActivityIndicator color={colors.accent as string} />
          <AppText style={styles.muted} selectable>
            {t('onboarding.modelChecking')}
          </AppText>
        </View>
      ) : null}

      {resumable && snapshot !== null ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText variant="heading" selectable>
            {t('onboarding.modelSetupPartialSaved').replace(
              '{progress}',
              String(Math.round(snapshot.progress * 100)),
            )}
          </AppText>
        </AppSurface>
      ) : null}

      {setupFailureVisible && !showCancelError ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText variant="heading" style={styles.error} selectable>
            {t(modelSetupFailureMessageKey(failureForMessage))}
          </AppText>
        </AppSurface>
      ) : null}

      {showCancelError ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText variant="heading" style={styles.error} selectable>
            {t('onboarding.modelCancelFailure')}
          </AppText>
        </AppSurface>
      ) : null}

      {cancelled && !resumable && !setupFailureVisible ? (
        <AppText style={styles.muted} selectable>
          {t('onboarding.modelSetupCancelDisclosure')}
        </AppText>
      ) : null}

      {(downloading || resumable) && snapshot !== null ? (
        <ModelProgress snapshot={snapshot} />
      ) : null}
      {downloading && snapshot?.state !== 'cancelling' ? (
        <AppText style={styles.muted} selectable>
          {t('onboarding.modelKeepOpen')}
        </AppText>
      ) : null}

      {showCancelError ? (
        <AppButton
          disabled={cancelBusy}
          label={t('onboarding.modelRetryCancel')}
          onPress={() => void cancelDownload()}
          tone="secondary"
        />
      ) : primaryAction === 'cancel' ? (
        <AppButton
          disabled={cancelBusy}
          label={t('onboarding.modelCancel')}
          onPress={() => void cancelDownload()}
          tone="quiet"
        />
      ) : primaryAction === 'cancelling' ? (
        <AppButton disabled label={t('onboarding.modelCancelling')} tone="quiet" />
      ) : primaryAction === 'continue' ? (
        <AppButton
          disabled={busy}
          label={t('onboarding.modelContinueDownload')}
          onPress={() => void startDownload()}
          tone="secondary"
        />
      ) : primaryAction === 'retry' ? (
        <AppButton
          disabled={busy}
          label={t('onboarding.modelRetry')}
          onPress={() => void retryModelPreparation()}
          tone="secondary"
        />
      ) : primaryAction === 'download' ? (
        <AppButton
          disabled={busy}
          label={t('onboarding.modelDownload')}
          onPress={() => void startDownload()}
        />
      ) : primaryAction === 'open' ? (
        <AppButton
          disabled={busy}
          label={busy ? t('onboarding.modelEntering') : t('onboarding.modelOpen')}
          onPress={() => void openAlyte()}
        />
      ) : null}

      <ModelDetailsDisclosure manifest={model.manifest} />
    </AppSurface>
  );
}

export function ModelSetupScreen({ model, onComplete, contextual = false }: ModelSetupPanelProps) {
  return (
    <View style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={styles.content} style={screenStyles.scroll}>
        {!contextual ? (
          <>
            <StatusPill>{t('onboarding.eyebrow')}</StatusPill>
            <AppText variant="display" style={styles.title} selectable>
              {t('onboarding.title')}
            </AppText>
            <AppText style={styles.body} selectable>
              {t('onboarding.body')}
            </AppText>
          </>
        ) : null}
        <ModelSetupPanel contextual={contextual} model={model} onComplete={onComplete} />
      </ScreenScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: spacing.md, padding: spacing.lg },
  title: { color: colors.ink, maxWidth: 360, marginTop: spacing.md },
  body: { color: colors.mutedInk, ...typography.body, maxWidth: 420 },
  muted: { color: colors.mutedInk },
  modelCard: { gap: spacing.md, marginTop: spacing.md, padding: spacing.md },
  packHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  packCopy: { flex: 1, gap: spacing.xs },
  facts: { gap: spacing.sm },
  fact: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 32 },
  factLabel: { color: colors.ink, flexShrink: 1 },
  checking: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 44 },
  callout: { gap: spacing.sm, padding: spacing.md },
  error: { color: colors.danger },
});
