import { useCallback, useEffect, useState } from 'react';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
import { LabRecordDetail } from './LabRecordDetail';
import type { LabRecord } from '@alyte/domain';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type DetailRoute = RouteProp<LabsStackParamList, 'LabRecordDetail'>;

export function LabRecordDetailRoute() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<DetailRoute>();
  const { labs } = useServices();
  const [record, setRecord] = useState<LabRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRecord(await labs.getRecord(route.params.recordId));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [labs, route.params.recordId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <AppText>{t('labs.loading')}</AppText>;
  if (error || record === null) {
    return (
      <>
        <AppText>{t('labs.recordLoadError')}</AppText>
        <AppButton
          label={t('labs.recordCancel')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </>
    );
  }
  return (
    <LabRecordDetail
      onChanged={setRecord}
      onDeleted={() => navigation.goBack()}
      onEditRecord={() => navigation.navigate('LabRecordForm', { recordId: record.id })}
      record={record}
      service={labs}
    />
  );
}
