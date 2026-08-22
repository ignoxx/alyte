import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ServicesContext, createServices } from './src/services';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/features/onboarding/OnboardingScreen';
import { ErrorBoundary } from './src/ui/ErrorBoundary';

export default function App() {
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [services] = useState(() => createServices());

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
