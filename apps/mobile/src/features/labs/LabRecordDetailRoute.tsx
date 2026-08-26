import { useCallback, useRef, useState, type PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { screenStyles, spacing } from '../../theme';
import { AppButton, AppText, ScreenScrollView } from '../../ui/primitives';
import { LabRecordDetail } from './LabRecordDetail';
import type { LabRecordDetail as Detail } from '@alyte/domain';
import type { NavigationProp } from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type DetailRoute = RouteProp<LabsStackParamList, 'LabRecordDetail'>;

export function LabRecordDetailRoute() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DetailRoute>();
  const { labs } = useServices();
  const [record, setRecord] = useState<Detail | null>(null);
  const recordRef = useRef<Detail | null>(null);
  const root = navigation.getParent()?.getParent<NavigationProp<RootStackParamList>>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    if (recordRef.current === null) setLoading(true);
    try {
      const next = await labs.getRecordDetail(route.params.recordId);
      if (next === null) {
        if (recordRef.current !== null) navigation.goBack();
        else setNotFound(true);
        return;
      }
      recordRef.current = next;
      setRecord(next);
      setError(false);
      setNotFound(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [labs, navigation, route.params.recordId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (loading) {
    return (
      <DetailScrollView centered>
        <AppText selectable>{t('labs.loading')}</AppText>
      </DetailScrollView>
    );
  }
  if (notFound) {
    return (
      <DetailScrollView centered>
        <AppText selectable variant="heading">
          {t('labs.recordNotFound')}
        </AppText>
        <AppButton
          label={t('accessibility.back')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </DetailScrollView>
    );
  }
  if (error && record === null) {
    return (
      <DetailScrollView centered>
        <AppText selectable variant="heading">
          {t('labs.recordLoadError')}
        </AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
        <AppButton
          label={t('accessibility.back')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </DetailScrollView>
    );
  }
  if (record === null) {
    return (
      <DetailScrollView centered>
        <AppText selectable>{t('labs.loading')}</AppText>
      </DetailScrollView>
    );
  }
  return (
    <LabRecordDetail
      detail={record}
      onCorrect={(measurementId) =>
        root?.navigate('MeasurementCorrection', { recordId: record.id, measurementId })
      }
      onDelete={(measurementId) =>
        root?.navigate(
          'LabDeletion',
          measurementId === undefined
            ? { recordId: record.id }
            : { recordId: record.id, measurementId },
        )
      }
      onEditRecord={() => navigation.navigate('LabRecordForm', { recordId: record.id })}
      onViewHistory={(biomarkerId) => navigation.navigate('BiomarkerHistory', { biomarkerId })}
      onViewSource={(measurement) =>
        root?.navigate('RecordSourcePreview', {
          recordId: record.id,
          measurementId: measurement.id,
        })
      }
      onRetrySource={() =>
        void labs
          .retryPendingDeletion(record.id)
          .then(load)
          .catch(() => setError(true))
      }
    />
  );
}

function DetailScrollView({
  centered = false,
  children,
}: PropsWithChildren<{ readonly centered?: boolean }>) {
  return (
    <ScreenScrollView
      contentContainerStyle={[
        screenStyles.content,
        styles.detailContent,
        centered && styles.center,
      ]}
      style={screenStyles.scroll}
      tabBarClearance="native"
    >
      {children}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
  detailContent: { paddingBottom: spacing.xxl },
});
