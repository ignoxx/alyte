import type { PropsWithChildren, ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type TextProps,
  type ViewProps,
} from 'react-native';
import { colors, spacing, typography } from '../theme';

type AppTextProps = TextProps & {
  variant?: keyof typeof typography;
};

export function AppText({
  variant = 'body',
  style,
  allowFontScaling = true,
  ...props
}: AppTextProps) {
  return (
    <Text
      allowFontScaling={allowFontScaling}
      style={[typography[variant], styles.text, style]}
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

export function StatusPill({ children }: PropsWithChildren) {
  return (
    <View accessibilityRole="text" style={styles.pill}>
      <AppText variant="caption" style={styles.pillText}>
        {children}
      </AppText>
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
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
  },
  softSurface: { backgroundColor: colors.accentSoft, borderColor: colors.accentSoft },
  button: {
    alignItems: 'center',
    borderRadius: 14,
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primaryButton: { backgroundColor: colors.accent },
  secondaryButton: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  quietButton: { minHeight: 44, paddingHorizontal: spacing.sm },
  pressedButton: { opacity: 0.78 },
  primaryLabel: { color: colors.surface },
  secondaryLabel: { color: colors.accent },
  emptyState: { gap: spacing.sm },
  emptyBody: { color: colors.mutedInk },
  pill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accentSoft,
    borderRadius: 99,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  pillText: { color: colors.accent },
});
