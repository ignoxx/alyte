import { useContext, type PropsWithChildren, type ReactNode } from 'react';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { Image } from 'expo-image';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ColorValue,
  type PressableProps,
  type ScrollViewProps,
  type TextProps,
  type ViewProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, statusColors, typography, type StatusTone } from '../theme';

type AppTextProps = TextProps & {
  variant?: keyof typeof typography;
};

export function AppText({
  variant = 'body',
  style,
  allowFontScaling = true,
  ...props
}: AppTextProps) {
  const { fontScale } = useWindowDimensions();
  const baseStyle = typography[variant];
  // React Native scales the glyphs for Dynamic Type, but an explicit lineHeight remains in the
  // unscaled design-token coordinate space on iOS. Scale that line box with the same system factor
  // so accessibility-sized glyphs get a content-sized line instead of being vertically clipped.
  // At the default size this is exactly the existing design-system value, preserving the normal
  // visual rhythm. Keeping allowFontScaling enabled is important: this only grows the line box.
  const dynamicTypeStyle =
    allowFontScaling && typeof baseStyle.lineHeight === 'number'
      ? { lineHeight: Math.ceil(baseStyle.lineHeight * fontScale) }
      : undefined;

  return (
    <Text
      allowFontScaling={allowFontScaling}
      style={[baseStyle, dynamicTypeStyle, styles.text, style]}
      {...props}
    />
  );
}

type AppSurfaceProps = PropsWithChildren<ViewProps> & {
  tone?: 'default' | 'soft';
};

export function AppSurface({ tone = 'default', style, ...props }: AppSurfaceProps) {
  return <View style={[styles.surface, tone === 'soft' && styles.softSurface, style]} {...props} />;
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
>;

export function ScreenScrollView({
  contentInset,
  scrollIndicatorInsets,
  ...props
}: ScreenScrollViewProps) {
  const tabBarHeight = useContext(BottomTabBarHeightContext);
  const safeAreaInsets = useSafeAreaInsets();
  // Native bottom tabs render outside the JS tree and currently do not provide the React
  // Navigation height context. Their propagated bottom safe-area inset is the dynamic fallback;
  // regular bottom tabs use their authoritative measured height instead.
  const bottomInset = tabBarHeight ?? safeAreaInsets.bottom;

  return (
    <ScrollView
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
}

type AppButtonProps = Omit<PressableProps, 'children'> & {
  label: string;
  accessibilityLabel?: string;
  tone?: 'primary' | 'secondary' | 'quiet';
};

export function AppButton({
  label,
  accessibilityLabel = label,
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
        pressed && styles.pressedButton,
        typeof style === 'function' ? style({ pressed }) : style,
      ]}
      {...props}
    >
      <AppText
        variant="label"
        style={tone === 'primary' ? styles.primaryLabel : styles.secondaryLabel}
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
  return (
    <View
      accessibilityRole="text"
      style={[
        styles.pill,
        subtle && styles.subtlePill,
        { backgroundColor: subtle ? colors.accentSoft : status.fill },
      ]}
    >
      <AppText
        variant="caption"
        style={[styles.pillText, { color: subtle ? colors.ink : status.ink }]}
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
  | 'ellipsis'
  | 'plus'
  | 'doc'
  | 'eye'
  | 'shield';

const iconSymbols: Record<AppIconName, string> = {
  home: 'house',
  labs: 'testtube.2',
  snap: 'camera',
  log: 'list.bullet',
  settings: 'gearshape',
  chevronRight: 'chevron.right',
  ellipsis: 'ellipsis',
  plus: 'plus',
  doc: 'doc.text',
  eye: 'eye',
  shield: 'shield',
};

/** Small SF Symbol seam for inline controls; navigation uses native SF Symbols directly. */
export function AppIcon({
  name,
  size = 20,
  color = colors.mutedInk,
  accessibilityLabel,
}: {
  readonly name: AppIconName;
  readonly size?: number;
  readonly color?: ColorValue;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Image
      accessibilityRole="image"
      source={`sf:${iconSymbols[name]}`}
      style={{ color, height: size, width: size }}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel, accessible: true })}
    />
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
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
  },
  softSurface: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft },
  button: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 12,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primaryButton: { backgroundColor: colors.accent },
  secondaryButton: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  quietButton: { minHeight: 44, paddingHorizontal: spacing.sm },
  pressedButton: { opacity: 0.78 },
  primaryLabel: { color: colors.onAccent },
  secondaryLabel: { color: colors.accent },
  emptyState: { gap: spacing.sm },
  emptyBody: { color: colors.mutedInk },
  pill: {
    alignSelf: 'flex-start',
    borderRadius: 99,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  subtlePill: { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
  pillText: { fontWeight: '600' },
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
});
