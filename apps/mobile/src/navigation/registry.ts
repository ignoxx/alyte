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
import { ModelStorageScreen } from '../features/settings/ModelStorageScreen';
import { SupportFaqScreen } from '../features/settings/SupportFaqScreen';
import { AppLockScreen } from '../features/app-lock/AppLockScreen';
import { DiagnosticsScreen } from '../features/settings/DiagnosticsScreen';
import { DeleteLocalDataScreen } from '../features/settings/DeleteLocalDataScreen';
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

const settingsFeatures: readonly NavigationFeature[] = [
  {
    name: 'AppLock',
    target: 'settings',
    component: AppLockScreen,
    titleKey: 'settings.appLockTitle',
  },
  {
    name: 'PrivacyStorage',
    target: 'settings',
    component: PrivacyStorageScreen,
    titleKey: 'settings.privacyTitle',
  },
  {
    name: 'ModelStorage',
    target: 'settings',
    component: ModelStorageScreen,
    titleKey: 'settings.modelStorageTitle',
  },
  {
    name: 'SupportFaq',
    target: 'settings',
    component: SupportFaqScreen,
    titleKey: 'settings.supportTitle',
  },
  {
    name: 'Diagnostics',
    target: 'settings',
    component: DiagnosticsScreen,
    titleKey: 'settings.diagnosticsTitle',
  },
  {
    name: 'DeleteLocalData',
    target: 'settings',
    component: DeleteLocalDataScreen,
    titleKey: 'settings.deleteTitle',
  },
];

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
