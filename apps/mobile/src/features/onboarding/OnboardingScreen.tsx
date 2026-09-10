import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigation } from '@react-navigation/native';
import type { NavigationProp } from '@react-navigation/native';
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
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { useServices } from '../../services';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
import {
  AppButton,
  AppIcon,
  AppSurface,
  AppText,
  TidalHero,
  TidalIconStage,
  type AppIconName,
} from '../../ui/primitives';
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
import type { RootStackParamList } from '../../navigation/types';
import {
  ONBOARDING_MODEL_PAGE,
  ONBOARDING_PAGE_COUNT,
  ONBOARDING_READY_PAGE,
  onboardingCanContinue,
  onboardingCanNavigateTo,
  onboardingPagerLocked,
  onboardingResumePage,
  onboardingVisiblePageCount,
} from './onboarding-state';

type OnboardingScreenProps = {
  readonly model: LocalModelService;
  readonly onComplete: () => Promise<void>;
  /** A deliberate app reset starts with the welcome page even when the model is already present. */
  readonly startFromBeginning?: boolean;
  /** Render only the import-pack setup task for an existing installation. */
  readonly setupOnly?: boolean;
  /** Called when an existing installation has finished reviewing the pack state. */
  readonly onSetupComplete?: () => void;
};

type StoryItem = {
  readonly icon: AppIconName;
  readonly title: string;
  readonly body: string;
};

function JourneyCard() {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= ONBOARDING_ACCESSIBILITY_FONT_SCALE;
  const steps: ReadonlyArray<{ readonly icon: AppIconName; readonly label: string }> = [
    { icon: 'addDocument', label: t('onboarding.journeyImport') },
    { icon: 'eye', label: t('onboarding.journeyCheck') },
    { icon: 'chart', label: t('onboarding.journeyCompare') },
  ];

  return (
    <AppSurface style={styles.journeyCard}>
      {!usesAccessibleLayout ? (
        <View accessibilityElementsHidden style={styles.journeyLine} />
      ) : null}
      <View style={[styles.journeySteps, usesAccessibleLayout && styles.journeyStepsAccessible]}>
        {steps.map((step) => (
          <View
            key={step.label}
            style={[styles.journeyStep, usesAccessibleLayout && styles.journeyStepAccessible]}
          >
            <View accessibilityElementsHidden style={styles.storyIconWell}>
              <AppIcon color={colors.accent} name={step.icon} size={22} />
            </View>
            <AppText
              variant="label"
              style={[styles.journeyLabel, usesAccessibleLayout && styles.journeyLabelAccessible]}
              selectable
            >
              {step.label}
            </AppText>
          </View>
        ))}
      </View>
    </AppSurface>
  );
}

function StoryCard({ items }: { readonly items: ReadonlyArray<StoryItem> }) {
  return (
    <AppSurface style={styles.storyCard}>
      {items.map((item, index) => (
        <View
          key={item.title}
          style={[styles.storyRow, index < items.length - 1 && styles.storyRowDivider]}
        >
          <View accessibilityElementsHidden style={styles.storyIconWell}>
            <AppIcon color={colors.accent} name={item.icon} size={22} />
          </View>
          <View style={styles.storyCopy}>
            <AppText variant="label" style={styles.storyTitle} selectable>
              {item.title}
            </AppText>
            <AppText variant="caption" style={styles.storyBody} selectable>
              {item.body}
            </AppText>
          </View>
        </View>
      ))}
    </AppSurface>
  );
}

function ReviewStory() {
  const items: ReadonlyArray<StoryItem> = [
    {
      icon: 'doc',
      title: t('onboarding.historySourceTitle'),
      body: t('onboarding.historySourceBody'),
    },
    {
      icon: 'eye',
      title: t('onboarding.historyReadingTitle'),
      body: t('onboarding.historyReadingBody'),
    },
    {
      icon: 'checkmarkCircle',
      title: t('onboarding.historyRecordTitle'),
      body: t('onboarding.historyRecordBody'),
    },
  ];

  return (
    <>
      <StoryCard items={items} />
      <View style={styles.storyNote}>
        <AppIcon color={colors.accent} name="chart" size={18} />
        <AppText variant="caption" style={styles.storyNoteText} selectable>
          {t('onboarding.historyCompareNote')}
        </AppText>
      </View>
    </>
  );
}

