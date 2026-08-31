import type { ComponentType } from 'react';
import type { MainTabParamList } from './types';
import { HomeScreen } from '../features/home/HomeScreen';
import { LabsScreen } from '../features/labs/LabsScreen';
import { LabRecordDetailRoute } from '../features/labs/LabRecordDetailRoute';
import { LabReportDetailRoute } from '../features/labs/LabReportDetailRoute';
import { BiomarkerHistoryRoute } from '../features/labs/BiomarkerHistoryRoute';
import { ExtractionDraftScreen } from '../features/labs/ExtractionDraftScreen';
import { LogScreen } from '../features/intake/LogScreen';
import { IntakeEntryScreen } from '../features/intake/IntakeEntryScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { SnapScreen } from '../features/intake/SnapScreen';
import { PrivacyStorageScreen } from '../features/settings/PrivacyStorageScreen';
import { SupportFaqScreen } from '../features/settings/SupportFaqScreen';
import { AppLockScreen } from '../features/app-lock/AppLockScreen';
import { DiagnosticsScreen } from '../features/settings/DiagnosticsScreen';
import { DeleteLocalDataScreen } from '../features/settings/DeleteLocalDataScreen';
import { CloudAccountScreen } from '../features/settings/CloudAccountScreen';
import {
  registerNavigationFeatures,
  settingsNavigationForGate,
  type NavigationFeature,
  type NavigationRegistry,
  type SettingsNavigationRouteName,
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

const labsFeatures: readonly NavigationFeature[] = [
  {
    name: 'LabReportDetail',
    target: 'labs',
    component: LabReportDetailRoute,
    titleKey: 'labs.reportTitle',
  },
  {
    name: 'ExtractionDraft',
    target: 'labs',
    component: ExtractionDraftScreen,
    titleKey: 'labs.extractionTitle',
  },
  {
    name: 'LabRecordDetail',
    target: 'labs',
    component: LabRecordDetailRoute,
    titleKey: 'labs.recordTitle',
  },
  {
    name: 'BiomarkerHistory',
    target: 'labs',
    component: BiomarkerHistoryRoute,
    titleKey: 'labs.biomarkerHistoryTitle',
  },
];

const intakeFeatures: readonly NavigationFeature[] = [
  {
    name: 'IntakeEntry',
    target: 'log',
    component: IntakeEntryScreen,
    titleKey: 'intake.newTitle',
  },
];

const settingsFeatureComponents = {
  CloudAccount: CloudAccountScreen,
  AppLock: AppLockScreen,
  PrivacyStorage: PrivacyStorageScreen,
  SupportFaq: SupportFaqScreen,
  Diagnostics: DiagnosticsScreen,
  DeleteLocalData: DeleteLocalDataScreen,
} satisfies Record<SettingsNavigationRouteName, ComponentType<any>>;

const settingsFeatures: readonly NavigationFeature[] = settingsNavigationForGate().map(
  (definition) => ({
    ...definition,
    component: settingsFeatureComponents[definition.name],
  }),
);

/**
 * Later vertical slices register detail and form routes under an existing destination stack. The
 * root tabs remain stable while feature modules own their screen implementations.
 */
export function createNavigationRegistry(
  extensions: readonly NavigationFeature[] = [],
): NavigationRegistry {
  return registerNavigationFeatures(coreFeatures, [
    ...labsFeatures,
    ...intakeFeatures,
    ...settingsFeatures,
    ...extensions,
  ]);
}
