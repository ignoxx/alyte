import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppButton, EmptyState, AppText } from '../../ui/primitives';
import { screenStyles, spacing } from '../../theme';

type LabsScreenProps = BottomTabScreenProps<MainTabParamList, 'Labs'>;

export function LabsScreen(_props: LabsScreenProps) {
  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <AppText variant="title">{t('labs.title')}</AppText>
        <EmptyState
          title={t('labs.emptyTitle')}
          body={t('labs.emptyBody')}
          action={
            <View style={styles.action}>
              <AppButton label={t('labs.action')} onPress={() => undefined} />
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
