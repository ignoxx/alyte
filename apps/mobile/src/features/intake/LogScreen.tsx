import { ScrollView, StyleSheet, View } from 'react-native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppButton, EmptyState, AppText } from '../../ui/primitives';
import { screenStyles, spacing } from '../../theme';

type LogScreenProps = BottomTabScreenProps<MainTabParamList, 'Log'>;

export function LogScreen(_props: LogScreenProps) {
  return (
    <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.safe}>
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
  );
}

const styles = StyleSheet.create({
  action: { marginTop: spacing.sm },
});
