import { useLayoutEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import type { LabReport } from '@alyte/domain';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import {
  AppButton,
  AppSurface,
  AppText,
  ScreenScrollView,
  TidalHero,
  TidalIconStage,
} from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import {
  LabReportImportError,
  LabReportSelectionError,
  type LabReportImportDestination,
  type PasswordRequest,
} from './report-service';

type Navigation = NativeStackNavigationProp<RootStackParamList, 'ReportImport'>;

function passwordRequest(): PasswordRequest {
  return ({ report }) =>
    new Promise<string | null>((resolve) => {
      Alert.prompt(
        t('labs.reportPasswordTitle'),
        t('labs.reportPasswordBody').replace('{filename}', report.originalFilename),
        (value) => resolve(value),
        'secure-text',
        undefined,
        undefined,
        { onDismiss: () => resolve(null) },
      );
    });
}

function errorMessage(error: unknown): string {
  if (error instanceof LabReportSelectionError) {
    return error.reason === 'multiple-images'
      ? t('labs.reportImportMultipleImages')
      : t('labs.reportImportInvalidImage');
  }
  if (!(error instanceof LabReportImportError)) return t('labs.reportImportError');
  if (error.report.originalPath === null || error.report.sourceHash === null) {
    return t('labs.reportImportNoSourceError');
  }
  if (error.reason === 'cancelled') return t('labs.reportImportCancelled');
  if (error.reason === 'wrong-password') return t('labs.reportWrongPassword');
  if (error.reason === 'malformed') return t('labs.reportMalformed');
  return t('labs.reportImportError');
}

export function LabReportImportScreen() {
  const navigation = useNavigation<Navigation>();
  const { reports } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<LabReport | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <AppButton
          disabled={busy}
          label={t('labs.recordCancel')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      ),
    });
  }, [busy, navigation]);

  function navigateToImportedReport(
    report: LabReport,
    destination: LabReportImportDestination = { kind: 'report-detail' },
  ) {
    if (destination.kind === 'extraction-draft') {
      navigation.navigate(
        'MainTabs',
        {
          screen: 'Labs',
          params: {
            screen: 'ExtractionDraft',
            params: { reportId: report.id, draftId: destination.draftId },
            pop: true,
          },
        },
        { pop: true },
      );
      return;
    }
    navigation.navigate(
      'MainTabs',
      {
        screen: 'Labs',
        params: { screen: 'LabReportDetail', params: { reportId: report.id }, pop: true },
      },
      { pop: true },
    );
    if (destination.kind === 'extraction-progress') {
      navigation.navigate('ExtractionProgress', { reportId: report.id });
    }
  }

  function showImportedReport(
    report: LabReport,
    destination: LabReportImportDestination = { kind: 'report-detail' },
    duplicate = false,
  ) {
    if (!duplicate) {
      navigateToImportedReport(report, destination);
      return;
    }
    Alert.alert(
      t('labs.reportAlreadyImported'),
      undefined,
      [{ text: t('labs.done'), onPress: () => navigateToImportedReport(report, destination) }],
      { cancelable: false },
    );
  }

  async function importPdf() {
    setBusy(true);
    setError(null);
    try {
      const result = await reports.importPdf(undefined, passwordRequest());
      if (result !== null) {
        setLastReport(result.report);
        showImportedReport(result.report, result.destination, result.duplicate);
      }
    } catch (caught) {
      setError(errorMessage(caught));
      if (caught instanceof LabReportImportError) setLastReport(caught.report);
    } finally {
      setBusy(false);
    }
  }

  async function importImages() {
    setBusy(true);
    setError(null);
    try {
      const result = await reports.importImages(undefined, passwordRequest());
      if (result !== null) {
        setLastReport(result.report);
        showImportedReport(result.report, result.destination, result.duplicate);
      }
    } catch (caught) {
      setError(errorMessage(caught));
      if (caught instanceof LabReportImportError) setLastReport(caught.report);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
      <TidalHero style={styles.importHero}>
        <View style={styles.importHeroHeading}>
          <TidalIconStage name="addDocument" size="compact" />
          <View style={styles.importHeroCopy}>
            <AppText style={styles.importHeroTitle} variant="title">
              {t('labs.reportImportTitle')}
            </AppText>
            <AppText style={styles.importHeroBody} variant="caption">
              {t('labs.reportImportBody')}
            </AppText>
          </View>
        </View>
      </TidalHero>
      <AppSurface style={styles.actions}>
        <AppButton
          disabled={busy}
          label={t('labs.reportPickPdf')}
          onPress={() => void importPdf()}
        />
        <AppButton
          disabled={busy}
          label={t('labs.reportPickImages')}
          onPress={() => void importImages()}
          tone="secondary"
        />
      </AppSurface>
      {busy && <AppText style={styles.muted}>{t('labs.reportImporting')}</AppText>}
      {error !== null && (
        <AppSurface tone="soft" style={styles.error}>
          <AppText variant="heading">{t('labs.reportImportFailedTitle')}</AppText>
          <AppText style={styles.muted}>{error}</AppText>
          {lastReport !== null && (
            <AppButton
              label={t('labs.reportViewFailed')}
              onPress={() => showImportedReport(lastReport)}
              tone="secondary"
            />
          )}
        </AppSurface>
      )}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  importHero: { padding: spacing.lg },
  importHeroHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  importHeroCopy: { flex: 1, gap: spacing.xs, minWidth: 210 },
  importHeroTitle: { color: colors.onBrand },
  importHeroBody: { color: colors.onBrandMuted },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  error: { gap: spacing.sm, marginTop: spacing.md },
  muted: { color: colors.mutedInk },
});
