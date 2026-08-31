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
import { AppButton, AppIcon, AppSurface, AppText } from '../../ui/primitives';
import {
  canCompleteModelOnboarding,
  hasResumableModelDownload,
  isModelDownloadActive,
  type LocalModelSnapshot,
} from '../local-models/model';
import { formatModelBytes } from '../local-models/manifest';
import {
  isExpectedDownloadCancellation,
  modelFailureFromError,
  modelProgressPercent,
  modelSetupFailureMessageKey,
  modelSetupFailureVisible,
  modelSetupPrimaryAction,
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

function ModelPreparationPage({
  model,
  snapshot,
  failure,
  cancelled,
}: {
  readonly model: LocalModelService;
  readonly snapshot: LocalModelSnapshot | null;
  readonly failure: LocalModelSnapshot['failure'];
  readonly cancelled: boolean;
}) {
  const ready = snapshot !== null && canCompleteModelOnboarding(snapshot);
  const active = snapshot !== null && isModelDownloadActive(snapshot);
  const resumable = hasResumableModelDownload(snapshot);
  const percent = snapshot === null ? 0 : modelProgressPercent(snapshot);
  const showFailure = modelSetupFailureVisible(snapshot, failure);
  const visibleFailure = snapshot?.state === 'failed' ? snapshot.failure : failure;
  const size = formatModelBytes(model.manifest.pack.bytes);
  const freeSpace = formatModelBytes(model.manifest.requirements.minimumFreeBytes);

  return (
    <View style={styles.pageBody}>
      <View accessibilityElementsHidden style={styles.iconWell}>
        <AppIcon name={ready ? 'checkmarkCircle' : 'folder'} size={34} color={colors.accent} />
      </View>
      <View style={styles.pageCopy}>
        <AppText variant="title" style={styles.pageTitle} selectable>
          {t('onboarding.modelPrepareTitle')}
        </AppText>
        <AppText style={styles.pageBodyText} selectable>
          {t('onboarding.modelPrepareBody')}
        </AppText>
      </View>

      <AppSurface style={styles.modelSummary}>
        <View style={styles.packHeader}>
          <View style={styles.packCopy}>
            <AppText variant="heading" selectable>
              {t('onboarding.modelName')}
            </AppText>
            <AppText variant="caption" style={styles.muted} selectable>
              {t('onboarding.modelRequiredLabel')}
            </AppText>
          </View>
          {ready ? <AppIcon name="checkmarkCircle" size={24} color={colors.accent} /> : null}
        </View>
        <View style={styles.facts}>
          <AppText style={styles.factLabel} selectable>
            {t('onboarding.modelSizeFact').replace('{size}', size)}
          </AppText>
          <AppText style={styles.factLabel} selectable>
            {t('onboarding.modelSpaceFact').replace('{space}', freeSpace)}
          </AppText>
          <AppText style={styles.factLabel} selectable>
            {t('onboarding.modelNoUploadFact')}
          </AppText>
        </View>
      </AppSurface>

      {snapshot === null && failure === null ? (
        <View accessibilityRole="progressbar" style={styles.checking}>
          <ActivityIndicator color={colors.accent as string} />
          <AppText style={styles.muted} selectable>
            {t('onboarding.modelChecking')}
          </AppText>
        </View>
      ) : null}

      {active || resumable ? (
        <View style={styles.progressGroup}>
          <View style={styles.progressCopy}>
            <AppText style={styles.muted} selectable>
              {snapshot?.state === 'verifying'
                ? t('onboarding.modelVerifying')
                : t(
                    resumable ? 'onboarding.modelDownloadPaused' : 'onboarding.modelDownloading',
                  ).replace('{progress}', String(percent))}
            </AppText>
            <AppText style={styles.progressPercent} selectable>
              {percent}%
            </AppText>
          </View>
          <View
            accessibilityLabel={t('onboarding.modelProgressLabel')}
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: percent }}
            style={styles.progressTrack}
          >
            <View style={[styles.progressFill, { width: `${percent}%` }]} />
          </View>
        </View>
      ) : null}

      {showFailure ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText style={styles.error} selectable>
            {t(modelSetupFailureMessageKey(visibleFailure))}
          </AppText>
        </AppSurface>
      ) : null}

      {cancelled && !resumable && !showFailure ? (
        <AppText style={styles.muted} selectable>
          {t('onboarding.modelSetupCancelDisclosure')}
        </AppText>
      ) : null}
    </View>
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
  const [modelBusy, setModelBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [completionFailed, setCompletionFailed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const pagerLocked = onboardingPagerLocked(snapshot);
  const ready = snapshot !== null && canCompleteModelOnboarding(snapshot);
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
    setModelFailure(null);
    setModelBusy(true);
    try {
      // Native verification ends in `ready`; onboarding must never call `load()`.
      await model.startDownload();
    } catch (error) {
      if (isExpectedDownloadCancellation(error, cancellationRequestedRef.current)) {
        setCancelled(true);
      } else {
        setModelFailure(modelFailureFromError(error));
      }
    } finally {
      cancellationRequestedRef.current = false;
      setModelBusy(false);
    }
  }

  async function cancelDownload() {
    cancellationRequestedRef.current = true;
    setCancelBusy(true);
    try {
      await model.cancelDownload();
      setCancelled(true);
      setModelFailure(null);
    } catch (error) {
      cancellationRequestedRef.current = false;
      setModelFailure(modelFailureFromError(error));
    } finally {
      setCancelBusy(false);
    }
  }

  function continueLabel(): string {
    if (page === ONBOARDING_MODEL_PAGE) {
      if (pagerLocked) return t('onboarding.modelCancel');
      if (ready) return t('onboarding.next');
      if (hasResumableModelDownload(snapshot)) return t('onboarding.modelContinueDownload');
      if (modelAction === 'retry') return t('onboarding.modelRetry');
      if (modelAction === 'checking') return t('onboarding.modelChecking');
      return t('onboarding.modelDownload');
    }
    return page === ONBOARDING_READY_PAGE ? t('onboarding.continue') : t('onboarding.next');
  }

  function continueDisabled(): boolean {
    if (finishing || cancelBusy) return true;
    if (page === ONBOARDING_MODEL_PAGE) {
      if (pagerLocked) return false;
      if (modelBusy) return true;
      return modelAction === 'checking' || modelAction === 'none';
    }
    if (modelBusy) return true;
    return !onboardingCanContinue(page, snapshot);
  }

  async function handleContinue() {
    if (continueDisabled()) return;
    if (page === ONBOARDING_MODEL_PAGE) {
      if (pagerLocked) {
        await cancelDownload();
      } else if (ready) {
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
      failure={modelFailure}
      cancelled={cancelled}
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
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <AppIcon name="chevronLeft" size={18} color={colors.accent} />
            </Pressable>
          ) : (
            <View accessibilityElementsHidden style={styles.backButton} />
          )}
        </View>
        <AppText variant="caption" style={styles.stepLabel} selectable>
          {t('onboarding.step')
            .replace('{current}', String(page + 1))
            .replace('{total}', String(ONBOARDING_PAGE_COUNT))}
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
          tone={page === ONBOARDING_MODEL_PAGE && pagerLocked ? 'quiet' : 'primary'}
        />
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
  stepLabel: { color: colors.mutedInk, fontVariant: ['tabular-nums'] },
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
  callout: { gap: spacing.sm, padding: spacing.md },
  modelSummary: { gap: spacing.md, padding: spacing.md },
  packHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  packCopy: { flex: 1, gap: spacing.xs },
  facts: { gap: spacing.sm },
  factLabel: { color: colors.ink },
  checking: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 44 },
  progressGroup: { gap: spacing.sm },
  progressCopy: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  progressPercent: { color: colors.ink, fontVariant: ['tabular-nums'] },
  progressTrack: {
    backgroundColor: colors.disabledFill,
    borderRadius: 99,
    height: 8,
    overflow: 'hidden',
  },
  progressFill: { backgroundColor: colors.accent, borderRadius: 99, height: '100%' },
  muted: { color: colors.mutedInk },
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
