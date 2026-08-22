import { NavigationContainer } from '@react-navigation/native';
import {
  createBottomTabNavigator,
  type BottomTabBarButtonProps,
} from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Pressable, StyleSheet, View } from 'react-native';
import type { AlyteServices } from '../services';
import { t } from '../localization';
import { colors, spacing } from '../theme';
import { createNavigationRegistry } from './registry';
import type { FeatureTarget, NavigationFeature } from './registry-model';
import type { MainTabParamList, RootStackParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTabs = createBottomTabNavigator<MainTabParamList>();
const FeatureStack = createNativeStackNavigator<Record<string, object | undefined>>();

type RootNavigatorProps = {
  services: AlyteServices;
  extensions?: readonly NavigationFeature[] | undefined;
};

function SnapTabButton({ accessibilityLabel, onPress, onLongPress }: BottomTabBarButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? t('accessibility.snapAction')}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.snapButton, pressed && styles.pressed]}
    >
      <View style={styles.snapCircle}>
        <View style={styles.snapDot} />
      </View>
    </Pressable>
  );
}

function FeatureStackNavigator({
  root,
  extensions,
}: {
  root: NavigationFeature;
  extensions: readonly NavigationFeature[];
}) {
  return (
    <FeatureStack.Navigator>
      <FeatureStack.Screen
        name={root.name}
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

function MainTabNavigator({ services: _services, extensions = [] }: RootNavigatorProps) {
  const registry = createNavigationRegistry(extensions);

  return (
    <MainTabs.Navigator
      initialRouteName="Home"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.mutedInk,
        tabBarLabelStyle: styles.tabLabel,
        tabBarStyle: styles.tabBar,
      }}
    >
      <MainTabs.Screen name="Home" options={{ tabBarLabel: t(registry.home.titleKey) }}>
        {() => (
          <FeatureStackNavigator
            root={registry.home}
            extensions={stackExtensions(registry.extensions, 'home')}
          />
        )}
      </MainTabs.Screen>
      <MainTabs.Screen name="Labs" options={{ tabBarLabel: t(registry.labs.titleKey) }}>
        {() => (
          <FeatureStackNavigator
            root={registry.labs}
            extensions={stackExtensions(registry.extensions, 'labs')}
          />
        )}
      </MainTabs.Screen>
      <MainTabs.Screen
        name="SnapAction"
        component={registry.snap.component}
        options={{
          tabBarLabel: t(registry.snap.titleKey),
          tabBarButton: (props) => (
            <SnapTabButton {...props} accessibilityLabel={t('accessibility.snapAction')} />
          ),
        }}
      />
      <MainTabs.Screen name="Log" options={{ tabBarLabel: t(registry.log.titleKey) }}>
        {() => (
          <FeatureStackNavigator
            root={registry.log}
            extensions={stackExtensions(registry.extensions, 'log')}
          />
        )}
      </MainTabs.Screen>
      <MainTabs.Screen name="Settings" options={{ tabBarLabel: t(registry.settings.titleKey) }}>
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
  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="MainTabs">
          {() => <MainTabNavigator services={services} extensions={extensions} />}
        </RootStack.Screen>
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    height: 78,
    paddingBottom: spacing.sm,
    paddingTop: spacing.xs,
  },
  tabLabel: { fontSize: 12, fontWeight: '600' },
  snapButton: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  snapCircle: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderColor: colors.surface,
    borderRadius: 32,
    borderWidth: 4,
    height: 58,
    justifyContent: 'center',
    marginTop: -22,
    width: 58,
  },
  snapDot: { backgroundColor: colors.warm, borderRadius: 8, height: 16, width: 16 },
  pressed: { opacity: 0.78 },
});
