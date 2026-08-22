import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { formatIntakeLocalDate, type IntakeEvent } from '@alyte/domain';
import type { HomeStackParamList } from '../../navigation/types';
import { dispatchHomeQuickActionFromStack } from '../../navigation/parent-tab';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { IntakeEventCard } from '../intake/IntakeEventCard';
import type { IntakeCloudJob } from '../intake/outbox';
import { groupIntakeTimeline } from './home-model';

type HomeNavigation = NativeStackNavigationProp<HomeStackParamList, 'HomeRoot'>;

export function HomeScreen() {
  const navigation = useNavigation<HomeNavigation>();
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
        {loading && <AppText style={styles.muted}>{t('home.loading')}</AppText>}
        {error && <AppText style={styles.error}>{t('home.error')}</AppText>}
        {!loading && !error && events.length === 0 && (
          <View style={styles.emptyState}>
            <AppText variant="title">{t('home.emptyTitle')}</AppText>
            <AppText style={styles.muted}>{t('home.emptyBody')}</AppText>
            <AppButton
              label={t('home.importAction')}
              onPress={() =>
                dispatchHomeQuickActionFromStack(navigation, {
                  kind: 'import-report',
                })
              }
            />
            <View style={styles.secondaryActions}>
              <AppButton
                label={t('home.snapAction')}
                tone="secondary"
                onPress={() =>
                  dispatchHomeQuickActionFromStack(navigation, {
                    kind: 'snap',
                  })
                }
              />
              <AppButton
                label={t('home.logAction')}
                tone="quiet"
                onPress={() =>
                  dispatchHomeQuickActionFromStack(navigation, {
                    kind: 'log-intake',
                  })
                }
              />
            </View>
          </View>
        )}
        {!loading && !error && events.length > 0 && (
          <View style={styles.timeline}>
            <View style={styles.summary}>
              <View>
                <AppText variant="title">{t('home.todaySummary')}</AppText>
                <AppText style={styles.muted}>
                  {t('home.todayCount').replace('{count}', String(events.length))}
                </AppText>
              </View>
              <AppButton
                label={t('home.logAction')}
                tone="quiet"
                onPress={() =>
                  dispatchHomeQuickActionFromStack(navigation, {
                    kind: 'log-intake',
                  })
                }
              />
            </View>
            {groupIntakeTimeline(events).map((group) => (
              <View key={group.localDate} style={styles.group}>
                <AppText variant="label" style={styles.groupLabel}>
                  {group.localDate === today ? t('home.todayGroup') : group.localDate}
                </AppText>
                <AppSurface style={styles.timelineSurface}>
                  {group.events.map((event) => (
                    <IntakeEventCard
                      compact
                      event={event}
                      key={event.id}
                      cloudJob={cloudJobs.find((job) => job.eventId === event.id) ?? null}
                      onDelete={() => deleteEvent(event)}
                      onEdit={() =>
                        dispatchHomeQuickActionFromStack(navigation, {
                          kind: 'edit-intake',
                          eventId: event.id,
                        })
                      }
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
                </AppSurface>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  emptyState: { gap: spacing.md, paddingTop: spacing.lg },
  secondaryActions: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  timeline: { gap: spacing.md, paddingTop: spacing.sm },
  summary: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  group: { gap: spacing.xs },
  groupLabel: { color: colors.mutedInk, textTransform: 'uppercase' },
  timelineSurface: { overflow: 'hidden', padding: 0 },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
});
