import { ScrollView, StyleSheet, View } from 'react-native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { MainTabParamList } from '../../navigation/types';
import { t } from '../../localization';
import { AppButton, EmptyState, AppText } from '../../ui/primitives';
import { screenStyles, spacing } from '../../theme';

type LabsScreenProps = BottomTabScreenProps<MainTabParamList, 'Labs'>;

export function LabsScreen(_props: LabsScreenProps) {
  return (
    <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.safe}>
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
  );
}

const styles = StyleSheet.create({
  action: { marginTop: spacing.sm },
});
