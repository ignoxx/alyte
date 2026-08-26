import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getScreenScrollBottomInset } from './screen-scroll-model';

test('native tab fallback composes device safe area and shared clearance', () => {
  assert.equal(getScreenScrollBottomInset(undefined, 34, 40), 74);
  assert.equal(getScreenScrollBottomInset(undefined, 0, 40), 40);
});

test('measured tab bars remain authoritative when they are taller than the fallback', () => {
  assert.equal(getScreenScrollBottomInset(83, 34, 40), 83);
});

test('short measured values cannot reduce native tab clearance', () => {
  assert.equal(getScreenScrollBottomInset(50, 34, 40), 74);
});

test('invalid inset values fail safe to zero before applying clearance', () => {
  assert.equal(getScreenScrollBottomInset(Number.NaN, -1, Number.NaN), 0);
});
