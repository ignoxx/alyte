import { useEffect, useLayoutEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from '@react-navigation/native';
import type { RedactionRegion } from '@alyte/domain';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import { AlytePDFWorkspace } from './AlytePDFWorkspace';
import { AlyteImageWorkspace } from './image';

type PreviewRoute = RouteProp<RootStackParamList, 'SanitizedSourcePreview'>;

export function SanitizedSourcePreviewScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<PreviewRoute>();
  const { reports } = useServices();
  const [artifactPath, setArtifactPath] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<'pdf' | 'image' | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <AppButton label={t('labs.done')} onPress={() => navigation.goBack()} tone="quiet" />
      ),
    });
  }, [navigation]);

  useEffect(() => {
    let active = true;
    void reports
      .previewSanitizedReport(route.params.reportId)
      .then((preview) => {
        if (preview.uris[route.params.pageIndex] === undefined)
          throw new Error('Sanitized page is unavailable');
        if (active) {
          setArtifactPath(preview.artifactPath);
          setSourceType(preview.sourceType);
        }
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attempt, reports, route.params.pageIndex, route.params.reportId]);

  if (failed) {
    return (
      <View style={styles.center}>
        <AppText selectable>{t('labs.extractionSanitizedPreviewError')}</AppText>
        <AppButton
          label={t('labs.retry')}
          onPress={() => {
            setFailed(false);
            setAttempt((current) => current + 1);
          }}
          tone="secondary"
        />
      </View>
    );
  }

  if (artifactPath === null || sourceType === null)
    return <AppText style={styles.loading}>{t('labs.loading')}</AppText>;

  const box = route.params.boundingBox;
  const sourceRegion: RedactionRegion = {
    id: 'extraction-source-region',
    label: null,
    origin: 'user',
    rect: box,
  };
  return (
    <View style={styles.root}>
      {sourceType === 'image' ? (
        <AlyteImageWorkspace
          accessibilityLabel={`${t('labs.sanitizedExactCanvas')} ${route.params.pageIndex + 1}`}
          accessibilityLabels={{ redaction: t('labs.extractionSourceRegionLabel') }}
          inspectionMode
          redactMode={false}
          redactions={[sourceRegion]}
          sourcePath={artifactPath}
          style={styles.workspace}
        />
      ) : (
        <AlytePDFWorkspace
          accessibilityLabel={`${t('labs.sanitizedExactCanvas')} ${route.params.pageIndex + 1}`}
          accessibilityLabels={{ redaction: t('labs.extractionSourceRegionLabel') }}
          crop={null}
          focusRegion={box}
          inspectionMode
          pageIndex={route.params.pageIndex}
          redactMode={false}
          redactions={[sourceRegion]}
          rotation={0}
          sourcePath={artifactPath}
          style={styles.workspace}
        />
      )}
      <AppText selectable style={styles.caption}>
        {t('labs.extractionSanitizedRegion')
          .replace('{page}', String(route.params.pageIndex + 1))
          .replace('{x}', box.x.toFixed(3))
          .replace('{y}', box.y.toFixed(3))}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.canvas, flex: 1 },
  workspace: { flex: 1 },
  loading: { padding: spacing.lg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  caption: { color: colors.mutedInk, padding: spacing.md },
});
