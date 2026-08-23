import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  createNavigationContainerRef,
  type NavigatorScreenParams,
} from '@react-navigation/native';
import { createNativeBottomTabNavigator } from '@react-navigation/bottom-tabs/unstable';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { useColorScheme } from 'react-native';
import { t } from '../../localization';
import { colors } from '../../theme';
import { DesignLabContext } from './context';
import {
  DesignLabHomeScreen,
  DesignLabImportScreen,
  DesignLabLabsScreen,
  DesignLabSettingsScreen,
} from './DesignLabScreens';
import type { DesignLabDirection, DesignLabState } from './model';
import { labAccents } from './theme';

type LabTabParamList = {
  LabHome: undefined;
  LabLabs: undefined;
  LabSettings: undefined;
};

type LabRootParamList = {
  DesignLabTabs: NavigatorScreenParams<LabTabParamList> | undefined;
  DesignLabImport: undefined;
};

type LabFeatureStackParamList = {
  HomeRoot: undefined;
  LabsRoot: undefined;
  SettingsRoot: undefined;
};

const Tabs = createNativeBottomTabNavigator<LabTabParamList>();
const Stack = createNativeStackNavigator<LabRootParamList>();
const FeatureStack = createNativeStackNavigator<LabFeatureStackParamList>();
const navigationRef = createNavigationContainerRef<LabRootParamList>();

function HomeStack({ openImport }: { openImport: () => void }) {
  return (
    <FeatureStack.Navigator>
      <FeatureStack.Screen
        name="HomeRoot"
        options={{ title: t('navigation.home'), headerLargeTitle: true }}
      >
        {() => <DesignLabHomeScreen onImport={openImport} />}
      </FeatureStack.Screen>
    </FeatureStack.Navigator>
  );
}

function LabsStack({ openImport }: { openImport: () => void }) {
  return (
    <FeatureStack.Navigator>
      <FeatureStack.Screen
        name="LabsRoot"
        options={{ title: t('navigation.labs'), headerLargeTitle: true }}
      >
        {() => <DesignLabLabsScreen onImport={openImport} />}
      </FeatureStack.Screen>
    </FeatureStack.Navigator>
  );
}

function SettingsStack() {
  return (
    <FeatureStack.Navigator>
      <FeatureStack.Screen
        name="SettingsRoot"
        component={DesignLabSettingsScreen}
        options={{ title: t('navigation.settings'), headerLargeTitle: true }}
      />
    </FeatureStack.Navigator>
  );
}

function LabTabs({
  openImport,
  direction,
  state,
  setDirection,
  setState,
  automationScrollKey,
}: {
  openImport: () => void;
  direction: DesignLabDirection;
  state: DesignLabState;
  setDirection: (direction: DesignLabDirection) => void;
  setState: (state: DesignLabState) => void;
  automationScrollKey: number;
}) {
  const icon = (name: 'house' | 'house.fill' | 'testtube.2' | 'gearshape' | 'gearshape.fill') => ({
    type: 'sfSymbol' as const,
    name,
  });
  return (
    <DesignLabContext.Provider
      value={{ direction, state, setDirection, setState, automationScrollKey }}
    >
      <Tabs.Navigator
        initialRouteName={
          process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_TAB === 'labs' ? 'LabLabs' : 'LabHome'
        }
        screenOptions={{
          tabBarActiveTintColor: labAccents[direction],
          tabBarInactiveTintColor: colors.mutedInk,
          tabBarControllerMode: 'tabBar',
          tabBarMinimizeBehavior: 'none',
          overrideScrollViewContentInsetAdjustmentBehavior: true,
        }}
      >
        <Tabs.Screen
          name="LabHome"
          options={{
            title: t('navigation.home'),
            tabBarLabel: t('navigation.home'),
            tabBarIcon: ({ focused }) => icon(focused ? 'house.fill' : 'house'),
          }}
        >
          {() => <HomeStack openImport={openImport} />}
        </Tabs.Screen>
        <Tabs.Screen
          name="LabLabs"
          options={{
            title: t('navigation.labs'),
            tabBarLabel: t('navigation.labs'),
            tabBarIcon: () => icon('testtube.2'),
          }}
        >
          {() => <LabsStack openImport={openImport} />}
        </Tabs.Screen>
        <Tabs.Screen
          name="LabSettings"
          component={SettingsStack}
          options={{
            title: t('navigation.settings'),
            tabBarLabel: t('navigation.settings'),
            tabBarIcon: ({ focused }) => icon(focused ? 'gearshape.fill' : 'gearshape'),
          }}
        />
      </Tabs.Navigator>
    </DesignLabContext.Provider>
  );
}

export function DesignLabNavigator() {
  const initialDirection = process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_DIRECTION;
  const initialState = process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_STATE;
  const [direction, setDirection] = useState<DesignLabDirection>(
    initialDirection === 'timeline' || initialDirection === 'library' ? initialDirection : 'quiet',
  );
  const [state, setState] = useState<DesignLabState>(
    initialState === 'two-reports' ? 'two-reports' : 'empty',
  );
  const [automationScrollKey, setAutomationScrollKey] = useState(0);
  const dark = useColorScheme() === 'dark';
  const base = dark ? DarkTheme : DefaultTheme;

  useEffect(() => {
    if (process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_AUTOMATE !== '1') return;
    const steps = [
      setTimeout(() => setState('two-reports'), 2_000),
      setTimeout(() => setDirection('timeline'), 4_000),
      setTimeout(() => setDirection('library'), 6_000),
      setTimeout(() => navigationRef.navigate('DesignLabTabs', { screen: 'LabLabs' }), 8_000),
      setTimeout(() => setAutomationScrollKey((value) => value + 1), 10_000),
      setTimeout(() => navigationRef.navigate('DesignLabTabs', { screen: 'LabSettings' }), 12_000),
      setTimeout(() => navigationRef.navigate('DesignLabTabs', { screen: 'LabHome' }), 14_000),
      setTimeout(() => setAutomationScrollKey((value) => value + 1), 16_000),
      setTimeout(() => navigationRef.navigate('DesignLabImport'), 18_000),
    ];
    return () => steps.forEach(clearTimeout);
  }, []);

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={{
        ...base,
        colors: {
          ...base.colors,
          background: colors.canvas as string,
          card: colors.surface as string,
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
            <LabTabs
              automationScrollKey={automationScrollKey}
              direction={direction}
              openImport={() => navigation.navigate('DesignLabImport')}
              setDirection={setDirection}
              setState={setState}
              state={state}
            />
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
