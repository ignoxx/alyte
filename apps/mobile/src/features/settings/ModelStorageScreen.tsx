import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';
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
import { useServices } from '../../services';
import { isModelDownloadActive, type LocalModelSnapshot } from '../local-models/model';
import { ModelDetailsDisclosure } from '../local-models/ModelDetailsDisclosure';
import { ModelProgress } from '../local-models/ModelProgress';
import {
  isExpectedDownloadCancellation,
  modelFailureMessageKey,
  modelOperation,
  modelStateLabelKey,
  modelStatusTone,
} from '../local-models/model-ui';

function ModelStorageState({ snapshot }: { readonly snapshot: LocalModelSnapshot | null }) {
  if (snapshot === null) {
    return (
      <View accessibilityRole="progressbar" style={styles.checking}>
        <ActivityIndicator color={colors.accent as string} />
        <AppText style={styles.muted} selectable>
          {t('onboarding.modelChecking')}
        </AppText>
      </View>
    );
  }
  return (
    <StatusPill tone={modelStatusTone(snapshot)}>
      {t(modelStateLabelKey(snapshot.state))}
    </StatusPill>
  );
}

export function ModelStorageScreen() {
  const { models } = useServices();
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [error, setError] = useState(false);
  const [cancelError, setCancelError] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [removed, setRemoved] = useState(false);
  const cancellationRequestedRef = useRef(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = models.subscribe((next) => {
      if (active) setSnapshot(next);
    });
    void models
      .getState()
      .then((next) => {
        if (active) {
          setSnapshot(next);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [models]);

  async function startDownload() {
    cancellationRequestedRef.current = false;
    setBusy(true);
    setError(false);
    setCancelError(false);
    setCancelled(false);
    setRemoved(false);
    try {
      await models.startDownload();
    } catch (downloadError) {
      if (isExpectedDownloadCancellation(downloadError, cancellationRequestedRef.current)) {
        setCancelled(true);
        setError(false);
        setCancelError(false);
      } else {
        setError(true);
      }
    } finally {
      cancellationRequestedRef.current = false;
      setBusy(false);
    }
  }

  async function cancelDownload() {
    cancellationRequestedRef.current = true;
    setCancelError(false);
    setCancelBusy(true);
    try {
      await models.cancelDownload();
      setCancelled(true);
      setError(false);
    } catch {
      // A cancellation request can fail independently of the pending download. Keep it distinct
      // from bridge/download failures and offer a retry while the native operation remains active.
      cancellationRequestedRef.current = false;
      setCancelled(false);
      setCancelError(true);
    } finally {
      setCancelBusy(false);
    }
  }

  async function removeModel() {
    setBusy(true);
    setError(false);
    setCancelError(false);
    setCancelled(false);
    setRemoved(false);
    try {
      await models.deletePack();
      setRemoved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const downloading = snapshot !== null && isModelDownloadActive(snapshot);
  const state = snapshot?.state;
  const failed = state === 'failed';
  const operation = modelOperation(state ?? null);

  return (
    <View style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        // NativeTabs are translucent and do not expose a React Navigation height context. Keep a
        // generous content inset so the final action remains above the glass in every card state.
        contentInset={{ bottom: 120 }}
        style={screenStyles.scroll}
      >
        <AppText style={styles.intro} selectable>
          {t('settings.modelStorageBody')}
        </AppText>

        <AppSurface style={styles.modelCard}>
          <View style={styles.modelHeading}>
            <AppIcon name="folder" size={28} color={colors.accent} />
            <View style={styles.modelHeadingCopy}>
              <AppText variant="heading" selectable>
                {t('settings.modelStoragePack')}
              </AppText>
              <ModelStorageState snapshot={snapshot} />
            </View>
          </View>
          {snapshot !== null && snapshot.state === 'ready' ? (
            <AppText style={styles.muted} selectable>
              {t('settings.modelStorageSize')}
            </AppText>
          ) : null}
          <ModelDetailsDisclosure manifest={models.manifest} />

          {error || failed ? (
            <AppSurface tone="soft" style={styles.callout}>
              <AppText variant="heading" style={styles.error} selectable>
                {failed && snapshot !== null
                  ? t(modelFailureMessageKey(snapshot.failure))
                  : t('settings.modelStorageError')}
              </AppText>
            </AppSurface>
          ) : null}
          {cancelError ? (
            <AppSurface tone="soft" style={styles.callout}>
              <AppText variant="heading" style={styles.error} selectable>
                {t('settings.modelStorageCancelError')}
              </AppText>
              <AppButton
                disabled={cancelBusy}
                label={t('settings.modelStorageRetryCancel')}
                onPress={() => void cancelDownload()}
                tone="secondary"
              />
            </AppSurface>
          ) : null}
          {removed ? (
            <AppText style={styles.muted} selectable>
              {t('settings.modelStorageRemoved')}
            </AppText>
          ) : null}

          {!cancelled && downloading && snapshot !== null ? (
            <ModelProgress snapshot={snapshot} />
          ) : null}
          {cancelled ? (
            <AppText style={styles.muted} selectable>
              {t('settings.modelStorageCancelled')}
            </AppText>
          ) : null}
          {!cancelled && !cancelError && operation === 'cancel' ? (
            <AppButton
              disabled={cancelBusy}
              label={t('settings.modelStorageCancel')}
              onPress={() => void cancelDownload()}
              tone="quiet"
            />
          ) : !cancelled && operation === 'cancelling' ? (
            <AppButton disabled label={t('settings.modelStorageCancelling')} tone="quiet" />
          ) : operation === 'retry' ? (
            <AppButton
              disabled={busy}
              label={t('settings.modelStorageRetry')}
              onPress={() => void startDownload()}
              tone="secondary"
            />
          ) : operation === 'checking' && error ? (
            <AppButton
              disabled={busy}
              label={t('settings.modelStorageRetry')}
              onPress={() => void startDownload()}
              tone="secondary"
            />
          ) : operation === 'download' ? (
            <AppButton
              disabled={busy}
              label={t('settings.modelStorageDownload')}
              onPress={() => void startDownload()}
            />
          ) : operation === 'deleting' ? (
            <AppButton disabled label={t('settings.modelStorageDeleting')} tone="quiet" />
          ) : operation === 'remove' ? (
            <AppButton
              disabled={busy || snapshot === null}
              label={t('settings.modelStorageDelete')}
              onPress={() =>
                Alert.alert(
                  t('settings.modelStoragePack'),
                  t('settings.modelStorageDeleteConfirm'),
                  [
                    { text: t('cancel'), style: 'cancel' },
                    {
                      text: t('settings.modelStorageDelete'),
                      style: 'destructive',
                      onPress: () => void removeModel(),
                    },
                  ],
                )
              }
              tone="secondary"
            />
          ) : null}
        </AppSurface>
      </ScreenScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.mutedInk, ...typography.body },
  modelCard: { gap: spacing.md, marginTop: spacing.md, padding: spacing.md },
  modelHeading: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  modelHeadingCopy: { flex: 1, gap: spacing.sm },
  checking: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 44 },
  muted: { color: colors.mutedInk },
  callout: { gap: spacing.sm, padding: spacing.md },
  error: { color: colors.danger },
});
