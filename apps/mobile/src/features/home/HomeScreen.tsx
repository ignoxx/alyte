import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useIsFocused } from '@react-navigation/native';
import { formatIntakeLocalDate, type IntakeEvent } from '@alyte/domain';
import type { MainTabParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, EmptyState, AppText } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { IntakeEventCard } from '../intake/IntakeEventCard';
import type { IntakeCloudJob } from '../intake/outbox';

type HomeScreenProps = BottomTabScreenProps<MainTabParamList, 'Home'>;

export function HomeScreen({ navigation }: HomeScreenProps) {
  const { intake, clock } = useServices();
  const isFocused = useIsFocused();
  const today = formatIntakeLocalDate(clock.now());
  const [events, setEvents] = useState<readonly IntakeEvent[]>([]);
  const [cloudJobs, setCloudJobs] = useState<readonly IntakeCloudJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextEvents, nextJobs] = await Promise.all([
        intake.listEventsForDay(today),
        intake.resumeCloudJobs(),
      ]);
      setEvents(nextEvents);
      setCloudJobs(nextJobs);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [intake, today]);

  useEffect(() => {
    if (isFocused) void load();
  }, [isFocused, load]);

  useEffect(() => intake.subscribe(() => void load()), [intake, load]);

  function deleteEvent(event: IntakeEvent) {
    Alert.alert(t('intake.deleteTitle'), t('intake.deleteConfirm'), [
      { text: t('intake.cancel'), style: 'cancel' },
      {
        text: t('intake.delete'),
        style: 'destructive',
        onPress: () =>
          void intake
            .deleteEvent(event.id)
            .then(() => load())
            .catch(() => setError(true)),
      },
    ]);
  }

  function removeImage(event: IntakeEvent) {
    Alert.alert(t('intake.removeImageTitle'), t('intake.removeImageConfirm'), [
      { text: t('intake.cancel'), style: 'cancel' },
      {
        text: t('intake.removeImage'),
        style: 'destructive',
        onPress: () =>
          void intake
            .removeIntakeImage(event.id)
            .then(() => load())
            .catch(() => setError(true)),
      },
    ]);
  }

  function cancelAnalysis(event: IntakeEvent) {
    Alert.alert(t('home.cancelAnalysis'), t('snap.cloudQueued'), [
      { text: t('intake.cancel'), style: 'cancel' },
      {
        text: t('home.cancelAnalysis'),
        style: 'destructive',
        onPress: () =>
          void intake
            .cancelCloudAnalysis(event.id)
            .then(() => load())
            .catch(() => setError(true)),
      },
    ]);
  }

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <View style={styles.titleRow}>
          <AppButton label={t('home.logAction')} onPress={() => navigation.navigate('Log')} />
        </View>
        {loading && <AppText style={styles.muted}>{t('home.loading')}</AppText>}
        {error && <AppText style={styles.error}>{t('home.error')}</AppText>}
        {!loading && !error && events.length === 0 && (
          <EmptyState
            title={t('home.emptyTitle')}
            body={t('home.emptyBody')}
            action={
              <View style={styles.actions}>
                <AppButton
                  label={t('home.importAction')}
                  tone="secondary"
                  onPress={() => navigation.navigate('Labs')}
                />
                <AppButton label={t('home.logAction')} onPress={() => navigation.navigate('Log')} />
              </View>
            }
          />
        )}
        {!loading && !error && events.length > 0 && (
          <AppSurface tone="soft" style={styles.summary}>
            <AppText variant="heading">{t('home.todaySummary')}</AppText>
            <AppText style={styles.muted}>
              {t('home.todayCount').replace('{count}', String(events.length))}
            </AppText>
          </AppSurface>
        )}
        {!loading &&
          !error &&
          events.map((event) => (
            <IntakeEventCard
              event={event}
              key={event.id}
              cloudJob={cloudJobs.find((job) => job.eventId === event.id) ?? null}
              onDelete={() => deleteEvent(event)}
              onEdit={() => navigation.navigate('Log')}
              onLogAgain={() =>
                void intake
                  .logAgain(event.id)
                  .then(() => load())
                  .catch(() => setError(true))
              }
              onRemoveImage={() => removeImage(event)}
              onCancelAnalysis={() => cancelAnalysis(event)}
              onToggleInclusion={() =>
                void intake
                  .setAnalysisInclusion(event.id, event.analysisInclusion === 'excluded')
                  .then(() => load())
                  .catch(() => setError(true))
              }
            />
          ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  titleRow: { gap: spacing.sm, marginBottom: spacing.md },
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  summary: { gap: spacing.xs, marginBottom: spacing.md },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
});
