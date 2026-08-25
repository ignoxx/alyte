import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton, AppSurface, AppText, GroupedRow, StatusPill } from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import { t } from '../../localization';
import { canCompleteModelOnboarding, type LocalModelSnapshot } from '../local-models/model';
import type { LocalModelService } from '../local-models/native';
import { formatModelBytes } from '../local-models/manifest';

type OnboardingScreenProps = {
  model: LocalModelService;
  onComplete: () => void;
};

function modelFailure(failure: LocalModelSnapshot['failure']): string {
  if (failure === 'offline') return t('onboarding.modelFailureOffline');
  if (failure === 'insufficient-space') return t('onboarding.modelFailureSpace');
  if (failure === 'checksum-mismatch' || failure === 'size-mismatch') {
    return t('onboarding.modelFailureChecksum');
  }
  if (failure === 'incompatible') return t('onboarding.modelFailureIncompatible');
  if (
    failure === 'http-failed' ||
    failure === 'upstream-missing' ||
    failure === 'redirect-rejected'
  ) {
    return t('onboarding.modelFailureNetwork');
  }
  return t('onboarding.modelFailureGeneric');
}

export function OnboardingScreen({ model, onComplete }: OnboardingScreenProps) {
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null);
  const [selected, setSelected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [bridgeUnavailable, setBridgeUnavailable] = useState(false);

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
  const downloading = snapshot?.state === 'downloading' || snapshot?.state === 'verifying';

  async function startDownload() {
    setSelected(true);
    setCancelled(false);
    setBridgeUnavailable(false);
    setBusy(true);
    try {
      await model.startDownload();
    } catch {
      // The native bridge emits a typed failure state. The action remains retryable and no
      // onboarding preference is written here.
      setBridgeUnavailable(true);
    } finally {
      setBusy(false);
    }
  }

  async function cancelDownload() {
    setBusy(true);
    try {
      await model.cancelDownload();
      setSelected(false);
      setCancelled(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <StatusPill>{t('onboarding.eyebrow')}</StatusPill>
        <AppText variant="display" style={styles.title}>
          {t('onboarding.title')}
        </AppText>
        <AppText style={styles.body}>{t('onboarding.body')}</AppText>
        <AppSurface style={styles.list}>
          <GroupedRow>
            <AppText variant="heading">{t('onboarding.localTitle')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.localBody')}</AppText>
          </GroupedRow>
          <GroupedRow>
            <AppText variant="heading">{t('onboarding.cloudTitle')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.cloudBody')}</AppText>
          </GroupedRow>
          <GroupedRow>
            <AppText variant="heading">{t('onboarding.measuredTitle')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.measuredBody')}</AppText>
          </GroupedRow>
        </AppSurface>
        <AppSurface style={styles.modelCard}>
          <StatusPill tone={ready ? 'measured' : 'neutral'}>
            {t('onboarding.modelEyebrow')}
          </StatusPill>
          <AppText variant="heading">{t('onboarding.modelTitle')}</AppText>
          <AppText style={styles.cardBody}>{t('onboarding.modelBody')}</AppText>
          <GroupedRow>
            <AppText variant="heading">{t('onboarding.modelName')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.modelPublisher')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.modelLicense')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.modelSource')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.modelSize')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.modelSpace')}</AppText>
            <AppText selectable style={styles.smallDetail}>
              {formatModelBytes(model.manifest.pack.artifact.bytes)} ·{' '}
              {model.manifest.pack.artifact.sha256.slice(0, 12)}…
            </AppText>
          </GroupedRow>
          {snapshot?.state === 'failed' && (
            <AppText style={styles.error}>{modelFailure(snapshot.failure)}</AppText>
          )}
          {bridgeUnavailable && snapshot?.state !== 'failed' && (
            <AppText style={styles.error}>{t('onboarding.modelFailureUnavailable')}</AppText>
          )}
          {cancelled && (
            <AppText style={styles.muted}>{t('onboarding.modelCancelDisclosure')}</AppText>
          )}
          {downloading && snapshot !== null ? (
            <>
              <AppText accessibilityLiveRegion="polite" style={styles.muted}>
                {snapshot.state === 'verifying'
                  ? t('onboarding.modelVerifying')
                  : t('onboarding.modelDownloading').replace(
                      '{progress}',
                      String(Math.round(snapshot.progress * 100)),
                    )}
              </AppText>
              <AppButton
                disabled={busy}
                label={t('onboarding.modelCancel')}
                onPress={() => void cancelDownload()}
                tone="quiet"
              />
            </>
          ) : ready && selected ? (
            <AppButton label={t('onboarding.continue')} onPress={onComplete} />
          ) : selected && !bridgeUnavailable ? (
            <AppButton
              disabled={busy}
              label={t('onboarding.modelDownload')}
              onPress={() => void startDownload()}
            />
          ) : (
            <AppButton label={t('onboarding.modelSelect')} onPress={() => setSelected(true)} />
          )}
          {selected && !ready && !downloading && snapshot?.state !== 'failed' && (
            <AppButton
              disabled={busy}
              label={t('cancel')}
              onPress={() => setSelected(false)}
              tone="quiet"
            />
          )}
          {selected && !ready && (snapshot?.state === 'failed' || bridgeUnavailable) && (
            <AppButton
              disabled={busy}
              label={t('onboarding.modelRetry')}
              onPress={() => void startDownload()}
              tone="secondary"
            />
          )}
        </AppSurface>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  title: { color: colors.ink, maxWidth: 360, marginTop: spacing.md },
  body: { color: colors.mutedInk, ...typography.body, maxWidth: 420 },
  list: { gap: 0, marginTop: spacing.md, padding: spacing.md },
  modelCard: { gap: spacing.sm, marginTop: spacing.md, padding: spacing.md },
  cardBody: { color: colors.mutedInk },
  smallDetail: { color: colors.mutedInk, fontSize: 12 },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
});
