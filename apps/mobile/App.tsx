import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ServicesContext, createServices } from './src/services';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/features/onboarding/OnboardingScreen';
import { ONBOARDING_COMPLETED_PREFERENCE } from './src/features/onboarding/preferences';
import { ErrorBoundary } from './src/ui/ErrorBoundary';
import { DesignLabNavigator } from './src/features/design-lab/DesignLabNavigator';
import { designLabEnabled } from './src/features/design-lab/model';

export default function App() {
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [services] = useState(() => createServices());
  const useDesignLab = designLabEnabled();

  useEffect(() => {
    if (useDesignLab) return;
    let active = true;
    void services.intake
      .getLocalPreference(ONBOARDING_COMPLETED_PREFERENCE)
      .then((value) => {
        if (active) setOnboardingComplete(value === 'true');
      })
      .catch(() => {
        // A protected preference read failure must not block local mode. Showing onboarding is the
        // safe fallback and does not discard any local records.
        if (active) setOnboardingComplete(false);
      });
    return () => {
      active = false;
    };
  }, [services, useDesignLab]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void services.intake.resumeCloudJobs();
    });
    return () => subscription.remove();
  }, [services]);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <ServicesContext.Provider value={services}>
          <StatusBar style="auto" />
          {useDesignLab ? (
            <DesignLabNavigator />
          ) : onboardingComplete === null ? null : onboardingComplete ? (
            <RootNavigator services={services} />
          ) : (
            <OnboardingScreen
              onComplete={() => {
                void services.intake
                  .setLocalPreference(ONBOARDING_COMPLETED_PREFERENCE, 'true')
                  .catch(() => {
                    // Continue into local mode even when the preference write is unavailable. A
                    // later launch will safely show onboarding again rather than blocking use.
                  });
                setOnboardingComplete(true);
              }}
            />
          )}
        </ServicesContext.Provider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
