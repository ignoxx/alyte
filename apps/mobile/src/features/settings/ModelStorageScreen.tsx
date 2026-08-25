import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { AppButton, AppIcon, AppText, AppSurface, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { useServices } from '../../services';
import type { LocalModelSnapshot } from '../local-models/model';
import { formatModelBytes } from '../local-models/manifest';

function stateLabel(snapshot: LocalModelSnapshot): string {
  const keys: Record<LocalModelSnapshot['state'], string> = {
    'not-installed': 'settings.modelStorageNotInstalled',
    downloading: 'settings.modelStorageDownloading',
    verifying: 'settings.modelStorageVerifying',
    ready: 'settings.modelStorageReady',
    loaded: 'settings.modelStorageLoaded',
    failed: 'settings.modelStorageFailed',
    cancelling: 'settings.modelStorageDownloading',
    deleting: 'settings.modelStorageDownloading',
  };
  const key = keys[snapshot.state];
  try {
    return t(key);
  } catch {
    return snapshot.state;
  }
}

export function ModelStorageScreen() {
  const { models } = useServices();
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = models.subscribe((next) => {
      if (active) setSnapshot(next);
    });
    void models
      .getState()
      .then((next) => {
        if (active) setSnapshot(next);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [models]);

  async function removeModel() {
    setBusy(true);
    setError(false);
    try {
      await models.deletePack();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const state = snapshot === null ? t('settings.modelStorageUnavailable') : stateLabel(snapshot);
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <View style={styles.header}>
          <AppIcon name="folder" size={28} color={colors.accent} />
          <AppText variant="heading">{t('settings.modelStoragePack')}</AppText>
          <AppText>{state}</AppText>
          {snapshot !== null &&
            snapshot.progress > 0 &&
            snapshot.state !== 'ready' &&
            snapshot.state !== 'loaded' && (
              <AppText style={styles.muted}>
                {t('settings.modelStorageProgress').replace(
                  '{progress}',
                  String(Math.round(snapshot.progress * 100)),
                )}
              </AppText>
            )}
          {snapshot !== null && (snapshot.state === 'ready' || snapshot.state === 'loaded') && (
            <AppText style={styles.muted}>
              {formatModelBytes(snapshot.storageBytes || models.manifest.pack.artifact.bytes)}
            </AppText>
          )}
          {error && <AppText style={styles.error}>{t('settings.modelStorageError')}</AppText>}
        </View>
        <AppSurface tone="soft">
          <AppText>{t('settings.modelStorageBody')}</AppText>
          <AppButton
            disabled={busy || snapshot === null || snapshot.state === 'not-installed'}
            label={t('settings.modelStorageDelete')}
            onPress={() =>
              Alert.alert(t('settings.modelStoragePack'), t('settings.modelStorageDeleteConfirm'), [
                { text: t('cancel'), style: 'cancel' },
                {
                  text: t('settings.modelStorageDelete'),
                  style: 'destructive',
                  onPress: () => void removeModel(),
                },
              ])
            }
            tone="secondary"
          />
        </AppSurface>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.sm, marginBottom: spacing.lg },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
});
