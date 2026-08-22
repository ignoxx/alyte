import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  featureStackRootName,
  registerNavigationFeatures,
  snapActionDestination,
  type CoreNavigationFeatures,
} from './registry-model';

const coreFeatures: CoreNavigationFeatures = {
  home: { name: 'Home', target: 'home', component: () => null, titleKey: 'navigation.home' },
  labs: { name: 'Labs', target: 'labs', component: () => null, titleKey: 'navigation.labs' },
  snap: {
    name: 'SnapAction',
    target: 'home',
    component: () => null,
    titleKey: 'navigation.snap',
  },
  log: { name: 'Log', target: 'log', component: () => null, titleKey: 'navigation.log' },
  settings: {
    name: 'Settings',
    target: 'settings',
    component: () => null,
    titleKey: 'navigation.settings',
  },
};

test('feature registration adds detail routes to the owning destination stack', () => {
  const registry = registerNavigationFeatures(coreFeatures, [
    {
      name: 'LabDetail',
      target: 'labs',
      component: () => null,
      titleKey: 'labs.title',
    },
  ]);

  assert.deepEqual(
    registry.extensions.map((feature) => feature.name),
    ['LabDetail'],
  );
  assert.equal(registry.extensions[0]?.target, 'labs');
});

test('core route names cannot be replaced by an extension', () => {
  const registry = registerNavigationFeatures(coreFeatures, [
    {
      name: 'Home',
      target: 'labs',
      component: () => null,
      titleKey: 'navigation.home',
    },
  ]);

  assert.deepEqual(registry.extensions, []);
});

test('native stack roots do not shadow tab routes and Snap returns to Home', () => {
  assert.equal(featureStackRootName('Labs'), 'LabsRoot');
  assert.equal(featureStackRootName('Log'), 'LogRoot');
  assert.deepEqual(snapActionDestination, { captureRoute: 'SnapCapture', returnTab: 'Home' });
});
