import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Share, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { useServices, runtimeVariant } from '../../services';
import { AppButton, AppSurface, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import { createDiagnosticsPayload, type DiagnosticsPayload } from '../local-controls/diagnostics';

export function DiagnosticsScreen() {
  const services = useServices();
  const [payload, setPayload] = useState<DiagnosticsPayload | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [shareFailed, setShareFailed] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    setShareFailed(false);
    try {
      const state = await services.controls.diagnosticsState();
      setPayload(
        createDiagnosticsPayload({
          appVersion: '0.1.0',
          variant: runtimeVariant(),
          osMajor: osMajorVersion(),
          localStorage: state.localStorage,
          protectedFiles: state.protectedFiles,
        }),
      );
      setStatus('ready');
    } catch {
      setPayload(null);
      setStatus('failed');
    }
  }, [services.controls]);

  useEffect(() => {
    void load();
  }, [load]);

  async function shareDiagnostics() {
    if (payload === null) return;
    setShareFailed(false);
    try {
      await Share.share({
        message: JSON.stringify(payload, null, 2),
        title: t('settings.diagnosticsTitle'),
      });
    } catch {
      setShareFailed(true);
    }
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        contentInset={{ bottom: spacing.xxl }}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText style={styles.intro}>{t('settings.diagnosticsIntro')}</AppText>
        {status === 'loading' ? (
          <View accessibilityRole="progressbar" style={styles.status}>
            <ActivityIndicator color={colors.accent as string} />
            <AppText style={styles.muted}>{t('settings.diagnosticsLoading')}</AppText>
          </View>
        ) : status === 'failed' ? (
          <AppSurface tone="soft" style={styles.status}>
            <AppText variant="heading">{t('settings.diagnosticsUnavailable')}</AppText>
            <AppButton
              label={t('settings.diagnosticsRetry')}
              onPress={() => void load()}
              tone="secondary"
            />
          </AppSurface>
        ) : (
          <>
            <AppSurface style={styles.preview}>
              <AppText selectable style={styles.code}>
                {JSON.stringify(payload, null, 2)}
              </AppText>
            </AppSurface>
            <AppButton
              label={t('settings.diagnosticsShare')}
              onPress={() => void shareDiagnostics()}
            />
            {shareFailed && (
              <AppText accessibilityLiveRegion="polite" style={styles.failure}>
                {t('settings.diagnosticsShareError')}
              </AppText>
            )}
          </>
        )}
      </ScreenScrollView>
    </SafeAreaView>
  );
}

function osMajorVersion(): number | null {
  const version = Number.parseInt(String(Platform.Version), 10);
  return Number.isInteger(version) && version > 0 ? version : null;
}

const styles = StyleSheet.create({
  intro: { ...typography.body, color: colors.mutedInk, marginBottom: spacing.lg },
  muted: { color: colors.mutedInk },
  status: { alignItems: 'center', gap: spacing.md },
  failure: { color: colors.danger, marginTop: spacing.md },
  preview: { marginBottom: spacing.lg },
  code: { ...typography.code },
});
