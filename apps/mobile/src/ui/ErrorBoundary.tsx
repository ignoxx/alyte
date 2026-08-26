import {
  Component,
  useEffect,
  useLayoutEffect,
  useState,
  type ErrorInfo,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import { AppState, StyleSheet, type AppStateStatus } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../localization';
import { AppButton, AppText } from './primitives';
import { colors, spacing, typography } from '../theme';
import { nativeSnapshotShield } from '../features/app-lock/shield';
import { createStartupRecoveryHandoff } from '../startup/protected-startup';

type ErrorBoundaryProps = PropsWithChildren;
type ErrorBoundaryState = { error: Error | null };

export function StartupRecoverySurface({ onRetry }: { readonly onRetry: () => void }) {
  const [handoff] = useState(() => createStartupRecoveryHandoff(nativeSnapshotShield));

  useLayoutEffect(() => {
    // This fallback also acts as the startup gate when service construction throws before the
    // normal AppLockProvider/LockGate tree can mount. Native can safely reveal this surface only
    // after the handoff; it remains opaque and contains no health content.
    handoff.markMounted();
  }, [handoff]);

  useEffect(() => {
    const clearWhenActive = (status: AppStateStatus = AppState.currentState) => {
      void handoff.clearWhenActive(status);
    };

    // A root failure can happen while the system auth sheet or a lifecycle transition is active.
    // Retry the explicit clear on the next active callback so the recovery surface cannot remain
    // behind the opaque native shield indefinitely.
    clearWhenActive();
    const subscription = AppState.addEventListener('change', clearWhenActive);
    return () => subscription.remove();
  }, [handoff]);

  return (
    <SafeAreaView style={styles.container} accessibilityViewIsModal>
      <AppText variant="title">{t('errors.title')}</AppText>
      <AppText style={styles.body}>{t('errors.body')}</AppText>
      <AppButton label={t('errors.retry')} onPress={onRetry} />
    </SafeAreaView>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Error details stay local; do not send health content to diagnostics.
    console.warn('Alyte shell error', error.name, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }

    return <StartupRecoverySurface onRetry={this.reset} />;
  }
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'stretch',
    backgroundColor: colors.canvas,
    flex: 1,
    gap: spacing.lg,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  body: { color: colors.mutedInk, ...typography.body },
});
