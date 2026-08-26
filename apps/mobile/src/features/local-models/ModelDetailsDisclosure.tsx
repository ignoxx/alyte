import { Collapsible, Host } from '@expo/ui';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { t } from '../../localization';
import { colors, spacing, typography } from '../../theme';
import { AppButton, AppText } from '../../ui/primitives';
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
 * The single native host keeps this one disclosure aligned with the native controls already used in
 * Settings. The body intentionally stays in the existing RN tree so provenance remains selectable
 * and the source action retains its ordinary system-link behavior.
 */
export function ModelDetailsDisclosure({ manifest }: ModelDetailsDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const { artifact, source } = manifest.pack;

  return (
    <Host matchContents style={styles.container}>
      <Collapsible
        isOpen={expanded}
        onOpenChange={setExpanded}
        label={`${t('model.details')} · ${t('model.detailsSummary')}`}
        labelStyle={styles.disclosureLabel}
      >
        <View style={styles.details}>
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
      </Collapsible>
    </Host>
  );
}

const styles = StyleSheet.create({
  container: { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
  disclosureLabel: { color: colors.ink as string, fontSize: 14, fontWeight: '600' },
  details: { gap: spacing.md, paddingBottom: spacing.sm },
  detailRow: { gap: spacing.xs },
  detailLabel: { color: colors.mutedInk, ...typography.label },
  detailValue: { color: colors.ink },
});
