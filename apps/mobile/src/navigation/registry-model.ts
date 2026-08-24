import type { ComponentType } from 'react';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';

export type FeatureTarget = 'home' | 'labs' | 'log' | 'settings';

export type NavigationFeature = {
  readonly name: string;
  readonly target: FeatureTarget;
  readonly component: ComponentType<any>;
  readonly titleKey: string;
  readonly options?: NativeStackNavigationOptions;
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

/** The current pre-cloud build intentionally ships before the local laboratory gate is passed. */
export const preGateTabNames = ['Home', 'Labs', 'Settings'] as const;

export const reportImportDestination = {
  route: 'ReportImport',
  presentation: 'fullScreenModal',
} as const;

export const extractionEditorDestination = {
  route: 'ExtractionMeasurementEditor',
  presentation: 'formSheet',
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
