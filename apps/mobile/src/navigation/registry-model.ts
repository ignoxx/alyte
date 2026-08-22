import type { ComponentType } from 'react';

export type FeatureTarget = 'home' | 'labs' | 'log' | 'settings';

export type NavigationFeature = {
  readonly name: string;
  readonly target: FeatureTarget;
  readonly component: ComponentType<any>;
  readonly titleKey: string;
};

export type CoreNavigationFeatures = {
  readonly home: NavigationFeature;
  readonly labs: NavigationFeature;
  readonly snap: NavigationFeature;
  readonly log: NavigationFeature;
  readonly settings: NavigationFeature;
};

export type NavigationRegistry = CoreNavigationFeatures & {
  readonly extensions: readonly NavigationFeature[];
};

export function registerNavigationFeatures(
  coreFeatures: CoreNavigationFeatures,
  extensions: readonly NavigationFeature[] = [],
): NavigationRegistry {
  const coreNames = new Set(Object.values(coreFeatures).map((feature) => feature.name));
  const extensionNames = new Set<string>();
  const acceptedExtensions = extensions.filter((feature) => {
    if (coreNames.has(feature.name) || extensionNames.has(feature.name)) {
      return false;
    }
    extensionNames.add(feature.name);
    return true;
  });

  return { ...coreFeatures, extensions: acceptedExtensions };
}
