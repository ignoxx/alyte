type FixtureRuntimeVariant = 'development' | 'preview' | 'production';

export interface ShowcaseSnapshot {
  readonly fixtureId: 'showcase.synthetic.v1';
  readonly label: 'Synthetic showcase data';
  readonly records: readonly ['Synthetic lab report', 'Synthetic intake event'];
}

const SYNTHETIC_SNAPSHOT: ShowcaseSnapshot = Object.freeze({
  fixtureId: 'showcase.synthetic.v1',
  label: 'Synthetic showcase data',
  records: ['Synthetic lab report', 'Synthetic intake event'] as const,
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
