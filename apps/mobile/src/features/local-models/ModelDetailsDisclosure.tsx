import { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { t } from '../../localization';
import { colors, spacing, typography } from '../../theme';
import { AppButton, AppIcon, AppText } from '../../ui/primitives';
import type { LocalModelManifest } from './manifest';
import { formatModelDownloadSize } from './model-ui';

type ModelDetailsDisclosureProps = {
  readonly manifest: LocalModelManifest;
};

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.detailRow}>
      <AppText variant="caption" style={styles.detailLabel} selectable>
        {label}
      </AppText>
      <AppText style={styles.detailValue} selectable>
        {value}
      </AppText>
    </View>
  );
}

/**
 * Technical model provenance stays available without competing with the required setup action.
 * This is intentionally local state: opening details is transient UI, not model lifecycle state.
 * This uses a regular RN expansion because the native Host/Collapsible bridge does not contribute
 * the expanded body height to the surrounding RN ScrollView on device. Keeping the body in the RN
 * layout tree ensures every provenance row and the source action remain visible and scrollable.
 */
export function ModelDetailsDisclosure({ manifest }: ModelDetailsDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const { artifact, source } = manifest.pack;

  return (
    <View style={styles.container}>
      <Pressable
        accessibilityLabel={t(expanded ? 'model.hideDetails' : 'model.details')}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={({ pressed }) => [styles.disclosure, pressed && styles.disclosurePressed]}
      >
        <View style={styles.disclosureCopy}>
          <AppText variant="label">{t('model.details')}</AppText>
          <AppText variant="caption" style={styles.detailSummary}>
            {t('model.detailsSummary')}
          </AppText>
        </View>
        <AppIcon
          name="chevronRight"
          size={16}
          color={colors.mutedInk}
          style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }}
        />
      </Pressable>
      {expanded && (
        <View accessibilityRole="summary" style={styles.details}>
          <DetailRow label={t('model.publisher')} value={manifest.pack.publisher} />
          <DetailRow label={t('model.license')} value={manifest.pack.license} />
          <DetailRow
            label={t('model.sourceRepository')}
            value={`${source.repository} @ ${source.revision}`}
          />
          <DetailRow
            label={t('model.artifact')}
            value={`${artifact.repository}/${artifact.filename}`}
          />
          <DetailRow label={t('model.artifactRevision')} value={artifact.revision} />
          <DetailRow label={t('model.checksum')} value={artifact.sha256} />
          <DetailRow
            label={t('model.downloadSize')}
            value={formatModelDownloadSize(artifact.bytes, locale)}
          />
          <DetailRow label={t('model.storageRequirement')} value={t('onboarding.modelSpace')} />
          <DetailRow
            label={t('model.runtime')}
            value={`${manifest.runtime.id} @ ${manifest.runtime.revision}`}
          />
          <AppButton
            label={t('model.sourceAction')}
            onPress={() => void Linking.openURL(artifact.url)}
            tone="quiet"
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
  disclosure: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 56,
    paddingVertical: spacing.sm,
  },
  disclosureCopy: { flex: 1, gap: spacing.xs },
  disclosurePressed: { opacity: 0.55 },
  detailSummary: { color: colors.mutedInk },
  details: { gap: spacing.md, paddingBottom: spacing.sm },
  detailRow: { gap: spacing.xs },
  detailLabel: { color: colors.mutedInk, ...typography.label },
  detailValue: { color: colors.ink },
});
