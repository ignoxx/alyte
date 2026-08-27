import {
  canCompleteModelOnboarding,
  hasResumableModelDownload,
  isModelDownloadActive,
  type LocalModelSnapshot,
} from '../local-models/model';

export const ONBOARDING_PAGE_COUNT = 6;
export const ONBOARDING_MODEL_SELECTION_PAGE = 3;
export const ONBOARDING_MODEL_DOWNLOAD_PAGE = 4;
export const ONBOARDING_READY_PAGE = 5;

export function onboardingCanContinue(
  page: number,
  modelSelected: boolean,
  snapshot: LocalModelSnapshot | null,
): boolean {
  if (page < 0 || page >= ONBOARDING_PAGE_COUNT) return false;
  if (page < ONBOARDING_MODEL_SELECTION_PAGE) return true;
  if (page === ONBOARDING_MODEL_SELECTION_PAGE) return modelSelected;
  return snapshot !== null && canCompleteModelOnboarding(snapshot);
}

/**
 * An interrupted first run resumes at the only page that can safely repair it. The app still
 * starts at the welcome page when no model work has begun, so a fresh install always gets the
 * complete explanation before the local model gate.
 */
export function onboardingResumePage(snapshot: LocalModelSnapshot | null): number {
  if (snapshot !== null && canCompleteModelOnboarding(snapshot)) return ONBOARDING_READY_PAGE;
  if (
    snapshot !== null &&
    (isModelDownloadActive(snapshot) || hasResumableModelDownload(snapshot))
  ) {
    return ONBOARDING_MODEL_DOWNLOAD_PAGE;
  }
  return 0;
}

/** The pager cannot leave the model page while a transfer or verification is in flight. */
export function onboardingPagerLocked(snapshot: LocalModelSnapshot | null): boolean {
  return snapshot !== null && isModelDownloadActive(snapshot);
}
