import type { NavigationProp, ParamListBase } from '@react-navigation/native';
import type { MainTabParamList, RootStackParamList } from './types';
import { reportImportDestination, snapActionDestination } from './registry-model';

export type FeatureStackNavigation = NavigationProp<ParamListBase>;
export type ParentTabNavigation = NavigationProp<MainTabParamList>;

export type HomeQuickAction =
  | { readonly kind: 'import-report' }
  | { readonly kind: 'continue-report'; readonly reportId: string }
  | { readonly kind: 'open-report'; readonly reportId: string }
  | { readonly kind: 'open-record'; readonly recordId: string }
  | { readonly kind: 'open-biomarker-history'; readonly biomarkerId: string }
  | { readonly kind: 'log-intake' }
  | { readonly kind: 'snap' }
  | { readonly kind: 'edit-intake'; readonly eventId: string };

/** Resolve the native tab navigator that owns a feature stack screen. */
export function getParentTabNavigation(navigation: FeatureStackNavigation): ParentTabNavigation {
  const parent = navigation.getParent<ParentTabNavigation>();
  if (parent === undefined) {
    throw new Error('Home quick actions require a parent tab navigator');
  }
  return parent;
}

/** Dispatch a Home action to its sibling native tab, optionally entering a child stack route. */
export function dispatchHomeQuickAction(
  navigation: ParentTabNavigation,
  action: HomeQuickAction,
): void {
  switch (action.kind) {
    case 'import-report':
      navigation
        .getParent<NavigationProp<RootStackParamList>>()
        ?.navigate(reportImportDestination.route);
      return;
    case 'continue-report':
      navigation.navigate('Labs', {
        screen: 'LabReportDetail',
        params: { reportId: action.reportId },
        // React Navigation's nested pop option returns to an existing detail route for this
        // report instead of appending a duplicate beneath an open Extraction Draft.
        pop: true,
      });
      return;
    case 'open-report':
      navigation.navigate('Labs', {
        screen: 'LabReportDetail',
        params: { reportId: action.reportId },
        pop: true,
      });
      return;
    case 'open-record':
      navigation.navigate('Labs', {
        screen: 'LabRecordDetail',
        params: { recordId: action.recordId },
        pop: true,
      });
      return;
    case 'open-biomarker-history':
      navigation.navigate('Labs', {
        screen: 'BiomarkerHistory',
        params: { biomarkerId: action.biomarkerId },
        pop: true,
      });
      return;
    case 'log-intake':
      navigation.navigate('Log', { screen: 'IntakeEntry' });
      return;
    case 'snap': {
      const root = navigation.getParent<NavigationProp<RootStackParamList>>();
      if (root === undefined) {
        throw new Error('Home Snap action requires the root navigator');
      }
      root.navigate(snapActionDestination.captureRoute);
      return;
    }
    case 'edit-intake':
      navigation.navigate('Log', {
        screen: 'IntakeEntry',
        params: { eventId: action.eventId },
      });
      return;
  }
}

export function openReportImportFromStack(navigation: FeatureStackNavigation): void {
  const root = getParentTabNavigation(navigation).getParent<NavigationProp<RootStackParamList>>();
  if (root === undefined) throw new Error('Report import requires the root navigator');
  root.navigate(reportImportDestination.route);
}

export function dispatchHomeQuickActionFromStack(
  navigation: FeatureStackNavigation,
  action: HomeQuickAction,
): void {
  dispatchHomeQuickAction(getParentTabNavigation(navigation), action);
}
