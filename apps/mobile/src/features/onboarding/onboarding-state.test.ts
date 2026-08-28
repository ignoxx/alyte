import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionLocalModelManifest } from '../local-models/manifest';
import { applyLocalModelEvent, notInstalledSnapshot } from '../local-models/model';
import {
  ONBOARDING_MODEL_PAGE,
  ONBOARDING_PAGE_COUNT,
  ONBOARDING_READY_PAGE,
  onboardingCanContinue,
  onboardingCanNavigateTo,
  onboardingPagerLocked,
  onboardingResumePage,
} from './onboarding-state';

test('the mandatory gate only advances from a verified model on the combined setup page', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  assert.equal(ONBOARDING_PAGE_COUNT, 5);
  assert.equal(onboardingCanContinue(ONBOARDING_MODEL_PAGE, initial), false);

  const ready = applyLocalModelEvent(initial, { kind: 'verified' });
  assert.equal(onboardingCanContinue(ONBOARDING_MODEL_PAGE, ready), true);
  assert.equal(onboardingCanContinue(ONBOARDING_READY_PAGE, ready), true);
  assert.equal(
    onboardingCanNavigateTo(ONBOARDING_MODEL_PAGE, ONBOARDING_READY_PAGE, initial),
    false,
  );
  assert.equal(onboardingCanNavigateTo(ONBOARDING_MODEL_PAGE, ONBOARDING_READY_PAGE, ready), true);
});

test('relaunch resumes model work and locks the pager during transfer', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  const downloading = applyLocalModelEvent(initial, { kind: 'download-requested' });
  assert.equal(onboardingResumePage(downloading), ONBOARDING_MODEL_PAGE);
  assert.equal(onboardingPagerLocked(downloading), true);
  assert.equal(onboardingResumePage(initial), 0);
  assert.equal(
    onboardingResumePage(applyLocalModelEvent(initial, { kind: 'verified' })),
    ONBOARDING_READY_PAGE,
  );
});
