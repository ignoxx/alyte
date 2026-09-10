import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, type AppStateStatus, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ServicesContext, createServices, type AlyteServices } from './src/services';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/features/onboarding/OnboardingScreen';
import {
  ONBOARDING_COMPLETED_PREFERENCE,
  persistOnboardingCompletion,
} from './src/features/onboarding/preferences';
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
import { AppResetContext } from './src/app-reset';
import { HomeLayoutProvider } from './src/features/settings/HomeLayoutProvider';

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

function AppContent({
  services,
  startOnboardingFromBeginning,
}: {
  readonly services: AlyteServices;
  readonly startOnboardingFromBeginning: boolean;
}) {
  const { controller, state: appLockState } = useAppLock();
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const cloudResumeInFlight = useRef<Promise<void> | null>(null);
  const cloudResumeHandledForActiveCycle = useRef(false);

  const resumeCloudIfUnlocked = useCallback(() => {
    if (AppState.currentState !== 'active' || controller.getSnapshot().phase !== 'unlocked') return;
    const accountSnapshot = services.account.getSnapshot();
    if (!accountSnapshot.signedIn || accountSnapshot.status !== 'active') return;
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
    void services.account.bootstrap().then(resumeCloudIfUnlocked);
  }, [appLockState.phase, resumeCloudIfUnlocked, services.account]);

  useEffect(() => {
    if (appLockState.phase !== 'unlocked') return;
    return services.account.subscribe(() => {
      const accountSnapshot = services.account.getSnapshot();
      if (accountSnapshot.signedIn && accountSnapshot.status === 'active') {
        resumeCloudIfUnlocked();
      }
    });
  }, [appLockState.phase, resumeCloudIfUnlocked, services.account]);

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
          startFromBeginning={startOnboardingFromBeginning}
          onComplete={async () => {
            await persistOnboardingCompletion(services.intake);
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

function AppRuntime({
  runtime,
  startOnboardingFromBeginning,
  onReset,
}: {
  readonly runtime: AppRuntimeDependencies;
  readonly startOnboardingFromBeginning: boolean;
  readonly onReset: () => void;
}) {
  const { services, appLockController } = runtime;

  return (
    <AppResetContext.Provider value={{ restartAtOnboarding: onReset }}>
      <ServicesContext.Provider value={services}>
        <AppLockProvider controller={appLockController}>
          <HomeLayoutProvider>
            <StatusBar style="auto" />
            <AppContent
              services={services}
              startOnboardingFromBeginning={startOnboardingFromBeginning}
            />
          </HomeLayoutProvider>
        </AppLockProvider>
      </ServicesContext.Provider>
    </AppResetContext.Provider>
  );
}

function ProtectedStartupRoot() {
  // Construction is attempted below the root boundary and represented explicitly so a thrown
  // native/storage adapter cannot prevent the opaque recovery surface from mounting.
  const [attempt, setAttempt] = useState(() => attemptProtectedStartup(constructAppRuntime));
  const [runtimeGeneration, setRuntimeGeneration] = useState(0);
  const [startOnboardingFromBeginning, setStartOnboardingFromBeginning] = useState(false);

  const restartAtOnboarding = useCallback(() => {
    setStartOnboardingFromBeginning(true);
    setAttempt(attemptProtectedStartup(constructAppRuntime));
    setRuntimeGeneration((current) => current + 1);
  }, []);
  if (attempt.kind === 'recovery') {
    return (
      <StartupRecoverySurface
        onRetry={() => setAttempt(attemptProtectedStartup(constructAppRuntime))}
      />
    );
  }
  return (
    <AppRuntime
      key={runtimeGeneration}
      onReset={restartAtOnboarding}
      runtime={attempt.value}
      startOnboardingFromBeginning={startOnboardingFromBeginning}
    />
  );
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
