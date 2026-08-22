import { useEffect, useState } from 'react';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
import { LabRecordForm } from './LabRecordForm';
import type { LabRecord } from '@alyte/domain';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type FormRoute = RouteProp<LabsStackParamList, 'LabRecordForm'>;

export function LabRecordFormRoute() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<FormRoute>();
  const { labs } = useServices();
  const recordId = route.params?.recordId;
  const [record, setRecord] = useState<LabRecord | null | undefined>(
    recordId === undefined ? null : undefined,
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    if (recordId === undefined) return;
    let active = true;
    void labs
      .getRecord(recordId)
      .then((next) => {
        if (active) setRecord(next);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [labs, recordId]);

  if (recordId !== undefined && (error || record === null)) {
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
  if (recordId !== undefined && record === undefined) return <AppText>{t('labs.loading')}</AppText>;
  return (
    <LabRecordForm
      initialRecord={record === undefined ? null : record}
      onCancel={() => navigation.goBack()}
      onSaved={(id) => navigation.replace('LabRecordDetail', { recordId: id })}
      service={labs}
    />
  );
}
