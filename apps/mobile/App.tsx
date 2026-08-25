import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, View } from 'react-native';
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
import { ErrorBoundary } from './src/ui/ErrorBoundary';

function NeutralLoadingSurface() {
  return <View accessibilityElementsHidden style={{ flex: 1 }} />;
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
      <ErrorBoundary>
        {onboardingComplete === null ? (
          <NeutralLoadingSurface />
        ) : onboardingComplete ? (
          <RootNavigator services={services} />
        ) : (
          <OnboardingScreen
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
      </ErrorBoundary>
    </LockGate>
  );
}

export default function App() {
  const [services] = useState(() => createServices());
  const [appLockController] = useState<AppLockController>(() =>
    createAppLockController({
      preferences: createAppLockPreferenceStore(services.intake),
      authentication: createAppLockAuthService(),
      shield: nativeSnapshotShield,
    }),
  );

  return (
    <SafeAreaProvider>
      <ServicesContext.Provider value={services}>
        <AppLockProvider controller={appLockController}>
          <StatusBar style="auto" />
          <AppContent services={services} />
        </AppLockProvider>
      </ServicesContext.Provider>
    </SafeAreaProvider>
  );
}
