import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
import { AppButton, AppIcon, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import {
  canCompleteModelOnboarding,
  hasResumableModelDownload,
  isModelDownloadActive,
  type LocalModelSnapshot,
} from '../local-models/model';
import { ModelDetailsDisclosure } from '../local-models/ModelDetailsDisclosure';
import { ModelProgress } from '../local-models/ModelProgress';
import {
  isExpectedDownloadCancellation,
  modelFailureFromError,
  modelSetupFailureMessageKey,
  modelSetupFailureVisible,
  modelSetupPrimaryAction,
  modelStatusTone,
  formatModelApproximateSize,
} from '../local-models/model-ui';
import type { LocalModelService } from '../local-models/native';
import {
  ONBOARDING_MODEL_PAGE,
  ONBOARDING_PAGE_COUNT,
  ONBOARDING_READY_PAGE,
  onboardingCanContinue,
  onboardingCanNavigateTo,
  onboardingPagerLocked,
  onboardingResumePage,
} from './onboarding-state';

type OnboardingScreenProps = {
  readonly model: LocalModelService;
  readonly onComplete: () => Promise<void>;
};

function IntroPage({
  icon,
  title,
  body,
  children,
}: {
  readonly icon: 'library' | 'lockShield' | 'chart' | 'checkmarkCircle';
  readonly title: string;
  readonly body: string;
  readonly children?: ReactNode;
}) {
  return (
    <View style={styles.pageBody}>
      <View accessibilityElementsHidden style={styles.iconWell}>
        <AppIcon name={icon} size={34} color={colors.accent} />
      </View>
      <View style={styles.pageCopy}>
        <AppText variant="title" style={styles.pageTitle} selectable>
          {title}
        </AppText>
        <AppText style={styles.pageBodyText} selectable>
          {body}
        </AppText>
      </View>
      {children}
    </View>
  );
}

function ModelFact({
  icon,
  children,
}: {
  readonly icon: 'phone' | 'cloud' | 'folder';
  readonly children: string;
}) {
  return (
    <View style={styles.fact}>
      <AppIcon name={icon} size={18} color={colors.accent} />
      <AppText variant="caption" style={styles.factLabel} selectable>
        {children}
      </AppText>
    </View>
  );
}

function ModelPreparationPage({
  model,
  snapshot,
  modelFailure,
  cancelled,
  cancelError,
}: {
  readonly model: LocalModelService;
  readonly snapshot: LocalModelSnapshot | null;
  readonly modelFailure: LocalModelSnapshot['failure'];
  readonly cancelled: boolean;
  readonly cancelError: boolean;
}) {
  const ready = snapshot !== null && canCompleteModelOnboarding(snapshot);
  const resumable = hasResumableModelDownload(snapshot);
  const active = snapshot !== null && isModelDownloadActive(snapshot);
  const failed = snapshot?.state === 'failed';
  const failure = failed ? (snapshot?.failure ?? null) : modelFailure;
  const showCancelError = cancelError && !resumable;
  const showFailure = modelSetupFailureVisible(snapshot, modelFailure);
  const locale = Intl.NumberFormat().resolvedOptions().locale;
  const downloadSize = formatModelApproximateSize(model.manifest.pack.artifact.bytes, locale);
  const freeSpace = formatModelApproximateSize(
    model.manifest.requirements.minimumFreeBytes,
    locale,
  );

  return (
    <View style={styles.pageBody}>
      <StatusPill tone={modelStatusTone(snapshot)}>
        {ready ? t('onboarding.modelReady') : t('onboarding.modelPrepareEyebrow')}
      </StatusPill>
      <View style={styles.pageCopy}>
        <AppText variant="title" style={styles.pageTitle} selectable>
          {t('onboarding.modelPrepareTitle')}
        </AppText>
        <AppText style={styles.pageBodyText} selectable>
          {t('onboarding.modelPrepareBody')}
        </AppText>
      </View>

      <AppSurface style={styles.modelSummary}>
        <View accessibilityRole="summary" style={styles.packHeader}>
          <View style={styles.modelIconWell} accessibilityElementsHidden>
            <AppIcon name="folder" size={26} color={colors.accent} />
          </View>
          <View style={styles.packCopy}>
            <AppText variant="heading" selectable>
              {t('onboarding.privateCapabilityName')}
            </AppText>
            <AppText variant="caption" style={styles.muted} selectable>
              {t('onboarding.privateCapabilityRequired')}
            </AppText>
          </View>
        </View>

        <View accessibilityRole="summary" style={styles.facts}>
          <ModelFact icon="phone">
            {t('onboarding.modelDownloadSizeFact').replace('{size}', downloadSize)}
          </ModelFact>
          <ModelFact icon="phone">
            {t('onboarding.modelFreeSpaceFact').replace('{size}', freeSpace)}
          </ModelFact>
          <ModelFact icon="phone">{t('onboarding.modelRunsLocallyFact')}</ModelFact>
          <ModelFact icon="cloud">{t('onboarding.modelNoUploadFact')}</ModelFact>
          <ModelFact icon="folder">{t('onboarding.privateCapabilityDeletionFact')}</ModelFact>
        </View>
      </AppSurface>

      {snapshot === null && modelFailure === null ? (
        <View accessibilityRole="progressbar" style={styles.checking}>
          <ActivityIndicator color={colors.accent as string} />
          <AppText style={styles.muted} selectable>
            {t('onboarding.modelChecking')}
          </AppText>
        </View>
      ) : null}

      {resumable && snapshot !== null ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText variant="heading" selectable>
            {t('onboarding.modelSetupPartialSaved').replace(
              '{progress}',
              String(Math.round(snapshot.progress * 100)),
            )}
          </AppText>
        </AppSurface>
      ) : null}

      {showFailure && !showCancelError ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText variant="heading" style={styles.error} selectable>
            {t(modelSetupFailureMessageKey(failure))}
          </AppText>
        </AppSurface>
      ) : null}

      {showCancelError ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText variant="heading" style={styles.error} selectable>
            {t('onboarding.modelCancelFailure')}
          </AppText>
        </AppSurface>
      ) : null}

      {cancelled && !resumable && !showFailure ? (
        <AppText style={styles.muted} selectable>
          {t('onboarding.modelSetupCancelDisclosure')}
        </AppText>
      ) : null}

      {active || resumable ? <ModelProgress snapshot={snapshot!} /> : null}
      {active && snapshot?.state !== 'cancelling' ? (
        <AppText style={styles.muted} selectable>
          {t('onboarding.modelKeepOpen')}
        </AppText>
      ) : null}

      <ModelDetailsDisclosure manifest={model.manifest} />
    </View>
  );
}

