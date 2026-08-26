import { StyleSheet, View } from 'react-native';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppText } from '../../ui/primitives';
import { hasResumableModelDownload, type LocalModelSnapshot } from './model';
import { modelProgressPercent } from './model-ui';

function progressLabel(snapshot: LocalModelSnapshot): string {
  const percent = modelProgressPercent(snapshot);
  if (snapshot.state === 'verifying') return t('onboarding.modelVerifying');
  if (hasResumableModelDownload(snapshot)) {
    return t('onboarding.modelDownloadPaused').replace('{progress}', String(percent));
  }
  return t('onboarding.modelDownloading').replace('{progress}', String(percent));
}

export function ModelProgress({ snapshot }: { readonly snapshot: LocalModelSnapshot }) {
  const percent = modelProgressPercent(snapshot);
  return (
    <View style={styles.progressGroup}>
      <View style={styles.progressCopy}>
        <AppText
          accessibilityLiveRegion="polite"
          style={[styles.progressLabel, styles.muted]}
          selectable
        >
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
  progressCopy: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  progressLabel: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  progressPercent: {
    color: colors.ink,
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
    marginLeft: spacing.sm,
  },
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
