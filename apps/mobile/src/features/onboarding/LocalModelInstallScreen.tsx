import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { ModelSetupScreen } from './ModelSetupPanel';

/** Contextual reinstall gate: model setup only, without first-run welcome content. */
export function LocalModelInstallScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { models } = useServices();
  return <ModelSetupScreen contextual model={models} onComplete={() => navigation.goBack()} />;
}
