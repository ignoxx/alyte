export type RuntimeVariant = 'development' | 'preview' | 'production';

export type CanonicalId = string & { readonly __brand: 'CanonicalId' };

export function canonicalId(value: string): CanonicalId {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)) {
    throw new Error(`Invalid canonical id: ${value}`);
  }

  return value as CanonicalId;
}

export interface ServiceClock {
  now(): Date;
}

export interface AlyteRuntime {
  readonly variant: RuntimeVariant;
  readonly cloudEnvironment: 'none' | 'production';
}

export * from './labs';
export * from './reports';
export * from './sanitization';
export * from './intake';
export * from './extraction';
export * from './geometry';
export * from './geometry-candidate-windows';
export * from './header-table';
export * from './geometry-extraction';
export * from './geometry-result-columns';
export * from './date-context';