function PrivacyStory() {
  const items: ReadonlyArray<StoryItem> = [
    {
      icon: 'eye',
      title: t('onboarding.privacyPreviewTitle'),
      body: t('onboarding.privacyPreviewBody'),
    },
    {
      icon: 'shield',
      title: t('onboarding.privacyLimitsTitle'),
      body: t('onboarding.privacyLimitsBody'),
    },
  ];

  return <StoryCard items={items} />;
}

function FirstStepCard() {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= ONBOARDING_ACCESSIBILITY_FONT_SCALE;
  return (
    <AppSurface
      tone="soft"
      style={[styles.firstStepCard, usesAccessibleLayout && styles.firstStepCardAccessible]}
    >
      <View accessibilityElementsHidden style={styles.firstStepIcon}>
        <AppIcon color={colors.accent} name="addDocument" size={30} />
      </View>
      <View style={styles.firstStepCopy}>
        <AppText variant="caption" style={styles.muted} selectable>
          {t('onboarding.readyStepLabel')}
        </AppText>
        <AppText variant="heading" selectable>
          {t('onboarding.readyStepTitle')}
        </AppText>
        <AppText style={styles.firstStepBody} selectable>
          {t('onboarding.readyStepBody')}
        </AppText>
      </View>
    </AppSurface>
  );
}

function IntroPage({
  icon,
  title,
  body,
  children,
  heroHeight,
}: {
  readonly icon: 'library' | 'lockShield' | 'chart' | 'checkmarkCircle';
  readonly title: string;
  readonly body?: string;
  readonly children?: ReactNode;
  readonly heroHeight: number;
}) {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= ONBOARDING_ACCESSIBILITY_FONT_SCALE;
  return (
    <View style={styles.pageBody}>
      <View style={[styles.pageHeader, { height: heroHeight }]}>
        <View style={styles.introHeaderContent}>
          {!usesAccessibleLayout ? <TidalIconStage name={icon} /> : null}
          <AppText
            maxFontSizeMultiplier={usesAccessibleLayout ? 2 : undefined}
            variant={usesAccessibleLayout ? 'heading' : 'display'}
            style={styles.pageTitle}
            selectable
          >
            {title}
          </AppText>
        </View>
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.introBodyContent,
          usesAccessibleLayout && styles.accessibleScrollContent,
        ]}
        contentInsetAdjustmentBehavior="automatic"
        directionalLockEnabled
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        style={styles.pageContentScroll}
      >
        {body === undefined ? null : (
          <AppText
            maxFontSizeMultiplier={usesAccessibleLayout ? 2 : undefined}
            style={styles.pageBodyText}
            selectable
          >
            {body}
          </AppText>
        )}
        {children}
      </ScrollView>
    </View>
  );
}

function ReadyPage({
  completionFailed,
  heroHeight,
}: {
  readonly completionFailed: boolean;
  readonly heroHeight: number;
}) {
  return (
    <IntroPage
      heroHeight={heroHeight}
      icon="checkmarkCircle"
      title={t('onboarding.readyTitle')}
    >
      <FirstStepCard />
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
  heroHeight,
}: {
  readonly model: LocalModelService;
  readonly snapshot: LocalModelSnapshot | null;
  readonly failure: LocalModelSnapshot['failure'];
  readonly cancelled: boolean;
  readonly heroHeight: number;
}) {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= ONBOARDING_ACCESSIBILITY_FONT_SCALE;
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
      <View style={[styles.pageHeader, { height: heroHeight }]}>
        <View style={styles.modelHeroHeading}>
          {!usesAccessibleLayout ? (
            <TidalIconStage name={ready ? 'checkmarkCircle' : 'lockShield'} />
          ) : null}
          <AppText
            maxFontSizeMultiplier={usesAccessibleLayout ? 2 : undefined}
            variant={usesAccessibleLayout ? 'heading' : 'title'}
            style={styles.modelHeroTitle}
            selectable
          >
            {t('onboarding.modelPrepareTitle')}
          </AppText>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.modelPageScrollContent,
          usesAccessibleLayout && styles.accessibleScrollContent,
        ]}
        contentInsetAdjustmentBehavior="automatic"
        directionalLockEnabled
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        style={styles.pageContentScroll}
      >
        <View style={styles.modelPageContent}>
          <AppText
            maxFontSizeMultiplier={usesAccessibleLayout ? 2 : undefined}
            style={styles.modelHeroBody}
            selectable
          >
            {t('onboarding.modelPrepareBody')}
          </AppText>
          <AppSurface style={styles.modelSummary}>
            <View style={styles.packHeader}>
              <View accessibilityElementsHidden style={styles.modelIconWell}>
                <AppIcon name="folder" size={25} color={colors.accent} />
              </View>
              <View style={styles.packCopy}>
                <AppText
                  variant="heading"
                  selectable
                >
                  {t('onboarding.modelName')}
                </AppText>
              </View>
              {ready ? <AppIcon name="checkmarkCircle" size={24} color={colors.accent} /> : null}
            </View>
            <View
              style={[styles.modelMetrics, usesAccessibleLayout && styles.modelMetricsAccessible]}
            >
              <View style={styles.modelMetric}>
                <AppText variant="caption" style={styles.muted} selectable>
                  {t('onboarding.modelDownloadMetric')}
                </AppText>
                <AppText
                  variant="stat"
                  selectable
                >
                  {size}
                </AppText>
              </View>
              <View
                accessibilityElementsHidden
                style={[
                  styles.modelMetricDivider,
                  usesAccessibleLayout && styles.modelMetricDividerAccessible,
                ]}
              />
              <View style={styles.modelMetric}>
                <AppText variant="caption" style={styles.muted} selectable>
                  {t('onboarding.modelSpaceMetric')}
                </AppText>
                <AppText
                  variant="stat"
                  selectable
                >
                  {freeSpace}
                </AppText>
              </View>
            </View>
            <View style={styles.modelDeviceNote}>
              <AppIcon color={colors.accent} name="phone" size={17} />
              <AppText
                variant="caption"
                style={styles.modelDeviceNoteText}
                selectable
              >
                {t('onboarding.modelOnDevice')}
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
                        resumable
                          ? 'onboarding.modelDownloadPaused'
                          : 'onboarding.modelDownloading',
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
      </ScrollView>
    </View>
  );
}

