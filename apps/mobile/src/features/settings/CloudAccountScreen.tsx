import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CONTRACT_VERSION } from '@alyte/contracts';
import { t } from '../../localization';
import { useServices } from '../../services';
import { AppButton, AppIcon, AppSurface, AppText, ScreenScrollView } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';

function errorCopy(code: string | null): string | null {
  switch (code) {
    case 'identity_cancelled':
      return t('settings.cloudAccountCancelled');
    case 'apple_unavailable':
      return t('settings.cloudAccountAppleUnavailable');
    case 'offline':
    case 'api_unconfigured':
      return t('settings.cloudAccountOffline');
    case 'refresh_token_expired':
    case 'refresh_token_invalid':
    case 'refresh_token_reused':
    case 'session_invalid':
      return t('settings.cloudAccountRefreshFailed');
    default:
      return code === null ? null : t('settings.cloudAccountUnavailable');
  }
}

function SettingsActionRow({
  icon,
  title,
  subtitle,
  onPress,
  disabled = false,
  destructive = false,
}: {
  readonly icon: 'cloud' | 'doc' | 'lockShield' | 'trash';
  readonly title: string;
  readonly subtitle: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.actionRow, pressed && !disabled && styles.rowPressed]}
    >
      <AppIcon name={icon} size={21} color={destructive ? colors.danger : colors.accent} />
      <View style={styles.actionCopy}>
        <AppText variant="heading" style={[styles.actionTitle, destructive && styles.destructive]}>
          {title}
        </AppText>
        <AppText variant="caption" style={styles.subtitle}>
          {subtitle}
        </AppText>
      </View>
      <AppIcon name="chevronRight" size={16} color={colors.mutedInk} />
    </Pressable>
  );
}

function exportSummary(
  result: {
    readonly consents: readonly unknown[];
    readonly sessions: readonly unknown[];
    readonly operations: readonly unknown[];
  } | null,
) {
  if (result === null) return null;
  return t('settings.cloudAccountExportSummary')
    .replace('{consents}', result.consents.length.toLocaleString())
    .replace('{sessions}', result.sessions.length.toLocaleString())
    .replace('{operations}', result.operations.length.toLocaleString());
}

