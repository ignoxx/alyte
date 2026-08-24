import { useCallback, useRef, useState } from 'react';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
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

  if (loading) return <AppText>{t('labs.loading')}</AppText>;
  if (notFound) {
    return (
      <>
        <AppText>{t('labs.recordNotFound')}</AppText>
        <AppButton
          label={t('accessibility.back')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </>
    );
  }
  if (error && record === null) {
    return (
      <>
        <AppText>{t('labs.recordLoadError')}</AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
        <AppButton
          label={t('labs.recordCancel')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </>
    );
  }
  if (record === null) return <AppText>{t('labs.loading')}</AppText>;
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
