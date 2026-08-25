import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { OnboardingScreen } from './OnboardingScreen';

/** Contextual reinstall gate. It intentionally uses the same disclosure as first launch. */
export function LocalModelInstallScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { models } = useServices();
  return <OnboardingScreen model={models} onComplete={() => navigation.goBack()} />;
}
