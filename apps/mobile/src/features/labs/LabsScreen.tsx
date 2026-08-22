import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { LabRecord } from '@alyte/domain';
import type { MainTabParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, EmptyState, AppText } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { LabRecordDetail } from './LabRecordDetail';
import { LabRecordForm } from './LabRecordForm';

type LabsScreenProps = BottomTabScreenProps<MainTabParamList, 'Labs'>;

export function LabsScreen(_props: LabsScreenProps) {
  const { labs } = useServices();
  const [records, setRecords] = useState<readonly LabRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<LabRecord | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRecords(await labs.listRecords());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('labs.errorBody'));
    } finally {
      setLoading(false);
    }
  }, [labs]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  async function openRecord(id: string) {
    setError(null);
    try {
      const record = await labs.getRecord(id);
      if (record === null) {
        setError(t('labs.recordNotFound'));
        return;
      }
      setSelectedRecord(record);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('labs.recordOpenError'));
    }
  }

  if (showForm) {
    return (
      <SafeAreaView style={screenStyles.safe}>
        <LabRecordForm
          service={labs}
          onCancel={() => setShowForm(false)}
          onSaved={(id) => {
            setShowForm(false);
            void openRecord(id);
            void loadRecords();
          }}
        />
      </SafeAreaView>
    );
  }

  if (selectedRecord !== null) {
    return (
      <SafeAreaView style={screenStyles.safe}>
        <LabRecordDetail
          onBack={() => setSelectedRecord(null)}
          onChanged={setSelectedRecord}
          onDeleted={() => {
            setSelectedRecord(null);
            void loadRecords();
          }}
          record={selectedRecord}
          service={labs}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={screenStyles.safe}>
      <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        <View style={styles.titleRow}>
          <AppText variant="title">{t('labs.title')}</AppText>
          <AppButton label={t('labs.manualAction')} onPress={() => setShowForm(true)} />
        </View>
        {loading && <AppText style={styles.muted}>{t('labs.loading')}</AppText>}
        {error !== null && (
          <AppSurface tone="soft" style={styles.errorSurface}>
            <AppText variant="heading">{t('labs.errorTitle')}</AppText>
            <AppText style={styles.muted}>{t('labs.errorBody')}</AppText>
            <AppText style={styles.errorDetail}>{error}</AppText>
            <AppButton
              label={t('labs.retry')}
              onPress={() => void loadRecords()}
              tone="secondary"
            />
          </AppSurface>
        )}
        {!loading && error === null && records.length === 0 && (
          <EmptyState
            title={t('labs.emptyTitle')}
            body={t('labs.emptyBody')}
            action={
              <View style={styles.actions}>
                <AppButton label={t('labs.manualAction')} onPress={() => setShowForm(true)} />
                <AppButton label={t('labs.action')} onPress={() => undefined} tone="secondary" />
              </View>
            }
          />
        )}
        {records.map((record) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t('labs.recordTitle')}: ${record.collectionDate.kind === 'known' ? record.collectionDate.value : t('labs.recordDateMissing')}`}
            key={record.id}
            onPress={() => void openRecord(record.id)}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <AppSurface style={styles.recordCard}>
              <AppText variant="heading">
                {record.collectionDate.kind === 'known'
                  ? record.collectionDate.value
                  : t('labs.recordDateMissing')}
              </AppText>
              <AppText style={styles.muted}>{record.specimenType}</AppText>
              <AppText style={styles.muted}>
                {t('labs.recordMeasurements').replace(
                  '{count}',
                  String(record.measurements.length),
                )}
              </AppText>
            </AppSurface>
          </Pressable>
        ))}
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
  actions: { gap: spacing.sm, marginTop: spacing.sm },
  recordCard: { gap: spacing.xs, marginBottom: spacing.sm },
  muted: { color: colors.mutedInk },
  errorSurface: { gap: spacing.sm, marginBottom: spacing.md },
  errorDetail: { color: colors.danger },
  pressed: { opacity: 0.78 },
});
