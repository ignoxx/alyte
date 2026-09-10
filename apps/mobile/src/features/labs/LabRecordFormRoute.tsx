import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppButton, AppText, ScreenStatusView } from '../../ui/primitives';
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

  const load = useCallback(async () => {
    if (recordId === undefined) return;
    setError(false);
    setRecord(undefined);
    try {
      const next = await labs.getRecord(recordId);
      setRecord(next);
      if (next === null) setError(true);
    } catch {
      setError(true);
    }
  }, [labs, recordId]);

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
    void load();
  }, [load]);

  if (recordId !== undefined && (error || record === null)) {
    return (
      <ScreenStatusView contentContainerStyle={styles.state}>
        <AppText selectable variant="heading">
          {t('labs.recordLoadError')}
        </AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
        <AppButton
          label={t('labs.recordCancel')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </ScreenStatusView>
    );
  }
  if (recordId !== undefined && record === undefined) {
    return (
      <ScreenStatusView contentContainerStyle={styles.state}>
        <ActivityIndicator accessibilityLabel={t('labs.loading')} color={colors.accent as string} />
        <AppText selectable>{t('labs.loading')}</AppText>
      </ScreenStatusView>
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

const styles = StyleSheet.create({
  headerAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  headerActionDisabled: { opacity: 0.45 },
  headerActionLabel: { color: colors.accent },
  headerActionPressed: { opacity: 0.65 },
  state: { alignItems: 'center', gap: spacing.md, padding: spacing.lg },
});
