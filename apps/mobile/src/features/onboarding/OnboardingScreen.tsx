import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import { t } from '../../localization';

type OnboardingScreenProps = {
  onComplete: () => void;
};

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  return (
    <SafeAreaView style={screenStyles.safe}>
      <View style={styles.content}>
        <StatusPill>{t('onboarding.eyebrow')}</StatusPill>
        <AppText variant="display" style={styles.title}>
          {t('onboarding.title')}
        </AppText>
        <AppText style={styles.body}>{t('onboarding.body')}</AppText>
        <AppSurface style={styles.card}>
          <AppText variant="heading">{t('onboarding.measuredTitle')}</AppText>
          <AppText style={styles.cardBody}>{t('onboarding.measuredBody')}</AppText>
        </AppSurface>
      </View>
      <View style={styles.footer}>
        <AppButton label={t('onboarding.continue')} onPress={onComplete} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, gap: spacing.lg, padding: spacing.xl },
  title: { color: colors.ink, maxWidth: 360, marginTop: spacing.xl },
  body: { color: colors.mutedInk, ...typography.body, maxWidth: 420 },
  card: { gap: spacing.sm, marginTop: spacing.lg },
  cardBody: { color: colors.mutedInk },
  footer: { padding: spacing.xl, paddingBottom: spacing.xxl },
});
