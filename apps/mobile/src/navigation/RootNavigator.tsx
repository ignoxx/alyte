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
import type { MainTabParamList, RootStackParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const MainTabs = createBottomTabNavigator<MainTabParamList>();

type RootNavigatorProps = {
  services: AlyteServices;
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

function MainTabNavigator({ services: _services }: RootNavigatorProps) {
  const routes = createNavigationRegistry();
  const [home, labs, snap, log, settings] = routes;
  if (!home || !labs || !snap || !log || !settings) {
    throw new Error('Core navigation registry is incomplete');
  }

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
      <MainTabs.Screen
        name="Home"
        component={home.component}
        options={{ tabBarLabel: t(home.titleKey) }}
      />
      <MainTabs.Screen
        name="Labs"
        component={labs.component}
        options={{ tabBarLabel: t(labs.titleKey) }}
      />
      <MainTabs.Screen
        name="SnapAction"
        component={snap.component}
        options={{
          tabBarLabel: t(snap.titleKey),
          tabBarButton: (props) => (
            <SnapTabButton {...props} accessibilityLabel={t('accessibility.snapAction')} />
          ),
        }}
      />
      <MainTabs.Screen
        name="Log"
        component={log.component}
        options={{ tabBarLabel: t(log.titleKey) }}
      />
      <MainTabs.Screen
        name="Settings"
        component={settings.component}
        options={{ tabBarLabel: t(settings.titleKey) }}
      />
    </MainTabs.Navigator>
  );
}

export function RootNavigator({ services }: RootNavigatorProps) {
  return (
    <NavigationContainer>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="MainTabs">
          {() => <MainTabNavigator services={services} />}
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
