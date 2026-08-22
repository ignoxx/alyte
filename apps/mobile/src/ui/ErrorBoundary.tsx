import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../localization';
import { AppButton, AppText } from './primitives';
import { colors, spacing, typography } from '../theme';

type ErrorBoundaryProps = PropsWithChildren;
type ErrorBoundaryState = { error: Error | null };

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

    return (
      <SafeAreaView style={styles.container} accessibilityViewIsModal>
        <AppText variant="title">{t('errors.title')}</AppText>
        <AppText style={styles.body}>{t('errors.body')}</AppText>
        <AppButton label={t('errors.restart')} onPress={this.reset} />
      </SafeAreaView>
    );
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
