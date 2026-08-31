import {
  DynamicColorIOS,
  Platform,
  PlatformColor,
  StyleSheet,
  type ColorValue,
} from 'react-native';

/**
 * Semantic system colors keep ordinary React Native surfaces in sync with UIKit's light and dark
 * appearances. The explicit fallback keeps shared pure/UI checks portable outside iOS.
 */
function systemColor(name: string, fallback: string): ColorValue {
  return Platform.OS === 'ios' ? PlatformColor(name) : fallback;
}

function adaptiveColor(light: string, dark: string): ColorValue {
  return Platform.OS === 'ios' ? DynamicColorIOS({ light, dark }) : light;
}

export const colors = {
  ink: adaptiveColor('#122320', '#F2FAF7'),
  mutedInk: adaptiveColor('#627570', '#A2B8B2'),
  canvas: adaptiveColor('#F2F7F5', '#08110F'),
  surface: adaptiveColor('#FFFFFF', '#111E1B'),
  elevatedSurface: adaptiveColor('#FFFFFF', '#172622'),
  onAccent: adaptiveColor('#F5FFFC', '#092F2C'),
  border: adaptiveColor('#D2E1DC', '#29443F'),
  accent: adaptiveColor('#17766B', '#74D7C4'),
  accentPressed: adaptiveColor('#0E5C53', '#97E7D8'),
  accentSoft: adaptiveColor('#E0EEEA', '#17312C'),
  disabledFill: adaptiveColor('#E2E9E6', '#24322F'),
  disabledInk: adaptiveColor('#77847F', '#748681'),
  brand: adaptiveColor('#155D57', '#114943'),
  brandDeep: adaptiveColor('#0C423E', '#092F2C'),
  brandMid: adaptiveColor('#23756C', '#1D625A'),
  brandSoft: adaptiveColor('#79D1BE', '#57B8A7'),
  onBrand: adaptiveColor('#F5FFFC', '#F4FFFC'),
  onBrandMuted: adaptiveColor('rgba(245,255,252,0.70)', 'rgba(244,255,252,0.68)'),
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
  sm: 12,
  md: 18,
  lg: 26,
  xl: 38,
  pill: 999,
} as const;

export const typography = StyleSheet.create({
  display: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.8 },
  metric: { fontSize: 36, lineHeight: 40, fontWeight: '700' },
  stat: { fontSize: 22, lineHeight: 27, fontWeight: '700' },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.35 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 23 },
  row: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  input: { fontSize: 17, lineHeight: 22 },
  code: { fontFamily: 'Menlo', fontSize: 13, lineHeight: 19 },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600', letterSpacing: 0.15 },
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
  measured: { fill: colors.accent, ink: colors.onAccent },
  userEntered: { fill: systemColor('systemPurple', '#8064A2'), ink: '#FFFFFF' },
  userCorrected: { fill: systemColor('systemIndigo', '#5B5FC7'), ink: '#FFFFFF' },
  extracted: { fill: systemColor('systemGray', '#7B8787'), ink: '#FFFFFF' },
  estimated: { fill: systemColor('systemOrange', '#B7791F'), ink: '#FFFFFF' },
  evidenceBacked: { fill: systemColor('systemGreen', '#217A5B'), ink: '#FFFFFF' },
  reviewNeeded: { fill: systemColor('systemYellow', '#A86B00'), ink: '#231A00' },
  excluded: { fill: systemColor('systemGray2', '#A0AAAA'), ink: '#FFFFFF' },
};

export const screenStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  scroll: { flex: 1 },
  content: { flexGrow: 1, padding: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center' },
});
