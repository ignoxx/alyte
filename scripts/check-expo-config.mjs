import assert from 'node:assert/strict';
import appConfig from '../apps/mobile/app.config.js';

const expected = {
  development: 'com.alyte.app.dev',
  preview: 'com.alyte.app.preview',
  production: 'com.alyte.app',
};

for (const [variant, bundleIdentifier] of Object.entries(expected)) {
  process.env.APP_VARIANT = variant;
  const config = appConfig({ config: {} });
  assert.equal(config.ios.bundleIdentifier, bundleIdentifier);
  assert.equal(config.extra.variant, variant);
  assert.equal(config.extra.apiEnvironment, variant === 'production' ? 'production' : 'none');
  assert.equal(config.extra.showcaseAllowed, variant !== 'production');
}

assert.notEqual(expected.development, expected.preview);
assert.notEqual(expected.preview, expected.production);
process.stdout.write('Expo app variants are valid.\n');
