export const ONBOARDING_COMPLETED_PREFERENCE = 'app.onboarding-completed';

type OnboardingPreferenceWriter = {
  readonly setLocalPreference: (key: string, value: string) => Promise<void>;
};

/** Completion is durable only after the local preference write succeeds. */
export async function persistOnboardingCompletion(
  preferences: OnboardingPreferenceWriter,
): Promise<void> {
  await preferences.setLocalPreference(ONBOARDING_COMPLETED_PREFERENCE, 'true');
}
