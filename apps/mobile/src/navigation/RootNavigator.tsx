import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useColorScheme } from 'react-native';
import type { AlyteServices } from '../services';
import { t } from '../localization';
import { colors } from '../theme';
import { createNavigationRegistry } from './registry';
import type { FeatureTarget, NavigationFeature } from './registry-model';
import { featureStackRootName, preGateTabNames, reportImportDestination } from './registry-model';
import type { MainTabParamList, RootStackParamList } from './types';
import { SnapScreen } from '../features/intake/SnapScreen';
import { SanitizedReportEditorRoute } from '../features/labs/SanitizedReportEditorRoute';
import { LabReportImportRoute } from '../features/labs/LabReportImportRoute';
import { SanitizedSourcePreviewScreen } from '../features/labs/SanitizedSourcePreviewScreen';
import { ExtractionMeasurementEditorScreen } from '../features/labs/ExtractionMeasurementEditorScreen';
import { extractionEditorDestination } from './registry-model';
import { MeasurementCorrectionScreen } from '../features/labs/MeasurementCorrectionScreen';
import { LabDeletionScreen } from '../features/labs/LabDeletionScreen';
import { RecordSourcePreviewScreen } from '../features/labs/RecordSourcePreviewScreen';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTabs = createNativeBottomTabNavigator<MainTabParamList>();
const FeatureStack = createNativeStackNavigator<Record<string, object | undefined>>();
const [homeTabName, labsTabName, settingsTabName] = preGateTabNames;

type RootNavigatorProps = {
  services: AlyteServices;
  extensions?: readonly NavigationFeature[] | undefined;
};

type MainTabNavigatorProps = RootNavigatorProps;

const stackScreenOptions = {
  contentStyle: { backgroundColor: colors.canvas },
  headerBackButtonDisplayMode: 'minimal' as const,
  headerLargeTitle: false,
  headerTransparent: true,
  headerShadowVisible: false,
  // native-stack's headerStyle typing predates RN's opaque semantic color type; UIKit accepts it
  // at runtime and resolves it against the current appearance.
  headerTintColor: colors.accent,
  headerTitleAlign: 'left' as const,
};

function navigationTheme(dark: boolean): Theme {
  const base = dark ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark,
    colors: {
      ...base.colors,
      background: colors.canvas as string,
      border: colors.border as string,
      card: colors.surface as string,
      notification: colors.danger as string,
      primary: colors.accent,
      text: colors.ink as string,
    },
  };
}

function FeatureStackNavigator({
  root,
  extensions,
}: {
  root: NavigationFeature;
  extensions: readonly NavigationFeature[];
}) {
  // The tab route and its stack root intentionally have different names. This keeps nested
  // navigation actions unambiguous (e.g. the Labs tab contains the LabsRoot screen).
  const stackRootName = featureStackRootName(root.name);

  return (
    <FeatureStack.Navigator screenOptions={stackScreenOptions}>
      <FeatureStack.Screen
        name={stackRootName}
        component={root.component}
        options={{ title: t(root.titleKey) }}
      />
      {extensions.map((feature) => (
        <FeatureStack.Screen
          key={feature.name}
          name={feature.name}
          component={feature.component}
          options={{ title: t(feature.titleKey), ...feature.options }}
        />
      ))}
    </FeatureStack.Navigator>
  );
}

function stackExtensions(
  extensions: readonly NavigationFeature[],
  target: FeatureTarget,
): readonly NavigationFeature[] {
  return extensions.filter((feature) => feature.target === target);
}

