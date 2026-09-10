import { forwardRef, useContext, useState, type PropsWithChildren, type ReactNode } from 'react';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { Image } from 'expo-image';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ColorValue,
  type PressableProps,
  type ScrollViewProps,
  type StyleProp,
  type TextProps,
  type ViewProps,
  type ViewStyle,
  type ImageStyle,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, statusColors, typography, type StatusTone } from '../theme';
import {
  getScreenPlatformPolicy,
  getScreenScrollBottomInset,
  getScreenStatusAvailableHeight,
  getScreenStatusBottomInset,
  getScreenStatusScrollEnabled,
  getScreenStatusUsesOverflowLayout,
} from './screen-scroll-model';

const screenPlatformPolicy = getScreenPlatformPolicy(process.env.EXPO_OS);

type AppTextProps = TextProps & {
  variant?: keyof typeof typography;
};

export function AppText({
  variant = 'body',
  style,
  allowFontScaling = true,
  maxFontSizeMultiplier,
  ...props
}: AppTextProps) {
  return (
    <Text
      allowFontScaling={allowFontScaling}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typography[variant], styles.text, style]}
      {...props}
    />
  );
}

type AppSurfaceProps = PropsWithChildren<ViewProps> & {
  tone?: 'default' | 'soft' | 'brand';
};

export function AppSurface({ tone = 'default', style, ...props }: AppSurfaceProps) {
  return (
    <View
      style={[
        styles.surface,
        tone === 'soft' && styles.softSurface,
        tone === 'brand' && styles.brandSurface,
        style,
      ]}
      {...props}
    />
  );
}

/**
 * The outer scrolling surface for app screens.
 *
 * Native tabs are translucent on iOS 26. Explicitly opting into UIKit's automatic adjustment
 * keeps the last control and the scroll indicator above the native tab bar. Keyboard and
 * indicator adjustment stay here as well so forms do not need per-screen inset guesses.
 */
type ScreenScrollViewProps = Omit<
  ScrollViewProps,
  | 'automaticallyAdjustContentInsets'
  | 'automaticallyAdjustKeyboardInsets'
  | 'automaticallyAdjustsScrollIndicatorInsets'
  | 'contentInsetAdjustmentBehavior'
> & {
  /** Reserve the shared native-tab clearance when this scroll surface ends in an action. */
  readonly tabBarClearance?: 'native';
};

export const ScreenScrollView = forwardRef<ScrollView, ScreenScrollViewProps>(
  function ScreenScrollView(
    { contentInset, scrollIndicatorInsets, tabBarClearance, ...props },
    ref,
  ) {
    const tabBarHeight = useContext(BottomTabBarHeightContext);
    const safeAreaInsets = useSafeAreaInsets();
    // Native bottom tabs render outside the JS tree and currently do not provide the React
    // Navigation height context. On iOS, the shared clearance keeps an action-ending route above
    // the translucent bar while regular bottom tabs continue to use their measured height. Other
    // platforms retain the existing safe-area/measured-tab behavior.
    const bottomInset = getScreenScrollBottomInset(
      tabBarHeight,
      safeAreaInsets.bottom,
      tabBarClearance === 'native' && screenPlatformPolicy === 'ios-native-tabs' ? spacing.xxl : 0,
      screenPlatformPolicy === 'ios-native-tabs' ? 'automatic' : 'legacy',
    );

    return (
      <ScrollView
        ref={ref}
        {...props}
        automaticallyAdjustContentInsets
        automaticallyAdjustKeyboardInsets
        automaticallyAdjustsScrollIndicatorInsets
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{
          ...contentInset,
          bottom: (contentInset?.bottom ?? 0) + bottomInset,
        }}
        scrollIndicatorInsets={{
          ...scrollIndicatorInsets,
          bottom: (scrollIndicatorInsets?.bottom ?? 0) + bottomInset,
        }}
      />
    );
  },
);

