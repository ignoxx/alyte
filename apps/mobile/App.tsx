import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ServicesContext, createServices } from './src/services';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/features/onboarding/OnboardingScreen';
import { ErrorBoundary } from './src/ui/ErrorBoundary';

export default function App() {
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [services] = useState(() => createServices());

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
          {onboardingComplete ? (
            <RootNavigator services={services} />
          ) : (
            <OnboardingScreen onComplete={() => setOnboardingComplete(true)} />
          )}
        </ServicesContext.Provider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
