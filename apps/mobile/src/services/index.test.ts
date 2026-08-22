import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices } from './index';

test('production service composition cannot expose showcase fixtures', () => {
  const original = process.env.EXPO_PUBLIC_SHOWCASE_MODE;
  process.env.EXPO_PUBLIC_SHOWCASE_MODE = 'true';

  try {
    assert.equal(createServices('production').showcase, null);
  } finally {
    if (original === undefined) {
      delete process.env.EXPO_PUBLIC_SHOWCASE_MODE;
    } else {
      process.env.EXPO_PUBLIC_SHOWCASE_MODE = original;
    }
  }
});

test('the native build variant is honored when Expo public env is absent', () => {
  const originalPublicVariant = process.env.EXPO_PUBLIC_APP_VARIANT;
  const originalVariant = process.env.APP_VARIANT;
  delete process.env.EXPO_PUBLIC_APP_VARIANT;
  process.env.APP_VARIANT = 'production';

  try {
    assert.equal(createServices().runtime.variant, 'production');
    assert.equal(createServices().showcase, null);
  } finally {
    if (originalPublicVariant === undefined) {
      delete process.env.EXPO_PUBLIC_APP_VARIANT;
    } else {
      process.env.EXPO_PUBLIC_APP_VARIANT = originalPublicVariant;
    }
    if (originalVariant === undefined) {
      delete process.env.APP_VARIANT;
    } else {
      process.env.APP_VARIANT = originalVariant;
    }
  }
});
