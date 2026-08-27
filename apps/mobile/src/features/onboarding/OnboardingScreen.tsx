import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
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
} from '../local-models/model-ui';
import type { LocalModelService } from '../local-models/native';
import {
  ONBOARDING_MODEL_DOWNLOAD_PAGE,
  ONBOARDING_MODEL_SELECTION_PAGE,
  ONBOARDING_PAGE_COUNT,
  ONBOARDING_READY_PAGE,
  onboardingPagerLocked,
  onboardingResumePage,
} from './onboarding-state';

type OnboardingScreenProps = {
  readonly model: LocalModelService;
  readonly onComplete: () => void;
};

function ModelFact({
  icon,
  children,
}: {
  readonly icon: 'phone' | 'cloud';
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

function IntroPage({
  icon,
  title,
  body,
  children,
}: {
  readonly icon: 'library' | 'lockShield' | 'chart' | 'cloud' | 'checkmarkCircle';
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

function ModelSelectionPage({
  selected,
  onSelect,
  model,
}: {
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly model: LocalModelService;
}) {
  return (
    <View style={styles.pageBody}>
      <StatusPill>{t('onboarding.modelEyebrow')}</StatusPill>
      <View style={styles.pageCopy}>
        <AppText variant="title" style={styles.pageTitle} selectable>
          {t('onboarding.modelChoiceTitle')}
        </AppText>
        <AppText style={styles.pageBodyText} selectable>
          {t('onboarding.modelChoiceBody')}
        </AppText>
      </View>

      <Pressable
        accessibilityLabel={t('onboarding.modelSelectLabel')}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        onPress={onSelect}
        style={({ pressed }) => [
          styles.modelChoice,
          selected && styles.modelChoiceSelected,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.modelChoiceIcon}>
          <AppIcon name="folder" size={26} color={colors.accent} />
        </View>
        <View style={styles.modelChoiceCopy}>
          <AppText variant="heading" selectable>
            {t('onboarding.modelName')}
          </AppText>
          <AppText style={styles.muted} selectable>
            {model.manifest.pack.publisher}
          </AppText>
          <AppText variant="caption" style={styles.muted} selectable>
            {t('onboarding.modelChoiceFact')}
          </AppText>
        </View>
        <AppIcon
          name="checkmarkCircle"
          size={28}
          color={selected ? colors.accent : colors.disabledInk}
          accessibilityLabel={
            selected ? t('onboarding.modelSelected') : t('onboarding.modelNotSelected')
          }
        />
      </Pressable>

      <ModelDetailsDisclosure manifest={model.manifest} />
    </View>
  );
}

function ModelDownloadPage({
  snapshot,
  modelFailure,
}: {
  readonly snapshot: LocalModelSnapshot | null;
  readonly modelFailure: LocalModelSnapshot['failure'];
}) {
  const ready = snapshot !== null && canCompleteModelOnboarding(snapshot);
  const resumable = hasResumableModelDownload(snapshot);
  const active = snapshot !== null && isModelDownloadActive(snapshot);
  const failed = snapshot?.state === 'failed';
  const failure = failed ? (snapshot?.failure ?? null) : modelFailure;

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
        <View style={styles.packHeader}>
          <AppIcon name="folder" size={26} color={colors.accent} />
          <View style={styles.packCopy}>
            <AppText variant="heading" selectable>
              {t('onboarding.modelName')}
            </AppText>
            <AppText variant="caption" style={styles.muted} selectable>
              {t('onboarding.modelRequiredLabel')}
            </AppText>
          </View>
        </View>
        <View style={styles.facts}>
          <ModelFact icon="phone">{t('onboarding.modelSizeFact')}</ModelFact>
          <ModelFact icon="phone">{t('onboarding.modelSpaceFact')}</ModelFact>
          <ModelFact icon="phone">{t('onboarding.modelRunsLocallyFact')}</ModelFact>
          <ModelFact icon="cloud">{t('onboarding.modelNoUploadFact')}</ModelFact>
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

      {modelSetupFailureVisible(snapshot, modelFailure) ? (
        <AppSurface tone="soft" style={styles.callout}>
          <AppText variant="heading" style={styles.error} selectable>
            {t(modelSetupFailureMessageKey(failure))}
          </AppText>
        </AppSurface>
      ) : null}

      {active && snapshot !== null ? <ModelProgress snapshot={snapshot} /> : null}
      {active ? (
        <AppText style={styles.muted} selectable>
          {t('onboarding.modelKeepOpen')}
        </AppText>
      ) : null}
    </View>
  );
}

function ReadyPage() {
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
  const [page, setPage] = useState(0);
  const [modelSelected, setModelSelected] = useState(false);
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null);
  const [modelFailure, setModelFailure] = useState<LocalModelSnapshot['failure']>(null);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
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
            setModelSelected(true);
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
    if (!shouldSyncPagerRef.current) return;
    pagerRef.current?.scrollTo({ x: width * page, animated: false });
    shouldSyncPagerRef.current = false;
  }, [page, width]);

  useEffect(() => {
    if (page !== ONBOARDING_MODEL_DOWNLOAD_PAGE || !ready) return;
    hasInteractedRef.current = true;
    shouldSyncPagerRef.current = true;
    setPage(ONBOARDING_READY_PAGE);
  }, [page, ready]);

  function moveToPage(nextPage: number, animated = true) {
    if (pagerLocked || nextPage < 0 || nextPage >= ONBOARDING_PAGE_COUNT) return;
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
    if (nextPage > ONBOARDING_MODEL_SELECTION_PAGE && !modelSelected) {
      moveToPage(ONBOARDING_MODEL_SELECTION_PAGE, false);
      return;
    }
    hasInteractedRef.current = true;
    setPage(nextPage);
  }

  async function startDownload() {
    cancellationRequestedRef.current = false;
    setModelFailure(null);
    setBusy(true);
    try {
      await model.startDownload();
    } catch (error) {
      if (!isExpectedDownloadCancellation(error, cancellationRequestedRef.current)) {
        setModelFailure(modelFailureFromError(error));
      }
    } finally {
      cancellationRequestedRef.current = false;
      setBusy(false);
    }
  }

  async function cancelDownload() {
    cancellationRequestedRef.current = true;
    setCancelBusy(true);
    try {
      await model.cancelDownload();
      setModelFailure(null);
    } catch {
      cancellationRequestedRef.current = false;
      setModelFailure('unknown');
    } finally {
      setCancelBusy(false);
    }
  }

  function continueLabel(): string {
    if (page === ONBOARDING_MODEL_DOWNLOAD_PAGE) {
      if (ready) return t('onboarding.continue');
      if (pagerLocked || busy) return t('onboarding.modelPreparing');
      if (resumable) return t('onboarding.modelContinueDownload');
      if (modelAction === 'retry') return t('onboarding.modelRetry');
      if (modelAction === 'checking') return t('onboarding.modelChecking');
      return t('onboarding.modelDownload');
    }
    return t('onboarding.continue');
  }

  function continueDisabled(): boolean {
    if (finishing || cancelBusy) return true;
    if (page === ONBOARDING_MODEL_SELECTION_PAGE) return !modelSelected;
    if (page === ONBOARDING_MODEL_DOWNLOAD_PAGE)
      return snapshot === null || (pagerLocked && !ready) || busy;
    if (page === ONBOARDING_READY_PAGE) return !ready;
    return false;
  }

  async function handleContinue() {
    if (continueDisabled()) return;
    if (page < ONBOARDING_MODEL_SELECTION_PAGE) {
      moveToPage(page + 1);
      return;
    }
    if (page === ONBOARDING_MODEL_SELECTION_PAGE) {
      moveToPage(ONBOARDING_MODEL_DOWNLOAD_PAGE);
      return;
    }
    if (page === ONBOARDING_MODEL_DOWNLOAD_PAGE && ready) {
      moveToPage(ONBOARDING_READY_PAGE);
      return;
    }
    if (page === ONBOARDING_READY_PAGE) {
      setFinishing(true);
      onComplete();
      return;
    }
    await startDownload();
  }

  const pages = [
    <IntroPage
      key="welcome"
      icon="library"
      title={t('onboarding.title')}
      body={t('onboarding.body')}
    />,
    <IntroPage
      key="local"
      icon="lockShield"
      title={t('onboarding.localTitle')}
      body={t('onboarding.localBody')}
    />,
    <IntroPage
      key="measured"
      icon="chart"
      title={t('onboarding.privacyTitle')}
      body={t('onboarding.privacyBody')}
    />,
    <ModelSelectionPage
      key="model-selection"
      model={model}
      selected={modelSelected}
      onSelect={() => {
        hasInteractedRef.current = true;
        setModelSelected(true);
      }}
    />,
    <ModelDownloadPage key="model-download" modelFailure={modelFailure} snapshot={snapshot} />,
    <ReadyPage key="ready" />,
  ];

  return (
    <View style={screenStyles.safe}>
      <View style={[styles.topBar, { paddingTop: Math.max(insets.top, spacing.sm) }]}>
        <View style={styles.topBarSide}>
          {page > 0 && !pagerLocked ? (
            <Pressable
              accessibilityLabel={t('onboarding.back')}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => moveToPage(page - 1)}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <AppIcon name="chevronLeft" size={18} color={colors.accent} />
            </Pressable>
          ) : null}
        </View>
        <AppText variant="caption" style={styles.stepLabel} selectable>
          {t('onboarding.step')
            .replace('{current}', String(page + 1))
            .replace('{total}', String(ONBOARDING_PAGE_COUNT))}
        </AppText>
        <View style={styles.topBarSide} />
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
        {page === ONBOARDING_MODEL_DOWNLOAD_PAGE && pagerLocked ? (
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

const styles = StyleSheet.create({
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: spacing.lg,
  },
  topBarSide: { minWidth: 44 },
  backButton: {
    alignItems: 'center',
    borderRadius: 99,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
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
  muted: { color: colors.mutedInk },
  modelChoice: {
    alignItems: 'center',
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
  },
  modelChoiceSelected: { borderColor: colors.accent, backgroundColor: colors.surface },
  modelChoiceIcon: {
    alignItems: 'center',
    backgroundColor: colors.accentSoft,
    borderRadius: radii.sm,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  modelChoiceCopy: { flex: 1, gap: spacing.xs },
  modelSummary: { gap: spacing.lg, padding: spacing.lg },
  packHeader: { alignItems: 'center', flexDirection: 'row', gap: spacing.md },
  packCopy: { flex: 1, gap: spacing.xs },
  facts: { gap: spacing.sm },
  fact: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minHeight: 30 },
  factLabel: { color: colors.ink, flexShrink: 1 },
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