type ScreenStatusViewProps = PropsWithChildren<{
  readonly contentContainerStyle?: StyleProp<ViewStyle>;
  readonly style?: StyleProp<ViewStyle>;
  /** Reserve the shared native-tab clearance when this status shell sits beneath native tabs. */
  readonly tabBarClearance?: 'native';
}>;

/**
 * A calm centered shell for loading, error, and empty states. Ordinary content has no bounce and
 * no movement because scrolling stays disabled. The native surface becomes scrollable only when
 * Dynamic Type or localized copy genuinely exceeds the header/tab-adjusted viewport, keeping the
 * primary action reachable.
 */
export function ScreenStatusView({
  children,
  contentContainerStyle,
  style,
  tabBarClearance,
}: ScreenStatusViewProps) {
  const tabBarHeight = useContext(BottomTabBarHeightContext);
  const safeAreaInsets = useSafeAreaInsets();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const [viewportHeight, setViewportHeight] = useState(windowHeight);
  const [contentHeight, setContentHeight] = useState(0);
  const usesNativeTabClearance =
    tabBarClearance === 'native' && screenPlatformPolicy === 'ios-native-tabs';
  const usesLegacySafeAreaClearance = screenPlatformPolicy === 'legacy';
  const bottomInset =
    usesNativeTabClearance || usesLegacySafeAreaClearance
      ? getScreenScrollBottomInset(
          tabBarHeight,
          safeAreaInsets.bottom,
          usesNativeTabClearance ? spacing.xxl : 0,
          usesNativeTabClearance ? 'automatic' : 'legacy',
        )
      : 0;
  // Full-screen stack routes do not sit beneath the native tab bar. On iOS, only callers that
  // explicitly opt in reserve the tab/header clearance; legacy platforms retain their safe-area
  // fallback for existing tab and stack layouts.
  const statusBottomClearance =
    usesNativeTabClearance || usesLegacySafeAreaClearance
      ? getScreenStatusBottomInset(
          tabBarHeight,
          safeAreaInsets.bottom,
          usesNativeTabClearance ? spacing.xxl : 0,
        )
      : 0;
  const topLayoutClearance = usesNativeTabClearance ? safeAreaInsets.top + spacing.xxl * 2 : 0;
  const availableHeight = getScreenStatusAvailableHeight(
    viewportHeight,
    topLayoutClearance,
    screenPlatformPolicy === 'ios-native-tabs' ? statusBottomClearance : 0,
  );
  const usesOverflowLayout = getScreenStatusUsesOverflowLayout(fontScale);
  const scrollEnabled =
    usesOverflowLayout || getScreenStatusScrollEnabled(contentHeight, availableHeight);

  function handleViewportLayout(event: LayoutChangeEvent) {
    setViewportHeight(event.nativeEvent.layout.height);
  }

  function handleContentLayout(event: LayoutChangeEvent) {
    setContentHeight(event.nativeEvent.layout.height);
  }

  return (
    <ScrollView
      alwaysBounceVertical={false}
      automaticallyAdjustContentInsets
      automaticallyAdjustKeyboardInsets
      automaticallyAdjustsScrollIndicatorInsets
      bounces={false}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={[
        styles.statusScreen,
        usesOverflowLayout && styles.statusScreenOverflow,
        { minHeight: availableHeight },
      ]}
      onLayout={handleViewportLayout}
      scrollEnabled={scrollEnabled}
      showsVerticalScrollIndicator={false}
      style={style}
    >
      <View style={{ paddingBottom: bottomInset }}>
        <View
          onLayout={handleContentLayout}
          style={[styles.statusMeasuredContent, contentContainerStyle]}
        >
          {children}
        </View>
      </View>
    </ScrollView>
  );
}

type AppButtonProps = Omit<PressableProps, 'children'> & {
  label: string;
  children?: ReactNode;
  accessibilityLabel?: string;
  labelMaxFontSizeMultiplier?: number;
  labelNumberOfLines?: number;
  tone?: 'primary' | 'secondary' | 'quiet' | 'destructive';
};

