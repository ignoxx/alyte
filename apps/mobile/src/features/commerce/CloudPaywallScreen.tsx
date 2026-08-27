import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
} from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { CLOUD_PLAN_OFFERS, CLOUD_PRODUCT_IDS, type CloudProductId } from '@alyte/contracts';
import { t } from '../../localization';
import { useServices } from '../../services';
import type { RootStackParamList } from '../../navigation/types';
import { colors, radii, screenStyles, spacing } from '../../theme';
import { AppButton, AppIcon, AppSurface, AppText, ScreenScrollView } from '../../ui/primitives';

type Props = NativeStackScreenProps<RootStackParamList, 'CloudPaywall'>;

function errorCopy(code: string | null): string | null {
  if (code === null) return null;
  if (code === 'purchase_cancelled') return t('settings.cloudPurchaseCancelled');
  if (code === 'store_unavailable' || code === 'purchase_failed') {
    return t('settings.cloudStoreUnavailable');
  }
  if (code === 'offline' || code === 'api_unconfigured' || code === 'request_timeout') {
    return t('settings.cloudOffline');
  }
  if (code === 'session_required') return t('settings.cloudSignInToContinue');
  return t('settings.cloudStoreUnavailable');
}

function priceFor(
  productId: CloudProductId,
  offerings: readonly { productId: CloudProductId; priceString: string }[],
): string {
  return (
    offerings.find((item) => item.productId === productId)?.priceString ??
    (productId === CLOUD_PRODUCT_IDS.cloudPlusAnnual
      ? t('settings.cloudPlusAnnual')
      : productId === CLOUD_PRODUCT_IDS.cloudPlusMonthly
        ? t('settings.cloudPlusMonthly')
        : t('settings.cloudStarterPrice'))
  );
}

