import { DynamicColorIOS, Platform, type ColorValue } from 'react-native';
import type { DesignLabDirection } from './model';

/** The three accents are the only variant-local tokens; generic semantics come from Alyte's theme. */
export const labAccents: Record<DesignLabDirection, ColorValue> = {
  quiet: Platform.OS === 'ios' ? DynamicColorIOS({ light: '#365B8C', dark: '#78A9E6' }) : '#365B8C',
  timeline:
    Platform.OS === 'ios' ? DynamicColorIOS({ light: '#9A4D35', dark: '#E48A70' }) : '#9A4D35',
  library:
    Platform.OS === 'ios' ? DynamicColorIOS({ light: '#56509A', dark: '#AAA4F4' }) : '#56509A',
};
