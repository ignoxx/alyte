import { DynamicColorIOS, Platform, PlatformColor, type ColorValue } from 'react-native';
import type { DesignLabDirection } from './model';

const semantic = (name: string, fallback: string): ColorValue =>
  Platform.OS === 'ios' ? PlatformColor(name) : fallback;

export const labColors = {
  background: semantic('systemGroupedBackground', '#F2F2F7'),
  surface: semantic('secondarySystemGroupedBackground', '#FFFFFF'),
  elevated: semantic('systemBackground', '#FFFFFF'),
  label: semantic('label', '#111111'),
  secondary: semantic('secondaryLabel', '#6C6C70'),
  tertiary: semantic('tertiaryLabel', '#8E8E93'),
  separator: semantic('separator', '#C6C6C8'),
  fill: semantic('tertiarySystemFill', '#E5E5EA'),
};

export const labAccents: Record<DesignLabDirection, ColorValue> = {
  quiet: Platform.OS === 'ios' ? DynamicColorIOS({ light: '#365B8C', dark: '#78A9E6' }) : '#365B8C',
  timeline:
    Platform.OS === 'ios' ? DynamicColorIOS({ light: '#9A4D35', dark: '#E48A70' }) : '#9A4D35',
  library:
    Platform.OS === 'ios' ? DynamicColorIOS({ light: '#56509A', dark: '#AAA4F4' }) : '#56509A',
};

export const labSpacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const labRadius = { sm: 10, md: 16, lg: 22, full: 999 } as const;
