import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { colors } from '../../theme';
import { AppText } from '../../ui/primitives';
import { LabRecordForm, type LabRecordFormHandle } from './LabRecordForm';
import type { LabRecord } from '@alyte/domain';

type Navigation = NativeStackNavigationProp<RootStackParamList>;
type FormRoute = RouteProp<RootStackParamList, 'LabRecordForm'>;

export function LabRecordFormRoute() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<FormRoute>();
  const { labs } = useServices();
  const recordId = route.params?.recordId;
  const formRef = useRef<LabRecordFormHandle>(null);
  const [record, setRecord] = useState<LabRecord | null | undefined>(
    recordId === undefined ? null : undefined,
  );
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const finish = useCallback(
    (id: string) => {
      if (recordId === undefined) {
        navigation.popTo('MainTabs', {
          screen: 'Labs',
          params: { screen: 'LabRecordDetail', params: { recordId: id } },
        });
      } else {
        navigation.goBack();
      }
    },
    [navigation, recordId],
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      headerBackVisible: false,
      headerLeft: () => (
        <HeaderAction
          disabled={saving}
          label={t('labs.recordCancel')}
          onPress={() => navigation.goBack()}
        />
      ),
      headerRight: () => (
        <HeaderAction
          disabled={saving}
          label={t('labs.recordSaveShort')}
          onPress={() => void formRef.current?.save()}
        />
      ),
      title: recordId === undefined ? t('labs.recordCreateTitle') : t('labs.recordEditTitle'),
    });
  }, [navigation, recordId, saving]);

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
      <StateView>
        <AppText selectable>{t('labs.recordLoadError')}</AppText>
      </StateView>
    );
  }
  if (recordId !== undefined && record === undefined) {
    return (
      <StateView>
        <AppText selectable>{t('labs.loading')}</AppText>
      </StateView>
    );
  }
  return (
    <LabRecordForm
      ref={formRef}
      initialRecord={record === undefined ? null : record}
      onSaved={finish}
      onSavingChange={setSaving}
      service={labs}
    />
  );
}

function HeaderAction({
  disabled = false,
  label,
  onPress,
}: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [
        styles.headerAction,
        disabled && styles.headerActionDisabled,
        pressed && !disabled && styles.headerActionPressed,
      ]}
    >
      <AppText style={styles.headerActionLabel}>{label}</AppText>
    </Pressable>
  );
}

function StateView({ children }: { readonly children: ReactNode }) {
  return <View style={styles.state}>{children}</View>;
}

const styles = StyleSheet.create({
  headerAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  headerActionDisabled: { opacity: 0.45 },
  headerActionLabel: { color: colors.accent },
  headerActionPressed: { opacity: 0.65 },
  state: { alignItems: 'center', flex: 1, justifyContent: 'center', padding: 24 },
});
