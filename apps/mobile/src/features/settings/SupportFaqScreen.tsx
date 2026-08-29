import { Collapsible, Host } from '@expo/ui';
import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { useNavigation } from '@react-navigation/native';

const faqItems = [
  ['faqLocalTitle', 'faqLocalBody'],
  ['faqBackupTitle', 'faqBackupBody'],
  ['faqExportTitle', 'faqExportBody'],
  ['faqDeleteTitle', 'faqDeleteBody'],
] as const;

export function supportMailto(): string {
  const subject = encodeURIComponent(t('settings.supportMailSubject'));
  const body = encodeURIComponent(t('settings.supportMailBody'));
  return `mailto:support@alyte.app?subject=${subject}&body=${body}`;
}

export function SupportFaqScreen() {
  const navigation = useNavigation<any>();
  const [expanded, setExpanded] = useState<number | null>(null);

  async function contactSupport() {
    const url = supportMailto();
    if (await Linking.canOpenURL(url)) {
      await Linking.openURL(url);
    } else {
      Alert.alert(t('settings.contactSupport'), t('settings.mailUnavailable'));
    }
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        contentInset={{ bottom: spacing.xxl }}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText style={styles.intro}>{t('settings.supportIntro')}</AppText>
        <View style={styles.group}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t('settings.contactSupport')}. ${t('settings.contactSupportSubtitle')}`}
            onPress={() => void contactSupport()}
            style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
          >
            <AppIcon name="phone" size={21} color={colors.accent} />
            <View style={styles.copy}>
              <AppText variant="heading" style={styles.rowTitle}>
                {t('settings.contactSupport')}
              </AppText>
              <AppText variant="caption" style={styles.subtitle}>
                {t('settings.contactSupportSubtitle')}
              </AppText>
            </View>
            <AppIcon name="chevronRight" size={16} color={colors.mutedInk} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t('settings.diagnostics')}. ${t('settings.diagnosticsSubtitle')}`}
            onPress={() => navigation.navigate('Diagnostics')}
            style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}
          >
            <AppIcon name="shield" size={21} color={colors.accent} />
            <View style={styles.copy}>
              <AppText variant="heading" style={styles.rowTitle}>
                {t('settings.diagnostics')}
              </AppText>
              <AppText variant="caption" style={styles.subtitle}>
                {t('settings.diagnosticsSubtitle')}
              </AppText>
            </View>
            <AppIcon name="chevronRight" size={16} color={colors.mutedInk} />
          </Pressable>
        </View>
        <AppText variant="heading" style={styles.sectionTitle}>
          {t('settings.faq')}
        </AppText>
        <View style={styles.group}>
          {faqItems.map(([titleKey, bodyKey], index) => {
            const isExpanded = expanded === index;
            return (
              <Host key={titleKey} matchContents={{ vertical: true }}>
                <Collapsible
                  isOpen={isExpanded}
                  onOpenChange={(nextOpen) => setExpanded(nextOpen ? index : null)}
                  label={t(`settings.${titleKey}`)}
                >
                  <AppText style={styles.faqBody}>{t(`settings.${bodyKey}`)}</AppText>
                </Collapsible>
              </Host>
            );
          })}
        </View>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.mutedInk, lineHeight: 22, marginBottom: spacing.lg },
  sectionTitle: { marginBottom: spacing.sm, marginTop: spacing.lg },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  actionRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 70,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  copy: { flex: 1, gap: spacing.xs },
  rowTitle: { fontSize: 16, lineHeight: 21 },
  subtitle: { color: colors.mutedInk },
  rowPressed: { backgroundColor: colors.accentSoft },
  faqRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 54,
    paddingHorizontal: spacing.lg,
  },
  faqBody: { color: colors.mutedInk, paddingBottom: spacing.lg, paddingHorizontal: spacing.lg },
});
