import { useEffect, useLayoutEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { RedactionRegion } from '@alyte/domain';
import type { RootStackParamList } from '../../navigation/types';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import { AlytePDFWorkspace } from './AlytePDFWorkspace';
import { AlyteImageWorkspace } from './image';

type Route = RouteProp<RootStackParamList, 'RecordSourcePreview'>;
type Navigation = NativeStackNavigationProp<RootStackParamList>;
type Ready = {
  path: string;
  sourceType: 'pdf' | 'image';
  pageIndex: number;
  box: RedactionRegion['rect'];
  orientation: number;
};
export function RecordSourcePreviewScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<Route>();
  const { labs, reports } = useServices();
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(
    () =>
      navigation.setOptions({
        headerLeft: () => (
          <AppButton label={t('labs.done')} onPress={() => navigation.goBack()} tone="quiet" />
        ),
      }),
    [navigation],
  );
  useEffect(() => {
    let active = true;
    void (async () => {
      const detail = await labs.getRecordDetail(route.params.recordId);
      const measurement = detail?.measurements.find(
        (item) => item.id === route.params.measurementId,
      );
      if (!detail || detail.source.kind !== 'retained' || !measurement?.source)
        throw new Error('unavailable');
      if (measurement.source.artifact?.kind === 'original') {
        // Local extraction provenance points at the immutable Original. The native
        // viewer owns its protected path; this screen never receives one.
        navigation.replace('OriginalSourcePreview', { reportId: detail.source.reportId });
        return;
      }
      const preview = await reports.previewSanitizedReport(detail.source.reportId);
      if (!preview.uris[measurement.source.pageIndex]) throw new Error('unavailable');
      if (active)
        setReady({
          path: preview.artifactPath,
          sourceType: preview.sourceType,
          pageIndex: measurement.source.pageIndex,
          box: measurement.source.boundingBox,
          orientation: measurement.source.orientation,
        });
    })().catch(() => {
      if (active) setError(t('labs.detailSourceUnavailableBody'));
    });
    return () => {
      active = false;
    };
  }, [attempt, labs, navigation, reports, route.params]);
  if (!ready)
    return (
      <View style={styles.center}>
        <AppText selectable>{error ?? t('labs.loading')}</AppText>
        {error && (
          <AppButton
            label={t('labs.retry')}
            onPress={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
            tone="secondary"
          />
        )}
      </View>
    );
  return (
    <View style={styles.root}>
      {ready.sourceType === 'image' ? (
        <AlyteImageWorkspace
          accessibilityLabel={`${t('labs.sanitizedExactCanvas')} ${ready.pageIndex + 1}`}
          accessibilityLabels={{ redaction: t('labs.extractionSourceRegionLabel') }}
          focusRegion={ready.box}
          inspectionMode
          redactMode={false}
          redactions={[
            { id: 'record-source-region', label: null, origin: 'user', rect: ready.box },
          ]}
          sourcePath={ready.path}
          style={styles.workspace}
        />
      ) : (
        <AlytePDFWorkspace
          accessibilityLabel={`${t('labs.sanitizedExactCanvas')} ${ready.pageIndex + 1}`}
          accessibilityLabels={{ redaction: t('labs.extractionSourceRegionLabel') }}
          crop={null}
          focusRegion={ready.box}
          inspectionMode
          pageIndex={ready.pageIndex}
          redactMode={false}
          redactions={[
            { id: 'record-source-region', label: null, origin: 'user', rect: ready.box },
          ]}
          rotation={ready.orientation}
          sourcePath={ready.path}
          style={styles.workspace}
        />
      )}
      <AppText selectable style={styles.caption}>
        {t('labs.detailVerifiedSource').replace('{page}', String(ready.pageIndex + 1))}
      </AppText>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { backgroundColor: colors.canvas, flex: 1 },
  workspace: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  caption: { color: colors.mutedInk, padding: spacing.md },
});
