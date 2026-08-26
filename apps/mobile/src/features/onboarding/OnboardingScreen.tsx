/**
 * Compatibility entry point for the first-run route. The required-model setup now lives in the
 * shared screen so contextual reinstall cannot accidentally render the welcome tour.
 */
export { ModelSetupScreen as OnboardingScreen } from './ModelSetupPanel';
