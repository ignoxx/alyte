import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useState } from 'react';
import { useColorScheme } from 'react-native';
import { DesignLabContext } from './context';
import {
  DesignLabHomeScreen,
  DesignLabImportScreen,
  DesignLabLabsScreen,
  DesignLabSettingsScreen,
} from './DesignLabScreens';
import type { DesignLabDirection, DesignLabState } from './model';
import { labAccents, labColors } from './theme';

const Tabs = createNativeBottomTabNavigator();
const Stack = createNativeStackNavigator();

function HomeStack({ openImport }: { openImport: () => void }) {
  return (
    <Stack.Navigator>
      <Stack.Screen name="HomeRoot" options={{ title: 'Home', headerLargeTitle: true }}>
        {() => <DesignLabHomeScreen onImport={openImport} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

function LabsStack({ openImport }: { openImport: () => void }) {
  return (
    <Stack.Navigator>
      <Stack.Screen name="LabsRoot" options={{ title: 'Labs', headerLargeTitle: true }}>
        {() => <DesignLabLabsScreen onImport={openImport} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

function SettingsStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen
        name="SettingsRoot"
        component={DesignLabSettingsScreen}
        options={{ title: 'Settings', headerLargeTitle: true }}
      />
    </Stack.Navigator>
  );
}

function LabTabs({ openImport }: { openImport: () => void }) {
  const initialDirection = process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_DIRECTION;
  const initialState = process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_STATE;
  const [direction, setDirection] = useState<DesignLabDirection>(
    initialDirection === 'timeline' || initialDirection === 'library' ? initialDirection : 'quiet',
  );
  const [state, setState] = useState<DesignLabState>(
    initialState === 'two-reports' ? 'two-reports' : 'empty',
  );
  const icon = (name: 'house' | 'house.fill' | 'testtube.2' | 'gearshape' | 'gearshape.fill') => ({
    type: 'sfSymbol' as const,
    name,
  });
  return (
    <DesignLabContext.Provider value={{ direction, state, setDirection, setState }}>
      <Tabs.Navigator
        initialRouteName={
          process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_TAB === 'labs' ? 'LabLabs' : 'LabHome'
        }
        screenOptions={{
          tabBarActiveTintColor: labAccents[direction],
          tabBarInactiveTintColor: labColors.secondary,
          tabBarControllerMode: 'tabBar',
          tabBarMinimizeBehavior: 'none',
          overrideScrollViewContentInsetAdjustmentBehavior: true,
        }}
      >
        <Tabs.Screen
          name="LabHome"
          options={{
            title: 'Home',
            tabBarLabel: 'Home',
            tabBarIcon: ({ focused }) => icon(focused ? 'house.fill' : 'house'),
          }}
        >
          {() => <HomeStack openImport={openImport} />}
        </Tabs.Screen>
        <Tabs.Screen
          name="LabLabs"
          options={{ title: 'Labs', tabBarLabel: 'Labs', tabBarIcon: () => icon('testtube.2') }}
        >
          {() => <LabsStack openImport={openImport} />}
        </Tabs.Screen>
        <Tabs.Screen
          name="LabSettings"
          component={SettingsStack}
          options={{
            title: 'Settings',
            tabBarLabel: 'Settings',
            tabBarIcon: ({ focused }) => icon(focused ? 'gearshape.fill' : 'gearshape'),
          }}
        />
      </Tabs.Navigator>
    </DesignLabContext.Provider>
  );
}

export function DesignLabNavigator() {
  const dark = useColorScheme() === 'dark';
  const base = dark ? DarkTheme : DefaultTheme;
  return (
    <NavigationContainer
      theme={{
        ...base,
        colors: {
          ...base.colors,
          background: labColors.background as string,
          card: labColors.surface as string,
        },
      }}
    >
      <Stack.Navigator
        initialRouteName={
          process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_IMPORT === '1'
            ? 'DesignLabImport'
            : 'DesignLabTabs'
        }
        screenOptions={{ headerShown: false }}
      >
        <Stack.Screen name="DesignLabTabs">
          {({ navigation }) => (
            <LabTabs openImport={() => navigation.navigate('DesignLabImport')} />
          )}
        </Stack.Screen>
        <Stack.Screen
          name="DesignLabImport"
          options={{ presentation: 'fullScreenModal', animation: 'default' }}
        >
          {({ navigation }) => <DesignLabImportScreen onClose={() => navigation.goBack()} />}
        </Stack.Screen>
      </Stack.Navigator>
    </NavigationContainer>
  );
}
