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

/** Root-level destinations used by the native action tab. Kept pure so navigation behavior is
 * testable without mounting UIKit-backed navigators. */
export const snapActionDestination = {
  captureRoute: 'SnapCapture',
  returnTab: 'Home',
} as const;

export function featureStackRootName(tabName: string): string {
  return `${tabName}Root`;
}

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
