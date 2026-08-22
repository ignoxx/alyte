import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppButton, EmptyState, AppText } from '../../ui/primitives';
import { screenStyles, spacing } from '../../theme';

type LogScreenProps = BottomTabScreenProps<MainTabParamList, 'Log'>;

export function LogScreen(_props: LogScreenProps) {
  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <AppText variant="title">{t('log.title')}</AppText>
        <EmptyState
          title={t('log.emptyTitle')}
          body={t('log.emptyBody')}
          action={
            <View style={styles.action}>
              <AppButton label={t('log.action')} onPress={() => undefined} />
            </View>
          }
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  action: { marginTop: spacing.sm },
});
