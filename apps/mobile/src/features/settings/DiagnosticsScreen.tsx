import { useEffect, useState } from 'react';
import { Platform, Share, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { useServices, runtimeVariant } from '../../services';
import { AppButton, AppSurface, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import { createDiagnosticsPayload, type DiagnosticsPayload } from '../local-controls/diagnostics';

export function DiagnosticsScreen() {
  const services = useServices();
  const [payload, setPayload] = useState<DiagnosticsPayload | null>(null);

  useEffect(() => {
    let active = true;
    void services.controls
      .diagnosticsState()
      .then((state) => {
        if (!active) return;
        setPayload(
          createDiagnosticsPayload({
            appVersion: '0.1.0',
            variant: runtimeVariant(),
            osMajor: osMajorVersion(),
            localStorage: state.localStorage,
            protectedFiles: state.protectedFiles,
          }),
        );
      })
      .catch(() => {
        if (active) setPayload(null);
      });
    return () => {
      active = false;
    };
  }, [services.controls]);

  async function shareDiagnostics() {
    if (payload === null) return;
    await Share.share({
      message: JSON.stringify(payload, null, 2),
      title: t('settings.diagnosticsTitle'),
    });
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
        {payload === null ? (
          <AppText style={styles.muted}>{t('settings.diagnosticsUnavailable')}</AppText>
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
  intro: { color: colors.mutedInk, lineHeight: 22, marginBottom: spacing.lg },
  muted: { color: colors.mutedInk },
  preview: { marginBottom: spacing.lg },
  code: { ...typography.code },
});
