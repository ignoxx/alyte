import en from './en.json';

export const strings = en;
export type Strings = typeof strings;

export function t<Path extends string>(path: Path): string {
  const value = path.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, strings);

  if (typeof value !== 'string') {
    throw new Error(`Missing localization key: ${path}`);
  }

  return value;
}
