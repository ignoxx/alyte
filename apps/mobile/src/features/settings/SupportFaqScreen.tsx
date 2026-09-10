import { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
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
    try {
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
        return;
      }
    } catch {
      // The same useful fallback applies when iOS rejects the Mail handoff.
    }
    Alert.alert(t('settings.contactSupport'), t('settings.mailUnavailable'));
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
            <AppIcon name="mail" size={21} color={colors.accent} />
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
              <View key={titleKey}>
                <Pressable
                  accessibilityLabel={t(`settings.${titleKey}`)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: isExpanded }}
                  onPress={() => setExpanded(isExpanded ? null : index)}
                  style={({ pressed }) => [
                    styles.faqRow,
                    index > 0 && styles.faqRowDivider,
                    pressed && styles.rowPressed,
                  ]}
                >
                  <AppText style={styles.faqTitle}>{t(`settings.${titleKey}`)}</AppText>
                  <AppIcon
                    color={colors.accent}
                    name="chevronRight"
                    size={16}
                    style={[styles.faqIcon, isExpanded && styles.faqIconExpanded]}
                  />
                </Pressable>
                {isExpanded && (
                  <View style={styles.faqAnswer}>
                    <AppText style={styles.faqBody}>{t(`settings.${bodyKey}`)}</AppText>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { ...typography.body, color: colors.mutedInk, marginBottom: spacing.lg },
  sectionTitle: { marginBottom: spacing.sm, marginTop: spacing.lg },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
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
  rowTitle: { ...typography.row },
  subtitle: { color: colors.mutedInk },
  rowPressed: { backgroundColor: colors.accentSoft },
  faqRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 54,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  faqRowDivider: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  faqTitle: { color: colors.accent, flex: 1, flexShrink: 1, minWidth: 0 },
  faqIcon: { flexShrink: 0 },
  faqIconExpanded: { transform: [{ rotate: '90deg' }] },
  faqAnswer: {
    paddingBottom: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  faqBody: { color: colors.mutedInk },
});