function MainTabNavigator({ services: _services, extensions = [] }: MainTabNavigatorProps) {
  const registry = createNavigationRegistry(extensions);
  const tabIcon = (
    name:
      | 'house'
      | 'house.fill'
      | 'testtube.2'
      | 'camera'
      | 'camera.fill'
      | 'list.bullet'
      | 'gearshape'
      | 'gearshape.fill',
  ) => ({ type: 'sfSymbol' as const, name });

  return (
    <MainTabs.Navigator
      initialRouteName={homeTabName}
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.mutedInk,
        // UIKit owns height, insets, materials, and transitions. `none` keeps the bar present while
        // scrolling until content-inset behavior is proven on every supported device.
        tabBarMinimizeBehavior: 'none',
        tabBarControllerMode: 'tabBar',
        // Do not force a legacy blur. On iOS 26 UIKit owns the Liquid Glass material and adapts it
        // to scroll-edge and accessibility settings when no blur effect is supplied.
        overrideScrollViewContentInsetAdjustmentBehavior: true,
      }}
    >
      <MainTabs.Screen
        name={homeTabName}
        options={{
          tabBarIcon: ({ focused }) => tabIcon(focused ? 'house.fill' : 'house'),
          tabBarLabel: t(registry.home.titleKey),
        }}
      >
        {() => (
          <FeatureStackNavigator
            root={registry.home}
            extensions={stackExtensions(registry.extensions, 'home')}
          />
        )}
      </MainTabs.Screen>
      <MainTabs.Screen
        name={labsTabName}
        options={{
          tabBarIcon: () => tabIcon('testtube.2'),
          tabBarLabel: t(registry.labs.titleKey),
        }}
      >
        {() => (
          <FeatureStackNavigator
            root={registry.labs}
            extensions={stackExtensions(registry.extensions, 'labs')}
          />
        )}
      </MainTabs.Screen>
      <MainTabs.Screen
        name={settingsTabName}
        options={{
          tabBarIcon: ({ focused }) => tabIcon(focused ? 'gearshape.fill' : 'gearshape'),
          tabBarLabel: t(registry.settings.titleKey),
        }}
      >
        {() => (
          <FeatureStackNavigator
            root={registry.settings}
            extensions={stackExtensions(registry.extensions, 'settings')}
          />
        )}
      </MainTabs.Screen>
    </MainTabs.Navigator>
  );
}

export function RootNavigator({ services, extensions }: RootNavigatorProps) {
  const colorScheme = useColorScheme();
  const dark = colorScheme === 'dark';

  return (
    <NavigationContainer theme={navigationTheme(dark)}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="MainTabs">
          {() => <MainTabNavigator extensions={extensions} services={services} />}
        </RootStack.Screen>
        <RootStack.Screen
          name={reportImportDestination.route}
          component={LabReportImportRoute}
          options={{
            presentation: reportImportDestination.presentation,
            headerShown: true,
            title: t('labs.reportImportTitle'),
          }}
        />
        <RootStack.Screen
          name="SnapCapture"
          component={SnapScreen}
          options={{ presentation: 'fullScreenModal', headerShown: false }}
        />
        <RootStack.Screen
          name="PrivacyWorkspace"
          component={SanitizedReportEditorRoute}
          options={{ presentation: 'fullScreenModal', headerShown: true }}
        />
        <RootStack.Screen
          name={extractionEditorDestination.route}
          component={ExtractionMeasurementEditorScreen}
          options={{
            presentation: extractionEditorDestination.presentation,
            sheetAllowedDetents: [0.6, 0.92],
            sheetInitialDetentIndex: 1,
            sheetGrabberVisible: true,
            headerLargeTitle: false,
            headerShown: true,
            title: t('labs.extractionEditorTitle'),
          }}
        />
        <RootStack.Screen
          name="SanitizedSourcePreview"
          component={SanitizedSourcePreviewScreen}
          options={{
            presentation: 'fullScreenModal',
            headerShown: true,
            title: t('labs.extractionSourcePreviewTitle'),
          }}
        />
        <RootStack.Screen
          name="MeasurementCorrection"
          component={MeasurementCorrectionScreen}
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.92],
            sheetGrabberVisible: true,
            headerShown: true,
            title: t('labs.detailCorrectionTitle'),
          }}
        />
        <RootStack.Screen
          name="LabDeletion"
          component={LabDeletionScreen}
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.75, 0.92],
            sheetGrabberVisible: true,
            headerShown: true,
            title: t('labs.detailDeletionPreview'),
          }}
        />
        <RootStack.Screen
          name="RecordSourcePreview"
          component={RecordSourcePreviewScreen}
          options={{
            presentation: 'fullScreenModal',
            headerShown: true,
            title: t('labs.extractionSourcePreviewTitle'),
          }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
