import { useEffect, useState } from 'react';
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
import { modelFailureMessageKey, modelStateLabelKey } from '../local-models/model-ui';

function modelStatusTone(
  snapshot: LocalModelSnapshot | null,
): 'neutral' | 'measured' | 'reviewNeeded' {
  if (snapshot?.state === 'ready' || snapshot?.state === 'loaded') return 'measured';
  if (snapshot?.state === 'failed') return 'reviewNeeded';
  return 'neutral';
}

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
  const [removed, setRemoved] = useState(false);

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
    setBusy(true);
    setError(false);
    setRemoved(false);
    try {
      await models.startDownload();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function cancelDownload() {
    setCancelBusy(true);
    try {
      await models.cancelDownload();
    } catch {
      setError(true);
    } finally {
      setCancelBusy(false);
    }
  }

  async function removeModel() {
    setBusy(true);
    setError(false);
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

  return (
    <View style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
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
          {removed ? (
            <AppText style={styles.muted} selectable>
              {t('settings.modelStorageRemoved')}
            </AppText>
          ) : null}

          {downloading && snapshot !== null ? <ModelProgress snapshot={snapshot} /> : null}
          {downloading ? (
            <AppButton
              disabled={cancelBusy}
              label={t('settings.modelStorageCancel')}
              onPress={() => void cancelDownload()}
              tone="quiet"
            />
          ) : failed ? (
            <AppButton
              disabled={busy}
              label={t('settings.modelStorageRetry')}
              onPress={() => void startDownload()}
              tone="secondary"
            />
          ) : error && snapshot === null ? (
            <AppButton
              disabled={busy}
              label={t('settings.modelStorageRetry')}
              onPress={() => void startDownload()}
              tone="secondary"
            />
          ) : state === 'not-installed' ? (
            <AppButton
              disabled={busy}
              label={t('settings.modelStorageDownload')}
              onPress={() => void startDownload()}
            />
          ) : (
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
          )}
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
