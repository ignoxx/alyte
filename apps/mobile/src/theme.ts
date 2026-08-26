import { Platform, PlatformColor, StyleSheet, type ColorValue } from 'react-native';

/**
 * Semantic system colors keep ordinary React Native surfaces in sync with UIKit's light and dark
 * appearances. The explicit fallback keeps shared pure/UI checks portable outside iOS.
 */
function systemColor(name: string, fallback: string): ColorValue {
  return Platform.OS === 'ios' ? PlatformColor(name) : fallback;
}

export const colors = {
  ink: systemColor('label', '#1E2A2A'),
  mutedInk: systemColor('secondaryLabel', '#617171'),
  canvas: systemColor('systemGroupedBackground', '#F7F9F6'),
  surface: systemColor('secondarySystemGroupedBackground', '#FFFFFF'),
  elevatedSurface: systemColor('systemBackground', '#FFFFFF'),
  onAccent: '#FFFFFF',
  border: systemColor('separator', '#D7E2DE'),
  accent: systemColor('systemBlue', '#007AFF'),
  accentPressed: systemColor('systemBlue', '#0066D6'),
  accentSoft: systemColor('tertiarySystemFill', '#DDEDE8'),
  disabledFill: systemColor('tertiarySystemFill', '#E1E6E4'),
  disabledInk: systemColor('secondaryLabel', '#566260'),
  warm: '#E9B872',
  danger: systemColor('systemRed', '#A14E4E'),
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 20,
  xl: 28,
  xxl: 40,
} as const;

/** Continuous corner scale used by shaped surfaces; keep screen-level radii on this scale. */
export const radii = {
  sm: 10,
  md: 16,
  lg: 22,
} as const;

export const typography = StyleSheet.create({
  display: { fontSize: 30, lineHeight: 36, fontWeight: '700' },
  title: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 23 },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600', letterSpacing: 0.4 },
  caption: { fontSize: 13, lineHeight: 18 },
});

export type StatusTone =
  | 'neutral'
  | 'measured'
  | 'userEntered'
  | 'userCorrected'
  | 'extracted'
  | 'estimated'
  | 'evidenceBacked'
  | 'reviewNeeded'
  | 'excluded';

/** Semantic provenance/status colors. Labels remain the source of truth; color only reinforces them. */
export const statusColors: Record<
  StatusTone,
  { readonly fill: ColorValue; readonly ink: ColorValue }
> = {
  neutral: { fill: systemColor('tertiarySystemFill', '#E7EEEB'), ink: colors.mutedInk },
  measured: { fill: systemColor('systemBlue', '#286B66'), ink: colors.onAccent },
  userEntered: { fill: systemColor('systemPurple', '#8064A2'), ink: colors.onAccent },
  userCorrected: { fill: systemColor('systemIndigo', '#5B5FC7'), ink: colors.onAccent },
  extracted: { fill: systemColor('systemGray', '#7B8787'), ink: colors.onAccent },
  estimated: { fill: systemColor('systemOrange', '#B7791F'), ink: colors.onAccent },
  evidenceBacked: { fill: systemColor('systemGreen', '#217A5B'), ink: colors.onAccent },
  reviewNeeded: { fill: systemColor('systemYellow', '#A86B00'), ink: '#231A00' },
  excluded: { fill: systemColor('systemGray2', '#A0AAAA'), ink: colors.onAccent },
};

export const screenStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  scroll: { flex: 1 },
  content: { flexGrow: 1, padding: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center' },
});
