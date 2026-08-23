export const designLabDirections = ['quiet', 'timeline', 'library'] as const;
export type DesignLabDirection = (typeof designLabDirections)[number];

export const designLabStates = ['empty', 'two-reports'] as const;
export type DesignLabState = (typeof designLabStates)[number];

export const designLabDirectionNames: Record<DesignLabDirection, string> = {
  quiet: 'Quiet',
  timeline: 'Timeline',
  library: 'Library',
};

export type SyntheticReport = {
  readonly id: string;
  readonly laboratory: string;
  readonly collected: string;
  readonly measurements: number;
};

export type SyntheticMeasuredChange = {
  readonly biomarker: string;
  readonly previous: string;
  readonly latest: string;
  readonly direction: 'increased' | 'decreased';
};

/** Deterministic, invented showcase records. They never enter Alyte persistence. */
export const syntheticReports: readonly SyntheticReport[] = [
  {
    id: 'synthetic-2026-08',
    laboratory: 'Northstar Laboratory',
    collected: '18 Aug 2026',
    measurements: 12,
  },
  {
    id: 'synthetic-2026-02',
    laboratory: 'Cedar Diagnostics',
    collected: '12 Feb 2026',
    measurements: 11,
  },
];

export const syntheticMeasuredChanges: readonly SyntheticMeasuredChange[] = [
  {
    biomarker: 'LDL cholesterol',
    previous: '3.1 mmol/L',
    latest: '3.4 mmol/L',
    direction: 'increased',
  },
  {
    biomarker: 'HDL cholesterol',
    previous: '1.3 mmol/L',
    latest: '1.5 mmol/L',
    direction: 'increased',
  },
  {
    biomarker: 'Triglycerides',
    previous: '1.4 mmol/L',
    latest: '1.1 mmol/L',
    direction: 'decreased',
  },
];

export function designLabEnabled(
  environment = process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB,
  development = __DEV__,
): boolean {
  return development && environment === '1';
}
