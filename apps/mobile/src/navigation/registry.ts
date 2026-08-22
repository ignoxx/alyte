import type { ComponentType } from 'react';
import type { MainTabParamList } from './types';
import { HomeScreen } from '../features/home/HomeScreen';
import { LabsScreen } from '../features/labs/LabsScreen';
import { LogScreen } from '../features/intake/LogScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { SnapScreen } from '../features/intake/SnapScreen';

export type MainRouteName = keyof MainTabParamList;

export type NavigationFeature = {
  readonly name: MainRouteName;
  readonly component: ComponentType<any>;
  readonly titleKey: string;
};

const coreFeatures: readonly NavigationFeature[] = [
  { name: 'Home', component: HomeScreen, titleKey: 'navigation.home' },
  { name: 'Labs', component: LabsScreen, titleKey: 'navigation.labs' },
  { name: 'SnapAction', component: SnapScreen, titleKey: 'navigation.snap' },
  { name: 'Log', component: LogScreen, titleKey: 'navigation.log' },
  { name: 'Settings', component: SettingsScreen, titleKey: 'navigation.settings' },
];

/**
 * Later vertical slices append screens through this registration point instead of editing the
 * application root. Core routes remain fixed so onboarding and local mode stay stable.
 */
export function createNavigationRegistry(
  extensions: readonly NavigationFeature[] = [],
): readonly NavigationFeature[] {
  const names = new Set(coreFeatures.map((feature) => feature.name));
  const acceptedExtensions = extensions.filter((feature) => !names.has(feature.name));
  return [...coreFeatures, ...acceptedExtensions];
}