export function OnboardingScreen({
  model,
  onComplete,
  startFromBeginning = false,
  setupOnly = false,
  onSetupComplete,
}: OnboardingScreenProps) {
  const { fontScale, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pagerRef = useRef<ScrollView>(null);
  const hasInteractedRef = useRef(false);
  const shouldSyncPagerRef = useRef(false);
  const cancellationRequestedRef = useRef(false);
  const previousReadyRef = useRef(false);
  const [page, setPage] = useState(setupOnly ? ONBOARDING_MODEL_PAGE : 0);
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
  const usesAccessibleLayout = fontScale >= ONBOARDING_ACCESSIBILITY_FONT_SCALE;
  const heroHeight = onboardingHeroHeight(fontScale);
  const topBarContentHeight = onboardingTopBarHeight(fontScale);

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
        if (!setupOnly && !startFromBeginning && !hasInteractedRef.current) {
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
  }, [model, setupOnly, startFromBeginning]);

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
      setupOnly ||
      page !== ONBOARDING_MODEL_PAGE ||
      !becameReady ||
      !onboardingCanNavigateTo(page, ONBOARDING_READY_PAGE, snapshot)
    ) {
      return;
    }
    hasInteractedRef.current = true;
    shouldSyncPagerRef.current = true;
    setPage(ONBOARDING_READY_PAGE);
  }, [page, ready, setupOnly, snapshot]);

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
    if (setupOnly) {
      if (pagerLocked) {
        await cancelDownload();
      } else if (ready) {
        onSetupComplete?.();
      } else if (
        modelAction === 'download' ||
        modelAction === 'continue' ||
        modelAction === 'retry'
      ) {
        await startDownload();
      }
      return;
    }
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

  if (setupOnly) {
    return (
      <View style={screenStyles.safe}>
        <StatusBar style="auto" />
        <ModelPreparationPage
          cancelled={cancelled}
          failure={modelFailure}
          heroHeight={heroHeight}
          model={model}
          snapshot={snapshot}
        />
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <AppButton
            disabled={continueDisabled()}
            label={
              ready
                ? t('settings.importPackDone')
                : page === ONBOARDING_MODEL_PAGE
                  ? continueLabel()
                  : t('settings.importPackDone')
            }
            labelMaxFontSizeMultiplier={1.5}
            labelNumberOfLines={1}
            onPress={() => void handleContinue()}
            style={styles.continueButton}
            tone={pagerLocked ? 'quiet' : 'primary'}
          />
        </View>
      </View>
    );
  }

  const pages = [
    <IntroPage
      key="welcome"
      heroHeight={heroHeight}
      icon="library"
      title={t('onboarding.title')}
      body={t('onboarding.body')}
    >
      <JourneyCard />
    </IntroPage>,
    <IntroPage
      key="history"
      heroHeight={heroHeight}
      icon="chart"
      title={t('onboarding.historyTitle')}
    >
      <ReviewStory />
    </IntroPage>,
    <IntroPage
      key="privacy"
      heroHeight={heroHeight}
      icon="lockShield"
      title={t('onboarding.privacyTitle')}
      body={t('onboarding.privacyBody')}
    >
      <PrivacyStory />
    </IntroPage>,
    <ModelPreparationPage
      key="model"
      model={model}
      snapshot={snapshot}
      failure={modelFailure}
      cancelled={cancelled}
      heroHeight={heroHeight}
    />,
    <ReadyPage key="ready" completionFailed={completionFailed} heroHeight={heroHeight} />,
  ];
  const visiblePages = pages.slice(0, onboardingVisiblePageCount(snapshot));

  return (
    <View style={screenStyles.safe}>
      <StatusBar style="light" />
      <View
        style={[
          styles.topBar,
          {
            height: topBarContentHeight + insets.top,
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
                color={pagerLocked ? colors.onBrandMuted : colors.onBrand}
              />
            </Pressable>
          ) : (
            <View accessibilityElementsHidden style={styles.backButton} />
          )}
        </View>
        <AppText
          maxFontSizeMultiplier={1.5}
          variant="label"
          style={styles.brandLabel}
          selectable
        >
          {t('onboarding.brand')}
        </AppText>
        <View accessibilityElementsHidden style={styles.topBarControlSlot} />
      </View>

      <View style={styles.pagerFrame}>
        <TidalHero edge="bottom" style={[styles.sharedHeroBackdrop, { height: heroHeight }]} />
        <ScrollView
          ref={pagerRef}
          bounces={false}
          contentContainerStyle={styles.pagerContent}
          decelerationRate="fast"
          directionalLockEnabled
          horizontal
          onMomentumScrollEnd={handlePageEnd}
          pagingEnabled
          scrollEnabled={!pagerLocked && !usesAccessibleLayout}
          showsHorizontalScrollIndicator={false}
          style={styles.pager}
        >
          {visiblePages.map((content, index) => (
            <View
              accessibilityElementsHidden={index !== page}
              importantForAccessibility={index === page ? 'auto' : 'no-hide-descendants'}
              key={index}
              style={[styles.pageFrame, { width }]}
            >
              {content}
            </View>
          ))}
        </ScrollView>
      </View>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <View
          accessibilityLabel={t('onboarding.progressLabel')}
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 1, max: visiblePages.length, now: page + 1 }}
          style={styles.dots}
        >
          {Array.from({ length: visiblePages.length }, (_, index) => (
            <View key={index} style={[styles.dot, index === page && styles.activeDot]} />
          ))}
        </View>
        <AppButton
          disabled={continueDisabled()}
          label={continueLabel()}
          labelMaxFontSizeMultiplier={1.5}
          labelNumberOfLines={1}
          onPress={() => void handleContinue()}
          style={styles.continueButton}
          tone={page === ONBOARDING_MODEL_PAGE && pagerLocked ? 'quiet' : 'primary'}
        />
      </View>
    </View>
  );
}

