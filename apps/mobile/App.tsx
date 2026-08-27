import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, type AppStateStatus, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ServicesContext, createServices, type AlyteServices } from './src/services';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/features/onboarding/OnboardingScreen';
import { ONBOARDING_COMPLETED_PREFERENCE } from './src/features/onboarding/preferences';
import { AppLockProvider, useAppLock } from './src/features/app-lock/AppLockProvider';
import { createAppLockAuthService } from './src/features/app-lock/auth';
import {
  createAppLockController,
  type AppLockController,
} from './src/features/app-lock/controller';
import { createAppLockPreferenceStore } from './src/features/app-lock/preferences';
import { nativeSnapshotShield } from './src/features/app-lock/shield';
import { LockGate } from './src/features/app-lock/LockGate';
import { ErrorBoundary, StartupRecoverySurface } from './src/ui/ErrorBoundary';
import { AppText } from './src/ui/primitives';
import { colors, spacing } from './src/theme';
import { t } from './src/localization';
import { attemptProtectedStartup } from './src/startup/protected-startup';

function NeutralLoadingSurface() {
  return (
    <View accessibilityRole="progressbar" style={styles.loadingSurface}>
      <ActivityIndicator color={colors.accent as string} />
      <AppText accessibilityLiveRegion="polite" style={styles.loadingLabel} selectable>
        {t('app.loading')}
      </AppText>
    </View>
  );
}

function AppContent({ services }: { readonly services: AlyteServices }) {
  const { controller, state: appLockState } = useAppLock();
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const cloudResumeInFlight = useRef<Promise<void> | null>(null);
  const cloudResumeHandledForActiveCycle = useRef(false);

  const resumeCloudIfUnlocked = useCallback(() => {
    if (AppState.currentState !== 'active' || controller.getSnapshot().phase !== 'unlocked') return;
    if (cloudResumeHandledForActiveCycle.current) return;
    cloudResumeHandledForActiveCycle.current = true;
    if (cloudResumeInFlight.current !== null) return;
    const work = services.intake
      .resumeCloudJobs()
      .then(() => undefined)
      .catch(() => undefined);
    cloudResumeInFlight.current = work;
    void work.finally(() => {
      if (cloudResumeInFlight.current === work) cloudResumeInFlight.current = null;
    });
  }, [controller, services]);

  useEffect(() => {
    void controller.bootstrap();
  }, [controller]);

  useEffect(() => {
    if (appLockState.phase !== 'unlocked') return;
    let active = true;
    void services.intake
      .getLocalPreference(ONBOARDING_COMPLETED_PREFERENCE)
      .then((value) => {
        if (active) setOnboardingComplete(value === 'true');
      })
      .catch(() => {
        // Onboarding is non-health UI. The app-lock preference itself is handled by the neutral
        // LockGate retry state, so a failed lock read never falls back to this surface.
        if (active) setOnboardingComplete(false);
      });
    return () => {
      active = false;
    };
  }, [appLockState.phase, services]);

  useEffect(() => {
    if (appLockState.phase !== 'unlocked') return;
    // These services open the shared local SQLite file lazily. Starting them only after the
    // app-lock policy has resolved prevents first-launch migration/connection races from making a
    // valid default policy look unreadable to the neutral gate.
    void services.export.startup().catch(() => undefined);
    void services.controls.reconcile().catch(() => undefined);
  }, [appLockState.phase, services]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        void controller.onForeground().then(resumeCloudIfUnlocked);
      } else {
        cloudResumeHandledForActiveCycle.current = false;
        controller.onBackground(nextState === 'inactive' ? 'inactive' : 'background');
      }
    });
    return () => subscription.remove();
  }, [controller, resumeCloudIfUnlocked]);

  useEffect(() => {
    if (appLockState.phase === 'unlocked') resumeCloudIfUnlocked();
  }, [appLockState.phase, resumeCloudIfUnlocked]);

  return (
    <LockGate>
      {onboardingComplete === null ? (
        <NeutralLoadingSurface />
      ) : onboardingComplete ? (
        <RootNavigator services={services} />
      ) : (
        <OnboardingScreen
          model={services.models}
          onComplete={() => {
            void services.intake
              .setLocalPreference(ONBOARDING_COMPLETED_PREFERENCE, 'true')
              .catch(() => {
                // Continue into local mode even when the preference write is unavailable. A
                // later launch safely shows onboarding again rather than risking a false
                // preference.
              });
            setOnboardingComplete(true);
          }}
        />
      )}
    </LockGate>
  );
}

type AppRuntimeDependencies = {
  readonly services: AlyteServices;
  readonly appLockController: AppLockController;
};

function constructAppRuntime(): AppRuntimeDependencies {
  const services = createServices();
  return {
    services,
    appLockController: createAppLockController({
      preferences: createAppLockPreferenceStore(services.intake),
      authentication: createAppLockAuthService(),
      shield: nativeSnapshotShield,
    }),
  };
}

function AppRuntime({ runtime }: { readonly runtime: AppRuntimeDependencies }) {
  const { services, appLockController } = runtime;

  return (
    <ServicesContext.Provider value={services}>
      <AppLockProvider controller={appLockController}>
        <StatusBar style="auto" />
        <AppContent services={services} />
      </AppLockProvider>
    </ServicesContext.Provider>
  );
}

function ProtectedStartupRoot() {
  // Construction is attempted below the root boundary and represented explicitly so a thrown
  // native/storage adapter cannot prevent the opaque recovery surface from mounting.
  const [attempt, setAttempt] = useState(() => attemptProtectedStartup(constructAppRuntime));
  if (attempt.kind === 'recovery') {
    return (
      <StartupRecoverySurface
        onRetry={() => setAttempt(attemptProtectedStartup(constructAppRuntime))}
      />
    );
  }
  return <AppRuntime runtime={attempt.value} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <ProtectedStartupRoot />
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingSurface: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  loadingLabel: { color: colors.mutedInk, textAlign: 'center' },
});
