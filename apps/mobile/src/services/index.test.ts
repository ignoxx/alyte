import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices } from './index';
import { createSharedDatabaseRepositoryFactories } from './shared-database';

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

test('clean showcase bootstrap serializes shared opens and retries a failed first open', async () => {
  const opened: string[] = [];
  let active = 0;
  let peak = 0;
  let labAttempts = 0;
  const open = async (name: string): Promise<string> => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    opened.push(name);
    return name;
  };
  const { repositoryFactory, intakeRepositoryFactory } = createSharedDatabaseRepositoryFactories(
    async () => {
      labAttempts += 1;
      if (labAttempts === 1) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        opened.push('lab-failed');
        throw new Error('first lab open failed');
      }
      return open('lab-retry');
    },
    () => open('intake'),
  );

  const labFirst = repositoryFactory();
  const intakeFirst = intakeRepositoryFactory();
  await assert.rejects(labFirst, /first lab open failed/);
  assert.equal(await intakeFirst, 'intake');
  assert.equal(await repositoryFactory(), 'lab-retry');
  assert.deepEqual(opened, ['lab-failed', 'intake', 'lab-retry']);
  assert.equal(peak, 1);
});
