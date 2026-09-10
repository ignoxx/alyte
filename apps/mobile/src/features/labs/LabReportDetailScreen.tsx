import { useCallback, useLayoutEffect, useState, type PropsWithChildren } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { formatLocaleDate, type LabRecord, type LabReport, type SpecimenType } from '@alyte/domain';
import type { LabsStackParamList, RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  ScreenScrollView,
  ScreenStatusView,
  StatusPill,
} from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { LabReportImportError, type PasswordRequest } from './report-service';
import {
  formatReportFileSize,
  getLabReportFailureRecovery,
  getLabReportDetailState,
} from './report-detail-model';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type DetailRoute = RouteProp<LabsStackParamList, 'LabReportDetail'>;

function stateLabel(
  report: LabReport,
  integrity: 'verified' | 'missing' | 'mismatch' | 'not-verifiable',
): string {
  if (integrity !== 'verified') {
    return t(
      integrity === 'missing'
        ? 'labs.reportIntegrityMissing'
        : integrity === 'mismatch'
          ? 'labs.reportIntegrityMismatch'
          : 'labs.reportIntegrityNot-verifiable',
    );
  }
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

function specimenLabel(value: SpecimenType): string {
  return t(`labs.specimen.${value}`);
}

function resultCount(count: number): string {
  return t(count === 1 ? 'labs.recordMeasurement' : 'labs.recordMeasurements').replace(
    '{count}',
    String(count),
  );
}

function pageCount(count: number | null): string {
  if (count === null) return t('labs.reportPagesUnknown');
  return t(count === 1 ? 'labs.reportOnePage' : 'labs.reportPages').replace(
    '{count}',
    String(count),
  );
}

export function LabReportDetailScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DetailRoute>();
  const { reports, labs } = useServices();
  const [report, setReport] = useState<LabReport | null>(null);
  const [integrity, setIntegrity] = useState<
    'verified' | 'missing' | 'mismatch' | 'not-verifiable'
  >('not-verifiable');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [openDraftId, setOpenDraftId] = useState<string | null>(null);
  const [linkedRecords, setLinkedRecords] = useState<readonly LabRecord[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, records] = await Promise.all([
        reports.getReport(route.params.reportId),
        labs.listRecords(),
      ]);
      setReport(next);
      setLinkedRecords(
        next === null
          ? []
          : records
              .filter(
                (record) => record.labReportId === next.id || next.labRecordIds.includes(record.id),
              )
              .sort((left, right) => {
                const leftDate =
                  left.collectionDate.kind === 'known' ? left.collectionDate.value : '';
                const rightDate =
                  right.collectionDate.kind === 'known' ? right.collectionDate.value : '';
                return rightDate.localeCompare(leftDate) || right.id.localeCompare(left.id);
              }),
      );
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
  }, [labs, reports, route.params.reportId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight:
        busy || report === null || report.importState === 'deleted'
          ? () => null
          : () => (
              <Pressable
                accessibilityLabel={t('labs.reportMoreActions')}
                accessibilityRole="button"
                hitSlop={10}
                onPress={openMoreMenu}
                style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
              >
                <AppIcon color={colors.onBrand} name="ellipsis" size={20} />
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
    if (busy || report === null) return;
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
    if (busy || report === null) return;
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
    if (busy || report === null) return;
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
      <ScreenStatusView
        contentContainerStyle={styles.center}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText>{t('labs.loading')}</AppText>
      </ScreenStatusView>
    );
  }
  if (detailState === 'error') {
    return (
      <ScreenStatusView
        contentContainerStyle={styles.center}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText selectable>{t('labs.reportLoadError')}</AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
        <AppButton
          label={t('accessibility.back')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </ScreenStatusView>
    );
  }
  if (detailState === 'unavailable') {
    return (
      <ScreenStatusView
        contentContainerStyle={styles.center}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
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
      </ScreenStatusView>
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
      <AppSurface style={styles.reportSummary}>
        <View style={styles.reportHeroHeading}>
          <View style={styles.reportHeroCopy}>
            {(report.importState !== 'imported' || integrity !== 'verified') && (
              <StatusPill>{stateLabel(report, integrity)}</StatusPill>
            )}
            <AppText variant="title">{report.originalFilename}</AppText>
            <AppText style={styles.reportSummaryBody} variant="caption">
              {[
                sourceLabel(report),
                pageCount(report.pageCount),
                formatReportFileSize(report.byteSize, {
                  locale,
                  unknownLabel: t('labs.reportSizeUnknown'),
                }),
              ].join(' · ')}
            </AppText>
          </View>
        </View>
      </AppSurface>
      {linkedRecords.length > 0 && (
        <View style={styles.resultsSection}>
          <AppText variant="heading">{t('labs.reportResults')}</AppText>
          <AppSurface style={styles.resultsGroup}>
            {linkedRecords.map((record, index) => {
              const date =
                record.collectionDate.kind === 'known'
                  ? formatLocaleDate(record.collectionDate.value, locale)
                  : t('labs.recordDateMissing');
              return (
                <Pressable
                  accessibilityRole="button"
                  key={record.id}
                  onPress={() => navigation.navigate('LabRecordDetail', { recordId: record.id })}
                  style={({ pressed }) => [
                    styles.resultRow,
                    index > 0 && styles.resultRowDivider,
                    pressed && styles.actionPressed,
                  ]}
                >
                  <View style={styles.actionBody}>
                    <AppText variant="heading">{specimenLabel(record.specimenType)}</AppText>
                    <AppText style={styles.resultMeta} variant="caption">
                      {`${date} · ${resultCount(record.measurements.length)}`}
                    </AppText>
                  </View>
                  <AppIcon name="chevronRight" size={16} />
                </Pressable>
              );
            })}
          </AppSurface>
        </View>
      )}
      {report.importState !== 'deleted' && integrity === 'verified' && (
        <AppSurface style={styles.actionSection}>
          <AppText variant="label" style={styles.sectionLabel}>
            {t('labs.reportSource')}
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
            </View>
            <AppIcon name="chevronRight" size={16} />
          </Pressable>
          {report.importState === 'imported' &&
            (openDraftId !== null || report.labRecordIds.length === 0) && (
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
        </AppSurface>
      )}
      {integrity !== 'verified' && report.importState !== 'deleted' && (
        <AppSurface tone="soft" style={styles.error}>
          <AppText variant="heading">{t('labs.reportSourceUnavailableTitle')}</AppText>
          <AppText>{t('labs.reportSourceUnavailableBody')}</AppText>
          <AppButton
            disabled={busy}
            label={t('labs.reportDelete')}
            onPress={confirmDelete}
            tone="secondary"
          />
        </AppSurface>
      )}
      {integrity === 'verified' &&
        (report.importState === 'failed' || report.importState === 'interrupted') && (
          <AppSurface tone="soft" style={styles.error}>
            <AppText>
              {t(
                failureRecovery.message === 'retained-source'
                  ? 'labs.reportRetryBody'
                  : 'labs.reportNoSourceRetryBody',
              )}
            </AppText>
            {failureRecovery.action === 'retry' ? (
              <AppButton
                disabled={busy}
                label={t('labs.reportRetry')}
                onPress={() => void retry()}
              />
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
    </DetailScrollView>
  );
}

function DetailScrollView({ children }: PropsWithChildren) {
  return (
    <ScreenScrollView
      contentContainerStyle={screenStyles.content}
      style={screenStyles.scroll}
      tabBarClearance="native"
    >
      {children}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  reportSummary: { padding: spacing.lg },
  reportHeroHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  reportHeroCopy: { flex: 1, gap: spacing.sm, minWidth: 210 },
  reportSummaryBody: { color: colors.mutedInk },
  body: { color: colors.mutedInk, marginTop: spacing.md },
  resultMeta: { color: colors.mutedInk, marginTop: spacing.xs },
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
  error: { gap: spacing.sm, marginTop: spacing.md },
  headerAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  pressed: { opacity: 0.6 },
  resultsSection: { gap: spacing.sm, marginTop: spacing.lg },
  resultsGroup: { overflow: 'hidden', padding: 0 },
  resultRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 64,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  resultRowDivider: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
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
  errorText: { color: colors.danger },
});
