import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t } from '../../localization';
import {
  appLockControlsPresentation,
  appLockGraceOptions,
  getAppLockRowLayout,
} from './app-lock-ui-model';

test('app lock controls expose their labels, current grace value, and disabled states', () => {
  const controls = appLockControlsPresentation({ enabled: false, grace: 'fiveMinutes' }, false);

  assert.deepEqual(controls.enable, {
    testID: 'app-lock-enabled',
    accessibilityLabel: t('settings.appLock.enable'),
    accessibilityHint: t('settings.appLock.enableSupporting'),
    checked: false,
    disabled: false,
  });
  assert.deepEqual(controls.grace, {
    testID: 'app-lock-grace',
    accessibilityLabel: `${t('settings.appLock.grace')}, ${t('settings.appLock.graceFiveMinutes')}`,
    accessibilityHint: t('settings.appLock.graceSupporting'),
    value: 'fiveMinutes',
    valueLabel: t('settings.appLock.graceFiveMinutes'),
    disabled: true,
  });
});

test('a pending settings operation disables both controls without losing the selected value', () => {
  const controls = appLockControlsPresentation({ enabled: true, grace: 'oneMinute' }, true);

  assert.equal(controls.enable.disabled, true);
  assert.equal(controls.grace.disabled, true);
  assert.equal(controls.grace.value, 'oneMinute');
  assert.equal(controls.grace.valueLabel, t('settings.appLock.graceOneMinute'));
});

test('grace options stay in the product order used by the native menu', () => {
  assert.deepEqual(appLockGraceOptions(), [
    { value: 'immediate', label: t('settings.appLock.graceImmediate') },
    { value: 'oneMinute', label: t('settings.appLock.graceOneMinute') },
    { value: 'fiveMinutes', label: t('settings.appLock.graceFiveMinutes') },
  ]);
});

test('app lock rows stack at accessibility sizes while preserving compact ordinary sizing', () => {
  assert.equal(getAppLockRowLayout(1), 'inline');
  assert.equal(getAppLockRowLayout(1.29), 'inline');
  assert.equal(getAppLockRowLayout(1.3), 'stacked');
  assert.equal(getAppLockRowLayout(3.2), 'stacked');
});

test('invalid font scales retain the compact app lock layout', () => {
  assert.equal(getAppLockRowLayout(Number.NaN), 'inline');
  assert.equal(getAppLockRowLayout(Number.POSITIVE_INFINITY), 'inline');
  assert.equal(getAppLockRowLayout(0), 'inline');
});
