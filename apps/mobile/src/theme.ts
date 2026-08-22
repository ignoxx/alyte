import { StyleSheet } from 'react-native';

export const colors = {
  ink: '#1E2A2A',
  mutedInk: '#617171',
  canvas: '#F7F9F6',
  surface: '#FFFFFF',
  border: '#D7E2DE',
  accent: '#286B66',
  accentPressed: '#1F5652',
  accentSoft: '#DDEDE8',
  warm: '#E9B872',
  danger: '#A14E4E',
} as const;

export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const typography = StyleSheet.create({
  display: { fontSize: 32, lineHeight: 40, fontWeight: '700' },
  title: { fontSize: 26, lineHeight: 34, fontWeight: '700' },
  heading: { fontSize: 20, lineHeight: 28, fontWeight: '700' },
  body: { fontSize: 17, lineHeight: 25 },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600', letterSpacing: 0.4 },
  caption: { fontSize: 13, lineHeight: 18 },
});

export const screenStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  scroll: { flex: 1 },
  content: { flexGrow: 1, padding: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center' },
});
