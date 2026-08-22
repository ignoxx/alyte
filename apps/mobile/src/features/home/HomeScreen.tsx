import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppButton, EmptyState, AppText } from '../../ui/primitives';
import { screenStyles, spacing } from '../../theme';

type HomeScreenProps = BottomTabScreenProps<MainTabParamList, 'Home'>;

export function HomeScreen({ navigation }: HomeScreenProps) {
  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm, marginTop: spacing.sm },
});
