import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  GroupedRow,
  ScreenScrollView,
  StatusPill,
} from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import { t } from '../../localization';
import {
  canCompleteModelOnboarding,
  isModelDownloadActive,
  type LocalModelSnapshot,
} from '../local-models/model';
import { ModelDetailsDisclosure } from '../local-models/ModelDetailsDisclosure';
import { ModelProgress } from '../local-models/ModelProgress';
import {
  isExpectedDownloadCancellation,
  modelFailureMessageKey,
  modelStatusTone,
} from '../local-models/model-ui';
import type { LocalModelService } from '../local-models/native';

type OnboardingScreenProps = {
  model: LocalModelService;
  onComplete: () => void;
};

function ModelOption({
  selected,
  disabled,
  onPress,
}: {
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${t('onboarding.modelName')}${selected ? `, ${t('onboarding.modelSelected')}` : ''}`}
      accessibilityRole="radio"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.modelOption,
        selected && styles.modelOptionSelected,
        pressed && styles.modelOptionPressed,
      ]}
    >
      <AppIcon name="folder" size={24} color={colors.accent} />
      <View style={styles.modelOptionCopy}>
        <AppText variant="heading">{t('onboarding.modelName')}</AppText>
        <AppText style={styles.muted}>{t('onboarding.modelPublisher')}</AppText>
        <AppText variant="caption" style={styles.muted} selectable>
          {t('onboarding.modelFree')}
        </AppText>
        <AppText variant="caption" style={styles.muted}>
          {t('onboarding.modelDownloadSummary')} · {t('onboarding.modelSpaceSummary')}
        </AppText>
      </View>
      {selected ? <AppIcon name="checkmarkCircle" size={23} color={colors.accent} /> : null}
    </Pressable>
  );
}

export function OnboardingScreen({ model, onComplete }: OnboardingScreenProps) {
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null);
  const [selected, setSelected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [cancelError, setCancelError] = useState(false);
  const [bridgeUnavailable, setBridgeUnavailable] = useState(false);
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
          setBridgeUnavailable(false);
        }
      })
      .catch(() => {
        if (active) setBridgeUnavailable(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [model]);

  const ready = snapshot !== null && canCompleteModelOnboarding(snapshot);
  const downloading = snapshot !== null && isModelDownloadActive(snapshot);

  async function startDownload() {
    cancellationRequestedRef.current = false;
    setSelected(true);
    setCancelled(false);
    setCancelError(false);
    setBridgeUnavailable(false);
    setBusy(true);
    try {
      const installed = await model.startDownload();
      // Promotion and verification happen in the native module. Loading is a separate activation
      // step so onboarding never completes on a partial or merely downloaded artifact.
      if (canCompleteModelOnboarding(installed) && installed.state === 'ready') {
        await model.load();
      }
    } catch (error) {
      if (isExpectedDownloadCancellation(error, cancellationRequestedRef.current)) {
        // Native cancellation resolves cancelDownload, then rejects its pending download with a
        // typed cancellation. The completed cancellation already owns the calm outcome below.
        setSelected(false);
        setCancelled(true);
        setCancelError(false);
        setBridgeUnavailable(false);
      } else {
        // The native bridge emits a typed failure state. Keep the action retryable and do not write
        // the onboarding preference here.
        setBridgeUnavailable(true);
      }
    } finally {
      cancellationRequestedRef.current = false;
      setBusy(false);
    }
  }

  async function enterAlyte() {
    if (!ready) return;
    setBusy(true);
    setBridgeUnavailable(false);
    try {
      let current = snapshot;
      if (current?.state === 'ready') current = await model.load();
      if (current !== null && canCompleteModelOnboarding(current)) onComplete();
    } catch {
      setBridgeUnavailable(true);
    } finally {
      setBusy(false);
    }
  }

  async function cancelDownload() {
    cancellationRequestedRef.current = true;
    setCancelError(false);
    setCancelBusy(true);
    try {
      await model.cancelDownload();
      setSelected(false);
      setCancelled(true);
      setBridgeUnavailable(false);
    } catch {
      // A failed cancellation is distinct from the expected rejection of startDownload after a
      // successful cancel. Leave the operation retryable and explain the next action.
      cancellationRequestedRef.current = false;
      setCancelled(false);
      setCancelError(true);
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <View style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={styles.content} style={screenStyles.scroll}>
        <StatusPill>{t('onboarding.eyebrow')}</StatusPill>
        <AppText variant="display" style={styles.title} selectable>
          {t('onboarding.title')}
        </AppText>
        <AppText style={styles.body} selectable>
          {t('onboarding.body')}
        </AppText>

        <AppSurface tone="soft" style={styles.promiseCard}>
          <GroupedRow icon="shield">
            <AppText variant="heading">{t('onboarding.localTitle')}</AppText>
            <AppText style={styles.muted} selectable>
              {t('onboarding.localBody')}
            </AppText>
          </GroupedRow>
          <GroupedRow icon="cloud">
            <AppText variant="heading">{t('onboarding.cloudTitle')}</AppText>
            <AppText style={styles.muted} selectable>
              {t('onboarding.cloudBody')}
            </AppText>
          </GroupedRow>
          <GroupedRow icon="labs">
            <AppText variant="heading">{t('onboarding.measuredTitle')}</AppText>
            <AppText style={styles.muted} selectable>
              {t('onboarding.measuredBody')}
            </AppText>
          </GroupedRow>
        </AppSurface>

        <AppSurface style={styles.modelCard}>
          <StatusPill tone={modelStatusTone(snapshot)}>{t('onboarding.modelEyebrow')}</StatusPill>
          <AppText variant="heading" selectable>
            {t('onboarding.modelTitle')}
          </AppText>
          <AppText style={styles.muted} selectable>
            {t('onboarding.modelBody')}
          </AppText>
          <ModelOption
            disabled={downloading || busy}
            onPress={() => {
              setSelected(true);
              setCancelled(false);
              setCancelError(false);
            }}
            selected={selected}
          />
          <ModelDetailsDisclosure manifest={model.manifest} />

          {snapshot === null && !bridgeUnavailable ? (
            <View accessibilityRole="progressbar" style={styles.checking}>
              <ActivityIndicator color={colors.accent as string} />
              <AppText style={styles.muted} selectable>
                {t('onboarding.modelChecking')}
              </AppText>
            </View>
          ) : null}
          {snapshot?.state === 'failed' ? (
            <AppSurface tone="soft" style={styles.callout}>
              <AppText variant="heading" style={styles.error} selectable>
                {t(modelFailureMessageKey(snapshot.failure))}
              </AppText>
              <AppButton
                disabled={busy}
                label={t('onboarding.modelRetry')}
                onPress={() => void startDownload()}
                tone="secondary"
              />
            </AppSurface>
          ) : null}
          {bridgeUnavailable && snapshot?.state !== 'failed' ? (
            <AppSurface tone="soft" style={styles.callout}>
              <AppText variant="heading" style={styles.error} selectable>
                {t('onboarding.modelFailureUnavailable')}
              </AppText>
              <AppButton
                disabled={busy}
                label={t('onboarding.modelRetry')}
                onPress={() => void startDownload()}
                tone="secondary"
              />
            </AppSurface>
          ) : null}
          {cancelError ? (
            <AppSurface tone="soft" style={styles.callout}>
              <AppText variant="heading" style={styles.error} selectable>
                {t('onboarding.modelCancelFailure')}
              </AppText>
              <AppButton
                disabled={cancelBusy}
                label={t('onboarding.modelRetryCancel')}
                onPress={() => void cancelDownload()}
                tone="secondary"
              />
            </AppSurface>
          ) : null}
          {cancelled ? (
            <AppText style={styles.muted} selectable>
              {t('onboarding.modelCancelDisclosure')}
            </AppText>
          ) : null}

          {!cancelled && downloading && snapshot !== null ? (
            <ModelProgress snapshot={snapshot} />
          ) : null}
          {!cancelled && downloading && snapshot?.state === 'cancelling' ? (
            <AppButton disabled label={t('onboarding.modelCancelling')} tone="quiet" />
          ) : !cancelled && !cancelError && downloading && snapshot !== null ? (
            <AppButton
              disabled={cancelBusy}
              label={t('onboarding.modelCancel')}
              onPress={() => void cancelDownload()}
              tone="quiet"
            />
          ) : ready && selected ? (
            <AppButton
              disabled={busy}
              label={busy ? t('onboarding.modelEntering') : t('onboarding.continue')}
              onPress={() => void enterAlyte()}
            />
          ) : selected && !bridgeUnavailable && snapshot?.state !== 'failed' ? (
            <AppButton
              disabled={busy}
              label={t('onboarding.modelDownload')}
              onPress={() => void startDownload()}
            />
          ) : !selected && snapshot !== null && snapshot.state !== 'failed' ? (
            <AppButton
              disabled={busy}
              label={t('onboarding.modelSelect')}
              onPress={() => {
                setSelected(true);
                setCancelled(false);
                setCancelError(false);
              }}
            />
          ) : null}
        </AppSurface>
      </ScreenScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: spacing.md, padding: spacing.lg },
  title: { color: colors.ink, maxWidth: 360, marginTop: spacing.md },
  body: { color: colors.mutedInk, ...typography.body, maxWidth: 420 },
  muted: { color: colors.mutedInk },
  promiseCard: { gap: 0, marginTop: spacing.md, padding: spacing.md },
  modelCard: { gap: spacing.md, marginTop: spacing.md, padding: spacing.md },
  modelOption: {
    alignItems: 'center',
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 76,
    padding: spacing.md,
  },
  modelOptionSelected: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  modelOptionPressed: { opacity: 0.72 },
  modelOptionCopy: { flex: 1, gap: spacing.xs },
  checking: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 44 },
  callout: { gap: spacing.sm, padding: spacing.md },
  error: { color: colors.danger },
});
