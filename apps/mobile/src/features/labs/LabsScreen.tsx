import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { LabRecord, LabReport, SpecimenType } from '@alyte/domain';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import {
  AppButton,
  AppIcon,
  AppSurface,
  EmptyState,
  AppText,
  ScreenScrollView,
} from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { labsShowsManualRecordAction } from './labs-ui-model';

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

export function LabsScreen() {
  const navigation = useNavigation<Navigation>();
  const services = useServices();
  const { labs } = services;
  const isFocused = useIsFocused();
  const [records, setRecords] = useState<readonly LabRecord[]>([]);
  const [reports, setReports] = useState<readonly LabReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const { fontScale } = useWindowDimensions();
  const usesAccessibilityTextSize = fontScale >= 1.3;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const hasData = labsShowsManualRecordAction(reports.length, records.length);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: hasData
        ? () => (
            <Pressable
              accessibilityLabel={t('labs.action')}
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => navigation.navigate('LabReportImport')}
              style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}
            >
              <AppIcon color={colors.accent} name="plus" size={20} />
            </Pressable>
          )
        : () => null,
    });
  }, [hasData, navigation]);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [nextRecords, nextReports] = await Promise.all([
        labs.listRecords(),
        services.reports.listReports(),
      ]);
      setRecords(nextRecords);
      setReports(nextReports);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [labs, services.reports]);

  useEffect(() => {
    if (isFocused) void loadRecords();
  }, [isFocused, loadRecords]);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        {loading && <AppText style={styles.muted}>{t('labs.loading')}</AppText>}
        {error && (
          <AppSurface tone="soft" style={styles.errorSurface}>
            <AppText variant="heading">{t('labs.errorTitle')}</AppText>
            <AppText style={styles.muted}>{t('labs.errorBody')}</AppText>
            <AppButton
              label={t('labs.retry')}
              onPress={() => void loadRecords()}
              tone="secondary"
            />
          </AppSurface>
        )}
        {!loading && !error && records.length === 0 && reports.length === 0 && (
          <EmptyState
            title={t('labs.emptyTitle')}
            body={t('labs.emptyBody')}
            action={
              <View style={styles.emptyActions}>
                <AppButton
                  label={t('labs.action')}
                  onPress={() => navigation.navigate('LabReportImport')}
                  style={usesAccessibilityTextSize ? styles.fullWidthAction : undefined}
                />
                <AppButton
                  label={t('labs.manualAction')}
                  onPress={() => navigation.navigate('LabRecordForm')}
                  style={usesAccessibilityTextSize ? styles.fullWidthAction : undefined}
                  tone="secondary"
                />
              </View>
            }
          />
        )}
        {reports.length > 0 && (
          <View style={styles.section}>
            <AppText variant="label" style={styles.sectionLabel}>
              {t('labs.reportsSection')}
            </AppText>
            <AppSurface style={styles.sectionSurface}>
              {reports.map((report) => (
                <Pressable
                  accessibilityLabel={`${t('labs.reportTitle')}: ${report.originalFilename}`}
                  accessibilityRole="button"
                  key={report.id}
                  onPress={() => navigation.navigate('LabReportDetail', { reportId: report.id })}
                  style={({ pressed }) => [styles.listRow, pressed && styles.rowPressed]}
                >
                  <AppIcon name="doc" size={22} />
                  <View style={styles.rowBody}>
                    <AppText numberOfLines={1} variant="heading">
                      {report.originalFilename}
                    </AppText>
                    <AppText numberOfLines={1} style={styles.muted}>
                      {`${reportSourceLabel(report)} · ${reportStateLabel(report)}`}
                    </AppText>
                  </View>
                  <AppIcon name="chevronRight" size={16} />
                </Pressable>
              ))}
            </AppSurface>
          </View>
        )}
        {records.length > 0 && (
          <View style={styles.section}>
            <AppText variant="label" style={styles.sectionLabel}>
              {t('labs.recordsSection')}
            </AppText>
            <AppSurface style={styles.sectionSurface}>
              {records.map((record) => {
                const date =
                  record.collectionDate.kind === 'known'
                    ? new Intl.DateTimeFormat(locale, {
                        dateStyle: 'medium',
                        timeZone: 'UTC',
                      }).format(new Date(`${record.collectionDate.value}T00:00:00.000Z`))
                    : t('labs.recordDateMissing');
                return (
                  <Pressable
                    accessibilityLabel={`${t('labs.recordTitle')}: ${date}`}
                    accessibilityRole="button"
                    key={record.id}
                    onPress={() => navigation.navigate('LabRecordDetail', { recordId: record.id })}
                    style={({ pressed }) => [styles.listRow, pressed && styles.rowPressed]}
                  >
                    <AppIcon name="labs" size={22} />
                    <View style={styles.rowBody}>
                      <AppText variant="heading">{date}</AppText>
                      <AppText style={styles.muted}>
                        {`${specimenLabel(record.specimenType)} · ${t('labs.recordMeasurements').replace('{count}', String(record.measurements.length))}`}
                      </AppText>
                    </View>
                    <AppIcon name="chevronRight" size={16} />
                  </Pressable>
                );
              })}
            </AppSurface>
          </View>
        )}
        {!loading && !error && hasData && (
          <AppButton
            label={t('labs.manualAction')}
            onPress={() => navigation.navigate('LabRecordForm')}
            style={styles.manualAction}
            tone="quiet"
          />
        )}
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  emptyActions: { gap: spacing.sm },
  fullWidthAction: { alignSelf: 'stretch', width: '100%' },
  section: { gap: spacing.xs, marginTop: spacing.md },
  sectionLabel: { color: colors.mutedInk, textTransform: 'uppercase' },
  sectionSurface: { overflow: 'hidden', padding: 0 },
  listRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 64,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  rowBody: { flex: 1, gap: spacing.xs },
  rowPressed: { backgroundColor: colors.accentSoft },
  headerAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  manualAction: { alignSelf: 'flex-start' },
  muted: { color: colors.mutedInk },
  errorSurface: { gap: spacing.sm, marginBottom: spacing.md },
  pressed: { opacity: 0.78 },
});
