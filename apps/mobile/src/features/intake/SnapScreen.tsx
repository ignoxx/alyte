import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';

type SnapScreenProps = BottomTabScreenProps<MainTabParamList, 'SnapAction'>;

export function SnapScreen({ navigation }: SnapScreenProps) {
  return (
    <SafeAreaView style={[screenStyles.safe, screenStyles.content, styles.container]}>
      <AppText variant="title">{t('snap.title')}</AppText>
      <AppText style={styles.body}>{t('snap.body')}</AppText>
      <AppText variant="caption" style={styles.placeholder}>
        {t('snap.placeholder')}
      </AppText>
      <AppButton
        label={t('snap.close')}
        tone="secondary"
        onPress={() => navigation.navigate('Home')}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  body: { color: colors.mutedInk },
  placeholder: { color: colors.mutedInk },
});
