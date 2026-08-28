import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommonActions, StackActions, StackRouter } from '@react-navigation/routers';
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

test('pushing source preview keeps the measurement editor and its row context underneath', () => {
  const router = StackRouter({ initialRouteName: 'MainTabs' });
  const routeNames = [
    'MainTabs',
    'ExtractionMeasurementEditor',
    'OriginalSourcePreview',
    'SanitizedSourcePreview',
  ];
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
    StackActions.push('OriginalSourcePreview', {
      reportId: 'report-synthetic',
      pageIndex: 0,
    }) as never,
    options,
  );
  assert.deepEqual(
    withPreview?.routes.map((route) => [route.name, route.params]),
    [
      ['MainTabs', undefined],
      [
        'ExtractionMeasurementEditor',
        { reportId: 'report-synthetic', draftId: 'draft-synthetic', rowId: 'row-synthetic' },
      ],
      ['OriginalSourcePreview', { reportId: 'report-synthetic', pageIndex: 0 }],
    ],
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
    ['MainTabs', 'ExtractionMeasurementEditor'],
  );

  const withSanitizedPreview = afterBack
    ? router.getStateForAction(
        afterBack as StackNavigationState<ParamListBase>,
        StackActions.push('SanitizedSourcePreview', {
          reportId: 'report-synthetic',
          pageIndex: 0,
          boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        }) as never,
        options,
      )
    : null;
  assert.deepEqual(
    withSanitizedPreview?.routes.map((route) => route.name),
    ['MainTabs', 'ExtractionMeasurementEditor', 'SanitizedSourcePreview'],
  );
  const afterSanitizedBack = withSanitizedPreview
    ? router.getStateForAction(
        withSanitizedPreview as StackNavigationState<ParamListBase>,
        StackActions.pop(),
        options,
      )
    : null;
  assert.deepEqual(
    afterSanitizedBack?.routes.map((route) => route.name),
    ['MainTabs', 'ExtractionMeasurementEditor'],
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
  dispatchHomeQuickAction(navigation, { kind: 'open-report', reportId: 'report-43' });
  dispatchHomeQuickAction(navigation, { kind: 'open-record', recordId: 'record-42' });
  dispatchHomeQuickAction(navigation, {
    kind: 'open-biomarker-history',
    biomarkerId: 'biomarker.ldl_c',
  });
  dispatchHomeQuickAction(navigation, { kind: 'log-intake' });
  dispatchHomeQuickAction(navigation, { kind: 'snap' });
  dispatchHomeQuickAction(navigation, { kind: 'edit-intake', eventId: 'event-42' });

  assert.deepEqual(calls, [
    ['ReportImport'],
    ['Labs', { screen: 'LabReportDetail', params: { reportId: 'report-42' }, pop: true }],
    ['Labs', { screen: 'LabReportDetail', params: { reportId: 'report-43' }, pop: true }],
    ['Labs', { screen: 'LabRecordDetail', params: { recordId: 'record-42' }, pop: true }],
    ['Labs', { screen: 'BiomarkerHistory', params: { biomarkerId: 'biomarker.ldl_c' }, pop: true }],
    ['Log', { screen: 'IntakeEntry' }],
    ['SnapCapture'],
    ['Log', { screen: 'IntakeEntry', params: { eventId: 'event-42' } }],
  ]);
});

test('Home continues an open Extraction Draft at its exact Labs route', () => {
  const calls: unknown[][] = [];
  const navigation = {
    navigate: (...args: unknown[]) => calls.push(args),
    getParent: () => ({ navigate: (...args: unknown[]) => calls.push(args) }),
  } as unknown as ParentTabNavigation;

  dispatchHomeQuickAction(navigation, {
    kind: 'continue-report',
    reportId: 'report-confirmed',
    draftId: 'draft-open',
  });

  assert.deepEqual(calls, [
    [
      'Labs',
      {
        screen: 'ExtractionDraft',
        params: { reportId: 'report-confirmed', draftId: 'draft-open' },
        pop: true,
      },
    ],
  ]);
});

test('Continue report pops to the one existing detail route and leaves a clean Labs Back path', () => {
  const router = StackRouter({ initialRouteName: 'LabsRoot' });
  const options = {
    routeNames: ['LabsRoot', 'LabReportDetail', 'ExtractionDraft'],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options) as StackNavigationState<ParamListBase>;
  state = router.getStateForAction(
    state,
    StackActions.push('LabReportDetail', { reportId: 'report-R' }) as never,
    options,
  ) as StackNavigationState<ParamListBase>;
  state = router.getStateForAction(
    state,
    StackActions.push('ExtractionDraft', {
      reportId: 'report-R',
      draftId: 'draft-R',
    }) as never,
    options,
  ) as StackNavigationState<ParamListBase>;

  const continued = router.getStateForAction(
    state,
    CommonActions.navigate('LabReportDetail', { reportId: 'report-R' }, { pop: true }) as never,
    options,
  );

  assert.deepEqual(
    continued?.routes.map((route) => [route.name, route.params]),
    [
      ['LabsRoot', undefined],
      ['LabReportDetail', { reportId: 'report-R' }],
    ],
  );
  const afterBack = continued
    ? router.getStateForAction(
        continued as StackNavigationState<ParamListBase>,
        StackActions.pop() as never,
        options,
      )
    : null;
  assert.deepEqual(
    afterBack?.routes.map((route) => route.name),
    ['LabsRoot'],
  );
});

test('multi-record confirmation can pop to Labs without stacking another root', () => {
  const router = StackRouter({ initialRouteName: 'LabsRoot' });
  const options = {
    routeNames: ['LabsRoot', 'ExtractionDraft'],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options) as StackNavigationState<ParamListBase>;
  state = router.getStateForAction(
    state,
    StackActions.push('ExtractionDraft', {
      reportId: 'report-multi',
      draftId: 'draft-multi',
    }) as never,
    options,
  ) as StackNavigationState<ParamListBase>;

  const afterConfirm = router.getStateForAction(state, StackActions.popToTop(), options);
  assert.deepEqual(
    afterConfirm?.routes.map((route) => route.name),
    ['LabsRoot'],
  );
});

test('root terminal handoff removes extraction progress before opening the existing MainTabs', () => {
  const router = StackRouter({ initialRouteName: 'MainTabs' });
  const options = {
    routeNames: ['MainTabs', 'ExtractionProgress'],
    routeParamList: {},
    routeGetIdList: {},
  };
  let state = router.getInitialState(options) as StackNavigationState<ParamListBase>;
  state = router.getStateForAction(
    state,
    StackActions.push('ExtractionProgress', { reportId: 'report-progress' }) as never,
    options,
  ) as StackNavigationState<ParamListBase>;

  const terminal = router.getStateForAction(
    state,
    CommonActions.navigate(
      'MainTabs',
      {
        screen: 'Labs',
        params: {
          screen: 'ExtractionDraft',
          params: { reportId: 'report-progress', draftId: 'draft-progress' },
          pop: true,
        },
      },
      { pop: true },
    ) as never,
    options,
  );

  assert.deepEqual(
    terminal?.routes.map((route) => route.name),
    ['MainTabs'],
  );
  assert.deepEqual(terminal?.routes[0]?.params, {
    screen: 'Labs',
    params: {
      screen: 'ExtractionDraft',
      params: { reportId: 'report-progress', draftId: 'draft-progress' },
      pop: true,
    },
  });
});
