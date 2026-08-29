import { useCallback, useLayoutEffect, useState, type PropsWithChildren } from 'react';
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
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
import { LabReportImportError, type PasswordRequest } from './report-service';
import {
  formatReportFileSize,
  formatReportPageCount,
  formatLabReportDetailRowAccessibilityLabel,
  getLabReportFailureRecovery,
  getLabReportDetailState,
  getLabReportDetailRowLayout,
  type LabReportDetailRowLayout,
} from './report-detail-model';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type DetailRoute = RouteProp<LabsStackParamList, 'LabReportDetail'>;

function stateLabel(
  report: LabReport,
  integrity: 'verified' | 'missing' | 'mismatch' | 'not-verifiable',
): string {
  const recovery =
    integrity === 'verified'
      ? getLabReportFailureRecovery(report)
      : { action: 'delete' as const, message: 'missing-source' as const };
  if (recovery.message === 'missing-source') {
    if (report.importState === 'failed') return t('labs.reportStateFailedNoSource');
    if (report.importState === 'interrupted') return t('labs.reportStateInterruptedNoSource');
  }
  return t(
    report.importState === 'imported'
      ? 'labs.reportStateImported'
      : report.importState === 'interrupted'
        ? 'labs.reportStateInterrupted'
        : report.importState === 'failed'
          ? 'labs.reportStateFailed'
          : report.importState === 'deleted'
            ? 'labs.reportStateDeleted'
            : 'labs.reportStateImporting',
  );
}

function sourceLabel(report: LabReport): string {
  return report.sourceType === 'pdf' ? t('labs.reportPdf') : t('labs.reportImage');
}

export function LabReportDetailScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DetailRoute>();
  const { reports } = useServices();
  const { fontScale } = useWindowDimensions();
  const detailRowLayout = getLabReportDetailRowLayout(fontScale);
  const [report, setReport] = useState<LabReport | null>(null);
  const [integrity, setIntegrity] = useState<
    'verified' | 'missing' | 'mismatch' | 'not-verifiable'
  >('not-verifiable');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await reports.getReport(route.params.reportId);
      setReport(next);
      if (next === null) {
        setIntegrity('missing');
      } else {
        setIntegrity(await reports.verifySource(next.id));
      }
      try {
        const openDraft = (await reports.listOpenExtractionDrafts()).find(
          (candidate) => candidate.reportId === route.params.reportId,
        );
        setOpenDraftId(openDraft?.draftId ?? null);
      } catch {
        // An unavailable draft lookup should not hide the imported report or block a safe retry.
        setOpenDraftId(null);
      }
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [reports, route.params.reportId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

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

  function openPreview() {
    if (report === null) return;
    navigation
      .getParent<NativeStackNavigationProp<RootStackParamList>>()
      ?.getParent<NativeStackNavigationProp<RootStackParamList>>()
      ?.navigate('OriginalSourcePreview', { reportId: report.id });
  }

  async function extractLocally() {
    if (report === null) return;
    if (openDraftId !== null) {
      navigation.navigate('ExtractionDraft', {
        reportId: report.id,
        draftId: openDraftId,
      });
      return;
    }
    navigation
      .getParent<NativeStackNavigationProp<RootStackParamList>>()
      ?.getParent<NativeStackNavigationProp<RootStackParamList>>()
      ?.navigate('ExtractionProgress', { reportId: report.id });
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

  const detailState = getLabReportDetailState(report, loading, error);
  if (detailState === 'loading') {
    return (
      <DetailScrollView centered>
        <AppText>{t('labs.loading')}</AppText>
      </DetailScrollView>
    );
  }
  if (detailState === 'error') {
    return (
      <DetailScrollView centered>
        <AppText selectable>{t('labs.reportLoadError')}</AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
        <AppButton
          label={t('accessibility.back')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </DetailScrollView>
    );
  }
  if (detailState === 'unavailable') {
    return (
      <DetailScrollView centered>
        <AppText selectable variant="heading">
          {t('labs.reportUnavailableTitle')}
        </AppText>
        <AppText selectable style={styles.body}>
          {t('labs.reportUnavailableBody')}
        </AppText>
        <AppButton
          label={t('accessibility.back')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </DetailScrollView>
    );
  }

  // `ready` is only possible with a loaded report; the guard keeps this invariant explicit for
  // TypeScript and protects the detail renderer if the state model changes later.
  if (report === null) return null;

  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const failureRecovery =
    integrity === 'verified'
      ? getLabReportFailureRecovery(report)
      : { action: 'delete' as const, message: 'missing-source' as const };

  return (
    <DetailScrollView>
      <AppText variant="heading">{report.originalFilename}</AppText>
      <StatusPill>{stateLabel(report, integrity)}</StatusPill>
      <AppSurface style={styles.metaSection}>
        <DetailRow
          label={t('labs.reportSourceType')}
          layout={detailRowLayout}
          value={sourceLabel(report)}
        />
        <DetailRow
          label={formatReportPageCount(
            t('labs.reportPageCount'),
            report.pageCount,
            t('labs.reportUnknown'),
          )}
          layout={detailRowLayout}
          value=""
        />
        <DetailRow
          label={t('labs.reportSize')}
          layout={detailRowLayout}
          value={formatReportFileSize(report.byteSize, {
            locale,
            unknownLabel: t('labs.reportSizeUnknown'),
          })}
        />
        <DetailRow
          label={t('labs.reportIntegrity')}
          layout={detailRowLayout}
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
            onPress={openPreview}
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]}
          >
            <AppIcon name="eye" size={20} />
            <View style={styles.actionBody}>
              <AppText variant="heading">{t('labs.reportPreview')}</AppText>
              <AppText style={styles.body}>{t('labs.reportPreviewBody')}</AppText>
            </View>
            <AppIcon name="chevronRight" size={16} />
          </Pressable>
          {report.importState === 'imported' && report.labRecordIds.length === 0 && (
            <View style={styles.extractAction}>
              <AppButton
                disabled={busy}
                label={
                  openDraftId === null
                    ? t('labs.extractionStart')
                    : t('labs.extractionReviewCached')
                }
                onPress={() => void extractLocally()}
                style={styles.extractButton}
              />
            </View>
          )}
          {report.importState === 'imported' && report.labRecordIds.length > 0 && (
            <AppText style={styles.actionStatus}>{t('labs.extractionAlreadyConfirmed')}</AppText>
          )}
        </AppSurface>
      )}
      {(report.importState === 'failed' || report.importState === 'interrupted') && (
        <AppSurface tone="soft" style={styles.error}>
          <AppText>
            {t(
              failureRecovery.message === 'retained-source'
                ? 'labs.reportRetryBody'
                : 'labs.reportNoSourceRetryBody',
            )}
          </AppText>
          {failureRecovery.action === 'retry' ? (
            <AppButton disabled={busy} label={t('labs.reportRetry')} onPress={() => void retry()} />
          ) : (
            <AppButton
              disabled={busy}
              label={t('labs.reportDelete')}
              onPress={confirmDelete}
              tone="secondary"
            />
          )}
        </AppSurface>
      )}
      {report.labRecordIds.length > 0 && (
        <AppText style={styles.body}>
          {t('labs.reportLinkedRecords').replace('{count}', String(report.labRecordIds.length))}
        </AppText>
      )}
    </DetailScrollView>
  );
}

