import { useLayoutEffect, useState } from 'react';
import { Alert, StyleSheet } from 'react-native';
import type { LabReport } from '@alyte/domain';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import {
  LabReportImportError,
  LabReportSelectionError,
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

  function showImportedReport(report: LabReport, openProgress: boolean) {
    navigation.navigate('MainTabs', {
      screen: 'Labs',
      params: { screen: 'LabReportDetail', params: { reportId: report.id } },
    });
    if (openProgress) {
      navigation.navigate('ExtractionProgress', { reportId: report.id });
    }
  }

  async function importPdf() {
    setBusy(true);
    setError(null);
    try {
      const result = await reports.importPdf(undefined, passwordRequest());
      if (result !== null) {
        setLastReport(result.report);
        showImportedReport(result.report, true);
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
        showImportedReport(result.report, true);
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
      <AppText style={styles.intro}>{t('labs.reportImportBody')}</AppText>
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
              onPress={() => showImportedReport(lastReport, false)}
              tone="secondary"
            />
          )}
        </AppSurface>
      )}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm, marginTop: spacing.md },
  error: { gap: spacing.sm, marginTop: spacing.md },
  intro: { color: colors.mutedInk, marginTop: spacing.sm },
  muted: { color: colors.mutedInk },
});
