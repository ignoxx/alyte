import { ScrollView, StyleSheet, View } from 'react-native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppButton, EmptyState, AppText } from '../../ui/primitives';
import { screenStyles, spacing } from '../../theme';

type HomeScreenProps = BottomTabScreenProps<MainTabParamList, 'Home'>;

export function HomeScreen({ navigation }: HomeScreenProps) {
  return (
    <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.safe}>
      <AppText variant="title">{t('home.title')}</AppText>
      <EmptyState
        title={t('home.emptyTitle')}
        body={t('home.emptyBody')}
        action={
          <View style={styles.actions}>
            <AppButton
              label={t('home.importAction')}
              tone="secondary"
              onPress={() => navigation.navigate('Labs')}
            />
            <AppButton
              label={t('home.logAction')}
              tone="quiet"
              onPress={() => navigation.navigate('Log')}
            />
          </View>
        }
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm, marginTop: spacing.sm },
});
