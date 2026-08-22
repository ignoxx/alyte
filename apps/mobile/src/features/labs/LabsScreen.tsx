import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import type { LabRecord, SpecimenType } from '@alyte/domain';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, EmptyState, AppText } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;

function specimenLabel(value: SpecimenType): string {
  const suffix =
    value === 'unknown' ? 'Unknown' : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
  return t(`labs.specimen${suffix}`);
}

export function LabsScreen() {
  const navigation = useNavigation<Navigation>();
  const { labs } = useServices();
  const [records, setRecords] = useState<readonly LabRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setRecords(await labs.listRecords());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [labs]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <View style={styles.titleRow}>
          <AppText variant="title">{t('labs.title')}</AppText>
          <AppButton
            label={t('labs.manualAction')}
            onPress={() => navigation.navigate('LabRecordForm')}
          />
        </View>
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
        {!loading && !error && records.length === 0 && (
          <EmptyState
            title={t('labs.emptyTitle')}
            body={t('labs.emptyBody')}
            action={
              <AppButton
                label={t('labs.manualAction')}
                onPress={() => navigation.navigate('LabRecordForm')}
              />
            }
          />
        )}
        {records.map((record) => {
          const date =
            record.collectionDate.kind === 'known'
              ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
                  new Date(`${record.collectionDate.value}T00:00:00.000Z`),
                )
              : t('labs.recordDateMissing');
          return (
            <Pressable
              accessibilityLabel={`${t('labs.recordTitle')}: ${date}`}
              accessibilityRole="button"
              key={record.id}
              onPress={() => navigation.navigate('LabRecordDetail', { recordId: record.id })}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <AppSurface style={styles.recordCard}>
                <AppText variant="heading">{date}</AppText>
                <AppText style={styles.muted}>{specimenLabel(record.specimenType)}</AppText>
                <AppText style={styles.muted}>
                  {t('labs.recordMeasurements').replace(
                    '{count}',
                    String(record.measurements.length),
                  )}
                </AppText>
              </AppSurface>
            </Pressable>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  recordCard: { gap: spacing.xs, marginBottom: spacing.sm },
  muted: { color: colors.mutedInk },
  errorSurface: { gap: spacing.sm, marginBottom: spacing.md },
  pressed: { opacity: 0.78 },
});
