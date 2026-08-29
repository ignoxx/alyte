import type { ComponentType } from 'react';
import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import type { SettingsStackParamList } from './types';

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

export type SettingsNavigationRouteName = Exclude<keyof SettingsStackParamList, 'SettingsRoot'>;

export type SettingsFeatureDefinition = {
  readonly name: SettingsNavigationRouteName;
  readonly target: 'settings';
  readonly titleKey: string;
};

/**
 * The local laboratory shell has no accepted cloud-ready gate yet. Keep cloud Settings navigation
 * absent until the cloud slice owns and passes an explicit user-ready gate.
 */
export const localNavigationGate = {
  cloudSettingsEnabled: false,
} as const;

/**
 * These are the production Settings route definitions. Components are attached by the mobile
 * registry so this pure configuration can be tested without importing native UI modules.
 */
export const settingsFeatureDefinitions = {
  cloud: [
    {
      name: 'CloudAccount',
      target: 'settings',
      titleKey: 'settings.cloudAccountTitle',
    },
  ],
  local: [
    {
      name: 'AppLock',
      target: 'settings',
      titleKey: 'settings.appLockTitle',
    },
    {
      name: 'PrivacyStorage',
      target: 'settings',
      titleKey: 'settings.privacyTitle',
    },
    {
      name: 'ModelStorage',
      target: 'settings',
      titleKey: 'settings.modelStorageTitle',
    },
    {
      name: 'SupportFaq',
      target: 'settings',
      titleKey: 'settings.supportTitle',
    },
    {
      name: 'Diagnostics',
      target: 'settings',
      titleKey: 'settings.diagnosticsTitle',
    },
    {
      name: 'DeleteLocalData',
      target: 'settings',
      titleKey: 'settings.deleteTitle',
    },
  ],
} as const satisfies {
  readonly cloud: readonly SettingsFeatureDefinition[];
  readonly local: readonly SettingsFeatureDefinition[];
};

/** Select the production Settings routes from the explicit cloud-slice gate. */
export function settingsNavigationForGate(
  cloudSettingsEnabled = localNavigationGate.cloudSettingsEnabled,
): readonly SettingsFeatureDefinition[] {
  return cloudSettingsEnabled
    ? [...settingsFeatureDefinitions.cloud, ...settingsFeatureDefinitions.local]
    : settingsFeatureDefinitions.local;
}

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

/** Generic Labs-stack seam for future shell promotion; the route remains nested under Labs. */
export const biomarkerHistoryDestination = {
  route: 'BiomarkerHistory',
  presentation: 'push',
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
