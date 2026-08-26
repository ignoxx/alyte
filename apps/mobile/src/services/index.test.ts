import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServices, type AlyteServices } from './index';
import { createAppLockController } from '../features/app-lock/controller';
import { createAppLockPreferenceStore } from '../features/app-lock/preferences';
import type { IntakeRepository } from '../features/intake/persistence';
import type { LabRepository } from '../features/labs/persistence';
import { createSharedDatabaseRepositoryFactories } from './shared-database';
import { ONBOARDING_COMPLETED_PREFERENCE } from '../features/onboarding/preferences';

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

function fakeRepositories(initialPreference: string | null = null) {
  const preferences = new Map<string, string>();
  if (initialPreference !== null) {
    preferences.set('app.app-lock.policy', initialPreference);
  }
  const labRecords: unknown[] = [];
  const intakeEvents: unknown[] = [];
  const labRepository = {
    listPendingCombinedDeletions: async () => [],
    listRecords: async () => labRecords,
    createRecord: async (input: unknown) => {
      labRecords.push(input);
      return input;
    },
  } as unknown as LabRepository;
  const intakeRepository = {
    listEvents: async () => intakeEvents,
    listSnapRecoveries: async () => [],
    listCloudJobs: async () => [],
    createEvent: async (input: unknown) => {
      intakeEvents.push(input);
      return input;
    },
    getLocalPreference: async (key: string) => preferences.get(key) ?? null,
    setLocalPreference: async (key: string, value: string) => {
      preferences.set(key, value);
    },
  } as unknown as IntakeRepository;
  return { labRepository, intakeRepository, labRecords, intakeEvents, preferences };
}

function controllerFor(services: AlyteServices) {
  return createAppLockController({
    preferences: createAppLockPreferenceStore(services.intake),
    authentication: {
      async authenticate() {
        return { kind: 'cancelled' as const };
      },
    },
    shield: {
      markReactGateMounted() {},
      async clear() {},
      async isInstalled() {
        return true;
      },
    },
  });
}

function inertMediaStore() {
  return {
    async remove() {},
    async verifyRemoved() {
      return true;
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('clean showcase composition unlocks with a missing policy and reaches first-run onboarding', async () => {
  const originalShowcase = process.env.EXPO_PUBLIC_SHOWCASE_MODE;
  process.env.EXPO_PUBLIC_SHOWCASE_MODE = 'true';
  try {
    const fake = fakeRepositories();
    const opened: string[] = [];
    const services = createServices('development', {
      openLabDatabase: async () => {
        opened.push('labs');
        return fake.labRepository;
      },
      openIntakeDatabase: async () => {
        opened.push('intake');
        return fake.intakeRepository;
      },
      intakeMediaStore: inertMediaStore(),
    });
    assert.notEqual(services.showcase, null);

    const controller = controllerFor(services);
    await controller.bootstrap();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (fake.labRecords.length > 0 && fake.intakeEvents.length > 0) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(controller.getSnapshot().preferences, {
      enabled: false,
      grace: 'immediate',
    });
    assert.equal(controller.getSnapshot().phase, 'unlocked');
    assert.equal(await services.intake.getLocalPreference(ONBOARDING_COMPLETED_PREFERENCE), null);
    assert.deepEqual(opened, ['labs', 'intake']);
    assert.ok(fake.labRecords.length > 0);
    assert.ok(fake.intakeEvents.length > 0);
  } finally {
    restoreEnvironment('EXPO_PUBLIC_SHOWCASE_MODE', originalShowcase);
  }
});

test('composition keeps native open failures retryable and malformed policies fail closed', async () => {
  const fake = fakeRepositories();
  let attempts = 0;
  const services = createServices('production', {
    openIntakeDatabase: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('native protection unavailable');
      return fake.intakeRepository;
    },
    intakeMediaStore: inertMediaStore(),
  });
  const controller = controllerFor(services);
  await controller.bootstrap();
  assert.equal(controller.getSnapshot().phase, 'retry');
  await controller.bootstrap();
  assert.equal(controller.getSnapshot().phase, 'unlocked');
  assert.equal(attempts, 2);

  const malformed = fakeRepositories('{"enabled":false}');
  const malformedServices = createServices('production', {
    openIntakeDatabase: async () => malformed.intakeRepository,
    intakeMediaStore: inertMediaStore(),
  });
  const malformedController = controllerFor(malformedServices);
  await malformedController.bootstrap();
  assert.equal(malformedController.getSnapshot().phase, 'retry');
});
