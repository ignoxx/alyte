import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton, AppSurface, AppText, GroupedRow, StatusPill } from '../../ui/primitives';
import { colors, screenStyles, spacing, typography } from '../../theme';
import { t } from '../../localization';

type OnboardingScreenProps = {
  onComplete: () => void;
};

export function OnboardingScreen({ onComplete }: OnboardingScreenProps) {
  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <StatusPill>{t('onboarding.eyebrow')}</StatusPill>
        <AppText variant="display" style={styles.title}>
          {t('onboarding.title')}
        </AppText>
        <AppText style={styles.body}>{t('onboarding.body')}</AppText>
        <AppSurface style={styles.list}>
          <GroupedRow>
            <AppText variant="heading">{t('onboarding.localTitle')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.localBody')}</AppText>
          </GroupedRow>
          <GroupedRow>
            <AppText variant="heading">{t('onboarding.cloudTitle')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.cloudBody')}</AppText>
          </GroupedRow>
          <GroupedRow>
            <AppText variant="heading">{t('onboarding.measuredTitle')}</AppText>
            <AppText style={styles.cardBody}>{t('onboarding.measuredBody')}</AppText>
          </GroupedRow>
        </AppSurface>
        <AppButton label={t('onboarding.continue')} onPress={onComplete} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, gap: spacing.md, justifyContent: 'center', padding: spacing.xl },
  title: { color: colors.ink, maxWidth: 360, marginTop: spacing.md },
  body: { color: colors.mutedInk, ...typography.body, maxWidth: 420 },
  list: { gap: 0, marginTop: spacing.md, padding: spacing.md },
  cardBody: { color: colors.mutedInk },
});
