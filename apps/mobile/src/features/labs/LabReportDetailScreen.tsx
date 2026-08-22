import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { LabReport } from '@alyte/domain';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { LabReportImportError, type PasswordRequest } from './report-service';
import type { LabReportPreview } from './report-service';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type DetailRoute = RouteProp<LabsStackParamList, 'LabReportDetail'>;

function stateLabel(state: LabReport['importState']): string {
  return t(
    state === 'imported'
      ? 'labs.reportStateImported'
      : state === 'interrupted'
        ? 'labs.reportStateInterrupted'
        : state === 'failed'
          ? 'labs.reportStateFailed'
          : state === 'deleted'
            ? 'labs.reportStateDeleted'
            : 'labs.reportStateImporting',
  );
}

function sourceLabel(report: LabReport): string {
  return report.sourceType === 'pdf' ? t('labs.reportPdf') : t('labs.reportImage');
}

function formatBytes(value: number | null): string {
  if (value === null) return t('labs.reportSizeUnknown');
  if (value < 1024) return `${value} B`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function LabReportDetailScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DetailRoute>();
  const { reports } = useServices();
  const [report, setReport] = useState<LabReport | null>(null);
  const [integrity, setIntegrity] = useState<
    'verified' | 'missing' | 'mismatch' | 'not-verifiable'
  >('not-verifiable');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState<LabReportPreview | null>(null);
  const [previewError, setPreviewError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await reports.getReport(route.params.reportId);
      setReport(next);
      setIntegrity(next === null ? 'missing' : await reports.verifySource(next.id));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [reports, route.params.reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  function promptPassword(): PasswordRequest {
    return ({ report: passwordReport }) =>
      new Promise<string | null>((resolve) => {
        Alert.prompt(
          t('labs.reportPasswordTitle'),
          t('labs.reportPasswordBody').replace('{filename}', passwordReport.originalFilename),
          (value) => resolve(value),
          'secure-text',
          undefined,
          undefined,
          { onDismiss: () => resolve(null) },
        );
      });
  }

  async function retry() {
    if (report === null) return;
    setBusy(true);
    try {
      const next = await reports.retryImport(report.id, promptPassword());
      setReport(next);
      setIntegrity(await reports.verifySource(next.id));
    } catch (caught) {
      setError(caught instanceof LabReportImportError ? true : true);
    } finally {
      setBusy(false);
    }
  }

  async function openPreview() {
    if (report === null) return;
    setBusy(true);
    setPreviewError(false);
    try {
      setPreview(await reports.previewOriginal(report.id, promptPassword()));
    } catch {
      setPreviewError(true);
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (report === null) return;
    Alert.alert(t('labs.reportDelete'), t('labs.reportDeleteConfirm'), [
      {
        text: t('labs.recordDeleteConfirmAction'),
        style: 'destructive',
        onPress: () => void remove(),
      },
      { text: t('labs.recordDeleteCancel'), style: 'cancel' },
    ]);
  }

  async function remove() {
    if (report === null) return;
    setBusy(true);
    try {
      await reports.deleteReport(report.id);
      navigation.goBack();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <AppText>{t('labs.loading')}</AppText>;
  if (error || report === null) {
    return (
      <View style={styles.center}>
        <AppText>{t('labs.reportLoadError')}</AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
      <View style={styles.header}>
        <AppButton
          label={t('labs.recordCancel')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
        <AppButton
          disabled={busy || report.importState === 'deleted'}
          label={t('labs.reportDelete')}
          onPress={confirmDelete}
          tone="secondary"
        />
      </View>
      <AppText variant="title">{t('labs.reportTitle')}</AppText>
      <AppText variant="heading">{report.originalFilename}</AppText>
      <StatusPill>{stateLabel(report.importState)}</StatusPill>
      <AppSurface style={styles.meta}>
        <AppText>{`${t('labs.reportSourceType')}: ${sourceLabel(report)}`}</AppText>
        <AppText>
          {t('labs.reportPageCount').replace(
            '{count}',
            String(report.pageCount ?? t('labs.reportUnknown')),
          )}
        </AppText>
        <AppText>{`${t('labs.reportSize')}: ${formatBytes(report.byteSize)}`}</AppText>
        <AppText>{`${t('labs.reportIntegrity')}: ${t(`labs.reportIntegrity${integrity[0]?.toUpperCase() ?? ''}${integrity.slice(1)}`)}`}</AppText>
      </AppSurface>
      {report.importState !== 'deleted' && integrity === 'verified' && (
        <AppSurface tone="soft" style={styles.previewSurface}>
          <AppText>{t('labs.reportPreviewBody')}</AppText>
          <AppButton
            disabled={busy}
            label={t('labs.reportPreview')}
            onPress={() => void openPreview()}
          />
          {previewError && (
            <AppText style={styles.errorText}>{t('labs.reportPreviewError')}</AppText>
          )}
          {report.sourceType === 'pdf' && (
            <AppButton
              disabled={busy}
              label={t('labs.sanitizedEditorOpen')}
              onPress={() => navigation.navigate('SanitizedReportEditor', { reportId: report.id })}
              tone="secondary"
            />
          )}
        </AppSurface>
      )}
      {report.importState === 'imported' && (
        <AppText style={styles.body}>{t('labs.reportRetainedBody')}</AppText>
      )}
      {(report.importState === 'failed' || report.importState === 'interrupted') && (
        <AppSurface tone="soft" style={styles.error}>
          <AppText>{t('labs.reportRetryBody')}</AppText>
          <AppButton disabled={busy} label={t('labs.reportRetry')} onPress={() => void retry()} />
        </AppSurface>
      )}
      {report.labRecordIds.length > 0 && (
        <AppText style={styles.body}>
          {t('labs.reportLinkedRecords').replace('{count}', String(report.labRecordIds.length))}
        </AppText>
      )}
      <Modal
        accessibilityViewIsModal
        animationType="slide"
        onRequestClose={() => setPreview(null)}
        visible={preview !== null}
      >
        <View style={styles.previewModal}>
          <View style={styles.previewHeader}>
            <AppText variant="heading">{t('labs.reportPreviewTitle')}</AppText>
            <AppButton
              label={t('labs.reportPreviewClose')}
              onPress={() => setPreview(null)}
              tone="quiet"
            />
          </View>
          <ScrollView contentContainerStyle={styles.previewPages}>
            {preview?.uris.map((uri, index) => (
              <Image
                accessibilityLabel={`${t('labs.reportPreviewImageLabel')} ${index + 1}`}
                key={`${uri}-${index}`}
                onError={() => {
                  setPreview(null);
                  setPreviewError(true);
                }}
                resizeMode="contain"
                source={{ uri }}
                style={styles.previewImage}
              />
            ))}
          </ScrollView>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.mutedInk, marginTop: spacing.md },
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
  error: { gap: spacing.sm, marginTop: spacing.md },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  meta: { gap: spacing.xs, marginTop: spacing.md },
  previewSurface: { gap: spacing.sm, marginTop: spacing.md },
  errorText: { color: colors.danger },
  previewModal: { backgroundColor: colors.canvas, flex: 1, padding: spacing.lg },
  previewHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  previewPages: { flexGrow: 1, gap: spacing.md, paddingVertical: spacing.md },
  previewImage: { height: 520, width: '100%' },
});