function ReadyPage({ completionFailed }: { readonly completionFailed: boolean }) {
  return (
    <IntroPage
      icon="checkmarkCircle"
      title={t('onboarding.readyTitle')}
      body={t('onboarding.readyBody')}
    >
      <AppSurface tone="soft" style={styles.callout}>
        <AppText style={styles.readyCopy} selectable>
          {t('onboarding.modelReadyBody')}
        </AppText>
      </AppSurface>
      {completionFailed ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText selectable>{t('onboarding.completionFailure')}</AppText>
        </AppSurface>
      ) : null}
    </IntroPage>
  );
}

export function OnboardingScreen({ model, onComplete }: OnboardingScreenProps) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pagerRef = useRef<ScrollView>(null);
  const hasInteractedRef = useRef(false);
  const shouldSyncPagerRef = useRef(false);
  const cancellationRequestedRef = useRef(false);
  const previousReadyRef = useRef(false);
  const [page, setPage] = useState(0);
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null);
  const [modelFailure, setModelFailure] = useState<LocalModelSnapshot['failure']>(null);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [cancelError, setCancelError] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [completionFailed, setCompletionFailed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const pagerLocked = onboardingPagerLocked(snapshot);
  const ready = snapshot !== null && canCompleteModelOnboarding(snapshot);
  const resumable = hasResumableModelDownload(snapshot);
  const modelAction = modelSetupPrimaryAction(snapshot, modelFailure);

  useEffect(() => {
    let active = true;
    const unsubscribe = model.subscribe((next) => {
      if (active) setSnapshot(next);
    });
    void model
      .getState()
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setModelFailure(null);
        if (!hasInteractedRef.current) {
          const resumePage = onboardingResumePage(next);
          if (resumePage > 0) {
            shouldSyncPagerRef.current = true;
            setPage(resumePage);
          }
        }
      })
      .catch(() => {
        if (active) setModelFailure('unavailable');
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [model]);

  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (active) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!shouldSyncPagerRef.current) return;
    pagerRef.current?.scrollTo({ x: width * page, animated: false });
    shouldSyncPagerRef.current = false;
  }, [page, width]);

  useEffect(() => {
    const becameReady = ready && !previousReadyRef.current;
    previousReadyRef.current = ready;
    if (
      page !== ONBOARDING_MODEL_PAGE ||
      !becameReady ||
      !onboardingCanNavigateTo(page, ONBOARDING_READY_PAGE, snapshot)
    ) {
      return;
    }
    hasInteractedRef.current = true;
    shouldSyncPagerRef.current = true;
    setPage(ONBOARDING_READY_PAGE);
  }, [page, ready, snapshot]);

  function moveToPage(nextPage: number, animated = !reduceMotion) {
    if (pagerLocked || nextPage < 0 || nextPage >= ONBOARDING_PAGE_COUNT) return;
    if (!onboardingCanNavigateTo(page, nextPage, snapshot)) {
      pagerRef.current?.scrollTo({ x: width * page, animated: false });
      return;
    }
    hasInteractedRef.current = true;
    setPage(nextPage);
    pagerRef.current?.scrollTo({ x: width * nextPage, animated });
  }

  function handlePageEnd(event: NativeSyntheticEvent<NativeScrollEvent>) {
    if (pagerLocked) return;
    const nextPage = Math.max(
      0,
      Math.min(ONBOARDING_PAGE_COUNT - 1, Math.round(event.nativeEvent.contentOffset.x / width)),
    );
    moveToPage(nextPage, false);
  }

  async function startDownload() {
    cancellationRequestedRef.current = false;
    setCancelled(false);
    setCancelError(false);
    setModelFailure(null);
    setBusy(true);
    try {
      await model.startDownload();
    } catch (error) {
      if (isExpectedDownloadCancellation(error, cancellationRequestedRef.current)) {
        setCancelled(true);
      } else {
        setModelFailure(modelFailureFromError(error));
      }
    } finally {
      cancellationRequestedRef.current = false;
      setBusy(false);
    }
  }

  async function cancelDownload() {
    cancellationRequestedRef.current = true;
    setCancelError(false);
    setCancelBusy(true);
    try {
      await model.cancelDownload();
      setCancelled(true);
      setModelFailure(null);
    } catch {
      cancellationRequestedRef.current = false;
      setCancelled(false);
      setCancelError(true);
    } finally {
      setCancelBusy(false);
    }
  }

  function continueLabel(): string {
    if (page === ONBOARDING_MODEL_PAGE) {
      if (ready) return t('onboarding.next');
      if (pagerLocked || busy) return t('onboarding.modelPreparing');
      if (resumable) return t('onboarding.modelContinueDownload');
      if (modelAction === 'retry') return t('onboarding.modelRetry');
      if (modelAction === 'checking') return t('onboarding.modelChecking');
      return t('onboarding.modelDownload');
    }
    return page === ONBOARDING_READY_PAGE ? t('onboarding.continue') : t('onboarding.next');
  }

  function continueDisabled(): boolean {
    if (finishing || cancelBusy) return true;
    if (page === ONBOARDING_MODEL_PAGE) {
      if (pagerLocked || busy) return true;
      return modelAction === 'checking' || modelAction === 'none';
    }
    return !onboardingCanContinue(page, snapshot);
  }

  async function handleContinue() {
    if (continueDisabled()) return;
    if (page === ONBOARDING_MODEL_PAGE) {
      if (ready) {
        moveToPage(ONBOARDING_READY_PAGE);
      } else if (
        modelAction === 'download' ||
        modelAction === 'continue' ||
        modelAction === 'retry'
      ) {
        await startDownload();
      }
      return;
    }
    if (!onboardingCanContinue(page, snapshot)) return;
    if (page < ONBOARDING_MODEL_PAGE) {
      moveToPage(page + 1);
      return;
    }
    setFinishing(true);
    setCompletionFailed(false);
    try {
      await onComplete();
    } catch {
      setCompletionFailed(true);
      setFinishing(false);
    }
  }

  const pages = [
    <IntroPage
      key="welcome"
      icon="library"
      title={t('onboarding.title')}
      body={t('onboarding.body')}
    />,
    <IntroPage
      key="history"
      icon="chart"
      title={t('onboarding.historyTitle')}
      body={t('onboarding.historyBody')}
    />,
    <IntroPage
      key="privacy"
      icon="lockShield"
      title={t('onboarding.privacyTitle')}
      body={t('onboarding.privacyBody')}
    />,
    <ModelPreparationPage
      key="model"
      model={model}
      snapshot={snapshot}
      modelFailure={modelFailure}
      cancelled={cancelled}
      cancelError={cancelError}
    />,
    <ReadyPage key="ready" completionFailed={completionFailed} />,
  ];

  return (
    <View style={screenStyles.safe}>
      <View
        style={[
          styles.topBar,
          {
            height: TOP_BAR_CONTENT_HEIGHT + insets.top,
            paddingTop: insets.top,
          },
        ]}
      >
        <View style={styles.topBarControlSlot}>
          {page > 0 ? (
            <Pressable
              accessibilityLabel={t('onboarding.back')}
              accessibilityRole="button"
              accessibilityState={{ disabled: pagerLocked }}
              disabled={pagerLocked}
              hitSlop={8}
              onPress={() => moveToPage(page - 1)}
              style={({ pressed }) => [
                styles.backButton,
                pagerLocked && styles.backButtonDisabled,
                pressed && styles.pressed,
              ]}
            >
              <AppIcon
                name="chevronLeft"
                size={18}
                color={pagerLocked ? colors.disabledInk : colors.accent}
              />
            </Pressable>
          ) : (
            <View accessibilityElementsHidden style={styles.backButton} />
          )}
        </View>
        <AppText variant="label" style={styles.brandLabel}>
          {t('onboarding.brand')}
        </AppText>
        <View accessibilityElementsHidden style={styles.topBarControlSlot} />
      </View>

      <ScrollView
        ref={pagerRef}
        bounces={false}
        contentContainerStyle={styles.pagerContent}
        horizontal
        onMomentumScrollEnd={handlePageEnd}
        pagingEnabled
        scrollEnabled={!pagerLocked}
        showsHorizontalScrollIndicator={false}
      >
        {pages.map((content, index) => (
          <View key={index} style={{ width }}>
            <ScrollView
              contentContainerStyle={styles.pageScrollContent}
              contentInsetAdjustmentBehavior="automatic"
              showsVerticalScrollIndicator={false}
            >
              {content}
            </ScrollView>
          </View>
        ))}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <View
          accessibilityLabel={t('onboarding.progressLabel')}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 1, max: ONBOARDING_PAGE_COUNT, now: page + 1 }}
          style={styles.dots}
        >
          {Array.from({ length: ONBOARDING_PAGE_COUNT }, (_, index) => (
            <View key={index} style={[styles.dot, index === page && styles.activeDot]} />
          ))}
        </View>
        <AppButton
          disabled={continueDisabled()}
          label={continueLabel()}
          onPress={() => void handleContinue()}
          style={styles.continueButton}
        />
        {page === ONBOARDING_MODEL_PAGE && pagerLocked ? (
          <AppButton
            disabled={cancelBusy}
            label={cancelBusy ? t('onboarding.modelCancelling') : t('onboarding.modelCancel')}
            onPress={() => void cancelDownload()}
            tone="quiet"
          />
        ) : null}
      </View>
    </View>
  );
}

