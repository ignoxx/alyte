import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useIsFocused } from '@react-navigation/native';
import { formatIntakeLocalDate, type IntakeEventType } from '@alyte/domain';
import type { MainTabParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import { captureFromCamera } from './camera-flow';
import type { IntakeCloudMode } from './outbox';

type SnapScreenProps = BottomTabScreenProps<MainTabParamList, 'SnapAction'>;

const CAPTURE_EVENT_TYPE: IntakeEventType = 'other';

export function SnapScreen({ navigation }: SnapScreenProps) {
  const { intake, clock } = useServices();
  const isFocused = useIsFocused();
  const openedCamera = useRef(false);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [cloudMode, setCloudMode] = useState<IntakeCloudMode>('local-only');
  const [disclosureAcknowledged, setDisclosureAcknowledged] = useState(false);

  const loadPreferences = useCallback(async () => {
    try {
      const preferences = await intake.getCapturePreferences();
      setCloudMode(preferences.cloudMode);
      setDisclosureAcknowledged(preferences.disclosureAcknowledged);
    } catch {
      setCloudMode('local-only');
    }
  }, [intake]);

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const saveAsset = useCallback(
    async (asset: ImagePicker.ImagePickerAsset) => {
      setError(false);
      setBusy(true);
      try {
        const captureId = `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const capturedAt = clock.now();
        await intake.captureSnap({
          captureId,
          source: {
            uri: asset.uri,
            filename: asset.fileName,
            mimeType: asset.mimeType,
            byteSize: asset.fileSize,
          },
          cloudMode,
          event: {
            id: captureId,
            eventType: CAPTURE_EVENT_TYPE,
            occurredAt: capturedAt.toISOString(),
            localDate: formatIntakeLocalDate(capturedAt),
            origin: 'snap',
            provenance: 'user-entered',
            reviewState: 'needs-review',
            components: [
              {
                name: 'Captured intake',
                amount: { kind: 'unknown', reason: 'not-confirmed' },
                reviewState: 'needs-review',
              },
            ],
          },
        });
        navigation.navigate('Home');
      } catch {
        setError(true);
      } finally {
        setBusy(false);
      }
    },
    [clock, cloudMode, intake, navigation],
  );

  const openCamera = useCallback(async () => {
    if (busy) return;
    try {
      setError(false);
      const result = await captureFromCamera(
        () => ImagePicker.requestCameraPermissionsAsync(),
        () =>
          ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            allowsEditing: false,
            exif: false,
            quality: 1,
          }),
      );
      if (result.kind === 'permission-denied') {
        setCameraDenied(true);
        return;
      }
      if (result.kind === 'cancelled') return;
      setCameraDenied(false);
      await saveAsset(result.asset);
    } catch {
      setError(true);
    }
  }, [busy, saveAsset]);

  useEffect(() => {
    if (!isFocused) {
      openedCamera.current = false;
      return;
    }
    if (openedCamera.current) return;
    openedCamera.current = true;
    void openCamera();
  }, [isFocused, openCamera]);

  async function choosePhoto() {
    if (busy) return;
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) return;
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        allowsMultipleSelection: false,
        exif: false,
        quality: 1,
      });
      const asset = result.canceled ? undefined : result.assets[0];
      if (asset !== undefined) await saveAsset(asset);
    } catch {
      setError(true);
    }
  }

  function selectCloudMode(next: IntakeCloudMode) {
    if (next === 'local-only') {
      setCloudMode(next);
      void intake.setCapturePreferences({ cloudMode: next });
      return;
    }
    if (disclosureAcknowledged) {
      setCloudMode(next);
      void intake.setCapturePreferences({ cloudMode: next });
      return;
    }
    Alert.alert(t('snap.cloudDisclosureTitle'), t('snap.cloudDisclosureBody'), [
      { text: t('snap.cloudDisclosureCancel'), style: 'cancel' },
      {
        text: t('snap.cloudDisclosureAccept'),
        onPress: () => {
          setDisclosureAcknowledged(true);
          setCloudMode(next);
          void intake.setCapturePreferences({ cloudMode: next, disclosureAcknowledged: true });
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={[screenStyles.safe, screenStyles.content, styles.container]}>
      <AppText variant="title">{t('snap.title')}</AppText>
      <AppText style={styles.body}>{t('snap.body')}</AppText>
      {busy && <AppText style={styles.muted}>{t('snap.saving')}</AppText>}
      {error && <AppText style={styles.error}>{t('snap.captureFailed')}</AppText>}
      {cameraDenied && (
        <AppSurface tone="soft" style={styles.permissionCard}>
          <AppText variant="heading">{t('snap.cameraPermissionDeniedTitle')}</AppText>
          <AppText style={styles.muted}>{t('snap.cameraPermissionDeniedBody')}</AppText>
        </AppSurface>
      )}
      <AppSurface style={styles.modeCard}>
        <AppText variant="label">
          {cloudMode === 'local-only' ? t('snap.localMode') : t('snap.cloudEnabled')}
        </AppText>
        <AppText style={styles.muted}>
          {cloudMode === 'local-only' ? t('snap.localModeBody') : t('snap.cloudModeBody')}
        </AppText>
        <View style={styles.modeActions}>
          <AppButton
            label={t('snap.localMode')}
            tone={cloudMode === 'local-only' ? 'primary' : 'secondary'}
            onPress={() => selectCloudMode('local-only')}
          />
          <AppButton
            label={t('snap.cloudMode')}
            tone={cloudMode === 'consented-cloud' ? 'primary' : 'secondary'}
            onPress={() => selectCloudMode('consented-cloud')}
          />
        </View>
      </AppSurface>
      <View style={styles.actions}>
        {cameraDenied && (
          <AppButton
            disabled={busy}
            label={t('snap.retryCamera')}
            onPress={() => void openCamera()}
          />
        )}
        <AppButton
          disabled={busy}
          label={t('snap.choosePhoto')}
          tone="secondary"
          onPress={() => void choosePhoto()}
        />
        <AppButton
          disabled={busy}
          label={t('snap.manual')}
          tone="secondary"
          onPress={() => navigation.navigate('Log')}
        />
        <AppButton
          disabled={busy}
          label={t('snap.reference')}
          tone="quiet"
          onPress={() => Alert.alert(t('snap.referenceTitle'), t('snap.referenceBody'))}
        />
        {!cameraDenied && !busy && (
          <AppText style={styles.muted}>{t('snap.openingCamera')}</AppText>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.lg },
  body: { color: colors.mutedInk },
  muted: { color: colors.mutedInk },
  error: { color: colors.danger },
  permissionCard: { gap: spacing.sm },
  modeCard: { gap: spacing.sm },
  modeActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  actions: { gap: spacing.sm },
});
