import { useLayoutEffect, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { AppButton, AppText, TidalHero, TidalIconStage } from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import { useAppLock } from './AppLockProvider';
import { nativeSnapshotShield } from './shield';

function messageForReason(reason: ReturnType<typeof useAppLock>['state']['reason']): string {
  switch (reason) {
    case 'preference-read-failed':
      return t('settings.appLock.readError');
    case 'shield-unavailable':
      return t('settings.appLock.shieldError');
    case 'cancelled':
      return t('settings.appLock.cancelled');
    case 'lockout':
      return t('settings.appLock.lockout');
    case 'unavailable':
    case 'enrollment-changed':
      return t('settings.appLock.unavailable');
    case 'authentication-failed':
      return t('settings.appLock.failed');
    default:
      return t('settings.appLock.body');
  }
}

export function LockGate({ children }: { readonly children: ReactNode }) {
  const { controller, state } = useAppLock();
  const locked = state.phase !== 'unlocked';
  const loading = state.phase === 'loading' || state.phase === 'authenticating';

  useLayoutEffect(() => {
    // The native shield is allowed to clear only after this opaque gate has committed. Keeping
    // this synchronous avoids a race with the controller's first passive bootstrap effect.
    nativeSnapshotShield.markReactGateMounted();
  }, []);

  return (
    <View style={styles.root}>
      <View
        pointerEvents={locked ? 'none' : 'auto'}
        accessibilityElementsHidden={locked}
        importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}
        style={[styles.content, locked && styles.hiddenContent]}
      >
        {children}
      </View>
      {locked ? (
        <View style={styles.overlay} accessibilityViewIsModal accessibilityRole="alert">
          <SafeAreaView style={[screenStyles.safe, styles.gate]}>
            <TidalHero style={styles.gateCard}>
              <View style={styles.gateCardContent}>
                <TidalIconStage
                  name="shield"
                  accessibilityLabel={t('settings.appLock.iconLabel')}
                />
                <AppText variant="title" style={styles.title} selectable>
                  {t('settings.appLock.titleGate')}
                </AppText>
                <AppText style={styles.body} selectable>
                  {messageForReason(state.reason)}
                </AppText>
                {loading ? <ActivityIndicator color={colors.onBrand as string} /> : null}
              </View>
            </TidalHero>
            {!loading ? (
              <AppButton
                label={
                  state.phase === 'retry'
                    ? t('settings.appLock.retry')
                    : t('settings.appLock.unlock')
                }
                onPress={() => {
                  void (state.phase === 'retry' ? controller.retry() : controller.unlock());
                }}
              />
            ) : null}
          </SafeAreaView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  content: { flex: 1 },
  hiddenContent: { opacity: 0 },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.canvas, zIndex: 10 },
  gate: { alignItems: 'center', gap: spacing.lg, justifyContent: 'center', padding: spacing.xl },
  gateCard: { maxWidth: 440, padding: spacing.lg, width: '100%' },
  gateCardContent: { alignItems: 'center', gap: spacing.md },
  title: { color: colors.onBrand, textAlign: 'center' },
  body: { ...typography.body, color: colors.onBrandMuted, maxWidth: 360, textAlign: 'center' },
});