const TOP_BAR_CONTENT_HEIGHT = 52;

const styles = StyleSheet.create({
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  topBarControlSlot: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  backButton: {
    alignItems: 'center',
    borderRadius: 99,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  brandLabel: { color: colors.ink, letterSpacing: 0.2 },
  pagerContent: { flexGrow: 1 },
  pageScrollContent: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  pageBody: { flex: 1, gap: spacing.lg, justifyContent: 'center', maxWidth: 480, width: '100%' },
  iconWell: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: colors.accentSoft,
    borderCurve: 'continuous',
    borderRadius: radii.lg,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  pageCopy: { alignItems: 'center', gap: spacing.sm },
  pageTitle: { textAlign: 'center' },
  pageBodyText: { color: colors.mutedInk, maxWidth: 380, textAlign: 'center', ...typography.body },
  muted: { color: colors.mutedInk },
  modelSummary: { gap: spacing.lg, padding: spacing.lg },
  modelIconWell: {
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  packHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  packCopy: { flex: 1, gap: spacing.xs },
  facts: { gap: spacing.sm },
  fact: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 30 },
  factLabel: { color: colors.ink, flexShrink: 1 },
  backButtonDisabled: { opacity: 0.6 },
  checking: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 44 },
  callout: { gap: spacing.sm, padding: spacing.md },
  error: { color: colors.danger },
  readyCopy: { color: colors.ink },
  footer: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  dots: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, height: 12 },
  dot: { backgroundColor: colors.disabledFill, borderRadius: 99, height: 6, width: 6 },
  activeDot: { backgroundColor: colors.accent, width: 20 },
  continueButton: { alignSelf: 'stretch' },
  pressed: { opacity: 0.65 },
});
