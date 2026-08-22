import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import { formatIntakeLocalDate, formatLocaleDate, type IntakeEvent } from '@alyte/domain';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { LogStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, EmptyState, AppText } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { IntakeEventCard } from './IntakeEventCard';

type Navigation = NativeStackNavigationProp<LogStackParamList>;

function shiftDay(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function LogScreen() {
  const navigation = useNavigation<Navigation>();
  const { intake, clock } = useServices();
  const isFocused = useIsFocused();
  const today = formatIntakeLocalDate(clock.now());
  const [selectedDay, setSelectedDay] = useState(today);
  const [events, setEvents] = useState<readonly IntakeEvent[]>([]);
  const [lastLogAgainId, setLastLogAgainId] = useState<string | null>(null);
  const [recentLogAgain, setRecentLogAgain] = useState<IntakeEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await intake.listEventsForDay(selectedDay));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [intake, selectedDay]);

  useEffect(() => {
    if (isFocused) void load();
  }, [isFocused, load]);

  useEffect(
    () =>
      intake.subscribe((change) => {
        if (
          recentLogAgain?.id === change.eventId &&
          change.kind !== 'created' &&
          change.kind !== 'logged-again'
        ) {
          setLastLogAgainId(null);
          setRecentLogAgain(null);
        }
        void load();
      }),
    [intake, load, recentLogAgain?.id],
  );

  async function logAgain(event: IntakeEvent) {
    try {
      const copy = await intake.logAgain(event.id);
      setLastLogAgainId(copy.id);
      setRecentLogAgain(copy);
      if (copy.localDate === selectedDay) setEvents((current) => [copy, ...current]);
    } catch {
      setError(true);
    }
  }

  async function undoLogAgain(eventId: string) {
    try {
      await intake.undoLogAgain(eventId);
      setLastLogAgainId(null);
      setRecentLogAgain(null);
      await load();
    } catch {
      setError(true);
    }
  }

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

  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <View style={styles.titleRow}>
          <AppText variant="title">{t('log.title')}</AppText>
          <AppButton label={t('log.action')} onPress={() => navigation.navigate('IntakeEntry')} />
        </View>
        <AppSurface tone="soft" style={styles.dayPicker}>
          <AppButton
            accessibilityLabel={t('log.previousDay')}
            label={t('log.previousDay')}
            tone="quiet"
            onPress={() => setSelectedDay((value) => shiftDay(value, -1))}
          />
          <AppText variant="heading">{formatLocaleDate(selectedDay, locale)}</AppText>
          <AppButton
            accessibilityLabel={t('log.nextDay')}
            label={t('log.nextDay')}
            tone="quiet"
            onPress={() => setSelectedDay((value) => shiftDay(value, 1))}
          />
          {selectedDay !== today && (
            <AppButton
              label={t('log.today')}
              tone="secondary"
              onPress={() => setSelectedDay(today)}
            />
          )}
        </AppSurface>
        {recentLogAgain !== null && (
          <AppSurface tone="soft" style={styles.success}>
            <AppText variant="heading">{t('log.loggedAgain')}</AppText>
            <AppText style={styles.muted}>{t('log.loggedAgainBody')}</AppText>
            <View style={styles.successActions}>
              <AppButton
                label={t('intake.undo')}
                tone="secondary"
                onPress={() => void undoLogAgain(recentLogAgain.id)}
              />
              <AppButton
                label={t('intake.edit')}
                tone="quiet"
                onPress={() => navigation.navigate('IntakeEntry', { eventId: recentLogAgain.id })}
              />
            </View>
          </AppSurface>
        )}
        {loading && <AppText style={styles.muted}>{t('log.loading')}</AppText>}
        {error && <AppText style={styles.error}>{t('log.error')}</AppText>}
        {!loading && !error && events.length === 0 && (
          <EmptyState
            title={t('log.emptyTitle')}
            body={t('log.emptyBody')}
            action={
              <AppButton
                label={t('log.action')}
                onPress={() => navigation.navigate('IntakeEntry')}
              />
            }
          />
        )}
        {!loading &&
          !error &&
          events.map((event) => (
            <IntakeEventCard
              event={event}
              key={event.id}
              onDelete={() => deleteEvent(event)}
              onEdit={() => navigation.navigate('IntakeEntry', { eventId: event.id })}
              onLogAgain={lastLogAgainId === event.id ? undefined : () => void logAgain(event)}
              onRemoveImage={() => removeImage(event)}
              onToggleInclusion={() =>
                void intake
                  .setAnalysisInclusion(event.id, event.analysisInclusion === 'excluded')
                  .then(() => load())
                  .catch(() => setError(true))
              }
              onUndo={lastLogAgainId === event.id ? () => void undoLogAgain(event.id) : undefined}
            />
          ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  titleRow: { gap: spacing.sm, marginBottom: spacing.md },
  dayPicker: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  success: { gap: spacing.xs, marginBottom: spacing.md },
  successActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger, marginBottom: spacing.sm },
});
