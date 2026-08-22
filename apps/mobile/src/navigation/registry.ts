import type { MainTabParamList } from './types';
import { HomeScreen } from '../features/home/HomeScreen';
import { LabsScreen } from '../features/labs/LabsScreen';
import { LogScreen } from '../features/intake/LogScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { SnapScreen } from '../features/intake/SnapScreen';
import {
  registerNavigationFeatures,
  type NavigationFeature,
  type NavigationRegistry,
} from './registry-model';

export type MainRouteName = keyof MainTabParamList;
export type { FeatureTarget, NavigationFeature, NavigationRegistry } from './registry-model';

const coreFeatures = {
  home: { name: 'Home', target: 'home', component: HomeScreen, titleKey: 'navigation.home' },
  labs: { name: 'Labs', target: 'labs', component: LabsScreen, titleKey: 'navigation.labs' },
  snap: {
    name: 'SnapAction',
    target: 'home',
    component: SnapScreen,
    titleKey: 'navigation.snap',
  },
  log: { name: 'Log', target: 'log', component: LogScreen, titleKey: 'navigation.log' },
  settings: {
    name: 'Settings',
    target: 'settings',
    component: SettingsScreen,
    titleKey: 'navigation.settings',
  },
} satisfies Omit<NavigationRegistry, 'extensions'>;

/**
 * Later vertical slices register detail and form routes under an existing destination stack. The
 * root tabs remain stable while feature modules own their screen implementations.
 */
export function createNavigationRegistry(
  extensions: readonly NavigationFeature[] = [],
): NavigationRegistry {
  return registerNavigationFeatures(coreFeatures, extensions);
}
