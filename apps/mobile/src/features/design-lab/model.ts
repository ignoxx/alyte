export const designLabDirections = ['quiet', 'timeline', 'library'] as const;
export type DesignLabDirection = (typeof designLabDirections)[number];

export const designLabStates = ['empty', 'two-reports'] as const;
export type DesignLabState = (typeof designLabStates)[number];

export type SyntheticReport = {
  readonly id: string;
  readonly laboratory: string;
  readonly collectedOn: string;
  readonly measurements: number;
};

export type SyntheticMeasuredChange = {
  readonly biomarkerKey:
    'designLab.biomarkerLdl' | 'designLab.biomarkerHdl' | 'designLab.biomarkerTriglycerides';
  readonly previous: number;
  readonly latest: number;
  readonly unit: 'millimolesPerLiter';
  readonly direction: 'increased' | 'decreased';
};

/** Deterministic, invented showcase records. They never enter Alyte persistence. */
export const syntheticReports: readonly SyntheticReport[] = [
  {
    id: 'synthetic-2026-08',
    laboratory: 'Northstar Laboratory',
    collectedOn: '2026-08-18',
    measurements: 12,
  },
  {
    id: 'synthetic-2026-02',
    laboratory: 'Cedar Diagnostics',
    collectedOn: '2026-02-12',
    measurements: 11,
  },
];

export const syntheticMeasuredChanges: readonly SyntheticMeasuredChange[] = [
  {
    biomarkerKey: 'designLab.biomarkerLdl',
    previous: 3.1,
    latest: 3.4,
    unit: 'millimolesPerLiter',
    direction: 'increased',
  },
  {
    biomarkerKey: 'designLab.biomarkerHdl',
    previous: 1.3,
    latest: 1.5,
    unit: 'millimolesPerLiter',
    direction: 'increased',
  },
  {
    biomarkerKey: 'designLab.biomarkerTriglycerides',
    previous: 1.4,
    latest: 1.1,
    unit: 'millimolesPerLiter',
    direction: 'decreased',
  },
];

function dateFromLocalISO(value: string): Date {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day, 12);
}

export function formatSyntheticDate(
  value: string,
  locale?: string,
  length: 'short' | 'long' = 'short',
): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: length === 'long' ? 'long' : 'short',
    ...(length === 'short' ? { year: 'numeric' as const } : {}),
  }).format(dateFromLocalISO(value));
}

export function formatSyntheticMeasurement(
  value: number,
  unitLabel: string,
  locale?: string,
): string {
  return `${formatSyntheticNumber(value, locale, 1)} ${unitLabel}`;
}

export function formatSyntheticNumber(
  value: number,
  locale?: string,
  maximumFractionDigits = 0,
): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

export function designLabEnabled(
  environment = process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB,
  development = __DEV__,
): boolean {
  return development && environment === '1';
}