export function CloudPaywallScreen({ navigation }: Props) {
  const services = useServices();
  const account = services.account;
  const commerce = services.commerce;
  const [accountSnapshot, setAccountSnapshot] = useState(() => account.getSnapshot());
  const [commerceSnapshot, setCommerceSnapshot] = useState(() => commerce.getSnapshot());
  const [appleAvailable, setAppleAvailable] = useState<boolean | null>(null);
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  const [annual, setAnnual] = useState(true);
  const [purchased, setPurchased] = useState(false);

  useEffect(() => {
    const unsubscribeAccount = account.subscribe(() => setAccountSnapshot(account.getSnapshot()));
    const unsubscribeCommerce = commerce.subscribe(() =>
      setCommerceSnapshot(commerce.getSnapshot()),
    );
    void account.bootstrap();
    void account.isAppleSignInAvailable().then(setAppleAvailable);
    return () => {
      unsubscribeAccount();
      unsubscribeCommerce();
    };
  }, [account, commerce]);

  useEffect(() => {
    if (accountSnapshot.signedIn && commerceSnapshot.status === 'idle') void commerce.load();
  }, [accountSnapshot.signedIn, commerce, commerceSnapshot.status]);

  async function signIn() {
    if (!disclosureAccepted) return;
    try {
      await account.signInWithApple();
    } catch {
      // The account service publishes a bounded category for this screen.
    }
  }

  async function purchase(productId: CloudProductId) {
    try {
      await commerce.purchase(productId);
      setPurchased(true);
      navigation.goBack();
    } catch {
      // Commerce state is rendered below; native StoreKit details never reach the UI.
    }
  }

  async function restore() {
    try {
      await commerce.restore();
    } catch {
      // Commerce state is rendered below.
    }
  }

  const isBusy =
    commerceSnapshot.status === 'loading' ||
    commerceSnapshot.status === 'purchasing' ||
    commerceSnapshot.status === 'restoring' ||
    accountSnapshot.status === 'working' ||
    accountSnapshot.status === 'restoring';
  const selectedPlusProduct = annual
    ? CLOUD_PRODUCT_IDS.cloudPlusAnnual
    : CLOUD_PRODUCT_IDS.cloudPlusMonthly;
  const error = errorCopy(commerceSnapshot.lastErrorCode ?? accountSnapshot.lastErrorCode);

  return (
    <ScreenScrollView
      style={screenStyles.safe}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <AppText variant="display" style={styles.title}>
        {t('settings.cloudPaywallTitle')}
      </AppText>
      <AppText style={styles.intro}>{t('settings.cloudPaywallIntro')}</AppText>

      {!accountSnapshot.signedIn ? (
        <AppSurface style={styles.signInSurface}>
          <View style={styles.row}>
            <AppIcon name="cloud" color={colors.accent} size={22} />
            <AppText variant="heading" style={styles.flex}>
              {t('settings.cloudAccountDisclosureTitle')}
            </AppText>
          </View>
          <AppText style={styles.muted}>{t('settings.cloudSignInToContinue')}</AppText>
          <AppText style={styles.muted}>{t('settings.cloudLocalContinuity')}</AppText>
          {!disclosureAccepted ? (
            <AppButton
              label={t('settings.cloudAccountDisclosureContinue')}
              tone="secondary"
              onPress={() => setDisclosureAccepted(true)}
            />
          ) : appleAvailable === true ? (
            <AppleAuthenticationButton
              buttonType={AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={10}
              onPress={() => void signIn()}
              style={styles.appleButton}
            />
          ) : (
            <AppButton
              label={t('settings.cloudAccountSignIn')}
              onPress={() => void signIn()}
              disabled={appleAvailable === null || isBusy}
            />
          )}
        </AppSurface>
      ) : (
        <>
          <AppSurface tone="soft" style={styles.benefitSurface}>
            <AppText variant="heading">{t('settings.cloudPaywallBenefit')}</AppText>
            <AppText style={styles.muted}>{t('settings.cloudLocalContinuity')}</AppText>
          </AppSurface>

          <View style={styles.planGroup}>
            <View style={styles.planCard}>
              <View style={styles.planHeading}>
                <View style={styles.flex}>
                  <AppText variant="heading">{t('settings.cloudStarterName')}</AppText>
                  <AppText style={styles.muted}>{t('settings.cloudStarterDetail')}</AppText>
                </View>
                <AppText variant="label" style={styles.price}>
                  {priceFor(CLOUD_PRODUCT_IDS.starterPack, commerceSnapshot.offerings)}
                </AppText>
              </View>
              <AppButton
                label={t('settings.cloudChooseStarter')}
                onPress={() => void purchase(CLOUD_PRODUCT_IDS.starterPack)}
                disabled={isBusy || purchased}
              />
            </View>

            <View style={styles.planCard}>
              <View style={styles.planHeading}>
                <View style={styles.flex}>
                  <AppText variant="heading">{t('settings.cloudPlusName')}</AppText>
                  <AppText style={styles.muted}>{t('settings.cloudPlusDetail')}</AppText>
                </View>
                <AppText variant="label" style={styles.price}>
                  {priceFor(selectedPlusProduct, commerceSnapshot.offerings)}
                </AppText>
              </View>
              <View style={styles.toggleRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: !annual }}
                  onPress={() => setAnnual(false)}
                  style={[styles.choice, !annual && styles.choiceSelected]}
                >
                  <AppText variant="label" style={!annual ? styles.choiceTextSelected : undefined}>
                    {t('settings.cloudPlusMonthly')}
                  </AppText>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: annual }}
                  onPress={() => setAnnual(true)}
                  style={[styles.choice, annual && styles.choiceSelected]}
                >
                  <AppText variant="label" style={annual ? styles.choiceTextSelected : undefined}>
                    {t('settings.cloudPlusAnnual')}
                  </AppText>
                </Pressable>
              </View>
              <AppButton
                label={t('settings.cloudChoosePlus')}
                onPress={() => void purchase(selectedPlusProduct)}
                disabled={isBusy || purchased}
              />
            </View>
          </View>

          {commerceSnapshot.allowance !== null && (
            <AppSurface tone="soft" style={styles.allowanceSurface}>
              <AppText variant="label">{t('settings.cloudAllowanceSummary')}</AppText>
              {commerceSnapshot.allowance.allowances.map((allowance) => (
                <AppText key={allowance.kind} style={styles.muted}>
                  {allowance.kind === 'snap'
                    ? t('settings.cloudSnapRemaining').replace(
                        '{count}',
                        String(allowance.remaining),
                      )
                    : t('settings.cloudReportRemaining').replace(
                        '{count}',
                        String(allowance.remaining),
                      )}
                </AppText>
              ))}
            </AppSurface>
          )}

          <AppButton
            label={t('settings.cloudRestore')}
            tone="secondary"
            onPress={() => void restore()}
            disabled={isBusy}
          />
        </>
      )}

      {commerceSnapshot.status === 'pending' && (
        <AppSurface tone="soft" style={styles.status}>
          <AppText style={styles.muted}>{t('settings.cloudPurchasePending')}</AppText>
        </AppSurface>
      )}
      {error !== null && commerceSnapshot.status !== 'pending' && (
        <AppSurface tone="soft" style={styles.status}>
          <AppText style={styles.error}>{error}</AppText>
        </AppSurface>
      )}
      <AppText variant="caption" style={styles.footer}>
        {t('settings.cloudTerms')}
      </AppText>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.xxl },
  title: { marginBottom: spacing.sm },
  intro: { color: colors.mutedInk, marginBottom: spacing.lg },
  signInSurface: { gap: spacing.md, marginBottom: spacing.lg },
  benefitSurface: { gap: spacing.sm, marginBottom: spacing.lg },
  row: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  flex: { flex: 1 },
  muted: { color: colors.mutedInk },
  appleButton: { height: 50, width: '100%' },
  planGroup: { gap: spacing.md, marginBottom: spacing.lg },
  planCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  planHeading: { alignItems: 'flex-start', flexDirection: 'row', gap: spacing.md },
  price: { color: colors.accent, textAlign: 'right' },
  toggleRow: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    flexDirection: 'row',
    padding: 3,
  },
  choice: {
    alignItems: 'center',
    borderRadius: radii.sm,
    flex: 1,
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  choiceSelected: { backgroundColor: colors.accent },
  choiceTextSelected: { color: colors.onAccent },
  allowanceSurface: { gap: spacing.xs, marginBottom: spacing.lg },
  status: { gap: spacing.sm, marginTop: spacing.lg },
  error: { color: colors.danger },
  footer: { color: colors.mutedInk, marginTop: spacing.lg, textAlign: 'center' },
});
