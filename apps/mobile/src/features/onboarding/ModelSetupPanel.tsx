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
  TidalHero,
  TidalIconStage,
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
  modelSetupFailureMessageKey,
  modelSetupFailureVisible,
  modelSetupPrimaryAction,
  modelStatusTone,
  formatModelApproximateSize,
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
  readonly icon: 'phone' | 'cloud' | 'folder';
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
  const locale = Intl.NumberFormat().resolvedOptions().locale;
  const downloadSize = formatModelApproximateSize(model.manifest.pack.artifact.bytes, locale);
  const freeSpace = formatModelApproximateSize(
    model.manifest.requirements.minimumFreeBytes,
    locale,
  );

  async function startDownload() {
    cancellationRequestedRef.current = false;
    setCancelled(false);
    setCancelError(false);
    setModelFailure(null);
    setBusy(true);
    try {
      await model.startDownload();
      // Verification and promotion happen in the native module. Loading is deliberately a
      // separate extraction-scoped step; onboarding completes with the pack ready on disk and
      // never allocates the multi-gigabyte runtime.
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
    if (!ready) return;
    setBusy(true);
    setModelFailure(null);
    try {
      // The setup gate only guarantees a verified artifact on disk. Runtime allocation belongs
      // to the first extraction and must never make onboarding or cold launch pay the multi-GB
      // memory cost.
      onComplete();
    } catch (error) {
      setModelFailure(modelFailureFromError(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryModelPreparation() {
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
    <View style={styles.modelCard}>
      <TidalHero style={styles.capabilityHero}>
        <View style={styles.capabilityHeading}>
          <TidalIconStage name="lockShield" size="compact" />
          <View style={styles.capabilityCopy}>
            <StatusPill tone={modelStatusTone(snapshot)}>{statusLabel}</StatusPill>
            <AppText variant="title" style={styles.capabilityTitle} selectable>
              {contextual ? t('onboarding.contextualModelTitle') : t('onboarding.modelTitle')}
            </AppText>
            <AppText style={styles.capabilityBody} selectable>
              {contextual ? t('onboarding.contextualModelBody') : t('onboarding.modelBody')}
            </AppText>
          </View>
        </View>
      </TidalHero>

      <View accessible accessibilityRole="summary" style={styles.packHeader}>
        <AppIcon name="folder" size={28} color={colors.accent} />
        <View style={styles.packCopy}>
          <AppText variant="heading" selectable>
            {t('onboarding.privateCapabilityName')}
          </AppText>
          <AppText variant="caption" style={styles.muted} selectable>
            {t('onboarding.privateCapabilityRequired')}
          </AppText>
        </View>
      </View>

      <View accessibilityRole="summary" style={styles.facts}>
        <ModelFact icon="phone">
          {t('onboarding.modelDownloadSizeFact').replace('{size}', downloadSize)}
        </ModelFact>
        <ModelFact icon="phone">
          {t('onboarding.modelFreeSpaceFact').replace('{size}', freeSpace)}
        </ModelFact>
        <ModelFact icon="phone">{t('onboarding.modelRunsLocallyFact')}</ModelFact>
        <ModelFact icon="cloud">{t('onboarding.modelNoUploadFact')}</ModelFact>
        <ModelFact icon="folder">{t('onboarding.privateCapabilityDeletionFact')}</ModelFact>
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
    </View>
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
  modelCard: { gap: spacing.md, marginTop: spacing.md },
  capabilityHero: { padding: spacing.lg },
  capabilityHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  capabilityCopy: { flex: 1, gap: spacing.sm, minWidth: 210 },
  capabilityTitle: { color: colors.onBrand },
  capabilityBody: { color: colors.onBrandMuted },
  packHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  packCopy: { flex: 1, gap: spacing.xs },
  facts: { gap: spacing.sm },
  fact: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 32 },
  factLabel: { color: colors.ink, flexShrink: 1 },
  checking: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 44 },
  callout: { gap: spacing.sm, padding: spacing.md },
  error: { color: colors.danger },
});
