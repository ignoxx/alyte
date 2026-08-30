import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getScreenPlatformPolicy,
  getScreenSafeAreaEdges,
  getScreenScrollBottomInset,
  getScreenStatusAvailableHeight,
  getScreenStatusBottomInset,
  getScreenStatusScrollEnabled,
  getScreenStatusUsesOverflowLayout,
  getScreenSurfaceMode,
} from './screen-scroll-model';

test('scroll inset is only the extra clearance beyond automatic safe-area adjustment', () => {
  assert.equal(getScreenScrollBottomInset(undefined, 34, 40, 'automatic'), 40);
  assert.equal(getScreenScrollBottomInset(undefined, 0, 40, 'automatic'), 40);
});

test('scroll surfaces do not duplicate the safe-area inset when no tab clearance is needed', () => {
  assert.equal(getScreenScrollBottomInset(undefined, 34, 0, 'automatic'), 0);
});

test('measured tab bars contribute only their portion beyond the safe area', () => {
  assert.equal(getScreenScrollBottomInset(83, 34, 40, 'automatic'), 49);
});

test('short measured values cannot reduce the minimum extra clearance', () => {
  assert.equal(getScreenScrollBottomInset(50, 34, 40, 'automatic'), 40);
});

test('legacy adjustment preserves the pre-ticket non-iOS safe-area fallback', () => {
  assert.equal(getScreenScrollBottomInset(undefined, 34, 0, 'legacy'), 34);
  assert.equal(getScreenScrollBottomInset(50, 34, 0, 'legacy'), 50);
});

test('invalid scroll inset values fail safe before applying either adjustment policy', () => {
  assert.equal(getScreenScrollBottomInset(Number.NaN, -1, Number.NaN, 'automatic'), 0);
  assert.equal(getScreenScrollBottomInset(Number.NaN, -1, Number.NaN, 'legacy'), 0);
});

test('platform policy isolates iOS native-tab behavior from the legacy fallback', () => {
  assert.equal(getScreenPlatformPolicy('ios'), 'ios-native-tabs');
  assert.equal(getScreenPlatformPolicy('android'), 'legacy');
  assert.equal(getScreenPlatformPolicy('web'), 'legacy');
  assert.equal(getScreenPlatformPolicy(undefined), 'legacy');

  assert.deepEqual(getScreenSafeAreaEdges('ios-native-tabs'), ['left', 'right']);
  assert.deepEqual(getScreenSafeAreaEdges('legacy'), ['left', 'right', 'bottom']);
});

test('status layout reserves the transparent header and complete tab-safe bottom region', () => {
  assert.equal(getScreenStatusBottomInset(undefined, 34, 40), 74);
  assert.equal(getScreenStatusBottomInset(83, 34, 40), 83);
  assert.equal(getScreenStatusAvailableHeight(852, 139, 83), 630);
});

test('status scrolling remains disabled until intrinsic content genuinely exceeds its viewport', () => {
  assert.equal(getScreenStatusScrollEnabled(420, 630), false);
  assert.equal(getScreenStatusScrollEnabled(630, 630), false);
  assert.equal(getScreenStatusScrollEnabled(631, 630), true);
  assert.equal(getScreenStatusScrollEnabled(Number.NaN, 630), false);
});

test('accessibility text sizes opt into a top-anchored overflow layout', () => {
  assert.equal(getScreenStatusUsesOverflowLayout(1), false);
  assert.equal(getScreenStatusUsesOverflowLayout(1.29), false);
  assert.equal(getScreenStatusUsesOverflowLayout(1.3), true);
  assert.equal(getScreenStatusUsesOverflowLayout(2.35), true);
  assert.equal(getScreenStatusUsesOverflowLayout(Number.NaN), false);
});

test('empty, loading, and error surfaces use the adaptive status shell', () => {
  assert.equal(getScreenSurfaceMode('empty'), 'status');
  assert.equal(getScreenSurfaceMode('loading'), 'status');
  assert.equal(getScreenSurfaceMode('error'), 'status');
  assert.equal(getScreenSurfaceMode('populated'), 'scroll');
});