function DetailScrollView({
  centered = false,
  children,
}: PropsWithChildren<{ readonly centered?: boolean }>) {
  return (
    <ScreenScrollView
      contentContainerStyle={[screenStyles.content, centered && styles.center]}
      style={screenStyles.scroll}
      tabBarClearance="native"
    >
      {children}
    </ScreenScrollView>
  );
}

function DetailRow({
  label,
  layout,
  value,
}: {
  readonly label: string;
  readonly layout: LabReportDetailRowLayout;
  readonly value: string;
}) {
  const hasValue = value.length > 0;
  return (
    <View
      accessible
      accessibilityLabel={formatLabReportDetailRowAccessibilityLabel(label, value)}
      style={[styles.detailRow, layout === 'stacked' && styles.detailRowStacked]}
    >
      <AppText style={[styles.detailLabel, layout === 'stacked' && styles.detailLabelStacked]}>
        {label}
      </AppText>
      {hasValue && (
        <AppText
          selectable
          style={[styles.detailValue, layout === 'stacked' && styles.detailValueStacked]}
        >
          {value}
        </AppText>
      )}
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
  detailRowStacked: {
    alignItems: 'stretch',
    flexDirection: 'column',
    gap: spacing.xs,
    paddingVertical: spacing.md,
  },
  detailLabel: { color: colors.mutedInk, flex: 1, flexShrink: 1, minWidth: 0 },
  detailLabelStacked: { flex: 0, width: '100%' },
  detailValue: {
    color: colors.ink,
    flex: 1,
    flexShrink: 1,
    marginLeft: spacing.md,
    minWidth: 0,
    textAlign: 'right',
  },
  detailValueStacked: { flex: 0, marginLeft: 0, textAlign: 'left', width: '100%' },
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
});
