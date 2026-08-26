import { StyleSheet, View } from 'react-native';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppText } from '../../ui/primitives';
import { modelProgressPercent } from './model-ui';
import type { LocalModelSnapshot } from './model';

function progressLabel(snapshot: LocalModelSnapshot): string {
  const percent = modelProgressPercent(snapshot);
  return snapshot.state === 'verifying'
    ? t('onboarding.modelVerifying')
    : t('onboarding.modelDownloading').replace('{progress}', String(percent));
}

export function ModelProgress({ snapshot }: { readonly snapshot: LocalModelSnapshot }) {
  const percent = modelProgressPercent(snapshot);
  return (
    <View style={styles.progressGroup}>
      <View style={styles.progressCopy}>
        <AppText accessibilityLiveRegion="polite" style={styles.muted} selectable>
          {progressLabel(snapshot)}
        </AppText>
        <AppText style={styles.progressPercent} selectable>
          {percent}%
        </AppText>
      </View>
      <View
        accessibilityLabel={t('onboarding.modelProgressLabel')}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: percent }}
        style={styles.progressTrack}
      >
        <View style={[styles.progressFill, { width: `${percent}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  progressGroup: { gap: spacing.sm },
  progressCopy: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  progressPercent: { color: colors.ink, fontVariant: ['tabular-nums'] },
  progressTrack: {
    backgroundColor: colors.disabledFill,
    borderRadius: 99,
    height: 8,
    overflow: 'hidden',
    width: '100%',
  },
  progressFill: { backgroundColor: colors.accent, borderRadius: 99, height: '100%' },
  muted: { color: colors.mutedInk },
});
