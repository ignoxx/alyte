import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { LabReport } from '@alyte/domain';
import type { LabsStackParamList, RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  ScreenScrollView,
  StatusPill,
} from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import {
  LabReportExtractionError,
  LabReportImportError,
  type PasswordRequest,
} from './report-service';
import type { LabReportPreview } from './report-service';
import { formatReportPageCount } from './report-detail-model';

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
  const [extractionError, setExtractionError] = useState<LabReportExtractionError['reason'] | null>(
    null,
  );
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

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight:
        report === null || report.importState === 'deleted'
          ? () => null
          : () => (
              <Pressable
                accessibilityLabel={t('labs.reportMoreActions')}
                accessibilityRole="button"
                hitSlop={10}
                onPress={openMoreMenu}
                style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
              >
                <AppIcon color={colors.accent} name="ellipsis" size={20} />
              </Pressable>
            ),
    });
  }, [busy, navigation, report]);

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

  async function extractLocally() {
    if (report === null) return;
    setBusy(true);
    setError(false);
    setExtractionError(null);
    try {
      const draft = await reports.startExtraction(report.id, promptPassword());
      navigation.navigate('ExtractionDraft', { reportId: report.id, draftId: draft.id });
    } catch (caught) {
      setExtractionError(
        caught instanceof LabReportExtractionError ? caught.reason : 'recognition',
      );
    } finally {
      setBusy(false);
    }
  }

  function openMoreMenu() {
    const showDelete = () => confirmDelete();
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          cancelButtonIndex: 1,
          destructiveButtonIndex: 0,
          options: [t('labs.reportDelete'), t('intake.cancel')],
          title: t('labs.reportMoreActions'),
        },
        (index) => {
          if (index === 0) showDelete();
        },
      );
      return;
    }
    Alert.alert(t('labs.reportMoreActions'), undefined, [
      { text: t('labs.reportDelete'), onPress: showDelete, style: 'destructive' },
      { text: t('intake.cancel'), style: 'cancel' },
    ]);
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
    <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
      <AppText variant="heading">{report.originalFilename}</AppText>
      <StatusPill>{stateLabel(report.importState)}</StatusPill>
      <AppSurface style={styles.metaSection}>
        <DetailRow label={t('labs.reportSourceType')} value={sourceLabel(report)} />
        <DetailRow
          label={formatReportPageCount(
            t('labs.reportPageCount'),
            report.pageCount,
            t('labs.reportUnknown'),
          )}
          value=""
        />
        <DetailRow label={t('labs.reportSize')} value={formatBytes(report.byteSize)} />
        <DetailRow
          label={t('labs.reportIntegrity')}
          value={t(`labs.reportIntegrity${integrity[0]?.toUpperCase() ?? ''}${integrity.slice(1)}`)}
        />
      </AppSurface>
      {report.importState !== 'deleted' && integrity === 'verified' && (
        <AppSurface style={styles.actionSection}>
          <AppText variant="label" style={styles.sectionLabel}>
            {t('labs.reportActions')}
          </AppText>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void openPreview()}
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]}
          >
            <AppIcon name="eye" size={20} />
            <View style={styles.actionBody}>
              <AppText variant="heading">{t('labs.reportPreview')}</AppText>
              <AppText style={styles.body}>{t('labs.reportPreviewBody')}</AppText>
            </View>
            <AppIcon name="chevronRight" size={16} />
          </Pressable>
          {previewError && (
            <AppText style={styles.errorText}>{t('labs.reportPreviewError')}</AppText>
          )}
          {(report.sourceType === 'pdf' || report.sourceType === 'image') && (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() =>
                navigation
                  .getParent<NativeStackNavigationProp<RootStackParamList>>()
                  ?.getParent<NativeStackNavigationProp<RootStackParamList>>()
                  ?.navigate('PrivacyWorkspace', { reportId: report.id })
              }
              style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]}
            >
              <AppIcon name="shield" size={20} />
              <View style={styles.actionBody}>
                <AppText variant="heading">{t('labs.sanitizedEditorOpen')}</AppText>
                <AppText style={styles.body}>{t('labs.sanitizedEditorBody')}</AppText>
              </View>
              <AppIcon name="chevronRight" size={16} />
            </Pressable>
          )}
          {report.sourceType === 'pdf' &&
            report.importState === 'imported' &&
            report.labRecordIds.length === 0 && (
              <View style={styles.extractAction}>
                <AppText variant="heading">{t('labs.extractionStart')}</AppText>
                <AppText style={styles.body}>{t('labs.reportRetainedBody')}</AppText>
                <AppButton
                  disabled={busy}
                  label={t('labs.extractionStart')}
                  onPress={() => void extractLocally()}
                  style={styles.extractButton}
                />
                {extractionError !== null && (
                  <AppText style={styles.errorText}>
                    {t(
                      extractionError === 'sanitized-source'
                        ? 'labs.extractionSourceError'
                        : extractionError === 'no-reviewable-measurements'
                          ? 'labs.extractionNoMeasurementsError'
                          : 'labs.extractionRecognitionError',
                    )}
                  </AppText>
                )}
              </View>
            )}
          {report.importState === 'imported' && report.labRecordIds.length > 0 && (
            <AppText style={styles.actionStatus}>{t('labs.extractionAlreadyConfirmed')}</AppText>
          )}
        </AppSurface>
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
        presentationStyle="pageSheet"
        visible={preview !== null}
      >
        <SafeAreaView edges={['top', 'bottom']} style={styles.previewModal}>
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
        </SafeAreaView>
      </Modal>
    </ScreenScrollView>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.detailRow}>
      <AppText style={styles.detailLabel}>{label}</AppText>
      <AppText selectable style={styles.detailValue}>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { color: colors.mutedInk, marginTop: spacing.md },
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
  error: { gap: spacing.sm, marginTop: spacing.md },
  headerAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  pressed: { opacity: 0.6 },
  metaSection: { gap: 0, marginTop: spacing.md, padding: 0 },
  detailRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  detailLabel: { color: colors.mutedInk },
  detailValue: { color: colors.ink, flexShrink: 1, marginLeft: spacing.md, textAlign: 'right' },
  actionSection: { gap: spacing.xs, marginTop: spacing.md, padding: 0 },
  sectionLabel: { color: colors.mutedInk, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  actionRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 68,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actionPressed: { backgroundColor: colors.accentSoft },
  actionBody: { flex: 1 },
  extractAction: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    padding: spacing.md,
  },
  extractButton: { alignSelf: 'stretch' },
  actionStatus: { color: colors.mutedInk, padding: spacing.md },
  errorText: { color: colors.danger },
  previewModal: { backgroundColor: colors.canvas, flex: 1, padding: spacing.lg },
  previewHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  previewPages: { flexGrow: 1, gap: spacing.md, paddingVertical: spacing.md },
  previewImage: { height: 520, width: '100%' },
});