/**
 * Existing installations can repair the on-device report reader without revisiting onboarding.
 * The native stack owns the modal's back/dismiss affordance. The model service keeps transfer
 * state durable when this task is dismissed, so reopening it shows progress or a resumable state.
 */
export function ImportPackSetupScreen() {
  const { models } = useServices();
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();

  return (
    <OnboardingScreen
      model={models}
      onComplete={async () => undefined}
      onSetupComplete={() => navigation.goBack()}
      setupOnly
    />
  );
}

const TOP_BAR_CONTENT_HEIGHT = 52;
const ONBOARDING_HERO_HEIGHT = 320;
const ONBOARDING_ACCESSIBILITY_FONT_SCALE = 1.5;

function onboardingHeroHeight(fontScale: number): number {
  return fontScale >= ONBOARDING_ACCESSIBILITY_FONT_SCALE ? 240 : ONBOARDING_HERO_HEIGHT;
}

function onboardingTopBarHeight(fontScale: number): number {
  return Math.max(TOP_BAR_CONTENT_HEIGHT, Math.round(44 + Math.max(0, fontScale - 1) * 14));
}

const styles = StyleSheet.create({
  topBar: {
    alignItems: 'center',
    backgroundColor: colors.brand,
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
  backButtonDisabled: { opacity: 0.56 },
  brandLabel: { color: colors.onBrand, letterSpacing: 0.2 },
  pagerFrame: { flex: 1, position: 'relative' },
  sharedHeroBackdrop: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  pager: { flex: 1 },
  pagerContent: { flexGrow: 1 },
  pageFrame: { flex: 1 },
  pageBody: { flex: 1, width: '100%' },
  pageHeader: {
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.xl,
  },
  introHeaderContent: {
    alignItems: 'center',
    gap: spacing.lg,
  },
  pageTitle: { color: colors.onBrand, maxWidth: 390, textAlign: 'center', width: '100%' },
  pageContentScroll: { backgroundColor: colors.canvas, flex: 1 },
  introBodyContent: {
    alignItems: 'center',
    flexGrow: 1,
    gap: spacing.lg,
    padding: spacing.xl,
  },
  accessibleScrollContent: { paddingBottom: 220 },
  pageBodyText: {
    color: colors.ink,
    maxWidth: 390,
    textAlign: 'center',
    width: '100%',
    ...typography.body,
  },
  callout: { alignSelf: 'stretch', gap: spacing.sm, padding: spacing.md },
  journeyCard: {
    maxWidth: 420,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.lg,
    position: 'relative',
    width: '100%',
  },
  journeyLine: {
    backgroundColor: colors.border,
    height: 2,
    left: '18%',
    position: 'absolute',
    right: '18%',
    top: 41,
  },
  journeySteps: { flexDirection: 'row', justifyContent: 'space-between' },
  journeyStepsAccessible: { flexDirection: 'column', gap: spacing.md },
  journeyStep: { alignItems: 'center', flex: 1, gap: spacing.sm },
  journeyStepAccessible: { flex: 0, flexDirection: 'row', width: '100%' },
  journeyLabel: { color: colors.ink, textAlign: 'center' },
  journeyLabelAccessible: { flex: 1, textAlign: 'left' },
  storyCard: { maxWidth: 420, paddingVertical: 0, width: '100%' },
  storyRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 64,
    paddingVertical: spacing.sm,
  },
  storyRowDivider: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  storyIconWell: {
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  storyCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  storyTitle: { width: '100%' },
  storyBody: { color: colors.mutedInk, width: '100%' },
  storyNote: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    maxWidth: 380,
    paddingHorizontal: spacing.sm,
  },
  storyNoteText: { color: colors.mutedInk, flex: 1 },
  firstStepCard: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.lg,
    maxWidth: 420,
    width: '100%',
  },
  firstStepCardAccessible: { alignItems: 'stretch', flexDirection: 'column' },
  firstStepIcon: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    height: 64,
    justifyContent: 'center',
    width: 64,
  },
  firstStepCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  firstStepBody: { color: colors.mutedInk },
  modelHeroHeading: { alignItems: 'center', gap: spacing.lg },
  modelHeroTitle: { color: colors.onBrand, maxWidth: 390, textAlign: 'center', width: '100%' },
  modelHeroBody: { color: colors.ink, maxWidth: 400, textAlign: 'center', width: '100%' },
  modelPageScrollContent: { flexGrow: 1 },
  modelPageContent: {
    alignItems: 'stretch',
    gap: spacing.md,
    padding: spacing.lg,
    width: '100%',
  },
  modelSummary: { gap: spacing.md, padding: spacing.md, width: '100%' },
  packHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  modelIconWell: {
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  packCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  modelMetrics: {
    alignItems: 'stretch',
    flexDirection: 'row',
    gap: spacing.md,
  },
  modelMetricsAccessible: { flexDirection: 'column' },
  modelMetric: { flex: 1, gap: spacing.xs },
  modelMetricDivider: { backgroundColor: colors.border, width: StyleSheet.hairlineWidth },
  modelMetricDividerAccessible: { height: StyleSheet.hairlineWidth, width: '100%' },
  modelDeviceNote: {
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderCurve: 'continuous',
    borderRadius: radii.sm,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  modelDeviceNoteText: { color: colors.ink, flex: 1 },
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
  footer: {
    alignItems: 'center',
    backgroundColor: colors.elevatedSurface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  dots: { alignItems: 'center', flexDirection: 'row', gap: spacing.xs, height: 12 },
  dot: { backgroundColor: colors.disabledFill, borderRadius: radii.pill, height: 6, width: 6 },
  activeDot: { backgroundColor: colors.accent, width: 20 },
  continueButton: { alignSelf: 'stretch' },
  pressed: { opacity: 0.65 },
});