export function AppButton({
  label,
  children,
  accessibilityLabel = label,
  labelMaxFontSizeMultiplier,
  labelNumberOfLines,
  tone = 'primary',
  style,
  ...props
}: AppButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: props.disabled === true }}
      style={({ pressed }) => [
        styles.button,
        tone === 'primary' && styles.primaryButton,
        tone === 'secondary' && styles.secondaryButton,
        tone === 'quiet' && styles.quietButton,
        tone === 'destructive' && styles.destructiveButton,
        props.disabled === true && styles.disabledButton,
        pressed && props.disabled !== true && styles.pressedButton,
        typeof style === 'function' ? style({ pressed }) : style,
      ]}
      {...props}
    >
      {children}
      <AppText
        maxFontSizeMultiplier={labelMaxFontSizeMultiplier}
        numberOfLines={labelNumberOfLines}
        variant="label"
        style={[
          tone === 'primary' || tone === 'destructive'
            ? styles.primaryLabel
            : styles.secondaryLabel,
          props.disabled === true && styles.disabledLabel,
        ]}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

export function StatusPill({
  children,
  tone = 'neutral',
  subtle = false,
}: PropsWithChildren<{ readonly tone?: StatusTone; readonly subtle?: boolean }>) {
  const status = statusColors[tone];
  const { width: windowWidth } = useWindowDimensions();
  const maxPillWidth = Math.max(0, windowWidth - spacing.xl * 2);

  return (
    <View
      accessibilityRole="text"
      style={[
        styles.pill,
        subtle && styles.subtlePill,
        {
          backgroundColor: subtle ? colors.accentSoft : status.fill,
        },
      ]}
    >
      <AppText
        variant="caption"
        style={[
          styles.pillText,
          {
            color: subtle ? colors.ink : status.ink,
            maxWidth: Math.max(0, maxPillWidth - spacing.sm * 2),
          },
        ]}
      >
        {children}
      </AppText>
    </View>
  );
}

export type AppIconName =
  | 'home'
  | 'labs'
  | 'snap'
  | 'log'
  | 'settings'
  | 'chevronRight'
  | 'chevronLeft'
  | 'ellipsis'
  | 'plus'
  | 'doc'
  | 'clock'
  | 'library'
  | 'chart'
  | 'phone'
  | 'mail'
  | 'folder'
  | 'photos'
  | 'addDocument'
  | 'lockShield'
  | 'eye'
  | 'shield'
  | 'trash'
  | 'cloud'
  | 'checkmarkCircle'
  | 'trendUp'
  | 'trendDown'
  | 'trendStable'
  | 'share'
  | 'reset';

const iconSymbols: Record<AppIconName, string> = {
  home: 'house',
  labs: 'testtube.2',
  snap: 'camera',
  log: 'list.bullet',
  settings: 'gearshape',
  chevronRight: 'chevron.right',
  chevronLeft: 'chevron.left',
  ellipsis: 'ellipsis',
  plus: 'plus',
  doc: 'doc.text',
  clock: 'clock',
  library: 'books.vertical',
  chart: 'chart.xyaxis.line',
  phone: 'iphone',
  mail: 'envelope',
  folder: 'folder',
  photos: 'photo.on.rectangle',
  addDocument: 'doc.badge.plus',
  lockShield: 'lock.shield',
  eye: 'eye',
  shield: 'shield',
  trash: 'trash',
  cloud: 'cloud',
  checkmarkCircle: 'checkmark.circle.fill',
  trendUp: 'arrow.up.right',
  trendDown: 'arrow.down.right',
  trendStable: 'arrow.right',
  share: 'square.and.arrow.up',
  reset: 'arrow.counterclockwise',
};

