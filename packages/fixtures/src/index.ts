type FixtureRuntimeVariant = 'development' | 'preview' | 'production';

export interface ShowcaseSnapshot {
  readonly fixtureId: 'showcase.synthetic.v1';
  readonly label: 'Synthetic showcase data';
  readonly records: readonly ['Synthetic lab report', 'Synthetic intake event'];
  readonly intakeEvents: readonly [
    {
      readonly id: 'showcase-intake-breakfast';
      readonly eventType: 'food';
      readonly name: 'Synthetic breakfast';
      readonly localTime: '09:00';
    },
    {
      readonly id: 'showcase-intake-drink';
      readonly eventType: 'drink';
      readonly name: 'Synthetic drink';
      readonly localTime: '12:00';
    },
  ];
}

const SYNTHETIC_RECORDS = Object.freeze([
  'Synthetic lab report',
  'Synthetic intake event',
] as const);

const SYNTHETIC_SNAPSHOT: ShowcaseSnapshot = Object.freeze({
  fixtureId: 'showcase.synthetic.v1',
  label: 'Synthetic showcase data',
  records: SYNTHETIC_RECORDS,
  intakeEvents: Object.freeze([
    {
      id: 'showcase-intake-breakfast',
      eventType: 'food',
      name: 'Synthetic breakfast',
      localTime: '09:00',
    },
    {
      id: 'showcase-intake-drink',
      eventType: 'drink',
      name: 'Synthetic drink',
      localTime: '12:00',
    },
  ] as const),
});

export function loadShowcaseSnapshot(
  variant: FixtureRuntimeVariant,
  requested: boolean,
): ShowcaseSnapshot | null {
  if (!requested) {
    return null;
  }

  if (variant === 'production') {
    throw new Error('Showcase data is disabled in production builds');
  }

  return SYNTHETIC_SNAPSHOT;
}
