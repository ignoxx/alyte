import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StackActions, StackRouter } from '@react-navigation/routers';
import type { ParamListBase, StackNavigationState } from '@react-navigation/routers';
import {
  extractionEditorDestination,
  biomarkerHistoryDestination,
  featureStackRootName,
  preGateTabNames,
  reportImportDestination,
  registerNavigationFeatures,
  snapActionDestination,
  type CoreNavigationFeatures,
} from './registry-model';
import { dispatchHomeQuickAction, type ParentTabNavigation } from './parent-tab';

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

test('pre-gate shell exposes three tabs and report import is a root full-screen task', () => {
  assert.deepEqual(preGateTabNames, ['Home', 'Labs', 'Settings']);
  assert.deepEqual(reportImportDestination, {
    route: 'ReportImport',
    presentation: 'fullScreenModal',
  });
});

test('the extraction editor is a root form sheet', () => {
  assert.deepEqual(extractionEditorDestination, {
    route: 'ExtractionMeasurementEditor',
    presentation: 'formSheet',
  });
});

test('biomarker history stays a generic push route inside Labs', () => {
  assert.deepEqual(biomarkerHistoryDestination, {
    route: 'BiomarkerHistory',
    presentation: 'push',
  });
});

test('replacing the root editor with source preview keeps MainTabs underneath for Back', () => {
  const router = StackRouter({ initialRouteName: 'MainTabs' });
  const routeNames = ['MainTabs', 'ExtractionMeasurementEditor', 'SanitizedSourcePreview'];
  const options = {
    routeNames,
    routeParamList: {},
    routeGetIdList: {},
  };
  const initial = router.getInitialState(options);
  const withEditor = router.getStateForAction(
    initial as StackNavigationState<ParamListBase>,
    StackActions.push('ExtractionMeasurementEditor', {
      reportId: 'report-synthetic',
      draftId: 'draft-synthetic',
      rowId: 'row-synthetic',
    }) as never,
    options,
  );
  assert.ok(withEditor);

  const withPreview = router.getStateForAction(
    withEditor as StackNavigationState<ParamListBase>,
    StackActions.replace('SanitizedSourcePreview', {
      reportId: 'report-synthetic',
      pageIndex: 0,
      boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    }) as never,
    options,
  );
  assert.deepEqual(
    withPreview?.routes.map((route) => route.name),
    ['MainTabs', 'SanitizedSourcePreview'],
  );

  const afterBack = withPreview
    ? router.getStateForAction(
        withPreview as StackNavigationState<ParamListBase>,
        StackActions.pop(),
        options,
      )
    : null;
  assert.deepEqual(
    afterBack?.routes.map((route) => route.name),
    ['MainTabs'],
  );
});

test('Home quick actions dispatch to sibling tabs and preserve the Log edit push', () => {
  const calls: unknown[][] = [];
  const navigation = {
    navigate: (...args: unknown[]) => calls.push(args),
    getParent: () => ({ navigate: (...args: unknown[]) => calls.push(args) }),
  } as unknown as ParentTabNavigation;

  dispatchHomeQuickAction(navigation, { kind: 'import-report' });
  dispatchHomeQuickAction(navigation, { kind: 'continue-report', reportId: 'report-42' });
  dispatchHomeQuickAction(navigation, { kind: 'log-intake' });
  dispatchHomeQuickAction(navigation, { kind: 'snap' });
  dispatchHomeQuickAction(navigation, { kind: 'edit-intake', eventId: 'event-42' });

  assert.deepEqual(calls, [
    ['ReportImport'],
    ['Labs', { screen: 'LabReportDetail', params: { reportId: 'report-42' } }],
    ['Log', { screen: 'IntakeEntry' }],
    ['SnapCapture'],
    ['Log', { screen: 'IntakeEntry', params: { eventId: 'event-42' } }],
  ]);
});
