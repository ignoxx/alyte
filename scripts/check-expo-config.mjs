import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import appConfig from '../apps/mobile/app.config.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileRoot = resolve(repositoryRoot, 'apps/mobile');
const require = createRequire(import.meta.url);
const expoCliPath = require.resolve('expo/bin/cli', { paths: [mobileRoot] });

function readExpoIntrospection(variant) {
  const output = execFileSync(
    process.execPath,
    [expoCliPath, 'config', '--type', 'introspect', '--json'],
    {
      cwd: mobileRoot,
      env: { ...process.env, APP_VARIANT: variant },
      encoding: 'utf8',
    },
  );
  return JSON.parse(output);
}

const expected = {
  development: { bundleIdentifier: 'com.alyte.app.dev', extendedVirtualAddressing: false },
  preview: { bundleIdentifier: 'com.alyte.app.preview', extendedVirtualAddressing: true },
  production: { bundleIdentifier: 'com.alyte.app', extendedVirtualAddressing: true },
};

for (const [variant, policy] of Object.entries(expected)) {
  const config = readExpoIntrospection(variant);
  assert.equal(config.ios.bundleIdentifier, policy.bundleIdentifier);
  assert.equal(config.ios.deploymentTarget, '26.0');
  assert.equal(config.ios.entitlements['com.apple.developer.kernel.increased-memory-limit'], true);
  assert.equal(
    Object.hasOwn(
      config.ios.entitlements,
      'com.apple.developer.kernel.extended-virtual-addressing',
    ),
    policy.extendedVirtualAddressing,
  );
  if (policy.extendedVirtualAddressing) {
    assert.equal(
      config.ios.entitlements['com.apple.developer.kernel.extended-virtual-addressing'],
      true,
    );
  }
  assert.equal(config.extra.variant, variant);
  assert.equal(config.extra.apiEnvironment, variant === 'production' ? 'production' : 'none');
  assert.equal(config.extra.showcaseAllowed, variant !== 'production');
}

process.env.APP_VARIANT = 'production';
const upstreamEntitlement = 'com.apple.developer.in-app-payments';
const configWithUpstreamEntitlement = appConfig({
  config: { ios: { entitlements: { [upstreamEntitlement]: true } } },
});
assert.equal(configWithUpstreamEntitlement.ios.entitlements[upstreamEntitlement], true);
assert.equal(
  configWithUpstreamEntitlement.ios.entitlements[
    'com.apple.developer.kernel.increased-memory-limit'
  ],
  true,
);
assert.equal(
  configWithUpstreamEntitlement.ios.entitlements[
    'com.apple.developer.kernel.extended-virtual-addressing'
  ],
  true,
);

assert.notEqual(expected.development.bundleIdentifier, expected.preview.bundleIdentifier);
assert.notEqual(expected.preview.bundleIdentifier, expected.production.bundleIdentifier);
process.env.APP_VARIANT = 'typo';
assert.throws(() => appConfig({ config: {} }), /Unknown APP_VARIANT/);
process.stdout.write('Expo app variants are valid.\n');
