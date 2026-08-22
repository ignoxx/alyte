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
