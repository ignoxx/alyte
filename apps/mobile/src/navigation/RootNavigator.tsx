import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import {
  createNativeBottomTabNavigator,
  type NativeBottomTabScreenProps,
} from '@react-navigation/bottom-tabs/unstable';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { ComponentType } from 'react';
import { useColorScheme } from 'react-native';
import type { AlyteServices } from '../services';
import { t } from '../localization';
import { colors } from '../theme';
import { createNavigationRegistry } from './registry';
import type { FeatureTarget, NavigationFeature } from './registry-model';
import { featureStackRootName, snapActionDestination } from './registry-model';
import type { MainTabParamList, RootStackParamList } from './types';
import { SnapScreen } from '../features/intake/SnapScreen';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTabs = createNativeBottomTabNavigator<MainTabParamList>();
const FeatureStack = createNativeStackNavigator<Record<string, object | undefined>>();

type RootNavigatorProps = {
  services: AlyteServices;
  extensions?: readonly NavigationFeature[] | undefined;
};

type MainTabNavigatorProps = RootNavigatorProps & {
  readonly onSnap: () => void;
};

const stackScreenOptions = {
  contentStyle: { backgroundColor: colors.canvas },
  headerBackButtonDisplayMode: 'minimal' as const,
  headerShadowVisible: false,
  // native-stack's headerStyle typing predates RN's opaque semantic color type; UIKit accepts it
  // at runtime and resolves it against the current appearance.
  headerStyle: { backgroundColor: colors.canvas as string },
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

function SnapActionPlaceholder() {
  return null;
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
          options={{ title: t(feature.titleKey) }}
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

function MainTabNavigator({ services: _services, extensions = [], onSnap }: MainTabNavigatorProps) {
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
      initialRouteName="Home"
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.mutedInk,
        // UIKit owns height, insets, materials, and transitions. `none` keeps the bar present while
        // scrolling until content-inset behavior is proven on every supported device.
        tabBarMinimizeBehavior: 'none',
        tabBarControllerMode: 'tabBar',
        tabBarBlurEffect: 'systemMaterial',
        overrideScrollViewContentInsetAdjustmentBehavior: true,
      }}
    >
      <MainTabs.Screen
        name="Home"
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
        name="Labs"
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
        name="SnapAction"
        component={
          SnapActionPlaceholder as ComponentType<
            NativeBottomTabScreenProps<MainTabParamList, 'SnapAction'>
          >
        }
        listeners={({ navigation }) => ({
          tabPress: () => {
            // Snap is an action, not a fifth content destination. Return to Home underneath the
            // full-screen capture route so completing or cancelling always lands on the day view.
            navigation.navigate(snapActionDestination.returnTab);
            onSnap();
          },
        })}
        options={{
          tabBarIcon: ({ focused }) => tabIcon(focused ? 'camera.fill' : 'camera'),
          tabBarLabel: t(registry.snap.titleKey),
          tabBarSelectionEnabled: false,
        }}
      />
      <MainTabs.Screen
        name="Log"
        options={{
          tabBarIcon: () => tabIcon('list.bullet'),
          tabBarLabel: t(registry.log.titleKey),
        }}
      >
        {() => (
          <FeatureStackNavigator
            root={registry.log}
            extensions={stackExtensions(registry.extensions, 'log')}
          />
        )}
      </MainTabs.Screen>
      <MainTabs.Screen
        name="Settings"
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
          {({ navigation }) => (
            <MainTabNavigator
              extensions={extensions}
              onSnap={() => navigation.navigate(snapActionDestination.captureRoute)}
              services={services}
            />
          )}
        </RootStack.Screen>
        <RootStack.Screen
          name="SnapCapture"
          component={SnapScreen}
          options={{ presentation: 'fullScreenModal', headerShown: false }}
        />
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
