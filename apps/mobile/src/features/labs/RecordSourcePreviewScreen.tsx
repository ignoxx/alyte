import { useEffect, useLayoutEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { RedactionRegion } from '@alyte/domain';
import type { RootStackParamList } from '../../navigation/types';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText, ScreenStatusView } from '../../ui/primitives';
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
  const isFocused = useIsFocused();
  const { labs, reports } = useServices();
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(
    () =>
      navigation.setOptions({
        headerLeft: () => (
          <AppButton
            label={t('labs.done')}
            labelMaxFontSizeMultiplier={1.5}
            onPress={() => navigation.goBack()}
            tone="quiet"
          />
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
        if (!active || !isFocused) return;
        navigation.replace('OriginalSourcePreview', {
          reportId: detail.source.reportId,
          pageIndex: measurement.source.pageIndex,
          boundingBox: measurement.source.boundingBox,
        });
        return;
      }
      const preview = await reports.previewSanitizedReport(detail.source.reportId);
      if (!active || !isFocused) return;
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
      // Keep this generic: the source may be an Original Report or a Sanitized Report.
      if (active) setError(t('labs.detailSourceUnavailable'));
    });
    return () => {
      active = false;
    };
  }, [attempt, isFocused, labs, navigation, reports, route.params]);

  function handleNativeViewerFailure() {
    // A native preview can fail after the protected artifact has loaded. Clear it before
    // showing recovery so a broken view cannot remain visible behind the retry state.
    setReady(null);
    setError(t('labs.detailSourceUnavailable'));
  }

  if (!ready)
    return (
      <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.root}>
        <ScreenStatusView contentContainerStyle={styles.center}>
          {error === null && (
            <ActivityIndicator
              accessibilityLabel={t('labs.loading')}
              color={colors.accent as string}
            />
          )}
          <AppText selectable variant={error === null ? 'body' : 'heading'}>
            {error ?? t('labs.loading')}
          </AppText>
          {error && (
            <>
              <AppButton
                label={t('labs.retry')}
                onPress={() => {
                  setError(null);
                  setAttempt((value) => value + 1);
                }}
                tone="secondary"
              />
              <AppButton label={t('labs.done')} onPress={() => navigation.goBack()} tone="quiet" />
            </>
          )}
        </ScreenStatusView>
      </SafeAreaView>
    );
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.root}>
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
          onFailure={handleNativeViewerFailure}
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
          onFailure={handleNativeViewerFailure}
          rotation={ready.orientation}
          sourcePath={ready.path}
          style={styles.workspace}
        />
      )}
      <AppText selectable style={styles.caption}>
        {t('labs.detailVerifiedSource').replace('{page}', String(ready.pageIndex + 1))}
      </AppText>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { backgroundColor: colors.canvas, flex: 1 },
  workspace: { flex: 1 },
  center: {
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  caption: { color: colors.mutedInk, padding: spacing.md },
});
