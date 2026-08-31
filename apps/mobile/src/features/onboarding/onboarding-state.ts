import {
  canCompleteModelOnboarding,
  hasResumableModelDownload,
  isModelDownloadActive,
  type LocalModelSnapshot,
} from '../local-models/model';

export const ONBOARDING_PAGE_COUNT = 5;
export const ONBOARDING_MODEL_PAGE = 3;
export const ONBOARDING_READY_PAGE = 4;

export function onboardingCanContinue(page: number, snapshot: LocalModelSnapshot | null): boolean {
  if (!Number.isInteger(page) || page < 0 || page >= ONBOARDING_PAGE_COUNT) return false;
  if (page < ONBOARDING_MODEL_PAGE) return true;
  return snapshot !== null && canCompleteModelOnboarding(snapshot);
}

/** Every forward pager path crosses the same page eligibility gates. */
export function onboardingCanNavigateTo(
  currentPage: number,
  targetPage: number,
  snapshot: LocalModelSnapshot | null,
): boolean {
  if (
    !Number.isInteger(currentPage) ||
    !Number.isInteger(targetPage) ||
    currentPage < 0 ||
    currentPage >= ONBOARDING_PAGE_COUNT ||
    targetPage < 0 ||
    targetPage >= ONBOARDING_PAGE_COUNT
  ) {
    return false;
  }
  if (targetPage <= currentPage) return true;
  for (let page = currentPage; page < targetPage; page += 1) {
    if (!onboardingCanContinue(page, snapshot)) return false;
  }
  return true;
}

/** Resume an interrupted transfer at its repair step without loading the model runtime. */
export function onboardingResumePage(snapshot: LocalModelSnapshot | null): number {
  if (snapshot !== null && canCompleteModelOnboarding(snapshot)) return ONBOARDING_READY_PAGE;
  if (
    snapshot !== null &&
    (isModelDownloadActive(snapshot) || hasResumableModelDownload(snapshot))
  ) {
    return ONBOARDING_MODEL_PAGE;
  }
  return 0;
}

/** The pager cannot leave the model page while a transfer or verification is in flight. */
export function onboardingPagerLocked(snapshot: LocalModelSnapshot | null): boolean {
  return snapshot !== null && isModelDownloadActive(snapshot);
}