/** Small SF Symbol seam for inline controls; navigation uses native SF Symbols directly. */
export function AppIcon({
  name,
  size = 20,
  color = colors.mutedInk,
  accessibilityLabel,
  style,
}: {
  readonly name: AppIconName;
  readonly size?: number;
  readonly color?: ColorValue;
  readonly accessibilityLabel?: string;
  readonly style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      accessibilityRole="image"
      source={`sf:${iconSymbols[name]}`}
      style={[{ color, height: size, width: size }, style]}
      {...(accessibilityLabel === undefined
        ? { accessible: false }
        : { accessibilityLabel, accessible: true })}
    />
  );
}

export function TidalHero({
  children,
  edge = 'rounded',
  style,
}: PropsWithChildren<{
  readonly edge?: 'rounded' | 'bottom';
  readonly style?: StyleProp<ViewStyle>;
}>) {
  return (
    <View
      style={[
        styles.tidalHero,
        edge === 'bottom' ? styles.tidalHeroBottomEdge : styles.tidalHeroRounded,
        style,
      ]}
    >
      <View accessibilityElementsHidden pointerEvents="none" style={styles.tidalHeroOrbLarge} />
      <View accessibilityElementsHidden pointerEvents="none" style={styles.tidalHeroOrbSmall} />
      <View style={styles.tidalHeroContent}>{children}</View>
    </View>
  );
}

export function TidalIconStage({
  name,
  accessibilityLabel,
  size = 'regular',
}: {
  readonly name: AppIconName;
  readonly accessibilityLabel?: string;
  readonly size?: 'compact' | 'regular';
}) {
  const compact = size === 'compact';
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityLabel === undefined ? undefined : 'image'}
      accessible={accessibilityLabel !== undefined}
      style={[styles.tidalIconStage, compact && styles.tidalIconStageCompact]}
    >
      <View style={[styles.tidalIconOuter, compact && styles.tidalIconOuterCompact]} />
      <View style={[styles.tidalIconMiddle, compact && styles.tidalIconMiddleCompact]} />
      <View style={[styles.tidalIconCore, compact && styles.tidalIconCoreCompact]}>
        <AppIcon color={colors.onBrand} name={name} size={compact ? 20 : 28} />
      </View>
    </View>
  );
}

/** Shared centered empty state for local laboratory surfaces. */
export function LabEmptyState({
  icon,
  title,
  body,
  actionLabel,
  onAction,
}: {
  readonly icon: AppIconName;
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const usesAccessibleLayout = fontScale >= 1.4;
  const titleScale = Math.min(fontScale, 1.8);
  const copyScale = Math.min(fontScale, 2);
  return (
    <View style={styles.labEmptyState}>
      {!usesAccessibleLayout && <TidalIconStage name={icon} />}
      <View style={styles.labEmptyCopy}>
        <AppText
          allowFontScaling={false}
          style={[styles.labEmptyTitle, { fontSize: 26 * titleScale, lineHeight: 32 * titleScale }]}
          variant="title"
        >
          {title}
        </AppText>
        <AppText
          allowFontScaling={false}
          style={[styles.labEmptyBody, { fontSize: 16 * copyScale, lineHeight: 23 * copyScale }]}
        >
          {body}
        </AppText>
      </View>
      <AppButton
        label={actionLabel}
        labelMaxFontSizeMultiplier={1.8}
        labelNumberOfLines={2}
        onPress={onAction}
        style={styles.labEmptyImportButton}
      >
        <AppIcon color={colors.onAccent} name="plus" size={17} />
      </AppButton>
    </View>
  );
}

export function GroupedRow({
  children,
  icon,
  trailing,
}: PropsWithChildren<{
  readonly icon?: AppIconName;
  readonly trailing?: ReactNode;
}>) {
  return (
    <View style={styles.groupedRow}>
      {icon !== undefined && <AppIcon name={icon} />}
      <View style={styles.groupedRowBody}>{children}</View>
      {trailing}
    </View>
  );
}

type EmptyStateProps = {
  title: string;
  body: string;
  action?: ReactNode;
};

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <AppSurface tone="soft" style={styles.emptyState}>
      <AppText variant="heading">{title}</AppText>
      <AppText style={styles.emptyBody}>{body}</AppText>
      {action}
    </AppSurface>
  );
}

