import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  useIsFocused,
  type Theme,
} from '@react-navigation/native';
import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { PropsWithChildren } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { useHeaderHeight } from '@react-navigation/elements';
import { StatusBar } from 'expo-status-bar';
import type { AlyteServices } from '../services';
import { t } from '../localization';
import { colors, spacing } from '../theme';
import { createNavigationRegistry } from './registry';
import type { FeatureTarget, NavigationFeature } from './registry-model';
import {
  featureStackRootName,
  importPackSetupDestination,
  preGateTabNames,
  reportImportDestination,
} from './registry-model';
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
import { OriginalSourcePreviewScreen } from '../features/labs/OriginalSourcePreviewScreen';
import { ExtractionProgressScreen } from '../features/labs/ExtractionProgressScreen';
import { FullExportScreen } from '../features/settings/FullExportScreen';
import { LabRecordFormRoute } from '../features/labs/LabRecordFormRoute';
import { CloudPaywallScreen } from '../features/commerce/CloudPaywallScreen';
import { ImportPackSetupScreen } from '../features/onboarding/OnboardingScreen';
import { TidalHero } from '../ui/primitives';

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
  headerTransparent: false,
  headerShadowVisible: false,
  // Native-stack's headerStyle typing predates RN's opaque semantic color type; UIKit accepts it
  // at runtime and resolves it against the current appearance. Keep the back affordance/action
  // accent while the native title itself follows the semantic label color.
  headerTintColor: colors.accent as string,
  headerTitleStyle: { color: colors.ink as string },
  headerTitleAlign: 'center' as const,
};

/**
 * Pushed feature details use the same full-width brand treatment as the Home hero. The native
 * header still owns the title and back action; this only supplies its background and tint.
 * The absolute background lets native-stack determine the header height, including the status bar
 * and large-title measurements, instead of guessing a platform-specific height.
 */
const featureDetailHeaderOptions = {
  headerBackground: () => <FeatureDetailHeaderBackground />,
  headerLargeStyle: { backgroundColor: 'transparent' },
  headerLargeTitleEnabled: true,
  headerLargeTitleStyle: { color: colors.onBrand as string },
  headerShadowVisible: false,
  headerTitleStyle: { color: colors.onBrand as string },
  headerTintColor: colors.onBrand as string,
};

function FeatureDetailHeaderBackground() {
  const isFocused = useIsFocused();
  return (
    <>
      {isFocused && <StatusBar style="light" />}
      <TidalHero edge="bottom" style={styles.featureDetailHeaderBackground} />
    </>
  );
}

function isEditingOrPreviewFeature(feature: NavigationFeature): boolean {
  const presentation = feature.options?.presentation;
  return (
    presentation === 'formSheet' || presentation === 'modal' || presentation === 'fullScreenModal'
  );
}

/**
 * The native header and the detail content deliberately share one curved hero in two slices. The
 * continuation is sized from React Navigation's actual header context so large-title, inset, and
 * platform-specific header measurements remain aligned.
 */
function DetailScreenLayout({ children }: PropsWithChildren) {
  const headerHeight = useHeaderHeight();
  const continuationHeight = spacing.lg;
  return (
    <View style={styles.detailScreenLayout}>
      <View pointerEvents="none" style={styles.detailHeaderContinuation}>
        <TidalHero
          edge="bottom"
          style={[
            styles.detailHeaderContinuationHero,
            {
              height: headerHeight + continuationHeight,
              top: -headerHeight,
            },
          ]}
        />
      </View>
      <View style={styles.detailScreenContent}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  featureDetailHeaderBackground: {
    bottom: -spacing.lg,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  detailScreenLayout: { flex: 1 },
  detailHeaderContinuation: {
    height: spacing.lg,
    overflow: 'hidden',
    width: '100%',
  },
  detailHeaderContinuationHero: {
    left: 0,
    position: 'absolute',
    right: 0,
  },
  detailScreenContent: { flex: 1 },
});

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
      primary: colors.accent as string,
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
    <FeatureStack.Navigator
      screenLayout={({ children, options }) =>
        options.headerBackground === undefined ? (
          children
        ) : (
          <DetailScreenLayout>{children}</DetailScreenLayout>
        )
      }
      screenOptions={stackScreenOptions}
    >
      <FeatureStack.Screen
        name={stackRootName}
        component={root.component}
        options={{
          // Every tab root owns its visible heading. Keeping the native header here would render
          // a second title above the Home/Labs/Settings hero and consume valuable first-screen
          // space. Pushed detail routes continue to use the native stack header.
          headerLargeTitle: false,
          headerShown: false,
          title: t(root.titleKey),
        }}
      />
      {extensions.map((feature) => (
        <FeatureStack.Screen
          key={feature.name}
          name={feature.name}
          component={feature.component}
          options={{
            ...(isEditingOrPreviewFeature(feature) ? {} : featureDetailHeaderOptions),
            title: t(feature.titleKey),
            ...feature.options,
          }}
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
      <RootStack.Navigator screenOptions={{ ...stackScreenOptions, headerShown: false }}>
        <RootStack.Screen name="MainTabs">
          {() => <MainTabNavigator extensions={extensions} services={services} />}
        </RootStack.Screen>
        <RootStack.Screen
          name="CloudPaywall"
          component={CloudPaywallScreen}
          options={{
            presentation: 'fullScreenModal',
            headerShown: true,
            title: t('settings.cloudPlans'),
            headerLargeTitle: false,
          }}
        />
        <RootStack.Screen
          name={importPackSetupDestination.route}
          component={ImportPackSetupScreen}
          options={{
            presentation: importPackSetupDestination.presentation,
            headerShown: true,
            headerTransparent: false,
            title: t('settings.importPackTitle'),
          }}
        />
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
          name="LabRecordForm"
          component={LabRecordFormRoute}
          options={{
            contentStyle: { backgroundColor: colors.canvas },
            presentation: 'fullScreenModal',
            headerBackVisible: false,
            headerLargeTitle: false,
            headerShown: true,
            headerShadowVisible: false,
            headerTintColor: colors.accent as string,
            title: t('labs.recordCreateTitle'),
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
          name="OriginalSourcePreview"
          component={OriginalSourcePreviewScreen}
          options={{
            presentation: 'fullScreenModal',
            headerShown: true,
            headerTransparent: false,
            title: t('labs.reportPreviewTitle'),
          }}
        />
        <RootStack.Screen
          name="ExtractionProgress"
          component={ExtractionProgressScreen}
          options={{ presentation: 'fullScreenModal', headerShown: false }}
        />
        <RootStack.Screen
          name={extractionEditorDestination.route}
          component={ExtractionMeasurementEditorScreen}
          options={{
            presentation: extractionEditorDestination.presentation,
            sheetAllowedDetents: [0.92],
            sheetInitialDetentIndex: 0,
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
        <RootStack.Screen
          name="FullExport"
          component={FullExportScreen}
          options={{
            presentation: 'fullScreenModal',
            headerShown: true,
            title: t('settings.exportTitle'),
          }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
