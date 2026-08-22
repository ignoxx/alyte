import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import {
  formatIntakeLocalDate,
  parseLocaleDecimal,
  type IntakeAmount,
  type IntakeEvent,
  type IntakeEventType,
} from '@alyte/domain';
import type { LogStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';

type Navigation = NativeStackNavigationProp<LogStackParamList>;
type EntryRoute = RouteProp<LogStackParamList, 'IntakeEntry'>;

const eventTypes: readonly IntakeEventType[] = [
  'food',
  'drink',
  'supplement',
  'medication',
  'other',
];

function eventTypeLabel(value: IntakeEventType): string {
  return t(
    value === 'food'
      ? 'intake.typeFood'
      : value === 'drink'
        ? 'intake.typeDrink'
        : value === 'supplement'
          ? 'intake.typeSupplement'
          : value === 'medication'
            ? 'intake.typeMedication'
            : 'intake.typeOther',
  );
}

function localTime(value: string): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function IntakeEntryScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<EntryRoute>();
  const { intake, clock } = useServices();
  const eventId = route.params?.eventId;
  const [event, setEvent] = useState<IntakeEvent | null>(null);
  const [eventType, setEventType] = useState<IntakeEventType>('food');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState('');
  const [amountUnknown, setAmountUnknown] = useState(true);
  const [date, setDate] = useState(formatIntakeLocalDate(clock.now()));
  const [time, setTime] = useState(localTime(clock.now().toISOString()));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (eventId === undefined) return;
    let active = true;
    void intake
      .getEvent(eventId)
      .then((next) => {
        if (!active || next === null) return;
        const component = next.components[0];
        setEvent(next);
        setEventType(next.eventType);
        setName(component?.name ?? '');
        if (component?.amount.kind === 'known') {
          setAmount(String(component.amount.value));
          setUnit(component.amount.unit);
          setAmountUnknown(false);
        } else {
          setAmount('');
          setUnit('');
          setAmountUnknown(true);
        }
        setDate(next.localDate);
        setTime(localTime(next.occurredAt));
        setNotes(next.notes ?? '');
      })
      .catch(() => {
        if (active) setError(t('intake.loadError'));
      });
    return () => {
      active = false;
    };
  }, [eventId, intake]);

  async function save() {
    setError(null);
    if (name.trim().length === 0 || (!amountUnknown && parseLocaleDecimal(amount) === null)) {
      setError(t('intake.required'));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      setError(t('intake.invalidDate'));
      return;
    }
    const parsedDate = new Date(`${date}T${time}:00`);
    if (Number.isNaN(parsedDate.getTime())) {
      setError(t('intake.invalidDate'));
      return;
    }
    const occurredAt = parsedDate.toISOString();
    const intakeAmount: IntakeAmount = amountUnknown
      ? { kind: 'unknown', reason: 'not-confirmed' }
      : {
          kind: 'known',
          value: parseLocaleDecimal(amount) as number,
          unit: unit.trim() || 'serving',
        };
    setSaving(true);
    try {
      if (event === null) {
        await intake.createEvent({
          eventType,
          occurredAt,
          localDate: date,
          origin: 'manual',
          components: [{ name: name.trim(), amount: intakeAmount }],
          notes: notes.trim() || null,
        });
      } else {
        const componentInput = { name: name.trim(), amount: intakeAmount };
        await intake.updateEvent(event.id, {
          eventType,
          occurredAt,
          localDate: date,
          notes: notes.trim() || null,
          components:
            event.components[0] === undefined
              ? [componentInput]
              : [
                  { ...componentInput, id: event.components[0].id },
                  ...event.components.slice(1).map((component) => ({
                    id: component.id,
                    name: component.name,
                    amount: component.amount,
                    canonicalId: component.canonicalId,
                    provenance: component.provenance,
                    reviewState: component.reviewState,
                  })),
                ],
        });
      }
      navigation.goBack();
    } catch {
      setError(t('intake.saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaViewWithScroll>
      <AppText variant="title">
        {event === null ? t('intake.newTitle') : t('intake.editTitle')}
      </AppText>
      <AppText style={styles.intro}>{t('intake.formIntro')}</AppText>
      <AppSurface style={styles.section}>
        <AppText variant="label">{t('intake.typeLabel')}</AppText>
        <View style={styles.choiceRow}>
          {eventTypes.map((type) => (
            <AppButton
              key={type}
              label={eventTypeLabel(type)}
              tone={eventType === type ? 'primary' : 'secondary'}
              onPress={() => setEventType(type)}
            />
          ))}
        </View>
        <AppText variant="label">{t('intake.nameLabel')}</AppText>
        <TextInput
          accessibilityLabel={t('intake.nameLabel')}
          onChangeText={setName}
          placeholder={t('intake.namePlaceholder')}
          style={styles.input}
          value={name}
        />
        <AppText variant="label">{t('intake.amountLabel')}</AppText>
        <TextInput
          accessibilityLabel={t('intake.amountLabel')}
          editable={!amountUnknown}
          keyboardType="decimal-pad"
          onChangeText={setAmount}
          placeholder={t('intake.amountPlaceholder')}
          style={[styles.input, amountUnknown && styles.disabledInput]}
          value={amount}
        />
        <TextInput
          accessibilityLabel={t('intake.unitLabel')}
          editable={!amountUnknown}
          onChangeText={setUnit}
          placeholder={t('intake.unitPlaceholder')}
          style={[styles.input, amountUnknown && styles.disabledInput]}
          value={unit}
        />
        <AppButton
          accessibilityRole="checkbox"
          accessibilityState={{ selected: amountUnknown }}
          label={t('intake.amountUnknown')}
          tone="quiet"
          onPress={() => setAmountUnknown((value) => !value)}
        />
        <AppText variant="label">{t('intake.dateLabel')}</AppText>
        <TextInput
          accessibilityLabel={t('intake.dateLabel')}
          onChangeText={setDate}
          placeholder="YYYY-MM-DD"
          style={styles.input}
          value={date}
        />
        <TextInput
          accessibilityLabel={t('intake.timeLabel')}
          onChangeText={setTime}
          placeholder="HH:MM"
          style={styles.input}
          value={time}
        />
        <AppText variant="label">{t('intake.notesLabel')}</AppText>
        <TextInput
          accessibilityLabel={t('intake.notesLabel')}
          onChangeText={setNotes}
          placeholder={t('intake.notesPlaceholder')}
          style={[styles.input, styles.multiline]}
          value={notes}
        />
      </AppSurface>
      {error !== null && <AppText style={styles.error}>{error}</AppText>}
      <AppButton disabled={saving} label={t('intake.save')} onPress={() => void save()} />
      <AppButton label={t('intake.cancel')} tone="quiet" onPress={() => navigation.goBack()} />
    </SafeAreaViewWithScroll>
  );
}

function SafeAreaViewWithScroll({ children }: { readonly children: ReactNode }) {
  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.mutedInk, marginBottom: spacing.md },
  section: { gap: spacing.sm, marginBottom: spacing.md },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  input: {
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 17,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
  },
  disabledInput: { backgroundColor: colors.canvas, color: colors.mutedInk },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  error: { color: colors.danger, marginBottom: spacing.sm },
});
