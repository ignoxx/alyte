import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useIsFocused, useNavigation, type NavigationProp } from '@react-navigation/native';
import { formatLocaleDate, type LabRecord, type LabReport, type SpecimenType } from '@alyte/domain';
import type { LabsStackParamList, RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppIcon, AppText, LabEmptyState, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { listHistoryEntries } from './biomarker-history-model';
import { summarizeLabReport } from './lab-read-model';
import { getLabReportFailureRecovery } from './report-detail-model';
import { openReportImportFromStack } from '../../navigation/parent-tab';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;

function specimenLabel(value: SpecimenType): string {
  const suffix =
    value === 'unknown' ? 'Unknown' : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  return t(`labs.specimen${suffix}`);
}

function reportSourceLabel(report: LabReport): string {
  return report.sourceType === 'pdf' ? t('labs.reportPdf') : t('labs.reportImage');
}

function reportStateLabel(report: LabReport): string {
  const recovery = getLabReportFailureRecovery(report);
  if (recovery.message === 'missing-source') {
    if (report.importState === 'failed') return t('labs.reportStateFailedNoSource');
    if (report.importState === 'interrupted') return t('labs.reportStateInterruptedNoSource');
  }
  return t(
    report.importState === 'imported'
      ? 'labs.reportStateImported'
      : report.importState === 'failed'
        ? 'labs.reportStateFailed'
        : report.importState === 'interrupted'
          ? 'labs.reportStateInterrupted'
          : report.importState === 'deleted'
            ? 'labs.reportStateDeleted'
            : 'labs.reportStateImporting',
  );
}

function countCopy(count: number, singularKey: string, pluralKey: string): string {
  return t(count === 1 ? singularKey : pluralKey).replace('{count}', String(count));
}

function measurementCount(count: number): string {
  return countCopy(count, 'labs.recordMeasurement', 'labs.recordMeasurements');
}

function historyMeasurementCount(count: number): string {
  return countCopy(count, 'labs.historyEntrySubtitleSingular', 'labs.historyEntrySubtitle');
}

function reportDetail(report: LabReport, records: readonly LabRecord[], locale: string): string {
  const summary = summarizeLabReport(report, records);
  const dateLabel =
    summary.collectionDate.kind === 'known'
      ? formatLocaleDate(summary.collectionDate.value, locale)
      : t('labs.recordDateMissing');
  return `${dateLabel} · ${reportSourceLabel(report)} · ${measurementCount(summary.measurementCount)}`;
}

export function LabsScreen() {
  const navigation = useNavigation<Navigation>();
  const services = useServices();
  const { labs } = services;
  const isFocused = useIsFocused();
  const root = navigation.getParent()?.getParent<NavigationProp<RootStackParamList>>();
  const [records, setRecords] = useState<readonly LabRecord[]>([]);
  const [reports, setReports] = useState<readonly LabReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const historyEntries = listHistoryEntries(records);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [nextRecords, nextReports] = await Promise.all([
        labs.listRecords(),
        services.reports.listReports(),
      ]);
      setRecords(nextRecords);
      setReports(nextReports.filter((report) => report.importState !== 'deleted'));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [labs, services.reports]);

  useEffect(() => {
    if (isFocused) void loadRecords();
  }, [isFocused, loadRecords]);

  const hasData = records.length > 0 || reports.length > 0;
  const isEmptyState = !loading && !error && !hasData;
  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        alwaysBounceVertical={!isEmptyState}
        bounces={!isEmptyState}
        contentContainerStyle={screenStyles.content}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        {loading && <AppText style={styles.muted}>{t('labs.loading')}</AppText>}
        {error && (
          <View style={styles.errorState}>
            <AppText variant="heading">{t('labs.errorTitle')}</AppText>
            <AppText style={styles.muted}>{t('labs.errorBody')}</AppText>
            <AppButton
              label={t('labs.retry')}
              onPress={() => void loadRecords()}
              tone="secondary"
            />
          </View>
        )}
        {isEmptyState && (
          <LabEmptyState
            actionLabel={t('labs.action')}
            icon="addDocument"
            onAction={() => openReportImportFromStack(navigation)}
            body={t('labs.emptyBody')}
            title={t('labs.emptyTitle')}
          />
        )}
        {!loading && !error && !isEmptyState && (
          <View style={styles.sections}>
            <AppButton
              label={t('labs.action')}
              onPress={() => openReportImportFromStack(navigation)}
              style={styles.importButton}
            >
              <AppIcon color={colors.onAccent} name="plus" size={17} />
            </AppButton>
            {reports.length > 0 && (
              <View style={styles.section}>
                <AppText variant="label" style={styles.sectionLabel}>
                  {t('labs.reportsSection')}
                </AppText>
                {reports.map((report) => {
                  const detail = reportDetail(report, records, locale);
                  return (
                    <Pressable
                      accessibilityHint={t('labs.reportRowHint')}
                      accessibilityLabel={`${t('labs.reportTitle')}: ${report.originalFilename}, ${detail}`}
                      accessibilityRole="button"
                      key={report.id}
                      onPress={() =>
                        navigation.navigate('LabReportDetail', { reportId: report.id })
                      }
                      style={({ pressed }) => [styles.listRow, pressed && styles.rowPressed]}
                    >
                      <AppIcon color={colors.accent} name="doc" size={22} />
                      <View style={styles.rowBody}>
                        <AppText numberOfLines={2} selectable variant="heading">
                          {report.originalFilename}
                        </AppText>
                        <AppText numberOfLines={2} selectable style={styles.muted}>
                          {`${detail} · ${reportStateLabel(report)}`}
                        </AppText>
                      </View>
                      <AppIcon name="chevronRight" size={16} />
                    </Pressable>
                  );
                })}
              </View>
            )}
            {records.length > 0 && (
              <View style={styles.section}>
                <AppText variant="label" style={styles.sectionLabel}>
                  {t('labs.recordsSection')}
                </AppText>
                {records.map((record) => {
                  const date =
                    record.collectionDate.kind === 'known'
                      ? formatLocaleDate(record.collectionDate.value, locale)
                      : t('labs.recordDateMissing');
                  const measurementSummary = measurementCount(record.measurements.length);
                  return (
                    <Pressable
                      accessibilityHint={t('labs.recordRowHint')}
                      accessibilityLabel={`${t('labs.recordTitle')}: ${date}, ${measurementSummary}`}
                      accessibilityRole="button"
                      key={record.id}
                      onPress={() =>
                        navigation.navigate('LabRecordDetail', { recordId: record.id })
                      }
                      style={({ pressed }) => [styles.listRow, pressed && styles.rowPressed]}
                    >
                      <AppIcon color={colors.accent} name="labs" size={22} />
                      <View style={styles.rowBody}>
                        <AppText selectable variant="heading">
                          {date}
                        </AppText>
                        <AppText selectable style={styles.muted}>
                          {`${record.laboratoryName ?? t('labs.recordTitle')} · ${specimenLabel(record.specimenType)} · ${measurementSummary}`}
                        </AppText>
                      </View>
                      <AppIcon name="chevronRight" size={16} />
                    </Pressable>
                  );
                })}
              </View>
            )}
            {historyEntries.length > 0 && (
              <View style={styles.section}>
                <AppText variant="label" style={styles.sectionLabel}>
                  {t('labs.historySection')}
                </AppText>
                {historyEntries.map((entry) => (
                  <Pressable
                    accessibilityHint={t('labs.historyRowHint')}
                    accessibilityLabel={`${entry.canonicalLabel}, ${historyMeasurementCount(entry.measurementCount)}`}
                    accessibilityRole="button"
                    key={entry.biomarkerId}
                    onPress={() =>
                      navigation.navigate('BiomarkerHistory', { biomarkerId: entry.biomarkerId })
                    }
                    style={({ pressed }) => [styles.listRow, pressed && styles.rowPressed]}
                  >
                    <AppIcon color={colors.accent} name="chart" size={22} />
                    <View style={styles.rowBody}>
                      <AppText numberOfLines={2} selectable variant="heading">
                        {entry.canonicalLabel}
                      </AppText>
                      <AppText selectable style={styles.muted}>
                        {historyMeasurementCount(entry.measurementCount)}
                      </AppText>
                    </View>
                    <AppIcon name="chevronRight" size={16} />
                  </Pressable>
                ))}
              </View>
            )}
            <AppButton
              label={t('labs.manualAction')}
              onPress={() => root?.navigate('LabRecordForm')}
              style={styles.manualAction}
              tone="quiet"
            />
          </View>
        )}
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  sections: { gap: spacing.lg, paddingBottom: spacing.lg },
  section: { gap: spacing.xs },
  sectionLabel: { color: colors.mutedInk, textTransform: 'uppercase' },
  importButton: { alignSelf: 'stretch' },
  manualAction: { alignSelf: 'flex-start' },
  listRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 68,
    paddingVertical: spacing.md,
  },
  rowBody: { flex: 1, gap: spacing.xs },
  rowPressed: { backgroundColor: colors.accentSoft },
  muted: { color: colors.mutedInk },
  errorState: { gap: spacing.sm },
});
