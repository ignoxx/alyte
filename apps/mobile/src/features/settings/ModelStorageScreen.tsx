import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { AppIcon, AppText, AppSurface, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';

export function ModelStorageScreen() {
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <View style={styles.header}>
          <AppIcon name="folder" size={28} color={colors.accent} />
          <AppText variant="heading">{t('settings.modelStorageUnavailable')}</AppText>
        </View>
        <AppSurface tone="soft">
          <AppText>{t('settings.modelStorageBody')}</AppText>
        </AppSurface>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { alignItems: 'center', flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
});