const styles = StyleSheet.create({
  text: { color: colors.ink },
  surface: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
  },
  softSurface: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft },
  brandSurface: { backgroundColor: colors.brand, borderColor: colors.brandMid },
  button: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primaryButton: { backgroundColor: colors.accent },
  secondaryButton: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  quietButton: { minHeight: 44, paddingHorizontal: spacing.sm },
  destructiveButton: { backgroundColor: colors.danger },
  disabledButton: { backgroundColor: colors.disabledFill, borderColor: colors.disabledFill },
  disabledLabel: { color: colors.disabledInk },
  pressedButton: { opacity: 0.72 },
  primaryLabel: { color: colors.onAccent },
  secondaryLabel: { color: colors.accent },
  emptyState: { gap: spacing.sm },
  emptyBody: { color: colors.mutedInk },
  pill: {
    alignSelf: 'flex-start',
    borderCurve: 'continuous',
    borderRadius: radii.pill,
    flexDirection: 'row',
    maxWidth: '100%',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  subtlePill: { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
  pillText: { flexShrink: 1, fontWeight: '600', minWidth: 0 },
  groupedRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 56,
    paddingVertical: spacing.sm,
  },
  groupedRowBody: { flex: 1, gap: spacing.xs },
  labEmptyState: {
    alignItems: 'center',
    gap: spacing.md,
    justifyContent: 'center',
    maxWidth: 440,
    paddingHorizontal: spacing.lg,
    width: '100%',
  },
  tidalHero: {
    backgroundColor: colors.brand,
    borderCurve: 'continuous',
    overflow: 'hidden',
    position: 'relative',
  },
  tidalHeroRounded: { borderRadius: radii.xl },
  tidalHeroBottomEdge: {
    borderBottomLeftRadius: radii.xl,
    borderBottomRightRadius: radii.xl,
  },
  tidalHeroContent: { zIndex: 1 },
  tidalHeroOrbLarge: {
    backgroundColor: colors.brandDeep,
    borderRadius: radii.pill,
    height: 280,
    opacity: 0.46,
    position: 'absolute',
    right: -148,
    top: 28,
    width: 280,
  },
  tidalHeroOrbSmall: {
    backgroundColor: colors.brandSoft,
    borderRadius: radii.pill,
    bottom: -84,
    height: 178,
    opacity: 0.17,
    position: 'absolute',
    right: 38,
    width: 178,
  },
  tidalIconStage: {
    alignItems: 'center',
    height: 112,
    justifyContent: 'center',
    position: 'relative',
    width: 112,
  },
  tidalIconStageCompact: { height: 72, width: 72 },
  tidalIconOuter: {
    backgroundColor: colors.brandMid,
    borderRadius: radii.pill,
    height: 112,
    opacity: 0.24,
    position: 'absolute',
    width: 112,
  },
  tidalIconOuterCompact: { height: 72, width: 72 },
  tidalIconMiddle: {
    backgroundColor: colors.brandSoft,
    borderRadius: radii.pill,
    height: 82,
    opacity: 0.48,
    position: 'absolute',
    width: 82,
  },
  tidalIconMiddleCompact: { height: 54, width: 54 },
  tidalIconCore: {
    alignItems: 'center',
    backgroundColor: colors.brandDeep,
    borderRadius: radii.pill,
    height: 56,
    justifyContent: 'center',
    position: 'absolute',
    width: 56,
  },
  tidalIconCoreCompact: { height: 38, width: 38 },
  labEmptyCopy: { alignItems: 'center', gap: spacing.xs, maxWidth: 340 },
  labEmptyTitle: { textAlign: 'center' },
  labEmptyBody: { color: colors.mutedInk, textAlign: 'center' },
  labEmptyImportButton: { alignSelf: 'stretch' },
  statusMeasuredContent: { flexShrink: 0 },
  statusScreen: { justifyContent: 'center' },
  statusScreenOverflow: { justifyContent: 'flex-start', paddingTop: spacing.sm },
});
