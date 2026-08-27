import assert from 'node:assert/strict';
import { test } from 'node:test';
import { productionLocalModelManifest } from '../local-models/manifest';
import { applyLocalModelEvent, notInstalledSnapshot } from '../local-models/model';
import {
  ONBOARDING_MODEL_DOWNLOAD_PAGE,
  ONBOARDING_MODEL_SELECTION_PAGE,
  ONBOARDING_READY_PAGE,
  onboardingCanContinue,
  onboardingPagerLocked,
  onboardingResumePage,
} from './onboarding-state';

test('the mandatory gate only completes from an explicit selection and verified model', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  assert.equal(onboardingCanContinue(ONBOARDING_MODEL_SELECTION_PAGE, false, initial), false);
  assert.equal(onboardingCanContinue(ONBOARDING_MODEL_SELECTION_PAGE, true, initial), true);
  assert.equal(onboardingCanContinue(ONBOARDING_MODEL_DOWNLOAD_PAGE, true, initial), false);

  const ready = applyLocalModelEvent(initial, { kind: 'verified' });
  assert.equal(onboardingCanContinue(ONBOARDING_MODEL_DOWNLOAD_PAGE, true, ready), true);
  assert.equal(onboardingCanContinue(ONBOARDING_READY_PAGE, true, ready), true);
});

test('relaunch resumes model work and locks the pager during transfer', () => {
  const initial = notInstalledSnapshot(productionLocalModelManifest);
  const downloading = applyLocalModelEvent(initial, { kind: 'download-requested' });
  assert.equal(onboardingResumePage(downloading), ONBOARDING_MODEL_DOWNLOAD_PAGE);
  assert.equal(onboardingPagerLocked(downloading), true);
  assert.equal(onboardingResumePage(initial), 0);
  assert.equal(
    onboardingResumePage(applyLocalModelEvent(initial, { kind: 'verified' })),
    ONBOARDING_READY_PAGE,
  );
});