export function CloudAccountScreen() {
  const services = useServices();
  const navigation = useNavigation<any>();
  const account = services.account;
  const [snapshot, setSnapshot] = useState(() => account.getSnapshot());
  const [exportResult, setExportResult] = useState<Awaited<
    ReturnType<typeof account.exportAccount>
  > | null>(null);
  const [deletionKey, setDeletionKey] = useState<string | null>(null);
  const [deletionAttempted, setDeletionAttempted] = useState(false);
  const [deletionComplete, setDeletionComplete] = useState(false);
  const isWorking = snapshot.status === 'working';
  const deletionWorking = isWorking && deletionKey !== null;

  useEffect(() => {
    const unsubscribe = account.subscribe(() => setSnapshot(account.getSnapshot()));
    void account.bootstrap();
    return unsubscribe;
  }, [account]);

  usePreventRemove(deletionWorking, ({ data }) => {
    Alert.alert(t('settings.cloudAccountDeleting'), t('settings.cloudAccountDeleteBody'), [
      { text: t('settings.cloudAccountDeleteCancel'), style: 'cancel' },
    ]);
    void data;
  });

  const error = errorCopy(snapshot.lastErrorCode);

  async function signIn() {
    setExportResult(null);
    try {
      await account.signInWithApple();
    } catch {
      // The service publishes a safe, user-facing error category. Raw provider/server details do
      // not cross this screen boundary.
    }
  }

  async function exportAccount() {
    setExportResult(null);
    try {
      setExportResult(await account.exportAccount());
    } catch {
      // Snapshot error state keeps the account and local mode observable.
    }
  }

  async function signOut() {
    setExportResult(null);
    try {
      await account.signOut();
    } catch {
      // Sign-out clears the device session even when the best-effort server revoke is offline.
    }
  }

  function confirmDelete() {
    if (isWorking || !snapshot.signedIn) return;
    const nextKey = deletionKey ?? `delete-${Date.now().toString(36)}`;
    setDeletionKey(nextKey);
    Alert.alert(t('settings.cloudAccountDeleteTitle'), t('settings.cloudAccountDeleteBody'), [
      { text: t('settings.cloudAccountDeleteCancel'), style: 'cancel' },
      {
        text: t('settings.cloudAccountDeleteConfirm'),
        style: 'destructive',
        onPress: () => void deleteAccount(nextKey),
      },
    ]);
  }

  async function deleteAccount(key: string) {
    setDeletionAttempted(true);
    try {
      await account.deleteAccount(key);
      setDeletionComplete(true);
      setDeletionKey(null);
    } catch {
      // Keep the same idempotency key so a retry can replay a confirmed server deletion.
    }
  }

  const restoredOffline = snapshot.status === 'offline' && snapshot.signedIn;

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={screenStyles.safe}>
      <ScreenScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
        {!snapshot.signedIn && !deletionComplete && (
          <>
            <AppText style={styles.intro}>{t('settings.cloudAccountDisclosureBody')}</AppText>
            <AppSurface style={styles.disclosure}>
              <View style={styles.disclosureHeading}>
                <AppIcon name="cloud" size={22} color={colors.accent} />
                <AppText variant="heading">{t('settings.cloudAccountDisclosureTitle')}</AppText>
              </View>
              <AppText style={styles.body}>{t('settings.cloudAccountProcessor')}</AppText>
              <AppText variant="caption" style={styles.policy}>
                {t('settings.cloudAccountPolicy').replace('{version}', CONTRACT_VERSION)}
              </AppText>
              <AppButton
                label={t('settings.cloudAccountSignIn')}
                onPress={() => void signIn()}
                disabled={isWorking || snapshot.status === 'restoring'}
              />
            </AppSurface>
          </>
        )}

        {snapshot.status === 'restoring' && (
          <AppSurface tone="soft" style={styles.statusSurface}>
            <AppText variant="label">{t('settings.cloudAccountRestoring')}</AppText>
          </AppSurface>
        )}

        {error !== null && !deletionComplete && (
          <AppSurface tone="soft" style={styles.statusSurface}>
            <AppText style={styles.body}>{error}</AppText>
          </AppSurface>
        )}

        {snapshot.signedIn && !deletionComplete && (
          <>
            <AppSurface tone="soft" style={styles.signedInSurface}>
              <View style={styles.disclosureHeading}>
                <AppIcon name="checkmarkCircle" size={22} color={colors.accent} />
                <AppText variant="heading">{t('settings.cloudAccountSignedIn')}</AppText>
              </View>
              {restoredOffline && (
                <AppText style={styles.body}>{t('settings.cloudAccountOffline')}</AppText>
              )}
            </AppSurface>
            <View style={styles.group}>
              <SettingsActionRow
                icon="doc"
                title={
                  isWorking ? t('settings.cloudAccountExporting') : t('settings.cloudAccountExport')
                }
                subtitle={t('settings.cloudAccountExportSubtitle')}
                onPress={() => void exportAccount()}
                disabled={isWorking || restoredOffline}
              />
              <SettingsActionRow
                icon="lockShield"
                title={t('settings.cloudAccountSignOut')}
                subtitle={t('settings.cloudAccountSignOutSubtitle')}
                onPress={() => void signOut()}
                disabled={isWorking}
              />
              <SettingsActionRow
                icon="trash"
                title={t('settings.cloudAccountDelete')}
                subtitle={t('settings.cloudAccountDeleteSubtitle')}
                onPress={confirmDelete}
                disabled={isWorking || restoredOffline}
                destructive
              />
            </View>
          </>
        )}

        {exportResult !== null && (
          <AppSurface tone="soft" style={styles.statusSurface}>
            <AppText variant="label">{t('settings.cloudAccountExportReady')}</AppText>
            <AppText style={styles.body}>{t('settings.cloudAccountExportReadyBody')}</AppText>
            <AppText variant="caption" style={styles.policy}>
              {exportSummary(exportResult)}
            </AppText>
          </AppSurface>
        )}

        {deletionComplete && (
          <AppSurface tone="soft" style={styles.statusSurface}>
            <AppText variant="heading">{t('settings.cloudAccountDeleted')}</AppText>
            <AppText style={styles.body}>{t('settings.cloudAccountDeletedBody')}</AppText>
            <AppButton label={t('done')} tone="secondary" onPress={() => navigation.goBack()} />
          </AppSurface>
        )}

        {deletionAttempted &&
          snapshot.lastErrorCode !== null &&
          snapshot.signedIn &&
          !deletionComplete && (
            <AppText style={styles.failure}>{t('settings.cloudAccountDeleteFailed')}</AppText>
          )}
      </ScreenScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.mutedInk, lineHeight: 22, marginBottom: spacing.lg },
  body: { color: colors.mutedInk, lineHeight: 22 },
  disclosure: { gap: spacing.md, marginBottom: spacing.lg },
  disclosureHeading: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  policy: { color: colors.mutedInk },
  statusSurface: { gap: spacing.sm, marginBottom: spacing.lg },
  signedInSurface: { gap: spacing.sm, marginBottom: spacing.lg },
  group: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: spacing.lg,
    overflow: 'hidden',
  },
  actionRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 70,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  actionCopy: { flex: 1, gap: spacing.xs },
  actionTitle: { fontSize: 16, lineHeight: 21 },
  subtitle: { color: colors.mutedInk },
  rowPressed: { backgroundColor: colors.accentSoft },
  destructive: { color: colors.danger },
  failure: { color: colors.danger, lineHeight: 22 },
});
