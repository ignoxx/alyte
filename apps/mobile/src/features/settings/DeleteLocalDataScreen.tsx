import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { usePreventRemove } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { useServices } from '../../services';
import { AppButton, AppIcon, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import {
  LOCAL_DELETION_SCOPES,
  type DeletionPlan,
  type LocalDataCounts,
  type LocalDeletionScope,
} from '../local-controls/model';

const scopeCopy: Record<LocalDeletionScope, { title: string; subtitle: string }> = {
  reports: { title: 'settings.deleteReports', subtitle: 'settings.deleteReportsSubtitle' },
  records: { title: 'settings.deleteRecords', subtitle: 'settings.deleteRecordsSubtitle' },
  events: { title: 'settings.deleteEvents', subtitle: 'settings.deleteEventsSubtitle' },
  media: { title: 'settings.deleteMedia', subtitle: 'settings.deleteMediaSubtitle' },
  'all-health': { title: 'settings.deleteAll', subtitle: 'settings.deleteAllSubtitle' },
};

const countCopy: Record<keyof LocalDataCounts, string> = {
  reports: 'settings.deleteCategoryReports',
  reportPages: 'settings.deleteCategoryReportPages',
  sanitizedReports: 'settings.deleteCategorySanitizedReports',
  records: 'settings.deleteCategoryRecords',
  measurements: 'settings.deleteCategoryMeasurements',
  corrections: 'settings.deleteCategoryCorrections',
  extractionDrafts: 'settings.deleteCategoryDrafts',
  extractionRows: 'settings.deleteCategoryDrafts',
  intakeEvents: 'settings.deleteCategoryIntakeEvents',
  intakeComponents: 'settings.deleteCategoryIntakeEvents',
  intakeImages: 'settings.deleteCategoryIntakeImages',
  cloudJobs: 'settings.deleteCategoryCloudJobs',
  captureRecoveries: 'settings.deleteCategoryCaptureRecoveries',
  combinedDeletions: 'settings.deleteCategoryRecords',
  exportJobs: 'settings.deleteCategoryExportJobs',
  sanitizationDrafts: 'settings.deleteCategoryDrafts',
};

function CountBlock({
  title,
  counts,
}: {
  readonly title: string;
  readonly counts: LocalDataCounts;
}) {
  const rows = (Object.keys(counts) as (keyof LocalDataCounts)[]).filter((key) => counts[key] > 0);
  return (
    <View style={styles.countBlock}>
      <AppText variant="heading" style={styles.countTitle}>
        {title}
      </AppText>
      {rows.length === 0 ? (
        <AppText variant="caption" style={styles.muted}>
          {t('settings.deleteNone')}
        </AppText>
      ) : (
        rows.map((key) => (
          <View key={key} style={styles.countRow}>
            <AppText style={styles.muted}>{t(countCopy[key])}</AppText>
            <AppText selectable style={styles.count}>
              {counts[key].toLocaleString()}
            </AppText>
          </View>
        ))
      )}
    </View>
  );
}

export function DeleteLocalDataScreen() {
  const services = useServices();
  const [scope, setScope] = useState<LocalDeletionScope>('reports');
  const [plan, setPlan] = useState<DeletionPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState(false);

  usePreventRemove(working, ({ data }) => {
    Alert.alert(t('settings.deleteWorking'), t('settings.deleteConfirmBody'), [
      { text: t('settings.deleteCancel'), style: 'cancel' },
    ]);
    // The operation is intentionally held until its short irreversible phase completes.
    void data;
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailure(false);
    void services.controls
      .preview(scope)
      .then((nextPlan) => {
        if (active) setPlan(nextPlan);
      })
      .catch(() => {
        if (active) setFailure(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [scope, services.controls]);

  const selected = useMemo(() => scopeCopy[scope], [scope]);

  function confirmDeletion() {
    if (plan === null || working) return;
    Alert.alert(t('settings.deleteConfirmTitle'), t('settings.deleteConfirmBody'), [
      { text: t('settings.deleteCancel'), style: 'cancel' },
      {
        text: t('settings.deleteConfirm'),
        style: 'destructive',
        onPress: () => void runDeletion(plan),
      },
    ]);
  }

  async function runDeletion(currentPlan: DeletionPlan) {
    setWorking(true);
    setFailure(false);
    try {
      const result = await services.controls.execute(currentPlan);
      if (result.state === 'completed') {
        // Rebuild the plan so the preview remains deterministic after a successful operation and
        // a second tap cannot attempt to apply the stale pre-deletion hash.
        setPlan(await services.controls.preview(scope));
      } else {
        setFailure(true);
      }
    } catch {
      setFailure(true);
    } finally {
      setWorking(false);
    }
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView
        contentContainerStyle={screenStyles.content}
        contentInset={{ bottom: 120 }}
        style={screenStyles.scroll}
      >
        <AppText style={styles.intro}>{t('settings.deleteIntro')}</AppText>
        <View style={styles.scopeGroup}>
          {LOCAL_DELETION_SCOPES.map((candidate) => {
            const copy = scopeCopy[candidate];
            const selectedScope = candidate === scope;
            return (
              <Pressable
                key={candidate}
                accessibilityRole="radio"
                accessibilityState={{ selected: selectedScope }}
                onPress={() => {
                  if (!working) setScope(candidate);
                }}
                style={({ pressed }) => [
                  styles.scopeRow,
                  selectedScope && styles.scopeSelected,
                  pressed && !working && styles.rowPressed,
                ]}
              >
                <View style={styles.scopeCopy}>
                  <AppText variant="heading" style={styles.scopeTitle}>
                    {t(copy.title)}
                  </AppText>
                  <AppText variant="caption" style={styles.muted}>
                    {t(copy.subtitle)}
                  </AppText>
                </View>
                {selectedScope && <AppIcon name="eye" size={18} color={colors.accent} />}
              </Pressable>
            );
          })}
        </View>
        {loading ? (
          <AppText style={styles.muted}>{t('settings.privacyLoading')}</AppText>
        ) : failure && plan === null ? (
          <AppText style={styles.muted}>{t('settings.privacyUnavailable')}</AppText>
        ) : plan !== null ? (
          <>
            <CountBlock title={t('settings.willBeDeleted')} counts={deletedCounts(plan)} />
            <CountBlock title={t('settings.willRemain')} counts={plan.willRemain} />
            {failure && <AppText style={styles.failure}>{t('settings.deleteFailureBody')}</AppText>}
            {working ? (
              <AppText style={styles.muted}>{t('settings.deleteWorking')}</AppText>
            ) : (
              <AppButton
                label={failure ? t('settings.deleteRetry') : t('settings.deleteConfirm')}
                tone="primary"
                onPress={confirmDeletion}
              />
            )}
          </>
        ) : null}
        {!working && plan !== null && !failure && (
          <AppText variant="caption" style={styles.scopeFootnote}>
            {t(selected.subtitle)}
          </AppText>
        )}
      </ScreenScrollView>
    </SafeAreaView>
  );
}

function deletedCounts(plan: DeletionPlan): LocalDataCounts {
  return (Object.keys(plan.counts) as (keyof LocalDataCounts)[]).reduce(
    (result, key) => ({ ...result, [key]: Math.max(0, plan.counts[key] - plan.willRemain[key]) }),
    {} as LocalDataCounts,
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.mutedInk, lineHeight: 22, marginBottom: spacing.lg },
  scopeGroup: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg,
    overflow: 'hidden',
  },
  scopeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 70,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  scopeSelected: { backgroundColor: colors.accentSoft },
  rowPressed: { backgroundColor: colors.accentSoft },
  scopeCopy: { flex: 1, gap: spacing.xs },
  scopeTitle: { fontSize: 16, lineHeight: 21 },
  muted: { color: colors.mutedInk },
  countBlock: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.lg,
  },
  countTitle: { fontSize: 16, lineHeight: 21, marginBottom: spacing.xs },
  countRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  count: { color: colors.ink, fontVariant: ['tabular-nums'] },
  failure: { color: colors.danger, marginBottom: spacing.md },
  scopeFootnote: { color: colors.mutedInk, marginTop: spacing.md },
});
